#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YTDLP="$ROOT_DIR/.clyra/bin/yt-dlp"
RAW_DIR="$ROOT_DIR/.clyra/gameplay-raw"
OUTPUT_DIR="$ROOT_DIR/public/media/fake-text/gameplay"
PYTHON_BIN="${PYTHON_BIN:-$HOME/.local/bin/python3.11}"
FFMPEG_BIN="${FFMPEG_PATH:-$HOME/.local/bin/ffmpeg}"

if [[ ! -x "$PYTHON_BIN" ]]; then PYTHON_BIN="$(command -v python3)"; fi
if [[ ! -x "$FFMPEG_BIN" ]]; then FFMPEG_BIN="$(command -v ffmpeg)"; fi

mkdir -p "$(dirname "$YTDLP")" "$RAW_DIR" "$OUTPUT_DIR/subway" "$OUTPUT_DIR/minecraft" "$OUTPUT_DIR/gta"

if [[ ! -f "$YTDLP" ]]; then
  curl -L --fail --silent --show-error \
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp" \
    -o "$YTDLP"
  chmod +x "$YTDLP"
fi

download_clip() {
  local id="$1"
  local url="$2"
  local section="$3"
  local raw="$RAW_DIR/$id.mp4"
  if [[ -s "$raw" ]]; then return; fi
  "$PYTHON_BIN" "$YTDLP" --no-warnings \
    -f "bv*[vcodec^=avc1][height<=1280]" \
    --download-sections "*$section" \
    -o "$raw" \
    "$url"
}

prepare_clip() {
  local id="$1"
  local category="${id%-*}"
  local raw="$RAW_DIR/$id.mp4"
  local video="$OUTPUT_DIR/$category/$id.mp4"
  local poster="$OUTPUT_DIR/$category/$id.jpg"
  if [[ ! -s "$video" ]]; then
    "$FFMPEG_BIN" -hide_banner -loglevel error -y -i "$raw" -t 40 -an \
      -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1" \
      -r 30 -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -movflags +faststart \
      "$video"
  fi
  if [[ ! -s "$poster" ]]; then
    "$FFMPEG_BIN" -hide_banner -loglevel error -y -ss 6 -i "$video" -frames:v 1 -q:v 2 "$poster"
  fi
}

SUBWAY_URL="https://youtu.be/QPW3XwBoQlw"
MINECRAFT_URL="https://youtu.be/u7kdVe8q5zs"
GTA_URL="https://youtu.be/ZtLrNBdXT7M"

download_clip subway-01 "$SUBWAY_URL" "00:00:00-00:00:40"
download_clip subway-02 "$SUBWAY_URL" "00:00:40-00:01:20"
download_clip subway-03 "$SUBWAY_URL" "00:01:20-00:02:00"
download_clip subway-04 "$SUBWAY_URL" "00:02:00-00:02:40"
download_clip subway-05 "$SUBWAY_URL" "00:02:33-00:03:13"

download_clip minecraft-01 "$MINECRAFT_URL" "00:02:00-00:02:40"
download_clip minecraft-02 "$MINECRAFT_URL" "00:07:30-00:08:10"
download_clip minecraft-03 "$MINECRAFT_URL" "00:13:00-00:13:40"
download_clip minecraft-04 "$MINECRAFT_URL" "00:18:30-00:19:10"
download_clip minecraft-05 "$MINECRAFT_URL" "00:24:00-00:24:40"

download_clip gta-01 "$GTA_URL" "00:00:20-00:01:00"
download_clip gta-02 "$GTA_URL" "00:02:40-00:03:20"
download_clip gta-03 "$GTA_URL" "00:05:00-00:05:40"
download_clip gta-04 "$GTA_URL" "00:07:20-00:08:00"
download_clip gta-05 "$GTA_URL" "00:09:40-00:10:20"

for id in \
  subway-01 subway-02 subway-03 subway-04 subway-05 \
  minecraft-01 minecraft-02 minecraft-03 minecraft-04 minecraft-05 \
  gta-01 gta-02 gta-03 gta-04 gta-05; do
  prepare_clip "$id"
done

printf 'Prepared 15 gameplay clips in %s\n' "$OUTPUT_DIR"
