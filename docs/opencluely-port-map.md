# OpenCluely Port Map

| Donor capability | Donor path | Clyra destination | Decision |
| --- | --- | --- | --- |
| Screen enumeration and PNG capture | `src/services/capture.service.js` | New Electron main-process capture service | Adapt API shape only; add explicit capture permission and evidence receipts. |
| Session history bounds | `src/managers/session.manager.js` | Existing chat/voice persistence | Reuse retention ideas, not code. |
| Cross-platform window lifecycle | `src/managers/window.manager.js` | `electron/main.mjs` | Existing shell already owns lifecycle; selectively add only safe user-visible utility windows. |
| Desktop shortcuts | `main.js` | `electron/main.mjs` | Add only disclosed productivity shortcuts. |
| Speech coalescing | `main.js` | `backend/voice/websocket/voice-stream-handler.ts` | Existing Clyra pipeline already coalesces turns; retain and test. |
| Stealth, disguise, sharing evasion | `main.js`, window manager | None | Rejected for safety and product fit. |
| Gemini/Azure/Whisper installers | service/core modules | None | Rejected; keep existing provider and local pipeline boundaries. |
