#!/usr/bin/env bash
# Remove + fresh-clone OpenCluely, then apply Clyra/Moondream bridge (no stealth).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROOT}/apps/opencluely"
BRIDGE="${ROOT}/scripts/opencluely-bridge"
REPO="https://github.com/TechyCSR/OpenCluely.git"

echo "==> Removing previous OpenCluely"
rm -rf "${DEST}"
mkdir -p "${ROOT}/apps"
echo "==> Cloning ${REPO}"
git clone --depth 1 "${REPO}" "${DEST}"
echo "==> At $(cd "${DEST}" && git rev-parse --short HEAD)"

if [[ -d "${BRIDGE}" ]]; then
  echo "==> Applying Clyra + vision bridge (centered expandable bar, no stealth)"
  cp "${BRIDGE}/llm.service.js" "${DEST}/src/services/llm.service.js"
  cp "${BRIDGE}/capture.service.js" "${DEST}/src/services/capture.service.js"
  cp "${BRIDGE}/desktop-control.service.js" "${DEST}/src/services/desktop-control.service.js"
  cp "${BRIDGE}/control-safety.js" "${DEST}/src/services/control-safety.js"
  if [[ -f "${BRIDGE}/macos-input.py" ]]; then
    cp "${BRIDGE}/macos-input.py" "${DEST}/src/services/macos-input.py"
    chmod +x "${DEST}/src/services/macos-input.py"
  fi
  cp "${BRIDGE}/config.js" "${DEST}/src/core/config.js"
  cp "${BRIDGE}/main.js" "${DEST}/main.js"
  cp "${BRIDGE}/window.manager.js" "${DEST}/src/managers/window.manager.js"
  cp "${BRIDGE}/prompt-loader.js" "${DEST}/prompt-loader.js"
  if [[ -f "${BRIDGE}/preload.js" ]]; then
    cp "${BRIDGE}/preload.js" "${DEST}/preload.js"
  fi
  mkdir -p "${DEST}/prompts" "${DEST}/src/ui"
  cp "${BRIDGE}/prompts/"*.md "${DEST}/prompts/" 2>/dev/null || true
  if [[ -d "${BRIDGE}/html" ]]; then
    cp "${BRIDGE}/html/"*.html "${DEST}/" 2>/dev/null || true
  fi
  if [[ -d "${BRIDGE}/ui" ]]; then
    cp "${BRIDGE}/ui/"*.js "${DEST}/src/ui/" 2>/dev/null || true
  fi
  cp "${BRIDGE}/env" "${DEST}/.env"
  touch "${DEST}/.opencluely-firstrun-completed"
fi

echo "==> npm install"
cd "${DEST}"
npm install --omit=optional

echo "Ready. Vision=Gemini (via Clyra /api/companion/vision-frame)  Text=Clyra /api/companion/ask  Stealth=OFF"
echo "Start (macOS/Linux): bash scripts/start-opencluely-electron.sh"
echo "Start (Windows):     powershell -ExecutionPolicy Bypass -File scripts/start-opencluely-electron.ps1"
