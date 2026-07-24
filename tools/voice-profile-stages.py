#!/usr/bin/env python3
"""Profile voice pipeline stages on Wallace Cl 2 — measure before optimizing."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "voice-pipeline"))
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("VOICE_STT_MODEL", "tiny.en")

import numpy as np

PCM_PATH = ROOT / "tmp" / "voice-bench" / "wallace-cl-2.pcm"
OUT_PATH = ROOT / "tmp" / "voice-bench" / "profile-stages.json"


def load_pcm(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def main() -> None:
    import config
    from stt_stream import StreamingTranscriber
    from tts_stream import synthesize_streaming
    from vad import VoiceActivityDetector

    audio = load_pcm(PCM_PATH)
    sr = 16000
    report: dict = {
        "audio": str(PCM_PATH.relative_to(ROOT)),
        "duration_ms": round(1000.0 * audio.size / sr, 1),
        "stages": {},
        "choices": {},
    }

    # --- VAD backends ---
    for backend in ("energy", "silero"):
        os.environ["VOICE_VAD_BACKEND"] = backend
        # Force reload
        import importlib
        import vad as vad_mod

        importlib.reload(vad_mod)
        vad = vad_mod.VoiceActivityDetector(sample_rate=sr)
        frame = int(sr * 0.04)
        t0 = time.perf_counter()
        speech_frames = 0
        scores = []
        for i in range(0, audio.size, frame):
            chunk = audio[i : i + frame]
            if chunk.size < frame // 2:
                break
            r = vad.score(chunk)
            scores.append(r.probability)
            if r.is_speech:
                speech_frames += 1
        ms = (time.perf_counter() - t0) * 1000
        report["stages"][f"vad_{vad.backend}"] = {
            "wall_ms": round(ms, 1),
            "per_frame_ms": round(ms / max(1, len(scores)), 3),
            "speech_frames": speech_frames,
            "mean_prob": round(float(np.mean(scores)) if scores else 0, 4),
        }

    os.environ["VOICE_VAD_BACKEND"] = "energy"

    # --- STT cold vs warm decode ---
    tr = StreamingTranscriber(sample_rate=sr, model_name=config.STT_MODEL)
    t0 = time.perf_counter()
    tr.ensure_model()
    report["stages"]["stt_model_load_ms"] = round((time.perf_counter() - t0) * 1000, 1)

    # Full-file decode (upper bound)
    t0 = time.perf_counter()
    text, conf, _ = tr._transcribe_window(audio)
    report["stages"]["stt_full_file_decode"] = {
        "ms": round((time.perf_counter() - t0) * 1000, 1),
        "text": text,
        "confidence": round(conf, 3),
    }

    # Warm repeat
    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        text2, conf2, _ = tr._transcribe_window(audio)
        times.append((time.perf_counter() - t0) * 1000)
    report["stages"]["stt_warm_decode"] = {
        "ms_avg": round(float(np.mean(times)), 1),
        "ms_min": round(float(np.min(times)), 1),
        "text": text2,
    }

    # Streaming push simulation with energy VAD
    import importlib
    import vad as vad_mod

    importlib.reload(vad_mod)
    vad = vad_mod.VoiceActivityDetector(sample_rate=sr)
    events = []
    tr2 = StreamingTranscriber(
        sample_rate=sr,
        model_name=config.STT_MODEL,
        on_event=lambda e: events.append((time.perf_counter(), e)),
    )
    tr2.ensure_model()
    frame = int(sr * 0.04)
    t_start = time.perf_counter()
    audio_end_t = None
    for i in range(0, audio.size, frame):
        chunk = audio[i : i + frame]
        if chunk.size == 0:
            break
        pcm = (np.clip(chunk, -1, 1) * 32767).astype(np.int16).tobytes()
        r = vad.score(chunk)
        tr2.push_audio(pcm, r.is_speech, r.probability)
        # Simulate realtime end
    audio_end_t = time.perf_counter()
    # Trailing silence
    silence = np.zeros(frame, dtype=np.float32)
    sil_pcm = (silence * 0).astype(np.int16).tobytes()
    for _ in range(20):
        r = vad.score(silence)
        tr2.push_audio(sil_pcm, False, r.probability)
    finals = [(t, e) for t, e in events if e.get("type") == "final"]
    report["stages"]["stt_streaming_sim"] = {
        "push_wall_ms": round((audio_end_t - t_start) * 1000, 1),
        "final_count": len(finals),
        "final_text": finals[-1][1].get("text") if finals else None,
        "final_decode_ms": finals[-1][1].get("ms") if finals else None,
        "audio_end_to_final_ms": round((finals[-1][0] - audio_end_t) * 1000, 1)
        if finals
        else None,
    }

    # --- TTS engines ---
    phrase = "Hi! I'm doing great, thanks for asking."
    for engine in ("auto", "macos", "sine"):
        if engine == "sine":
            os.environ["VOICE_ALLOW_SINE"] = "1"
        if engine == "macos":
            os.environ["VOICE_USE_MACOS_SAY"] = "1"
        else:
            os.environ.pop("VOICE_USE_MACOS_SAY", None)
        t0 = time.perf_counter()
        chunks = synthesize_streaming(phrase, engine=engine if engine != "auto" else "auto")
        ms = (time.perf_counter() - t0) * 1000
        report["stages"][f"tts_{engine}"] = {
            "ms": round(ms, 1),
            "chunks": len(chunks),
            "bytes": sum(len(c) for c in chunks),
        }
        os.environ.pop("VOICE_ALLOW_SINE", None)
        os.environ.pop("VOICE_USE_MACOS_SAY", None)

    # Recommendations from measurements
    stt_ms = report["stages"]["stt_warm_decode"]["ms_avg"]
    endpoint = config.ENDPOINT_SILENCE_MS
    report["bottlenecks"] = {
        "stt_decode_ms": stt_ms,
        "endpoint_silence_ms": endpoint,
        "estimated_speech_end_to_stt_final_ms": endpoint + stt_ms,
        "note": "LLM first-token dominates e2e when >500ms; start LLM earlier on stable text.",
    }
    report["choices"] = {
        "keep_faster_whisper": True,
        "reason_stt": f"warm decode ~{stt_ms}ms on tiny.en; replacing engine unlikely to beat this on CPU",
        "vad_pick": "energy"
        if report["stages"].get("vad_energy", {}).get("per_frame_ms", 99)
        <= report["stages"].get("vad_silero", {}).get("per_frame_ms", 99)
        else "silero",
        "tts_pick": "browser speechSynthesis (0 server ms) over macos say"
        if report["stages"].get("tts_macos", {}).get("ms", 0) > 400
        else "macos",
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print(f"\nwrote {OUT_PATH}")


if __name__ == "__main__":
    main()
