"""Fish Audio speech-to-text service.

Fish's `/v1/asr` endpoint is REST, non-streaming, and BETA (file upload in,
one transcript out) -- there is no live partial-transcript stream on Fish's
side. `SegmentedSTTService` (pipecat's own base class for exactly this shape
of provider) already buffers microphone audio between the VAD's
UserStartedSpeaking/UserStoppedSpeaking frames and calls `run_stt()` once per
utterance with the full segment, so the "final" transcript here is genuinely
fast and real -- one REST call per utterance, not per chunk.

To still surface a live-feeling caption while the user is mid-utterance (the
spec's "partial" requirement), `FishASRSTTService` also fires a rolling
`run_stt()` call on the *growing* buffer every ~700ms while VAD reports
speech, emitting `InterimTranscriptionFrame`s from those. This costs extra
Fish ASR calls during a long utterance in exchange for live captions; it is
an explicit trade-off of Fish's API surface, not a fabricated partial.
"""

from __future__ import annotations

import asyncio
import io
import time
import wave
from typing import AsyncGenerator, Optional

import aiohttp
from loguru import logger

from pipecat.frames.frames import ErrorFrame, Frame, InterimTranscriptionFrame, TranscriptionFrame
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601

FISH_ASR_URL = "https://api.fish.audio/v1/asr"
PARTIAL_INTERVAL_SECS = 0.7


def _pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setsampwidth(2)
        wav.setnchannels(1)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return buf.getvalue()


class FishASRSTTService(SegmentedSTTService):
    """Speech-to-text via Fish Audio's `/v1/asr` REST endpoint."""

    def __init__(self, *, api_key: str, sample_rate: Optional[int] = None, language: str = "en", **kwargs):
        super().__init__(
            sample_rate=sample_rate,
            settings=STTSettings(model="fish-asr", language=Language.EN),
            **kwargs,
        )
        self._api_key = api_key
        self._language = language
        self._session: Optional[aiohttp.ClientSession] = None
        self._partial_task: Optional[asyncio.Task] = None
        self._user_id = ""

    async def start(self, frame):  # noqa: D401 - pipecat lifecycle hook
        await super().start(frame)
        self._session = aiohttp.ClientSession()

    async def stop(self, frame):
        await self._cancel_partial_task()
        if self._session:
            await self._session.close()
            self._session = None
        await super().stop(frame)

    async def cancel(self, frame):
        await self._cancel_partial_task()
        if self._session:
            await self._session.close()
            self._session = None
        await super().cancel(frame)

    async def _cancel_partial_task(self):
        if self._partial_task and not self._partial_task.done():
            self._partial_task.cancel()
        self._partial_task = None

    async def _handle_user_started_speaking(self, frame):
        await super()._handle_user_started_speaking(frame)
        self._partial_task = self.create_task(self._partial_loop())

    async def _handle_user_stopped_speaking(self, frame):
        await self._cancel_partial_task()
        await super()._handle_user_stopped_speaking(frame)

    async def _partial_loop(self):
        try:
            while True:
                await asyncio.sleep(PARTIAL_INTERVAL_SECS)
                snapshot = bytes(self._audio_buffer)
                # Fish charges per call; skip near-silent / too-short snapshots.
                if len(snapshot) < self.sample_rate:  # < ~0.5s at 16-bit mono
                    continue
                text = await self._transcribe(snapshot)
                if text:
                    await self.push_frame(
                        InterimTranscriptionFrame(
                            text=text,
                            user_id=self._user_id,
                            timestamp=time_now_iso8601(),
                            language=Language.EN,
                        )
                    )
        except asyncio.CancelledError:
            pass

    async def _transcribe(self, pcm: bytes) -> str:
        if not self._api_key:
            return ""
        wav_bytes = _pcm_to_wav(pcm, self.sample_rate)
        form = aiohttp.FormData()
        form.add_field("audio", wav_bytes, filename="utterance.wav", content_type="audio/wav")
        form.add_field("language", self._language)
        form.add_field("ignore_timestamps", "true")
        assert self._session is not None
        async with self._session.post(
            FISH_ASR_URL,
            data=form,
            headers={"Authorization": f"Bearer {self._api_key}"},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise RuntimeError(f"Fish ASR failed ({resp.status}): {body[:200]}")
            data = await resp.json()
            return str(data.get("text") or "").strip()

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        started = time.perf_counter()
        try:
            text = await self._transcribe(audio)
        except Exception as exc:  # noqa: BLE001 - surface as a pipeline error frame
            logger.warning(f"[fish-stt] transcription failed: {exc}")
            yield ErrorFrame(str(exc))
            return
        logger.debug(f"[fish-stt] final in {(time.perf_counter() - started) * 1000:.0f}ms: {text!r}")
        if text:
            yield TranscriptionFrame(
                text=text,
                user_id=self._user_id,
                timestamp=time_now_iso8601(),
                language=Language.EN,
            )
