"""Provider 1: youtube-transcript-api."""

from __future__ import annotations

import logging
from typing import List, Optional, Sequence

from ..cleaner import clean_cues
from ..language import resolve_language_order
from ..retry import with_retries
from ..types import (
    ERROR_DISABLED,
    ERROR_NO_CAPTIONS,
    ERROR_PRIVATE,
    ERROR_UNKNOWN,
    ProviderDiagnostic,
    TranscriptCue,
    TranscriptMetadata,
)
from .base import ProviderFailure, TranscriptProvider

logger = logging.getLogger("youtube_transcript_engine.providers.yta")


def _map_exception(exc: BaseException) -> tuple[str, str, bool]:
    name = type(exc).__name__
    message = str(exc) or name
    lower = message.lower()
    if "disabled" in lower:
        return ERROR_DISABLED, "Captions are disabled for this video", False
    if "no transcript" in lower or "could not retrieve" in lower or "no transcripts" in lower:
        return ERROR_NO_CAPTIONS, "No captions available", False
    if "private" in lower:
        return ERROR_PRIVATE, "Video is private", False
    if "unavailable" in lower or "deleted" in lower:
        return "deleted_video", "Video unavailable or deleted", False
    return ERROR_UNKNOWN, message, True


class YoutubeTranscriptApiProvider(TranscriptProvider):
    name = "youtube-transcript-api"

    def fetch(
        self,
        video_id: str,
        *,
        preferred_languages: Sequence[str],
        translate_to: Optional[str] = None,
    ) -> tuple[List[TranscriptCue], TranscriptMetadata, ProviderDiagnostic]:
        try:
            from youtube_transcript_api import YouTubeTranscriptApi
        except ImportError as exc:
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="failed",
                    reason="youtube-transcript-api is not installed",
                ),
                retryable=False,
            ) from exc

        api = YouTubeTranscriptApi()

        def list_transcripts():
            return api.list(video_id)

        try:
            transcript_list = with_retries(list_transcripts, attempts=3)
        except Exception as exc:  # noqa: BLE001
            code, reason, retryable = _map_exception(exc)
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="failed",
                    reason=reason,
                    details={"code": code, "exception": type(exc).__name__},
                ),
                retryable=retryable,
            ) from exc

        available = []
        manual = []
        generated = []
        for item in transcript_list:
            code = getattr(item, "language_code", "") or ""
            available.append(code)
            if getattr(item, "is_generated", False):
                generated.append(item)
            else:
                manual.append(item)

        order = resolve_language_order(available, preferred=preferred_languages)
        chosen = None
        transcript_type = "manual"

        # Prefer manual captions in preferred language order, then auto.
        for lang in order:
            for item in manual:
                if getattr(item, "language_code", "") == lang:
                    chosen = item
                    transcript_type = "manual"
                    break
            if chosen:
                break
        if not chosen:
            for lang in order:
                for item in generated:
                    if getattr(item, "language_code", "") == lang:
                        chosen = item
                        transcript_type = "automatic"
                        break
                if chosen:
                    break
        if not chosen:
            # Fall back to first available.
            pool = list(manual) + list(generated)
            if not pool:
                raise ProviderFailure(
                    ProviderDiagnostic(
                        provider=self.name,
                        status="failed",
                        reason="No captions available",
                    ),
                    retryable=False,
                )
            chosen = pool[0]
            transcript_type = "automatic" if getattr(chosen, "is_generated", False) else "manual"

        language = getattr(chosen, "language_code", "") or ""
        if translate_to and translate_to != language and getattr(chosen, "is_translatable", False):
            try:
                chosen = chosen.translate(translate_to)
                language = translate_to
            except Exception as exc:  # noqa: BLE001
                logger.warning("Translation to %s failed: %s", translate_to, exc)

        def fetch_snippets():
            return chosen.fetch()

        try:
            fetched = with_retries(fetch_snippets, attempts=3)
        except Exception as exc:  # noqa: BLE001
            code, reason, retryable = _map_exception(exc)
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="failed",
                    reason=reason,
                    language=language,
                    details={"code": code},
                ),
                retryable=retryable,
            ) from exc

        raw_cues: List[TranscriptCue] = []
        snippets = list(fetched) if not isinstance(fetched, list) else fetched
        for snippet in snippets:
            text = getattr(snippet, "text", None)
            start = getattr(snippet, "start", None)
            duration = getattr(snippet, "duration", None)
            if text is None and isinstance(snippet, dict):
                text = snippet.get("text", "")
                start = snippet.get("start", 0)
                duration = snippet.get("duration", 0)
            raw_cues.append(
                TranscriptCue(
                    start=float(start or 0),
                    duration=float(duration or 0),
                    text=str(text or ""),
                )
            )

        cues = clean_cues(raw_cues)
        if not cues:
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="failed",
                    reason="Transcript empty after cleaning",
                    language=language,
                ),
                retryable=False,
            )

        metadata = TranscriptMetadata(
            video_id=video_id,
            language=language,
            transcript_source=self.name,
            transcript_type=transcript_type,
            provider_used=self.name,
            available_languages=sorted(set(available)),
        )
        diagnostic = ProviderDiagnostic(
            provider=self.name,
            status="success",
            language=language,
            details={"transcript_type": transcript_type, "cue_count": len(cues)},
        )
        return cues, metadata, diagnostic
