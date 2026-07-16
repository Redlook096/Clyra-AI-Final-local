"""Clyra ultra-low-latency voice pipeline worker.

STT: Faster-Whisper + streaming local-agreement (whisper_streaming policy)
VAD: Silero (energy fallback)
TTS: persistent Chatterbox-Turbo phrase synthesis
LLM: NOT here — existing OpenAI-compatible API stays in the Node app.
"""

from __future__ import annotations

import os

# Avoid OpenMP double-init crash on macOS (torch + ctranslate2).
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
# Allow Faster-Whisper cpu_threads to use a few cores without saturating 8GB machines.
os.environ.setdefault("OMP_NUM_THREADS", os.getenv("VOICE_WHISPER_CPU_THREADS", "4"))

import asyncio
import base64
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

# Allow `python main.py` from this directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import config
from stt_stream import StreamingTranscriber, pcm16_bytes_to_f32
from tts_stream import get_tts_runtime, synthesize_streaming
from vad import VoiceActivityDetector

app = FastAPI(title="Clyra Voice Pipeline", version="2.0.0")

_vad = VoiceActivityDetector(sample_rate=config.SAMPLE_RATE)
_model_ready = False


class SttRequest(BaseModel):
    audio: str
    sampleRate: int = config.SAMPLE_RATE
    model: str = config.STT_MODEL


class TtsRequest(BaseModel):
    text: str
    voice: str = config.TTS_VOICE
    sampleRate: int = config.TTS_SAMPLE_RATE


class SessionState:
    def __init__(self, session_id: str, websocket: WebSocket, loop: asyncio.AbstractEventLoop):
        self.session_id = session_id
        self.ws = websocket
        self.muted = False
        self._loop = loop
        self.transcriber = StreamingTranscriber(
            sample_rate=config.SAMPLE_RATE,
            model_name=config.STT_MODEL,
            language=config.STT_LANGUAGE,
            on_event=self._on_stt_event,
        )
        self._send_queue: asyncio.Queue = asyncio.Queue()
        self._audio_queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        self._closed = False
        self.metrics: Dict[str, float] = {}
        self._audio_task = loop.create_task(self._audio_worker())

    def _on_stt_event(self, event: Dict[str, Any]) -> None:
        # push_audio runs in a worker thread — always marshal onto the WS loop.
        self._loop.call_soon_threadsafe(self._send_queue.put_nowait, event)

    async def _audio_worker(self) -> None:
        """Drain mic frames without blocking the WS receive loop on Whisper."""
        while not self._closed:
            item = await self._audio_queue.get()
            if item is None:
                break
            if item == "flush":
                await asyncio.to_thread(self.transcriber.force_finalize)
                continue
            pcm, is_speech, speech_prob = item
            try:
                await asyncio.to_thread(
                    self.transcriber.push_audio,
                    pcm,
                    is_speech,
                    speech_prob,
                )
            except Exception as exc:
                print(f"[voice-pipeline] push_audio error: {exc}", flush=True)
                await self._send_queue.put(
                    {"type": "error", "message": f"stt: {exc}"}
                )

    async def enqueue_audio(self, pcm: bytes) -> None:
        audio = pcm16_bytes_to_f32(pcm)
        vad = _vad.score(audio)
        try:
            self._audio_queue.put_nowait((pcm, vad.is_speech, vad.probability))
        except asyncio.QueueFull:
            # Prefer freshest audio under backpressure.
            try:
                _ = self._audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self._audio_queue.put_nowait((pcm, vad.is_speech, vad.probability))
            except asyncio.QueueFull:
                pass

    async def enqueue_flush(self) -> None:
        try:
            self._audio_queue.put_nowait("flush")
        except asyncio.QueueFull:
            pass

    async def sender(self) -> None:
        while not self._closed:
            event = await self._send_queue.get()
            if event is None:
                break
            kind = event.get("type")
            if kind == "partial":
                await self.ws.send_json(
                    {
                        "type": "transcript_partial",
                        "sessionId": self.session_id,
                        "text": event.get("text", ""),
                        "confidence": event.get("confidence", 0.7),
                        "language": event.get("language"),
                    }
                )
            elif kind == "final":
                self.metrics["stt_final_ms"] = float(event.get("ms") or 0)
                await self.ws.send_json(
                    {
                        "type": "transcript_final",
                        "sessionId": self.session_id,
                        "text": event.get("text", ""),
                        "confidence": event.get("confidence", 0.85),
                        "language": event.get("language"),
                        "metrics": {"sttMs": self.metrics.get("stt_final_ms", 0)},
                    }
                )
            else:
                await self.ws.send_json(event)

    async def close(self) -> None:
        self._closed = True
        try:
            self._audio_queue.put_nowait(None)
        except asyncio.QueueFull:
            pass
        await self._send_queue.put(None)
        if self._audio_task:
            self._audio_task.cancel()


