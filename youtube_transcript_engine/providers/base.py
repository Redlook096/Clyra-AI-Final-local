"""Provider interface and registry helpers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, Optional, Sequence

from ..types import ProviderDiagnostic, TranscriptCue, TranscriptMetadata


class TranscriptProvider(ABC):
    name: str = "base"

    @abstractmethod
    def fetch(
        self,
        video_id: str,
        *,
        preferred_languages: Sequence[str],
        translate_to: Optional[str] = None,
    ) -> tuple[List[TranscriptCue], TranscriptMetadata, ProviderDiagnostic]:
        """Return cues + metadata + success diagnostic, or raise ProviderFailure."""
        raise NotImplementedError


class ProviderFailure(Exception):
    def __init__(self, diagnostic: ProviderDiagnostic, *, retryable: bool = False):
        super().__init__(diagnostic.reason or diagnostic.status)
        self.diagnostic = diagnostic
        self.retryable = retryable
