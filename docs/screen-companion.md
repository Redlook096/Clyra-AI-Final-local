# Screen Companion (OpenCluely UI + Clyra stack)

Clyra re-clones [OpenCluely](https://github.com/TechyCSR/OpenCluely) (MIT) as a **reference** under `references/OpenCluely` and ports its **original dark glass overlay UI** as a general desktop helper — not an interview stealth tool.

```bash
bash scripts/clone-opencluely.sh
```

## What we keep from OpenCluely

| Idea | Destination |
| --- | --- |
| Original dark glass command tab + chat panel | `electron/companion.html`, web `ScreenCompanionWorkspace` |
| Main-process screen capture API shape | `electron/screen-capture.mjs` |
| Floating always-on-top overlay | `electron/companion-manager.mjs` |
| Session “see screen → ask AI” loop | Companion + `/api/companion/*` + Talk mode (STT/TTS) |

## What we reject (kept out)

- Stealth / content-protection / screen-share invisibility
- Interview disguise process names
- Gemini/Azure/Whisper installer stack (Clyra already has STT/TTS + RapidOCR + existing AI models)

## Stack

- **Talk:** Clyra voice STT/TTS + `/api/companion/ask`
- **See:** RapidOCR ONNX + Pillow (`tools/companion-vision.py`) — open source, 8GB-safe. Optional `VISION_*` multimodal refine.
- **Guide:** Visible AI cursor points at OCR targets **without** moving the OS mouse or clicking (`desktop.point` / guide-only mode)
- **Take control:** `electron/desktop-control.mjs` (xdotool on Linux) + Atlas-style Take control / Resume AI / Stop bar

## Modes

1. **Observe** — see screen + answer questions  
2. **Guide** — blue pulsing pointer shows where to click while you remain in control  
3. **Control** — AI moves/clicks the OS cursor until you Take control or Stop  

## Shortcuts

- `⌘⇧J` / `Ctrl+Shift+J` — toggle Companion overlay (Electron)

## Web preview

`/?embedTool=companion` opens the React OpenCluely-style shell. Real capture + OS control require Electron.

## Tests

```bash
npm run test:companion              # RapidOCR + /api/companion/*
npm run test:companion:electron     # Overlay + guide pointer + control screenshots
```

Artifacts land in `/opt/cursor/artifacts/companion-*.jpg` and `companion-smoke.json`.
