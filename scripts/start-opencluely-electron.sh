#!/usr/bin/env bash
# Start OpenCluely Electron with Clyra API + Moondream vision.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${ROOT}/apps/opencluely"
export CLYRA_API_BASE="${CLYRA_API_BASE:-http://127.0.0.1:31415}"
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
export OPENCLUELY_VISION_MODEL="${OPENCLUELY_VISION_MODEL:-llava-phi3}"
export ELECTRON_DISABLE_SECURITY_WARNINGS=1

# Ensure Ollama is up
if ! curl -sf "${OLLAMA_BASE_URL}/api/tags" >/dev/null; then
  echo "Starting ollama serve..."
  ollama serve >/tmp/ollama-serve.log 2>&1 &
  sleep 2
fi

# Ensure llava-phi3 is present
if ! ollama list 2>/dev/null | grep -qi llava-phi3; then
  echo "Pulling llava-phi3 (lightweight vision ~1.7GB)..."
  ollama pull llava-phi3
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

# Headless-friendly Electron flags
exec env -u ELECTRON_RUN_AS_NODE \
  "${ELECTRON_BIN}" . --no-sandbox --disable-gpu --disable-dev-shm-usage "$@"