# OpenCluely Port Map

Reference clone: `references/OpenCluely` ← https://github.com/TechyCSR/OpenCluely.git (MIT)

| Donor capability | Donor path | Clyra destination | Decision |
| --- | --- | --- | --- |
| Glass command tab + chat UI | `index.html`, `chat.html`, `llm-response.html` | `electron/companion.html` + `ScreenCompanionWorkspace.tsx` | Keep visual language; rebrand to Clyra Companion |
| Screen enumeration / PNG capture | `src/services/capture.service.js` | `electron/screen-capture.mjs` | Adapt API shape; explicit capture + receipts |
| Floating windows | `src/managers/window.manager.js` | `electron/companion-manager.mjs` | Overlay only; no stealth |
| Session history bounds | `src/managers/session.manager.js` | Companion chat log | Retention ideas only |
| Desktop shortcuts | `main.js` | `⌘⇧J` in `electron/main.mjs` | Disclosed productivity shortcut |
| Gemini image analysis | LLM service | RapidOCR ONNX + optional `VISION_*` | Open-source local vision first |
| Stealth / share evasion | `main.js`, window manager | None | Rejected |
| Guide / teach pointer | (new) | `desktop-control.point` + guide mode | Clyra addition: point without control |
| OS cursor control | (new) | `desktop-control.mjs` | Atlas-style take control |
