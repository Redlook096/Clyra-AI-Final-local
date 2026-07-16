# Voice TTS Quality Gate

Date: 15 July 2026

## Product Decision

All product speech uses the official
[Resemble AI Chatterbox](https://github.com/resemble-ai/chatterbox) repository.
`ChatterboxTurboTTS` is the English conversational engine for live calls,
Would You Rather narration, and Fake Text Story participants. The model is
loaded once by the voice worker and reused across sessions. Creator routes proxy
that worker instead of loading a second model or spawning a Python process per
line.

Browser `speechSynthesis` is not presented as Chatterbox. A degraded browser
fallback can only be enabled explicitly with `VOICE_TTS_ALLOW_FALLBACK=true`.

## Local Validation State

This checkout pins official Chatterbox commit
`65b18437192794391a0308a8f705b1e33e633948`. On the Intel macOS development
host, the repository's pinned PyTorch 2.6 wheel is unavailable, so the isolated
`.venv-voice311` compatibility environment uses PyTorch and torchaudio 2.2.2.
The following import has been verified:

```python
from chatterbox.tts_turbo import ChatterboxTurboTTS
```

The model weights have not yet been warmed and a Chatterbox audio benchmark has
not yet been completed on this host. No latency, RAM, listening-test, or
naturalness result is claimed until `tools/benchmark-voice.py` completes with
the model loaded. The old Kokoro measurements are historical baseline data and
must not be used as current Chatterbox results.

## Shared Runtime

```text
OpenAI-compatible LLM token stream
  -> deterministic spoken-text normalization
  -> semantic phrase segmenter (8-28 useful words)
  -> bounded persistent Chatterbox-Turbo worker
  -> PCM16 phrase frames with generation metadata
  -> monotonic Web Audio scheduling
```

The next phrase can synthesize while the current phrase plays. Barge-in
increments the response generation, clears queued browser audio, cancels the
pending phrase, and rejects stale audio packets. Every creator line carries its
selected participant voice to the same worker.

## Acceptance Benchmark

Use the same legal 8-12 second consented reference and sentence set for every
run. Measure:

- model cold start and warm idle RSS
- first audio and total synthesis latency
- real-time factor
- CPU and GPU use
- peak RSS after repeated turns and interruptions
- pronunciation, warmth, pacing, expressiveness, consistency, and artifacts
- clicks, gaps, duplicated phrases, and stale playback after barge-in

Production acceptance still requires blind listening scores from multiple
people. Import success alone is not a voice-quality benchmark.

## Configuration

```bash
VOICE_TTS_ENGINE=chatterbox-turbo
VOICE_TTS_VOICE=Ryan
VOICE_TTS_REFERENCE=/absolute/path/to/consented-reference.wav
VOICE_TTS_ALLOW_FALLBACK=false
VOICE_TTS_SAMPLE_RATE=24000
VOICE_TTS_FLUSH_MS=120
VOICE_TTS_TIMEOUT_MS=30000
```

Run `tools/setup-voice.sh` once, then start the normal development command. No
second LLM provider or paid TTS API is used.
