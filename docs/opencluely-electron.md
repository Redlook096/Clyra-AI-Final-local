# OpenCluely (fresh Electron) + Clyra + Moondream

## Stack

| Piece | What |
| --- | --- |
| App | Fresh clone of [TechyCSR/OpenCluely](https://github.com/TechyCSR/OpenCluely.git) → `apps/opencluely` |
| UI | **Original** OpenCluely glass UI (`index.html`, `chat.html`, `llm-response.html`) |
| Vision | **Moondream** via Ollama — free, open-source, ~1.7GB, fits 8GB RAM |
| Text / chat | Clyra `/api/companion/ask` (project DeepSeek / LLM stack) |
| Stealth | **Rejected** — no content-protection, no Terminal disguise, no skip-taskbar hide |

## Setup

```bash
# Ollama + moondream (once)
ollama serve &
ollama pull moondream

# Clone fresh + apply Clyra/Moondream bridge
bash scripts/clone-opencluely.sh

# Run Electron (needs a display / xvfb)
bash scripts/start-opencluely-electron.sh
```

## Test with screenshots

```bash
# Clyra server must be on :31415
SHOT_DIR=/opt/cursor/artifacts/opencluely-electron node tools/opencluely-electron-tour.mjs
```

## Bridge files

Patched after each fresh clone from `scripts/opencluely-bridge/`:

- `llm.service.js` — Moondream vision + Clyra ask
- `config.js` — vision/clyra endpoints; stealth flags off
- `main.js` — honest OpenCluely name; skip Gemini onboarding
- `window.manager.js` — `setContentProtection(false)`
