# OpenCluely (fresh Electron) + Clyra + local vision

## Stack

| Piece | What |
| --- | --- |
| App | Fresh clone of [TechyCSR/OpenCluely](https://github.com/TechyCSR/OpenCluely.git) → `apps/opencluely` |
| UI | **Original** OpenCluely glass UI (`index.html`, `chat.html`, `llm-response.html`, settings) |
| Vision | **llava-phi3** via Ollama — free open-source VLM, fits ~8GB RAM (default). Override with `OPENCLUELY_VISION_MODEL`. |
| Capture | Native per OS: Linux ImageMagick, macOS `screencapture`, Windows PowerShell — fallback `desktopCapturer` |
| Text / chat | Clyra `/api/companion/ask` (project DeepSeek stack) |
| Stealth | **Rejected** — no content-protection, no Terminal disguise |

## Setup

```bash
ollama serve &
ollama pull llava-phi3

bash scripts/clone-opencluely.sh   # wipe + fresh clone + apply bridge
bash scripts/start-opencluely-electron.sh
```

## Test real Chrome overlap (no fake HTML cards)

```bash
# Control API must be up (port 3847). Then:
SHOT_DIR=/opt/cursor/artifacts/opencluely-chrome node tools/opencluely-chrome-real-overlap.mjs

# Or manually:
curl -X POST http://127.0.0.1:3847/show -H 'content-type: application/json' \
  -d '{"windows":["main","chat","llm-response"]}'
curl -X POST http://127.0.0.1:3847/chat -H 'content-type: application/json' \
  -d '{"text":"What is on my screen right now?"}'
```

Screen questions (`what's on my screen`, `what page am I on`, main heading/title, etc.) auto-route to screenshot + vision.

## Capture (Windows / macOS / Linux)

| Platform | Primary | Fallback |
| --- | --- | --- |
| Linux | ImageMagick `import` of focused window | `desktopCapturer` |
| macOS | `screencapture -x` | `desktopCapturer` |
| Windows | PowerShell GDI+ virtual-screen | `desktopCapturer` |

## UI

Centered tool bar at the top. Chat is **not** a separate side panel — click the chat icon (or Ctrl/Cmd+Shift+C) to smoothly expand the bar and reveal chat underneath.


Applied after every fresh clone:

- `capture.service.js` — Linux ImageMagick focused-window capture + crop fallback
- `llm.service.js` — local vision (Ollama) + Clyra ask; literal-read vision prompts
- `config.js` — clyra/vision endpoints; stealth flags off
- `main.js` — OpenCluely name; skip Gemini onboarding; hide overlays during capture; screen-question routing; control HTTP API
- `window.manager.js` — no content-protection; Linux-safe window create/position
- `html/` — solid panels so glass stays visible over white Chrome pages
