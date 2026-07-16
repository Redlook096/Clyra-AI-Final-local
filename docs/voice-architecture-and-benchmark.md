# Voice Architecture and Validation

Date: 15 July 2026. Development host: Intel MacBook Pro, four-core i7, 16 GB
RAM. This is not the final 8 GB acceptance machine.

## Why the Previous Voice Sounded Robotic

1. The Python worker could be unavailable while the product silently used
   browser speech synthesis.
2. Very short token fragments restarted pitch and sentence prosody.
3. PCM crossed the app as repeated base64 JSON chunks and separate playback
   sources, making joins audible.
4. Creator narration and live calls used different engines and voices.
5. Mute stopped recognition without always releasing microphone tracks.

## Selected Engine

The selected engine is official
[Chatterbox-Turbo](https://github.com/resemble-ai/chatterbox), using
`ChatterboxTurboTTS`. It is the sole neural TTS path for voice calls, Fake Text
Story, and Would You Rather. One warm model instance, one conditioning cache,
and a bounded inference queue are shared by all sessions.

The repository comparison that led to the earlier architecture remains useful,
but no unused model is installed as an active product path:

| Engine | Role after this change | Reason |
| --- | --- | --- |
| Chatterbox-Turbo | Selected shared engine | English conversational quality, reference conditioning, compact Turbo model |
| Qwen3-TTS 0.6B | Not active | Would duplicate a heavier creator runtime |
| CosyVoice 3 0.5B | Not active | No local quality result justifies a second framework |
| MOSS-TTS-Nano | Not active | Candidate only if a measured low-resource profile is later required |
| Kokoro/Piper | Removed from active path | Avoid inconsistent voices and silent quality downgrade |

## Runtime Pipeline

```text
Browser microphone
  -> WebSocket PCM16
  -> endpointing and Faster-Whisper transcription
  -> existing OpenAI-compatible LLM stream
  -> spoken-text normalization
  -> semantic phrase buffer
  -> persistent Chatterbox-Turbo inference
  -> binary PCM transport with response and generation IDs
  -> scheduled Web Audio playback
```

Phrases target 8-28 useful words and flush after stable punctuation or a short
timeout. Playback uses one monotonic timeline. Barge-in clears scheduled audio,
cancels pending work, and discards packets from older generations.

## Voice Conditioning

Use a legal, consented 8-12 second conversational reference with one speaker,
no music, clipping, long silence, or strong room reverb. Configure it with
`VOICE_TTS_REFERENCE`. The persistent runtime caches conditioning rather than
re-encoding the same reference for every phrase.

## Verified Locally

- official Chatterbox source is pinned by `tools/setup-voice.sh`
- `ChatterboxTurboTTS` imports in `.venv-voice311`
- live and creator routes target the same persistent worker
- fallback is explicit and defaults off
- phrase queues and creator requests carry a selected voice

The model weights have not yet been warmed on this Intel host. Therefore this
document does not claim Chatterbox first-audio, RTF, RAM, or listening scores.
Run the benchmark on the target hardware before using the requested latency and
8 GB limits as accepted measurements.

## Production Configuration

```bash
VOICE_TTS_ENGINE=chatterbox-turbo
VOICE_TTS_VOICE=Ryan
VOICE_TTS_REFERENCE=/absolute/path/to/consented-reference.wav
VOICE_TTS_ALLOW_FALLBACK=false
VOICE_TTS_SAMPLE_RATE=24000
VOICE_TTS_FLUSH_MS=120
VOICE_BARGE_HOLD_MS=700
VOICE_TTS_TIMEOUT_MS=30000
```

No API key is sent to the voice worker or browser. The existing server-side LLM
configuration remains unchanged.
