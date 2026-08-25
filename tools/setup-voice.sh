#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UV="${UV:-$HOME/.local/bin/uv}"

if [[ ! -x "$UV" ]]; then
  echo "uv is required: https://docs.astral.sh/uv/"
  exit 1
fi

"$UV" python install 3.11
"$UV" venv --python 3.11 "$ROOT/.venv-voice311"
# Needed to build llvmlite (a numba/pipecat-ai dependency) from source on
# platforms without a prebuilt wheel for the pinned version.
"$UV" pip install --python "$ROOT/.venv-voice311/bin/python" cmake ninja
PATH="$ROOT/.venv-voice311/bin:$PATH" "$UV" pip install \
  --python "$ROOT/.venv-voice311/bin/python" \
  -r "$ROOT/requirements-voice.txt"

"$ROOT/.venv-voice311/bin/python" - <<'PY'
import importlib.util
required = ("fastapi", "uvicorn", "pipecat", "aiortc", "aiohttp")
missing = [name for name in required if importlib.util.find_spec(name) is None]
if missing:
    raise SystemExit(f"Voice setup incomplete: {', '.join(missing)}")
import pipecat
print(f"pipecat-ai import verified: {pipecat.__file__}")
PY

echo "Voice worker installed (Pipecat + SmallWebRTCTransport + Fish Audio + DeepSeek)."
echo "Configure FISH_AUDIO_API_KEY, FISH_TTS_REFERENCE_ID, and DEEPSEEK_API_KEY in .env.local."
