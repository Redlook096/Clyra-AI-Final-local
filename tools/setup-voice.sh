#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UV="${UV:-$HOME/.local/bin/uv}"
CHATTERBOX_COMMIT="${CHATTERBOX_COMMIT:-65b18437192794391a0308a8f705b1e33e633948}"

if [[ ! -x "$UV" ]]; then
  echo "uv is required: https://docs.astral.sh/uv/"
  exit 1
fi

"$UV" python install 3.11
"$UV" venv --python 3.11 "$ROOT/.venv-voice311"
"$UV" pip install --python "$ROOT/.venv-voice311/bin/python" -r "$ROOT/requirements-voice.txt"
"$UV" pip install --python "$ROOT/.venv-voice311/bin/python" --no-deps \
  "chatterbox-tts @ git+https://github.com/resemble-ai/chatterbox.git@${CHATTERBOX_COMMIT}"

"$ROOT/.venv-voice311/bin/python" - <<'PY'
import importlib.util
required = ("fastapi", "uvicorn", "faster_whisper", "chatterbox.tts_turbo")
missing = [name for name in required if importlib.util.find_spec(name) is None]
if missing:
    raise SystemExit(f"Voice setup incomplete: {', '.join(missing)}")
from chatterbox.tts_turbo import ChatterboxTurboTTS

print(f"Chatterbox-Turbo import verified: {ChatterboxTurboTTS.__name__}")
PY

echo "Voice runtime installed from pinned official Chatterbox commit ${CHATTERBOX_COMMIT}."
echo "Configure consented 8-12 second WAV files with VOICE_TTS_REFERENCE or CHATTERBOX_VOICE_<NAME>_REFERENCE."
