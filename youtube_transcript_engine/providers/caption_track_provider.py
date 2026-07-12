"""Provider 2: caption tracks via YouTube player metadata (no HTML scraping)."""

from __future__ import annotations

import json
import logging
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Sequence
from urllib.request import Request, urlopen

from ..cleaner import clean_cues
from ..language import resolve_language_order
from ..retry import with_retries
from ..types import ProviderDiagnostic, TranscriptCue, TranscriptMetadata
from .base import ProviderFailure, TranscriptProvider

logger = logging.getLogger("youtube_transcript_engine.providers.caption_track")

_PLAYER_ENDPOINT = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false"
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def _http_json(url: str, payload: Dict[str, Any], timeout: float = 15.0) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
        },
        method="POST",
    )
    with urlopen(req, timeout=timeout) as resp:  # noqa: S310 — documented YouTube endpoint
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _http_get(url: str, timeout: float = 15.0) -> bytes:
    req = Request(url, headers={"User-Agent": _USER_AGENT})
    with urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return resp.read()


def _parse_caption_xml(raw: bytes) -> List[TranscriptCue]:
    text = raw.decode("utf-8", errors="replace")
    cues: List[TranscriptCue] = []
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        if '"events"' in text:
            try:
                data = json.loads(text)
                for event in data.get("events", []):
                    segs = event.get("segs") or []
                    piece = "".join(seg.get("utf8", "") for seg in segs).strip()
                    if not piece or piece == "\n":
                        continue
                    start_ms = float(event.get("tStartMs", 0))
                    dur_ms = float(event.get("dDurationMs", 0))
                    cues.append(
                        TranscriptCue(start=start_ms / 1000.0, duration=dur_ms / 1000.0, text=piece)
                    )
                return cues
            except Exception:  # noqa: BLE001
                return []
        return []

    for node in root.iter("text"):
        start = float(node.attrib.get("start", node.attrib.get("t", 0)) or 0)
        duration = float(node.attrib.get("dur", node.attrib.get("d", 0)) or 0)
        body = "".join(node.itertext())
        cues.append(TranscriptCue(start=start, duration=duration, text=body))
    return cues


class CaptionTrackProvider(TranscriptProvider):
    name = "caption-track"

    def fetch(
        self,
        video_id: str,
        *,
        preferred_languages: Sequence[str],
        translate_to: Optional[str] = None,
    ) -> tuple[List[TranscriptCue], TranscriptMetadata, ProviderDiagnostic]:
        def load_player():
            return _http_json(
                _PLAYER_ENDPOINT,
                {
                    "context": {
                        "client": {
                            "clientName": "WEB",
                            "clientVersion": "2.20240401.00.00",
                            "hl": "en",
                            "gl": "US",
                        }
                    },
                    "videoId": video_id,
                },
            )

        try:
            player = with_retries(load_player, attempts=3)
        except Exception as exc:  # noqa: BLE001
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="failed",
                    reason=f"Player metadata request failed: {exc}",
                ),
                retryable=True,
            ) from exc

        status = ((player.get("playabilityStatus") or {}).get("status") or "").upper()
        if status and status not in {"OK", "LIVE_STREAM"}:
            reason = (player.get("playabilityStatus") or {}).get("reason") or status
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="failed",
                    reason=str(reason),
                    details={"playability": status},
                ),
                retryable=False,
            )

        video_details = player.get("videoDetails") or {}
        title = str(video_details.get("title") or "")
        uploader = str(video_details.get("author") or "")

        caption_tracks = (
            ((player.get("captions") or {}).get("playerCaptionsTracklistRenderer") or {}).get(
                "captionTracks"
            )
            or []
        )
        if not caption_tracks:
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="failed",
                    reason="No caption tracks in player metadata",
                ),
                retryable=False,
            )

        available = [str(track.get("languageCode") or "") for track in caption_tracks]
        order = resolve_language_order(available, preferred=preferred_languages)

        def pick_track() -> Dict[str, Any]:
            for want_asr in (False, True):
                for lang in order:
                    for track in caption_tracks:
                        code = str(track.get("languageCode") or "")
                        kind = str(track.get("kind") or "")
                        is_asr = kind == "asr"
                        if code == lang and is_asr == want_asr:
                            return track
            return caption_tracks[0]

        track = pick_track()
        base_url = str(track.get("baseUrl") or "")
        if not base_url:
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="failed",
                    reason="Caption track missing baseUrl",
                ),
                retryable=False,
            )

        language = str(track.get("languageCode") or "")
        transcript_type = "automatic" if str(track.get("kind") or "") == "asr" else "manual"

        if "fmt=" not in base_url:
            sep = "&" if "?" in base_url else "?"
            fetch_url = f"{base_url}{sep}fmt=srv3"
        else:
            fetch_url = base_url

        if translate_to and translate_to != language:
            sep = "&" if "?" in fetch_url else "?"
            fetch_url = f"{fetch_url}{sep}tlang={translate_to}"
            language = translate_to

        def download():
            return _http_get(fetch_url)

        try:
            raw = with_retries(download, attempts=3)
        except Exception as exc:  # noqa: BLE001
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="failed",
                    reason=f"Caption download failed: {exc}",
                    language=language,
                ),
                retryable=True,
            ) from exc

        cues = clean_cues(_parse_caption_xml(raw))
        if not cues:
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="failed",
                    reason="Caption track returned no usable cues",
                    language=language,
                ),
                retryable=False,
            )

        metadata = TranscriptMetadata(
            video_id=video_id,
            title=title,
            uploader=uploader,
            language=language,
            transcript_source="caption-track",
            transcript_type=transcript_type,
            provider_used=self.name,
            available_languages=sorted({c for c in available if c}),
        )
        diagnostic = ProviderDiagnostic(
            provider=self.name,
            status="success",
            language=language,
            details={"transcript_type": transcript_type, "cue_count": len(cues)},
        )
        return cues, metadata, diagnostic
