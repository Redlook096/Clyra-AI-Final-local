"""Provider 3: Official YouTube Data API stub (pluggable, not required)."""

from __future__ import annotations

import os
from typing import List, Optional, Sequence

from ..types import ProviderDiagnostic, TranscriptCue, TranscriptMetadata
from .base import ProviderFailure, TranscriptProvider


class YoutubeDataApiProvider(TranscriptProvider):
    """
    Placeholder for official YouTube Data API caption integration.

    Enable by setting YOUTUBE_DATA_API_KEY. Until a full captions.download
    OAuth flow is wired, this provider reports a structured skip/failure
    without affecting other providers.
    """

    name = "youtube-data-api"

    def fetch(
        self,
        video_id: str,
        *,
        preferred_languages: Sequence[str],
        translate_to: Optional[str] = None,
    ) -> tuple[List[TranscriptCue], TranscriptMetadata, ProviderDiagnostic]:
        api_key = os.environ.get("YOUTUBE_DATA_API_KEY", "").strip()
        if not api_key:
            raise ProviderFailure(
                ProviderDiagnostic(
                    provider=self.name,
                    status="skipped",
                    reason="YOUTUBE_DATA_API_KEY not configured",
                    details={"preferred_languages": list(preferred_languages), "translate_to": translate_to, "video_id": video_id},
                ),
                retryable=False,
            )

        # Official captions.download requires OAuth ownership of the video in
        # most cases. Keep this as an explicit extension point.
        raise ProviderFailure(
            ProviderDiagnostic(
                provider=self.name,
                status="failed",
                reason=(
                    "YouTube Data API captions.download requires OAuth for owned videos; "
                    "configure an enterprise adapter to enable this provider"
                ),
            ),
            retryable=False,
        )
