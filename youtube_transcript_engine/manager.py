"""Provider manager and public retrieve API."""

from __future__ import annotations

import logging
import re
from typing import List, Optional, Sequence

from .cache import TranscriptCache
from .cleaner import cues_to_full_text
from .providers import (
    CaptionTrackProvider,
    ProviderFailure,
    TranscriptProvider,
    YoutubeDataApiProvider,
    YoutubeTranscriptApiProvider,
)
from .types import (
    ERROR_INVALID_ID,
    ERROR_NO_CAPTIONS,
    ERROR_UNKNOWN,
    ProviderDiagnostic,
    TranscriptCue,
    TranscriptError,
    TranscriptMetadata,
    TranscriptResult,
)

logger = logging.getLogger("youtube_transcript_engine")

_VIDEO_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?v=|embed/|shorts/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})"
)
_BARE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def extract_video_id(value: str) -> Optional[str]:
    text = (value or "").strip()
    if not text:
        return None
    if _BARE_ID_RE.match(text):
        return text
    match = _VIDEO_ID_RE.search(text)
    if match:
        return match.group(1)
    # Also accept v= query without full host in some pasted strings.
    query = re.search(r"[?&]v=([A-Za-z0-9_-]{11})", text)
    if query:
        return query.group(1)
    return None


class TranscriptEngine:
    def __init__(
        self,
        providers: Optional[Sequence[TranscriptProvider]] = None,
        cache: Optional[TranscriptCache] = None,
    ) -> None:
        self.providers: List[TranscriptProvider] = list(
            providers
            or [
                YoutubeTranscriptApiProvider(),
                CaptionTrackProvider(),
                YoutubeDataApiProvider(),
            ]
        )
        self.cache = cache or TranscriptCache()

    def register_provider(self, provider: TranscriptProvider, *, index: Optional[int] = None) -> None:
        if index is None:
            self.providers.append(provider)
        else:
            self.providers.insert(index, provider)

    def retrieve(
        self,
        url_or_id: str,
        *,
        preferred_languages: Optional[Sequence[str]] = None,
        translate_to: Optional[str] = None,
        use_cache: bool = True,
    ) -> TranscriptResult:
        video_id = extract_video_id(url_or_id)
        if not video_id:
            return TranscriptResult(
                ok=False,
                error=TranscriptError(
                    code=ERROR_INVALID_ID,
                    message="Malformed YouTube URL or video ID",
                ),
                diagnostics=[
                    ProviderDiagnostic(
                        provider="engine",
                        status="failed",
                        reason="Malformed YouTube URL or video ID",
                    )
                ],
            )

        preferred = list(preferred_languages or ["en"])
        cache_key = f"{video_id}:{','.join(preferred)}:{translate_to or ''}"
        if use_cache:
            cached = self.cache.get(cache_key)
            if cached:
                logger.info("Cache hit for %s", video_id)
                return TranscriptResult(
                    ok=True,
                    cues=[TranscriptCue(**c) for c in cached.get("cues", [])],
                    metadata=TranscriptMetadata(**cached["metadata"]) if cached.get("metadata") else None,
                    diagnostics=[ProviderDiagnostic(**d) for d in cached.get("diagnostics", [])],
                    full_text=cached.get("full_text", ""),
                )

        diagnostics: List[ProviderDiagnostic] = []
        for provider in self.providers:
            try:
                cues, metadata, diagnostic = provider.fetch(
                    video_id,
                    preferred_languages=preferred,
                    translate_to=translate_to,
                )
                diagnostics.append(diagnostic)
                # Enrich metadata if caption-track later fills title; keep first success.
                full_text = cues_to_full_text(cues)
                result = TranscriptResult(
                    ok=True,
                    cues=cues,
                    metadata=metadata,
                    diagnostics=diagnostics,
                    full_text=full_text,
                )
                if use_cache:
                    self.cache.set(cache_key, result.to_dict())
                logger.info("Provider %s succeeded for %s", provider.name, video_id)
                return result
            except ProviderFailure as failure:
                diagnostics.append(failure.diagnostic)
                logger.warning(
                    "Provider %s failed for %s: %s",
                    provider.name,
                    video_id,
                    failure.diagnostic.reason,
                )
                continue
            except Exception as exc:  # noqa: BLE001
                diagnostics.append(
                    ProviderDiagnostic(
                        provider=getattr(provider, "name", "unknown"),
                        status="failed",
                        reason=str(exc) or type(exc).__name__,
                    )
                )
                logger.exception("Unexpected provider failure: %s", provider)
                continue

        # Prefer a meaningful last reason.
        last_reason = next(
            (d.reason for d in reversed(diagnostics) if d.reason and d.status != "skipped"),
            "Unable to retrieve transcript from any provider",
        )
        return TranscriptResult(
            ok=False,
            diagnostics=diagnostics,
            error=TranscriptError(code=ERROR_NO_CAPTIONS, message=last_reason),
        )


_default_engine: Optional[TranscriptEngine] = None


def retrieve_transcript(
    url_or_id: str,
    *,
    preferred_languages: Optional[Sequence[str]] = None,
    translate_to: Optional[str] = None,
    use_cache: bool = True,
) -> TranscriptResult:
    global _default_engine
    if _default_engine is None:
        _default_engine = TranscriptEngine()
    return _default_engine.retrieve(
        url_or_id,
        preferred_languages=preferred_languages,
        translate_to=translate_to,
        use_cache=use_cache,
    )
