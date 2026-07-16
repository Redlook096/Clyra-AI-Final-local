"""Persistent, bounded TTS runtime for conversational voice calls.

Chatterbox-Turbo is the quality engine. The runtime loads exactly one model,
reuses it across calls, and reports a degraded fallback instead of hiding it.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np

import config


def _resample(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate or not audio.size:
        return audio.astype(np.float32, copy=False)
    target_size = max(1, round(audio.size * target_rate / source_rate))
    old = np.linspace(0.0, 1.0, num=audio.size, endpoint=False)
    new = np.linspace(0.0, 1.0, num=target_size, endpoint=False)
    return np.interp(new, old, audio).astype(np.float32)


def _pcm16_b64(audio: np.ndarray) -> str:
    pcm = np.clip(audio * 32767.0, -32768, 32767).astype("<i2", copy=False)
    return base64.b64encode(pcm.tobytes()).decode("ascii")


def _chunk_pcm(audio: np.ndarray, sample_rate: int) -> List[str]:
    if not audio.size:
        return []
    # Fade the generated phrase only at its outer edges. Never fade each
    # transport frame; that creates the pulsing cadence heard in the old path.
    fade = min(round(sample_rate * 0.012), max(1, audio.size // 10))
    clean = np.asarray(audio, dtype=np.float32).reshape(-1).copy()
    if fade > 1:
        theta = np.linspace(0.0, np.pi / 2.0, fade, dtype=np.float32)
        clean[:fade] *= np.sin(theta)
        clean[-fade:] *= np.cos(theta)
    frame = max(1, round(sample_rate * (config.TTS_CHUNK_MS / 1000.0)))
    return [_pcm16_b64(clean[index : index + frame]) for index in range(0, clean.size, frame)]


def _shape(text: str) -> str:
    clean = re.sub(r"\s+", " ", (text or "").strip())
    clean = re.sub(r"([!?])\1+", r"\1", clean)
    return clean


def _available_memory_gb() -> float:
    try:
        import psutil

        return psutil.virtual_memory().total / (1024**3)
    except Exception:
        return 0.0


def _torch_device() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


@dataclass
class RuntimeStatus:
    requested_engine: str
    active_engine: str = "unloaded"
    profile: str = "detecting"
    device: str = "cpu"
    ready: bool = False
    degraded: bool = False
    reason: str = "not warmed"
    reference: str = ""
    model_load_ms: float = 0.0
    last_synthesis_ms: float = 0.0
    last_audio_seconds: float = 0.0
    real_time_factor: float = 0.0
    queue_capacity: int = 1


class TtsRuntime:
    """One warm model and one bounded inference slot for the whole process."""

    def __init__(self) -> None:
        self._model = None
        self._model_rate = 24000
        self._lock = threading.BoundedSemaphore(1)
        self._load_lock = threading.Lock()
        self._loaded = False
        self._voice = config.TTS_VOICE
        self._reference = os.getenv("VOICE_TTS_REFERENCE", "").strip()
        self._builtin_conditionals = None
        self._voice_conditionals: Dict[str, object] = {}
        self.status = RuntimeStatus(
            requested_engine=config.TTS_ENGINE,
            device=_torch_device(),
            reference=self._reference,
        )

    def describe(self) -> dict:
        return asdict(self.status)

    def _profile(self) -> str:
        explicit = os.getenv("VOICE_HARDWARE_PROFILE", "auto").lower()
        if explicit != "auto":
            return explicit
        # Hardware changes execution speed, never the selected product voice.
        if self.status.device in ("cuda", "mps") and _available_memory_gb() >= 7.0:
            return "quality-balanced"
        return "compatibility-cpu"

    def warm(self) -> dict:
        if self._loaded:
            return self.describe()
        with self._load_lock:
            if self._loaded:
                return self.describe()
            started = time.perf_counter()
            self.status.profile = self._profile()
            requested = config.TTS_ENGINE.lower()
            if requested not in ("auto", "", "chatterbox", "chatterbox-turbo"):
                self.status.reason = f"unsupported engine '{requested}'; Clyra requires chatterbox-turbo"
            else:
                try:
                    self._load_chatterbox()
                    self.status.active_engine = "chatterbox-turbo"
                    self.status.ready = True
                    self.status.degraded = False
                    self.status.reason = "ready"
                except BaseException as exc:
                    if isinstance(exc, KeyboardInterrupt):
                        raise
                    self.status.reason = f"chatterbox-turbo: {exc}"

            self._loaded = True
            self.status.model_load_ms = round((time.perf_counter() - started) * 1000, 1)
            if not self.status.ready:
                self.status.active_engine = "unavailable"
                self.status.degraded = True
                self.status.reason = self.status.reason[-1200:]
            return self.describe()

    def _load_chatterbox(self) -> None:
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        # from_pretrained owns device placement and model eval setup.
        self._model = ChatterboxTurboTTS.from_pretrained(device=self.status.device)
        self._model_rate = int(getattr(self._model, "sr", 24000))
        self._builtin_conditionals = getattr(self._model, "conds", None)

    def _reference_for_voice(self, voice: str) -> Optional[Path]:
        slug = re.sub(r"[^A-Z0-9]+", "_", (voice or "default").upper()).strip("_")
        candidates = (
            os.getenv(f"CHATTERBOX_VOICE_{slug}_REFERENCE", "").strip(),
            os.getenv(f"VOICE_TTS_REFERENCE_{slug}", "").strip(),
            self._reference,
        )
        for candidate in candidates:
            path = Path(candidate).expanduser() if candidate else None
            if path and path.is_file():
                return path
        return None

    def _select_chatterbox_voice(self, voice: str) -> None:
        key = (voice or "default").strip().lower()
        cached = self._voice_conditionals.get(key)
        if cached is not None:
            self._model.conds = cached
            return
        reference = self._reference_for_voice(voice)
        if reference:
            self._model.prepare_conditionals(str(reference))
            self._voice_conditionals[key] = self._model.conds
        elif self._builtin_conditionals is not None:
            self._model.conds = self._builtin_conditionals

    def _temperature_for_voice(self, voice: str) -> float:
        key = (voice or "default").strip().lower()
        # Keep the two original creator voices on their proven settings.
        if key == "ryan":
            return 0.72
        if key in ("aiden", "sage"):
            return 0.78
        # Stable per-name spread so unnamed voices still sound distinct
        # when no reference wav is present.
        digest = hashlib.md5(key.encode("utf-8")).hexdigest()
        bucket = int(digest[:4], 16) % 17  # 0..16
        return round(0.68 + bucket * 0.01, 2)

    def _generate(self, text: str, voice: str) -> Tuple[np.ndarray, int]:
        engine = self.status.active_engine
        if engine == "chatterbox-turbo":
            import torch

            self._select_chatterbox_voice(voice)
            # Keep identity stable while allowing a restrained difference
            # between creator voices when no second reference exists.
            temperature = self._temperature_for_voice(voice)
            with torch.inference_mode():
                output = self._model.generate(
                    text,
                    temperature=temperature,
                    top_p=0.92,
                    repetition_penalty=1.22,
                )
            if hasattr(output, "detach"):
                output = output.detach().float().cpu().numpy()
            return np.asarray(output, dtype=np.float32).reshape(-1), self._model_rate
        return np.zeros(0, np.float32), config.TTS_SAMPLE_RATE

    def synthesize(self, text: str, sample_rate: int, voice: str = "") -> List[str]:
        clean = _shape(text)
        if not clean:
            return []
        self.warm()
        if not self.status.ready:
            return []
        if not self._lock.acquire(timeout=float(os.getenv("VOICE_TTS_QUEUE_TIMEOUT", "2.0"))):
            raise RuntimeError("TTS inference queue is full")
        try:
            started = time.perf_counter()
            audio, source_rate = self._generate(clean, voice or self._voice)
            audio = _resample(audio, source_rate, sample_rate)
            elapsed = time.perf_counter() - started
            duration = audio.size / max(1, sample_rate)
            self.status.last_synthesis_ms = round(elapsed * 1000, 1)
            self.status.last_audio_seconds = round(duration, 3)
            self.status.real_time_factor = round(elapsed / duration, 3) if duration else 0.0
            return _chunk_pcm(audio, sample_rate)
        finally:
            self._lock.release()


_runtime = TtsRuntime()


def get_tts_runtime() -> TtsRuntime:
    return _runtime


def synthesize_streaming(
    text: str,
    voice: str = config.TTS_VOICE,
    sample_rate: int = config.TTS_SAMPLE_RATE,
    engine: str = config.TTS_ENGINE,
) -> List[str]:
    # engine is retained for API compatibility; one configured model is shared
    # across every call and creator session to keep the 8GB budget bounded.
    del engine
    return _runtime.synthesize(text, sample_rate, voice)


def iter_speakable_units(text: str) -> Iterable[str]:
    words: List[str] = []
    for word in text.split():
        words.append(word)
        if len(words) >= 8 and re.search(r"[.!?…,:;]$", word):
            yield " ".join(words)
            words = []
        elif len(words) >= 28:
            yield " ".join(words)
            words = []
    if words:
        yield " ".join(words)
