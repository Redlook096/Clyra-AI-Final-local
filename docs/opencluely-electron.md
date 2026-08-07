# OpenCluely (fresh Electron) + Clyra + local vision

## Stack

| Piece | What |
| --- | --- |
| App | Fresh clone of [TechyCSR/OpenCluely](https://github.com/TechyCSR/OpenCluely.git) → `apps/opencluely` |
| UI | **Original** OpenCluely glass UI (`index.html`, `chat.html`, `llm-response.html`, settings) |
| Vision | **llava-phi3** via Ollama — free open-source VLM, fits ~8GB RAM (default). Override with `OPENCLUELY_VISION_MODEL`. |
| Text / chat | Clyra `/api/companion/ask` (project DeepSeek stack) |
| Stealth | **Rejected** — no content-protection, no Terminal disguise |

## Setup

```bash
ollama serve &
ollama pull llava-phi3

bash scripts/clone-opencluely.sh   # wipe + fresh clone + apply bridge
bash scripts/start-opencluely-electron.sh
```

## Test with lots of screenshots

```bash
SHOT_DIR=/opt/cursor/artifacts/opencluely-electron node tools/opencluely-electron-tour.mjs
```

## Bridge patches (`scripts/opencluely-bridge/`)

Applied after every fresh clone:

- `llm.service.js` — local vision (Ollama) + Clyra ask
- `config.js` — clyra/vision endpoints; stealth flags off
- `main.js` — OpenCluely name; skip Gemini onboarding
- `window.manager.js` — no content-protection; Linux-safe window create/position
