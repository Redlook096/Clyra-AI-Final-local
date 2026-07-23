# Clyra Voice Calling — Ultra-Low-Latency Pipeline

## Architecture

```
Browser mic (PCM16)
  → WebSocket /voice/stream (Node gateway)
    → Voice pipeline WS /stream (Python)
        VAD (Silero | energy)
        Streaming STT (Faster-Whisper + local-agreement)
    ← partial / final transcripts
  → Existing OpenAI-compatible LLM API (DeepSeek / configured provider)
    → semantic phrase streaming through one persistent Chatterbox-Turbo worker
  → Browser speaker (PCM chunks)
```

**LLM rule:** The voice stack reuses the app’s existing OpenAI-compatible LLM. No second LLM provider.

## Repo selection

| Layer | Choice | Why |
|---|---|---|
| STT engine | [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper) | 4× faster than openai/whisper, low memory |
| Streaming policy | [whisper_streaming](https://github.com/ufal/whisper_streaming)-style local agreement | Partials, overlap windows, endpointing — not batch loops |
| Model default | `distil-large-v3` ([Distil-Whisper](https://huggingface.co/distil-whisper)) | ~6× speedup, strong English accuracy |
| Alt quality | `large-v3-turbo` / `small.en` | Env-selectable quality/latency tradeoff |
| VAD | [Silero VAD](https://github.com/snakers4/silero-vad) | Fast speech gating; energy fallback offline |
| TTS | [Chatterbox-Turbo](https://github.com/resemble-ai/chatterbox) | Shared human-realism engine for calls and creator narration |
| Degraded mode | Explicit browser fallback only | Disabled by default; never mislabeled as Chatterbox |
| Live patterns | [WhisperLive](https://github.com/collabora/WhisperLive) concepts | Browser mic + nearly-live server pattern |

## Folder structure

```
backend/voice/                 # Node gateway (sessions, LLM, WS protocol)
  pipeline/client.ts           # Python pipeline client
  websocket/voice-stream-handler.ts
backend/voice-pipeline/        # Python streaming worker
  main.py                      # FastAPI HTTP + WS /stream
  stt_stream.py                # Streaming Faster-Whisper
  vad.py
  tts_stream.py
  config.py
docker/docker-compose.voice.yml
requirements-voice.txt
```

## Protocol

Client → Node:
- `audio` `{ codec:"pcm16", data, seq }`
- `utterance` `{ text }` (browser STT fallback)
- `mute` `{ muted }`
- `barge_in`
- `ping`

Node → Client:
- `ready`, `pipeline_mode` `{ mode:"pipeline"|"browser" }`
- `status`, `transcript_partial`, `transcript_final`
- `llm_token`, `llm_done`, `tts_chunk`, `tts_done`, `error`

## Latency strategy

1. VAD gates STT so silence isn’t decoded
2. Overlapping short windows emit partials early
3. Endpoint ~420ms silence → final transcript
4. LLM streams tokens immediately
5. First speakable sentence → TTS immediately (don’t wait for full answer)
6. Barge-in aborts LLM + TTS without killing the session

## Environment

```env
VOICE_ENABLED=true
VOICE_PIPELINE_URL=http://127.0.0.1:8787
VOICE_STT_MODEL=distil-large-v3
VOICE_STT_LANGUAGE=en
VOICE_WHISPER_DEVICE=cpu
VOICE_WHISPER_COMPUTE=int8
VOICE_TTS_VOICE=Ryan
VOICE_TTS_ENGINE=chatterbox-turbo
VOICE_TTS_REFERENCE=/absolute/path/to/consented-voice-reference.wav
VOICE_TTS_ALLOW_FALLBACK=false
VOICE_SAMPLE_RATE=16000
VOICE_ENDPOINT_SILENCE_MS=420
VOICE_TTS_TIMEOUT_MS=3500
```

## Local run

```bash
# App
npm run dev:source

# Pipeline
python3 -m venv .venv-voice
source .venv-voice/bin/activate
pip install -r requirements-voice.txt
cd backend/voice-pipeline && python main.py
```

## Docker

```bash
docker compose -f docker/docker-compose.voice.yml up --build
```

## Tests

```bash
cd backend/voice-pipeline && python test_pipeline_unit.py

# Full voice-call emulation (Wallace fixture → STT → LLM → TTS)
# Prefers http://127.0.0.1:31415 (desktop), then :3000, or CLYRA_VOICE_BASE_URL.
npm run test:voice-e2e
# Dictation-only STT path (same audio / protocol)
npm run test:voice-e2e:dictation
# Or:
#   node tools/voice-call-e2e.mjs
#   node tools/voice-call-e2e.mjs --dictation
# Artifacts land in tmp/voice-bench/e2e-*/
```

## Fallback

| Failure | Behavior |
|---|---|
| Pipeline down | `pipeline_mode=browser` → Web Speech STT + speechSynthesis |
| Chatterbox unavailable | Report unavailable; browser fallback only when explicitly enabled |
| Silero missing | Energy VAD |
| TTS timeout | Client progressive speechSynthesis |