@app.on_event("startup")
async def startup() -> None:
    _ = _vad.backend
    # Keep the API available immediately. STT loads lazily on first microphone
    # audio; concurrently importing CTranslate2 and PyTorch crashes some Intel
    # macOS OpenMP runtimes.
    asyncio.create_task(asyncio.to_thread(get_tts_runtime().warm))


@app.get("/health")
def health() -> dict:
    runtime = get_tts_runtime()
    return {
        "status": "ok",
        "stt_model": config.STT_MODEL,
        "stt_device": config.STT_DEVICE,
        "tts_voice": config.TTS_VOICE,
        "tts_engine": config.TTS_ENGINE,
        "vad": _vad.backend,
        "sample_rate": config.SAMPLE_RATE,
        "tts_sample_rate": config.TTS_SAMPLE_RATE,
        "model_ready": runtime.status.ready,
        "tts_runtime": runtime.describe(),
        "architecture": {
            "stt": "faster-whisper + local-agreement streaming",
            "vad": "silero-vad | energy-fallback",
            "tts": "persistent chatterbox-turbo",
            "llm": "external-existing-openai-compatible",
        },
    }


@app.post("/stt")
def stt(req: SttRequest) -> JSONResponse:
    try:
        started = time.perf_counter()
        pcm = base64.b64decode(req.audio)
        audio = pcm16_bytes_to_f32(pcm)
        tr = StreamingTranscriber(sample_rate=req.sampleRate, model_name=req.model)
        text, conf, lang = tr._transcribe_window(audio)
        return JSONResponse(
            {
                "text": text,
                "confidence": conf,
                "language": lang,
                "ms": (time.perf_counter() - started) * 1000,
            }
        )
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.post("/tts")
def tts(req: TtsRequest) -> JSONResponse:
    try:
        started = time.perf_counter()
        chunks = synthesize_streaming(req.text, req.voice, req.sampleRate)
        return JSONResponse(
            {
                "chunks": chunks,
                "sampleRate": req.sampleRate,
                "ms": (time.perf_counter() - started) * 1000,
                "engine": get_tts_runtime().status.active_engine,
                "profile": get_tts_runtime().status.profile,
                "warning": get_tts_runtime().status.reason if get_tts_runtime().status.degraded else None,
            }
        )
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.websocket("/stream")
async def stream(ws: WebSocket) -> None:
    await ws.accept()
    session: Optional[SessionState] = None
    sender_task: Optional[asyncio.Task] = None

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            mtype = msg.get("type")

            if mtype == "session_start":
                session_id = str(msg.get("sessionId") or f"sess-{int(time.time() * 1000)}")
                session = SessionState(session_id, ws, asyncio.get_running_loop())
                sender_task = asyncio.create_task(session.sender())
                await ws.send_json(
                    {
                        "type": "ready",
                        "sessionId": session_id,
                        "sampleRate": config.SAMPLE_RATE,
                        "ttsSampleRate": config.TTS_SAMPLE_RATE,
                        "sttModel": config.STT_MODEL,
                        "vad": _vad.backend,
                    }
                )
                continue

            if session is None:
                await ws.send_json({"type": "error", "message": "session_start required"})
                continue

            if mtype == "mute":
                session.muted = bool(msg.get("muted"))
                continue

            if mtype == "barge_in":
                session.transcriber.reset_utterance()
                await ws.send_json({"type": "barge_in", "sessionId": session.session_id})
                continue

            if mtype == "audio" and not session.muted:
                data = msg.get("data") or ""
                pcm = base64.b64decode(data)
                await session.enqueue_audio(pcm)
                continue

            if mtype == "flush":
                await session.enqueue_flush()
                continue

            if mtype == "tts":
                text = str(msg.get("text") or "")
                voice = str(msg.get("voice") or config.TTS_VOICE)
                request_id = str(msg.get("requestId") or "")
                sample_rate = int(msg.get("sampleRate") or config.TTS_SAMPLE_RATE)
                started = time.perf_counter()
                chunks = await asyncio.to_thread(
                    synthesize_streaming, text, voice, sample_rate
                )
                for idx, chunk in enumerate(chunks):
                    await ws.send_json(
                        {
                            "type": "tts_chunk",
                            "sessionId": session.session_id,
                            "requestId": request_id,
                            "codec": "pcm16",
                            "sampleRate": sample_rate,
                            "data": chunk,
                            "seq": idx,
                        }
                    )
                await ws.send_json(
                    {
                        "type": "tts_done",
                        "sessionId": session.session_id,
                        "requestId": request_id,
                        "metrics": {"ttsMs": (time.perf_counter() - started) * 1000},
                    }
                )
                continue

            if mtype == "ping":
                await ws.send_json({"type": "pong", "sessionId": session.session_id})
                continue

            if mtype == "end":
                break

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        if session:
            await session.close()
        if sender_task:
            sender_task.cancel()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=config.PIPELINE_PORT)
