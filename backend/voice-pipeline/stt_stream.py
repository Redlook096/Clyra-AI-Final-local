"""
Streaming STT using Faster-Whisper with whisper_streaming-style local agreement.

Optimizations (measured):
- cpu_threads=4: ~756ms → ~437ms warm decode on tiny.en (Wallace Cl 2)
- Speculative decode at silence onset: overlaps endpoint wait with Whisper
- Cap trailing silence in the decode buffer
- Single-flight decode (model is not safely concurrent)
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import numpy as np

import config


EmitFn = Callable[[dict[str, Any]], None]

# Shared Faster-Whisper instance across sessions (warm path for call-fluent turns).
_SHARED_MODELS: dict[str, Any] = {}
_DECODE_LOCK = threading.Lock()
_DECODE_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voice-stt")


def pcm16_bytes_to_f32(data: bytes) -> np.ndarray:
    if not data:
        return np.zeros(0, dtype=np.float32)
    pcm = np.frombuffer(data, dtype=np.int16)
    return (pcm.astype(np.float32) / 32768.0).copy()


@dataclass
class StreamEvent:
    kind: str  # partial | final
    text: str
    confidence: float
    language: Optional[str] = None
    ms: float = 0.0


@dataclass
class StreamingTranscriber:
    sample_rate: int = config.SAMPLE_RATE
    model_name: str = config.STT_MODEL
    language: str = config.STT_LANGUAGE
    on_event: Optional[EmitFn] = None
    _model: Any = field(default=None, repr=False)
    _buffer: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    _preroll: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    _committed: str = ""
    _last_partial: str = ""
    _last_decode_at: float = 0.0
    _speech_ms: float = 0.0
    _silence_ms: float = 0.0
    _in_speech: bool = False
    _utterance_started_at: float = 0.0
    _language: Optional[str] = None
    _ignore_until: float = 0.0
    _spec_future: Optional[Future] = field(default=None, repr=False)
    _spec_gen: int = 0
    _spec_started_at: float = 0.0
    _spec_buf_len: int = 0
    _spec_speech_ms: float = 0.0

    def ensure_model(self) -> Any:
        if self._model is not None:
            return self._model
        key = (
            f"{self.model_name}|{config.STT_DEVICE}|{config.STT_COMPUTE}|"
            f"t{config.STT_CPU_THREADS}"
        )
        cached = _SHARED_MODELS.get(key)
        if cached is not None:
            self._model = cached
            return self._model
        from faster_whisper import WhisperModel

        self._model = WhisperModel(
            self.model_name,
            device=config.STT_DEVICE,
            compute_type=config.STT_COMPUTE,
            cpu_threads=max(1, config.STT_CPU_THREADS),
            num_workers=1,
        )
        _SHARED_MODELS[key] = self._model
        return self._model

    def reset_utterance(self) -> None:
        self._spec_gen += 1
        self._spec_future = None
        self._buffer = np.zeros(0, dtype=np.float32)
        self._committed = ""
        self._last_partial = ""
        self._speech_ms = 0.0
        self._silence_ms = 0.0
        self._in_speech = False
        self._utterance_started_at = 0.0
        # Keep preroll ring across utterances so the next onset still has context.

    def _emit(self, event: StreamEvent) -> None:
        if self.on_event:
            self.on_event(
                {
                    "type": event.kind,
                    "text": event.text,
                    "confidence": event.confidence,
                    "language": event.language,
                    "ms": event.ms,
                }
            )

    def _common_prefix(self, a: str, b: str) -> str:
        aw = a.split()
        bw = b.split()
        i = 0
        while i < len(aw) and i < len(bw) and aw[i] == bw[i]:
            i += 1
        return " ".join(aw[:i]).strip()

    def _trim_for_decode(self, audio: np.ndarray) -> np.ndarray:
        """Drop long trailing silence so Whisper sees speech sooner."""
        if audio.size < self.sample_rate // 5:
            return audio
        frame = max(1, self.sample_rate // 50)  # 20ms
        keep_silence = int(self.sample_rate * 0.12)
        last_speech = 0
        for i in range(0, audio.size, frame):
            chunk = audio[i : i + frame]
            if chunk.size == 0:
                break
            rms = float(np.sqrt(np.mean(np.square(chunk))))
            if rms >= 0.012:
                last_speech = i + chunk.size
        if last_speech <= 0:
            return audio
        end = min(audio.size, last_speech + keep_silence)
        return audio[:end]

    def _transcribe_window(self, audio: np.ndarray) -> tuple[str, float, Optional[str]]:
        if audio.size < int(self.sample_rate * 0.18):
            return "", 0.0, self._language
        model = self.ensure_model()
        clipped = self._trim_for_decode(audio)
        with _DECODE_LOCK:
            segments, info = model.transcribe(
                clipped.astype(np.float32, copy=False),
                language=self.language or None,
                beam_size=config.STT_BEAM_SIZE,
                best_of=1,
                temperature=0.0,
                vad_filter=False,
                condition_on_previous_text=False,
                without_timestamps=True,
            )
            parts: list[str] = []
            confs: list[float] = []
            for seg in segments:
                t = (seg.text or "").strip()
                if t:
                    parts.append(t)
                if getattr(seg, "avg_logprob", None) is not None:
                    confs.append(max(0.0, min(1.0, 1.0 + float(seg.avg_logprob))))
        text = " ".join(parts).strip()
        conf = sum(confs) / len(confs) if confs else (0.8 if text else 0.0)
        lang = getattr(info, "language", None) or self._language
        self._language = lang
        return text, conf, lang

    def _start_speculative_decode(self) -> None:
        if self._spec_future is not None and not self._spec_future.done():
            return
        snapshot = self._buffer.copy()
        gen = self._spec_gen
        self._spec_started_at = time.perf_counter()
        self._spec_buf_len = int(snapshot.size)
        self._spec_speech_ms = self._speech_ms

        def _job() -> tuple[int, str, float, Optional[str], float]:
            t0 = time.perf_counter()
            text, conf, lang = self._transcribe_window(snapshot)
            return gen, text, conf, lang, (time.perf_counter() - t0) * 1000

        self._spec_future = _DECODE_POOL.submit(_job)

    def push_audio(self, pcm16: bytes, is_speech: bool, speech_prob: float) -> None:
        del speech_prob  # reserved for future adaptive thresholds
        if time.perf_counter() < self._ignore_until:
            return
        frame = pcm16_bytes_to_f32(pcm16)
        if frame.size == 0:
            return
        frame_ms = 1000.0 * frame.size / self.sample_rate
        preroll_samples = int(self.sample_rate * (config.STT_PREROLL_MS / 1000.0))

        if is_speech:
            if not self._in_speech:
                self._in_speech = True
                self._utterance_started_at = time.perf_counter()
                self._silence_ms = 0.0
                self._spec_gen += 1
                self._spec_future = None
                # Seed utterance with pre-roll so word onsets aren't clipped.
                if self._preroll.size > 0:
                    self._buffer = np.concatenate([self._preroll, frame])
                    self._preroll = np.zeros(0, dtype=np.float32)
                else:
                    self._buffer = frame.copy()
            else:
                # Speech resumed — invalidate speculative decode.
                if self._silence_ms > 0:
                    self._spec_gen += 1
                    self._spec_future = None
                self._buffer = np.concatenate([self._buffer, frame])
            self._speech_ms += frame_ms
            self._silence_ms = 0.0
            max_samples = self.sample_rate * 20
            if self._buffer.size > max_samples:
                self._buffer = self._buffer[-max_samples:]
        else:
            if self._in_speech:
                prev_silence = self._silence_ms
                self._silence_ms += frame_ms
                # Keep a short silence tail only (avoid bloating the decode buffer).
                max_sil = int(self.sample_rate * 0.2)
                sil_samples = int(self.sample_rate * (self._silence_ms / 1000.0))
                if sil_samples <= max_sil:
                    self._buffer = np.concatenate([self._buffer, frame])
                # Overlap Whisper with the endpoint wait (measured: ~280–450ms saved).
                if (
                    prev_silence < config.SPECULATIVE_DECODE_MS
                    <= self._silence_ms
                    and self._speech_ms >= config.VAD_MIN_SPEECH_MS
                ):
                    self._start_speculative_decode()
            elif preroll_samples > 0:
                self._preroll = np.concatenate([self._preroll, frame])
                if self._preroll.size > preroll_samples:
                    self._preroll = self._preroll[-preroll_samples:]

        if (
            self._in_speech
            and self._silence_ms >= config.ENDPOINT_SILENCE_MS
            and self._speech_ms >= config.VAD_MIN_SPEECH_MS
        ):
            self._finalize()
            return

        if (
            config.STT_PARTIALS_ENABLED
            and self._in_speech
            and is_speech
            and (time.perf_counter() - self._last_decode_at)
            >= (config.STT_STEP_MS / 1000.0)
        ):
            self._last_decode_at = time.perf_counter()
            self._maybe_partial()

    def _window_audio(self) -> np.ndarray:
        window = int(self.sample_rate * (config.STT_WINDOW_MS / 1000.0))
        overlap = int(self.sample_rate * (config.STT_OVERLAP_MS / 1000.0))
        if self._buffer.size <= window:
            return self._buffer
        return self._buffer[-(window + overlap) :]

    def _maybe_partial(self) -> None:
        # A synchronous partial decode blocks this single audio worker for a
        # whole Whisper pass. During a real sentence that makes queued frames
        # pile up and can delay the final result for tens of seconds. Keep the
        # useful speculative pass, but let it run in the existing one-flight
        # executor; `_finalize` consumes it when it is still current.
        self._start_speculative_decode()

    def force_finalize(self) -> None:
        """End the current utterance even if silence threshold isn't met yet."""
        if not self._in_speech:
            return
        if self._speech_ms < config.VAD_MIN_SPEECH_MS and not (
            self._last_partial or self._committed
        ):
            self.reset_utterance()
            return
        self._finalize()

    def _finalize(self) -> None:
        started = time.perf_counter()
        text = ""
        conf = 0.0
        lang = self._language
        decode_ms = 0.0

        fut = self._spec_future
        # Only invalidate a speculative pass when the speaker continued. The
        # microphone can add several hundred milliseconds of trailing silence
        # before a flush; treating that silence as new content used to force a
        # second complete Whisper pass at the end of every turn.
        speech_grew = self._speech_ms > self._spec_speech_ms + 1.0
        if fut is not None and not speech_grew:
            try:
                gen, text, conf, lang, decode_ms = fut.result(timeout=8.0)
                if gen != self._spec_gen or conf < 0.7:
                    text = ""
            except Exception:
                text = ""

        if not text:
            text, conf, lang = self._transcribe_window(self._buffer)
            decode_ms = (time.perf_counter() - started) * 1000

        wall_ms = (time.perf_counter() - started) * 1000
        final = (text or self._last_partial or self._committed).strip()
        if final:
            self._emit(
                StreamEvent(
                    kind="final",
                    text=final,
                    confidence=conf or 0.85,
                    language=lang,
                    ms=decode_ms or wall_ms,
                )
            )
        self.reset_utterance()
        self._ignore_until = time.perf_counter() + 0.18
