#!/usr/bin/env bash
# Re-clone OpenCluely as a reference donor (UI language only — no stealth).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROOT}/references/OpenCluely"
mkdir -p "${ROOT}/references"
if [[ -d "${DEST}/.git" ]]; then
  git -C "${DEST}" fetch --depth 1 origin main
  git -C "${DEST}" checkout -f FETCH_HEAD
else
  git clone --depth 1 https://github.com/TechyCSR/OpenCluely.git "${DEST}"
fi
echo "OpenCluely reference ready at ${DEST}"
echo "Keep: glass command tab + chat UI look"
echo "Reject: stealth / screen-share invisibility / process disguise"
