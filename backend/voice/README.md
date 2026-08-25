# Clyra Voice Calling — Pipecat + WebRTC

## Architecture

```
Browser mic (WebRTC)
  → POST /voice/offer (Node)         builds system prompt + history
    → POST /api/offer (Python)       Pipecat SmallWebRTCTransport SDP answer
        VAD/turn detection (Silero)
        Fish Audio STT (/v1/asr)     -- final per utterance, rolling partials
    ← Pipecat pipeline: STT → LLM → TTS, with real barge-in/interruption
  → DeepSeek (OpenAI-compatible) LLM -- or the in-process Test Mode echo route
  → Fish Audio TTS (streaming, wss://api.fish.audio/v1/tts/live)
  → Browser speaker (WebRTC)
```

Pipecat's `PipelineTask(enable_rtvi=True)` emits connection/listening/
thinking/speaking/transcript events over the WebRTC data channel; the
frontend consumes them via `@pipecat-ai/client-react`.

**LLM rule:** DeepSeek is the only LLM provider, same key/model as the rest
of the app. **Test Mode** (a UI toggle, off by default) replaces the
DeepSeek call with an in-process loopback route
([echo_llm.py](../../backend/voice-pipeline/echo_llm.py)) that streams back
exactly what Fish STT heard — every other stage (WebRTC, VAD, Fish STT, Fish
TTS, barge-in) still runs for real. It exists so voice-call development
doesn't spend DeepSeek credits.

## Folder structure

```
backend/voice/                 # Node: sessions, system prompt, SDP proxy
  config.ts
  routes.ts                    # POST /voice/session, /voice/offer, /voice/end
  session/voice-session-manager.ts
  metrics/voice-metrics.ts
backend/voice-pipeline/        # Python: the actual Pipecat pipeline
  main.py                      # FastAPI: POST /api/offer, GET /health
  bot.py                       # builds the pipeline per connection
  fish_stt.py                  # FishASRSTTService (SegmentedSTTService)
  echo_llm.py                  # Test Mode's in-process OpenAI-compatible route
  config.py
docker/docker-compose.voice.yml
requirements-voice.txt
```

## Environment

```env
FISH_AUDIO_API_KEY=
FISH_TTS_REFERENCE_ID=       # Fish voice id
FISH_TTS_MODEL=              # e.g. s1 / s2-pro
DEEPSEEK_API_KEY=            # existing chat key, reused as-is
VOICE_SAMPLE_RATE=16000
VOICE_PIPELINE_URL=http://127.0.0.1:8787
```

## Local run

```bash
tools/setup-voice.sh            # once, builds .venv-voice311
npm run dev:source              # starts Node + auto-spawns the voice worker
```

Or run the worker by hand:

```bash
.venv-voice311/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8787
# (cwd: backend/voice-pipeline)
```

## Tests

```bash
.venv-voice311/bin/python backend/voice-pipeline/test_pipeline_unit.py
node tools/voice-call-webrtc-e2e.mjs   # full WebRTC E2E, Test Mode on
```
