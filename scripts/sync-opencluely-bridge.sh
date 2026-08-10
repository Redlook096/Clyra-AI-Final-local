#!/usr/bin/env bash
# Sync Clyra-owned OpenCluely bridge files into the already-installed Electron companion.
# This intentionally does not re-clone the donor app or touch node_modules.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="${ROOT}/scripts/opencluely-bridge"
APP="${ROOT}/apps/opencluely"

if [[ ! -f "${APP}/package.json" ]]; then
  echo "OpenCluely is not installed. Run: bash scripts/clone-opencluely.sh" >&2
  exit 1
fi

backup_root="${APP}/.clyra-bridge-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "${backup_root}/src/services" "${backup_root}/src/ui"

sync_file() {
  local source="$1"
  local target="$2"
  local backup="${backup_root}/${target}"
  mkdir -p "$(dirname "${backup}")" "$(dirname "${APP}/${target}")"
  if [[ -f "${APP}/${target}" ]]; then
    cp "${APP}/${target}" "${backup}"
  fi
  cp "${BRIDGE}/${source}" "${APP}/${target}"
}

# Files owned by the Clyra bridge. Keep this list narrow so unrelated companion
# customisations and installed dependencies remain untouched.
sync_file "main.js" "main.js"
sync_file "window.manager.js" "src/managers/window.manager.js"
sync_file "capture.service.js" "src/services/capture.service.js"
sync_file "llm.service.js" "src/services/llm.service.js"
sync_file "desktop-control.service.js" "src/services/desktop-control.service.js"
sync_file "control-safety.js" "src/services/control-safety.js"
sync_file "macos-input.py" "src/services/macos-input.py"
sync_file "macos-input.swift" "src/services/macos-input.swift"
sync_file "computer-agent.service.js" "computer-agent.service.js"
sync_file "computer-agent-bash.js" "computer-agent-bash.js"
sync_file "computer-agent-api.mjs" "computer-agent-api.mjs"
sync_file "preload.js" "preload.js"
sync_file "ui/bar-chat.js" "src/ui/bar-chat.js"
sync_file "html/index.html" "index.html"

chmod +x "${APP}/src/services/macos-input.py"
chmod +x "${APP}/src/services/macos-input.swift"
echo "Synced OpenCluely bridge. Reversible backup: ${backup_root}"
