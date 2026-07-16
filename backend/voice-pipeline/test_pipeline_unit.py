"""Unit tests for voice pipeline helpers (no model download required)."""

from __future__ import annotations

import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "voice-pipeline"))

from stt_stream import pcm16_bytes_to_f32  # noqa: E402
from tts_stream import TtsRuntime, iter_speakable_units  # noqa: E402
from vad import VoiceActivityDetector  # noqa: E402


def test_pcm_roundtrip_silence():
    frames = 1600
    pcm = b"".join(struct.pack("<h", 0) for _ in range(frames))
    audio = pcm16_bytes_to_f32(pcm)
    assert audio.shape[0] == frames
    assert float(abs(audio).max()) < 1e-6


def test_energy_vad_detects_tone():
    vad = VoiceActivityDetector(sample_rate=16000, threshold=0.3)
    import numpy as np

    t = np.linspace(0, 0.2, 3200, endpoint=False)
    speech = (0.2 * np.sin(2 * np.pi * 180 * t)).astype("float32")
    silence = np.zeros(3200, dtype="float32")
    assert vad.score(speech).probability > vad.score(silence).probability


def test_speakable_units_split():
    units = list(iter_speakable_units("Hello there, thanks for joining me in the studio today. How are you feeling about the interface we designed together?"))
    assert len(units) >= 2
    assert units[0].endswith(".")


def test_tts_runtime_has_one_engine_path():
    runtime = TtsRuntime()
    assert runtime.status.requested_engine in ("chatterbox-turbo", "chatterbox", "auto")
    assert hasattr(runtime, "_load_chatterbox")
    assert not hasattr(runtime, "_load_kokoro")
    assert not hasattr(runtime, "_load_piper")
    assert not hasattr(runtime, "_generate_macos")


if __name__ == "__main__":
    test_pcm_roundtrip_silence()
    test_energy_vad_detects_tone()
    test_speakable_units_split()
    test_tts_runtime_has_one_engine_path()
    print("voice pipeline unit tests passed (4 checks)")
