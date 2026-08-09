#!/usr/bin/env bash
# Start OpenCluely Electron with Clyra API + lightweight local vision (gemma3:4b).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${ROOT}/apps/opencluely"
export CLYRA_API_BASE="${CLYRA_API_BASE:-http://127.0.0.1:31415}"
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
export OPENCLUELY_VISION_MODEL="${OPENCLUELY_VISION_MODEL:-gemma3:4b}"
export CLYRA_CONTROL_PORT="${CLYRA_CONTROL_PORT:-3847}"
export ELECTRON_DISABLE_SECURITY_WARNINGS=1

# Ensure Ollama is up
if ! curl -sf "${OLLAMA_BASE_URL}/api/tags" >/dev/null; then
  echo "Starting ollama serve..."
  ollama serve >/tmp/ollama-serve.log 2>&1 &
  sleep 2
fi

# Ensure vision model is present (non-blocking: warn and continue if pull is slow)
VISION_MODEL="${OPENCLUELY_VISION_MODEL}"
if ! ollama list 2>/dev/null | grep -qi "$(echo "$VISION_MODEL" | cut -d: -f1)"; then
  echo "Vision model ${VISION_MODEL} missing — pulling in background (OpenCluely will start anyway)..."
  ollama pull "${VISION_MODEL}" >/tmp/ollama-pull-opencluely.log 2>&1 &
fi

# Ensure Clyra API is up
if ! curl -sf "${CLYRA_API_BASE}/" >/dev/null; then
  echo "WARN: Clyra API not reachable at ${CLYRA_API_BASE}"
fi

cd "${APP}"
ELECTRON_BIN="${APP}/node_modules/.bin/electron"
if [[ ! -x "${ELECTRON_BIN}" ]]; then
  echo "electron binary missing — run: bash scripts/clone-opencluely.sh"
  exit 1
fi

# Unique macOS TCC identity so Privacy → Microphone lists "OpenCluely".
if [[ "$(uname -s)" == "Darwin" ]]; then
  node "${ROOT}/tools/patch-electron-macos-privacy.mjs" opencluely >/dev/null || true
fi

# Headless-friendly Electron flags
# On macOS keep GPU enabled so the overlay feels native; Linux headless keeps the safer flags.
EXTRA_FLAGS=()
if [[ "$(uname -s)" != "Darwin" ]]; then
  EXTRA_FLAGS+=(--no-sandbox --disable-gpu --disable-dev-shm-usage)
fi

exec env -u ELECTRON_RUN_AS_NODE \
  "${ELECTRON_BIN}" . "${EXTRA_FLAGS[@]}" "$@"
