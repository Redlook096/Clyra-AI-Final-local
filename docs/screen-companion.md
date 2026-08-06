# Screen Companion (OpenCluely-inspired)

Clyra ports the useful parts of [OpenCluely](https://github.com/TechyCSR/OpenCluely) (MIT) as a **general desktop helper**, not an interview stealth tool.

## What we reuse

| OpenCluely idea | Clyra destination |
| --- | --- |
| Main-process screen capture API shape | `electron/screen-capture.mjs` |
| Floating always-on-top overlay | `electron/companion-manager.mjs` + `companion.html` |
| Session “see screen → ask AI” loop | Companion + `/api/companion/*` |

## What we reject

- Stealth / content-protection / screen-share invisibility
- Interview disguise process names
- Gemini/Azure/Whisper installer stack (Clyra already has STT/TTS)

## Stack

- **Talk:** Clyra voice STT/TTS + `/api/clyra/chat` (same API as the rest of the app)
- **See:** RapidOCR ONNX + Pillow (`tools/companion-vision.py`) — lightning-fast, 8GB-RAM safe, open source. Optional `VISION_*` multimodal endpoint can refine.
- **Take control:** `electron/desktop-control.mjs` (xdotool on Linux) + Atlas-style black Take control / Resume AI / Stop bar and on-screen AI cursor (same language as AI Browser)

## Shortcuts

- `⌘⇧J` / `Ctrl+Shift+J` — toggle Companion overlay (Electron)

## Web preview

`/?embedTool=companion` opens the React shell. Real screen capture and OS control require the Electron app.

## Voice + screenshare

During a voice call, **Share screen** opens Screen Companion (Electron) or a browser display picker. Shared frames can be analysed via `/api/companion/vision-frame` (RapidOCR). Talk or Message modes both work; message mode skips TTS.

Voice turn timing is tuned for snappier STT (`VOICE_TRAILING_SILENCE_MS≈820`, barge ≈480ms) with `base.en` Whisper for accuracy on 8GB machines.

## Tests

```bash
npm run test:companion              # RapidOCR + /api/companion/*
npm run test:companion:electron     # Electron overlay capture + Atlas cursor takeover
```

Electron smoke writes `/opt/cursor/artifacts/companion-smoke.json`.
