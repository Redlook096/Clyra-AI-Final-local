"""Simple file-backed transcript cache."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional


class TranscriptCache:
    def __init__(self, cache_dir: Optional[str] = None, ttl_seconds: int = 60 * 60 * 24) -> None:
        root = cache_dir or os.environ.get(
            "YOUTUBE_TRANSCRIPT_CACHE_DIR",
            str(Path.cwd() / ".cache" / "youtube-transcripts"),
        )
        self.cache_dir = Path(root)
        self.ttl_seconds = ttl_seconds
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in key)
        return self.cache_dir / f"{safe}.json"

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        path = self._path(key)
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            expires_at = float(payload.get("expires_at", 0))
            if expires_at and expires_at < time.time():
                path.unlink(missing_ok=True)
                return None
            return payload.get("data")
        except Exception:
            return None

    def set(self, key: str, data: Dict[str, Any]) -> None:
        path = self._path(key)
        payload = {
            "expires_at": time.time() + self.ttl_seconds,
            "cached_at": time.time(),
            "data": data,
        }
        path.write_text(json.dumps(payload), encoding="utf-8")
