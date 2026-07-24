"""Voice pipeline configuration."""

from __future__ import annotations

import os


def env_str(key: str, default: str) -> str:
    return os.getenv(key, default)


def env_int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, str(default)))
    except ValueError:
        return default


def env_float(key: str, default: float) -> float:
    try:
        return float(os.getenv(key, str(default)))
    except ValueError:
        return default


SAMPLE_RATE = env_int("VOICE_SAMPLE_RATE", 16000)
# distil-large-v3 for production accuracy/speed; tiny.en is the call-fluent local CPU default.
STT_MODEL = env_str("VOICE_STT_MODEL", "tiny.en")
STT_DEVICE = env_str("VOICE_WHISPER_DEVICE", "cpu")
STT_COMPUTE = env_str("VOICE_WHISPER_COMPUTE", "int8")
# Measured: threads=1 ~756ms, threads=2 ~585ms, threads=4 ~437ms on tiny.en.
# Default 4 for call speed; set VOICE_WHISPER_CPU_THREADS=2 if the host is CPU-contended.
STT_CPU_THREADS = env_int("VOICE_WHISPER_CPU_THREADS", 4)
STT_LANGUAGE = env_str("VOICE_STT_LANGUAGE", "en")
STT_BEAM_SIZE = env_int("VOICE_STT_BEAM_SIZE", 1)
STT_WINDOW_MS = env_int("VOICE_STT_WINDOW_MS", 800)
STT_STEP_MS = env_int("VOICE_STT_STEP_MS", 480)
STT_OVERLAP_MS = env_int("VOICE_STT_OVERLAP_MS", 280)
STT_MIN_COMMIT_MS = env_int("VOICE_STT_MIN_COMMIT_MS", 400)
# Shorter endpoint — speculative decode overlaps the wait (profiled).
ENDPOINT_SILENCE_MS = env_int("VOICE_ENDPOINT_SILENCE_MS", 300)
# Kick off Whisper as soon as silence starts so endpoint wait ≠ added latency.
SPECULATIVE_DECODE_MS = env_int("VOICE_SPECULATIVE_DECODE_MS", 140)
# Keep a short pre-roll before VAD speech onset so Whisper hears word starts
# (without this, tiny.en often turns "Hi, how…" into "I have…").
STT_PREROLL_MS = env_int("VOICE_STT_PREROLL_MS", 200)
# Mid-stream partials are expensive on CPU; off by default for call-fluent latency.
STT_PARTIALS_ENABLED = env_str("VOICE_STT_PARTIALS", "0").lower() in (
    "1",
    "true",
    "yes",
    "on",
)
VAD_THRESHOLD = env_float("VOICE_VAD_THRESHOLD", 0.45)
VAD_MIN_SPEECH_MS = env_int("VOICE_VAD_MIN_SPEECH_MS", 140)
# Continuous user speech required before interrupting assistant TTS (noise immunity).
BARGE_HOLD_MS = env_int("VOICE_BARGE_HOLD_MS", 700)
TTS_VOICE = env_str("VOICE_TTS_VOICE", "Ryan")
# Every product surface uses the same persistent Chatterbox-Turbo runtime.
# Unsupported hosts may opt into a clearly reported fallback.
TTS_ENGINE = env_str("VOICE_TTS_ENGINE", "chatterbox-turbo")
# Match capture/playback rate to avoid pitch/pop artifacts from resampling mismatch.
TTS_SAMPLE_RATE = env_int("VOICE_TTS_SAMPLE_RATE", 24000)
TTS_QUALITY_MODE = env_str("VOICE_TTS_QUALITY_MODE", "natural")  # natural | fast
TTS_KOKORO_SPEED = env_float(
    "VOICE_TTS_KOKORO_SPEED",
    0.92 if TTS_QUALITY_MODE == "natural" else 1.05,
)
TTS_CHUNK_MS = env_float("VOICE_TTS_CHUNK_MS", 160.0 if TTS_QUALITY_MODE == "natural" else 100.0)
TTS_FADE_MS = env_float("VOICE_TTS_FADE_MS", 12.0)
PIPELINE_PORT = env_int("VOICE_PIPELINE_PORT", 8787)
