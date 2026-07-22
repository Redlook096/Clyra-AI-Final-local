"""Unit tests for voice pipeline helpers (no model download required)."""

from __future__ import annotations

import struct
import sys
from concurrent.futures import Future
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "voice-pipeline"))

from stt_stream import StreamingTranscriber, pcm16_bytes_to_f32  # noqa: E402
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


def test_finalize_reuses_speculative_decode_after_trailing_silence():
    """Silence after speech must not turn one Whisper pass into two."""
    import numpy as np

    events = []
    transcriber = StreamingTranscriber(on_event=events.append)
    transcriber._buffer = np.zeros(16000, dtype=np.float32)
    transcriber._speech_ms = 620.0
    transcriber._spec_speech_ms = 620.0
    transcriber._spec_gen = 4
    transcriber._spec_buf_len = 12000
    future = Future()
    future.set_result((4, "Ready for the next task.", 0.91, "en", 42.0))
    transcriber._spec_future = future

    def should_not_decode(_audio):
        raise AssertionError("trailing silence should reuse the speculative decode")

    transcriber._transcribe_window = should_not_decode  # type: ignore[method-assign]
    transcriber._finalize()
    assert events and events[0]["type"] == "final"
    assert events[0]["text"] == "Ready for the next task."


if __name__ == "__main__":
    test_pcm_roundtrip_silence()
    test_energy_vad_detects_tone()
    test_speakable_units_split()
    test_tts_runtime_has_one_engine_path()
    test_finalize_reuses_speculative_decode_after_trailing_silence()
    print("voice pipeline unit tests passed (5 checks)")
