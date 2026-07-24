# Vivid multimodal dependencies

| Component | Source | Runtime | Status |
| --- | --- | --- | --- |
| Async text-to-speech | Async Voice WebSocket / streaming API | Server | Integrated. Uses server-only `ASYNC_API_KEY`, raw PCM, and Max voice ID. |
| Async speech-to-text | Async Voice STT WebSocket | Server | Integrated as a guarded live-call path with the existing local pipeline retained as recovery. |
| Browser capture | `getUserMedia` / `getDisplayMedia` | Browser | Integrated for local, permission-gated preview and lifecycle cleanup. |
| Existing voice pipeline | Project voice worker client | Local server/browser | Retained as STT recovery when the Async STT stream cannot be opened. |

## Reference study

| Repository | Commit | Concept used | Included in production |
| --- | --- | --- | --- |
| `katipally/openlive` | `d47a67319577d4b7c054278769274b3ad6571c93` | Thick-client voice-loop concepts: warm workers, turn cancellation, sentence/phrase streaming, and strict lifecycle cleanup. | No. The ignored `_reference/openlive` copy is study material only; no OpenLive UI, branding, or frontend code is used. |

The requested heavyweight local vision models are not bundled. A functional object-recognition/OCR implementation requires a downloaded vision model or a configured vision provider; the current configured LLM is text-only, and this project deliberately does not fabricate visual observations in its absence.
