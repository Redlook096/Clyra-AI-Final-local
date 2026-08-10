#!/usr/bin/env bash
# Start OpenCluely Electron with Clyra API + Gemini vision (via Clyra server).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${ROOT}/apps/opencluely"
export CLYRA_API_BASE="${CLYRA_API_BASE:-http://127.0.0.1:31415}"
export CLYRA_CONTROL_PORT="${CLYRA_CONTROL_PORT:-3847}"
export CLYRA_OPENCLUELY_PREWARM="${CLYRA_OPENCLUELY_PREWARM:-}"
export ELECTRON_DISABLE_SECURITY_WARNINGS=1

# Load Clyra env so GEMINI_API_KEY reaches the server OpenCluely calls for vision.
if [[ -f "${ROOT}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/.env.local"
  set +a
elif [[ -f "${ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/.env"
  set +a
fi

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "WARN: GEMINI_API_KEY is not set — OpenCluely screen vision requires it on the Clyra server."
fi

if ! curl -sf "${CLYRA_API_BASE}/" >/dev/null 2>&1; then
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

EXTRA_FLAGS=()
UNAME="$(uname -s)"
if [[ "${UNAME}" != "Darwin" ]]; then
  EXTRA_FLAGS+=(--no-sandbox --disable-gpu --disable-dev-shm-usage)
fi

exec env -u ELECTRON_RUN_AS_NODE \
  "${ELECTRON_BIN}" . ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"} "$@"
