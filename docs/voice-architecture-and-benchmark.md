# Voice Call Architecture

Date: 22 August 2026. Replaces the previous Faster-Whisper/Chatterbox +
raw-WebSocket design described in this file's earlier revisions.

## Stack

```
Browser mic (WebRTC, @pipecat-ai/client-js + small-webrtc-transport)
  -> POST /voice/offer (Node: attaches system prompt + history server-side)
    -> POST /api/offer (Python: Pipecat SmallWebRTCTransport SDP answer)
        Silero VAD / turn detection
        Fish Audio STT (/v1/asr, REST -- see below)
    <- Pipecat pipeline: STT -> LLM -> TTS, real barge-in/interruption
  -> DeepSeek (OpenAI-compatible) LLM, or the in-process Test Mode echo route
  -> Fish Audio TTS (wss://api.fish.audio/v1/tts/live, streaming)
  -> Browser speaker (WebRTC)
```

`PipelineTask(enable_rtvi=True)` emits connection/listening/thinking/
speaking/transcript events over the WebRTC data channel; the frontend
(`src/hooks/useVoiceCall.ts`) consumes them via `@pipecat-ai/client-js`
(`RTVIEvent`), not custom timers.

## Why Fish STT isn't fully streaming

Fish Audio's `/v1/asr` is a REST, non-streaming, BETA endpoint (upload
audio, get one transcript back) -- there's no live partial-transcript
stream on Fish's side, unlike its TTS (which is real streaming websocket
and is used as Pipecat's built-in `FishAudioTTSService`). `FishASRSTTService`
(`backend/voice-pipeline/fish_stt.py`) subclasses Pipecat's
`SegmentedSTTService`, which already buffers mic audio between VAD
start/stop and calls the REST endpoint once per utterance for a fast
**final** transcript. It also polls the growing buffer every ~700ms while
VAD reports ongoing speech to approximate a live **partial** caption. This
is a deliberate trade-off documented here, not a fabricated feature.

## Test Mode

A persisted, off-by-default UI setting (Settings -> Voice). When on, the
LLM stage is a loopback route served by the same Python process
(`backend/voice-pipeline/echo_llm.py`) that streams back exactly what Fish
STT heard, in the real OpenAI streaming chunk format `OpenAILLMService`
expects -- so every other stage (WebRTC, VAD, Fish STT, Fish TTS, barge-in,
turn management) still runs for real, but DeepSeek is never called. Exists
so voice-call development and testing doesn't spend DeepSeek credits.

## Environment

```env
FISH_AUDIO_API_KEY=
FISH_TTS_REFERENCE_ID=
FISH_TTS_MODEL=s1
DEEPSEEK_API_KEY=            # existing chat key, reused as-is
VOICE_SAMPLE_RATE=16000
VOICE_PIPELINE_URL=http://127.0.0.1:8787
```

## Dictation is separate

Cmd+Shift+K global dictation and the composer's mic button never needed an
LLM or TTS turn, so they kept their own small WS bridge to Fish's REST ASR
(`backend/voice/websocket/dictation-stream.ts`) instead of going through
the Pipecat pipeline above.

## Verified

- Real `@pipecat-ai/client-js` browser client connects through the full
  stack: WebRTC ICE, RTVI `client-ready` handshake, pipeline start --
  confirmed via `backend/voice-pipeline` server logs during manual and
  Playwright-driven browser testing.
- A standalone `aiortc` peer-connection script exercises `/api/offer`
  directly (SDP offer/answer, `connectionState: connected`) without the
  browser, isolating the Python worker's WebRTC handling.
- `backend/voice-pipeline/test_pipeline_unit.py` covers config defaults,
  the PCM->WAV helper, `/health`, and the Test Mode echo route's streaming
  format against the real `openai` client.
- `tools/voice-call-webrtc-e2e.mjs` drives the actual app UI in a real
  Chromium (Playwright) with a fake mic device and asserts the call reaches
  Listening and ends cleanly.

## Not yet verified in this environment

Real Fish Audio STT/TTS behavior, barge-in-mid-sentence, a 10-minute soak,
and reconnect-after-network-loss all need a real `FISH_AUDIO_API_KEY` (and
ideally a recorded speech fixture at `tmp/voice-bench/wallace-cl-2.wav`) --
this development machine doesn't have one configured. `tools/
voice-call-webrtc-e2e.mjs` is built to exercise all of this once a key is
set; without one, Fish's TTS websocket rejects the connection with HTTP 401
and the pipeline reports that as a non-fatal `ErrorFrame`, which is exactly
what was observed while building this.
