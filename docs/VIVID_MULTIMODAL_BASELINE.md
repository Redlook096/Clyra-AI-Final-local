# Vivid multimodal baseline

Recorded 2026-07-20 from the local development workspace. Values below are observations, not estimates.

| Check | Result | Notes |
| --- | --- | --- |
| Framework | React 19 + Vite + Express | `server.ts` hosts the local app and call WebSocket. |
| Package manager | npm | Project scripts are declared in `package.json`. |
| Voice transport | Local WebSocket | Browser PCM is sent to `/voice/stream`; response PCM is played through one browser `AudioContext`. |
| LLM stream | Existing server-side SSE bridge | Keeps existing chat history and system prompt. |
| TTS configuration | Async Flash, Max | Backend-only environment configuration; browser does not receive the key. |
| Creator TTS health | Passed | `GET /api/creator/tts/health` returned Async model and Max. |
| Live Async Flash request | Passed | A short local request returned a 44.1 kHz PCM WAV response using Max. |
| TypeScript | Passed | `npm run lint`. |
| Creator tests | Passed | 60 assertions. |
| Voice tests | Passed | 15 assertions. |

No microphone, camera, screen-share, upstream TTS latency, FPS, CPU, memory, or interruption timing values are recorded here because the automated environment did not have an interactive device-permission session. Reporting those as measurements would be misleading.
