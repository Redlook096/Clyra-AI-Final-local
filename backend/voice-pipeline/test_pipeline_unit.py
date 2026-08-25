"""Fast, no-network unit checks for the voice worker's own code (not Fish/
DeepSeek, which need real credentials -- see tools/voice-call-webrtc-e2e.mjs
for the end-to-end check against a live server).

Run: .venv-voice311/bin/python backend/voice-pipeline/test_pipeline_unit.py
"""

from __future__ import annotations

import json
import sys
import wave

from fastapi.testclient import TestClient

from config import load_config
from fish_stt import _pcm_to_wav
from main import app


def test_config_defaults(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("FISH_AUDIO_API_KEY", raising=False)
    config = load_config()
    assert config.port == 8787
    assert config.sample_rate == 16000
    assert config.fish_api_key == ""


def test_pcm_to_wav_roundtrip():
    pcm = (b"\x00\x01" * 100) * 2  # arbitrary 16-bit samples
    wav_bytes = _pcm_to_wav(pcm, 16000)
    import io

    with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
        assert wav.getframerate() == 16000
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.readframes(wav.getnframes()) == pcm


def test_health_endpoint():
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["architecture"]["stt"] == "fish-audio"


def test_echo_route_streams_back_last_user_message():
    client = TestClient(app)
    with client.stream(
        "POST",
        "/echo/v1/chat/completions",
        json={
            "model": "echo-1",
            "messages": [{"role": "user", "content": "testing one two three"}],
            "stream": True,
        },
    ) as resp:
        assert resp.status_code == 200
        text = ""
        for line in resp.iter_lines():
            if not line.startswith("data: ") or line.strip() == "data: [DONE]":
                continue
            payload = json.loads(line[len("data: ") :])
            delta = payload["choices"][0]["delta"].get("content")
            if delta:
                text += delta
    assert text == "testing one two three"


if __name__ == "__main__":

    class _FakeMonkeypatch:
        def delenv(self, key, raising=False):
            import os

            os.environ.pop(key, None)

    failures = 0
    for name, fn in [
        ("test_config_defaults", lambda: test_config_defaults(_FakeMonkeypatch())),
        ("test_pcm_to_wav_roundtrip", test_pcm_to_wav_roundtrip),
        ("test_health_endpoint", test_health_endpoint),
        ("test_echo_route_streams_back_last_user_message", test_echo_route_streams_back_last_user_message),
    ]:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL {name}: {exc}")

    sys.exit(1 if failures else 0)
