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
  echo "==> Applying Clyra + Moondream bridge (original UI kept)"
  cp "${BRIDGE}/llm.service.js" "${DEST}/src/services/llm.service.js"
  cp "${BRIDGE}/config.js" "${DEST}/src/core/config.js"
  cp "${BRIDGE}/main.js" "${DEST}/main.js"
  cp "${BRIDGE}/window.manager.js" "${DEST}/src/managers/window.manager.js"
  cp "${BRIDGE}/env" "${DEST}/.env"
  touch "${DEST}/.opencluely-firstrun-completed"
fi

echo "==> npm install"
cd "${DEST}"
npm install --omit=optional

echo "Ready. Vision=moondream (Ollama)  Text=Clyra /api/companion/ask  Stealth=OFF"
echo "Start: bash scripts/start-opencluely-electron.sh"
