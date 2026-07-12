"""Shared types for the transcript engine."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class TranscriptCue:
    start: float
    duration: float
    text: str

    def to_dict(self) -> Dict[str, Any]:
        return {"start": self.start, "duration": self.duration, "text": self.text}


@dataclass
class TranscriptMetadata:
    video_id: str
    title: str = ""
    uploader: str = ""
    language: str = ""
    transcript_source: str = ""
    transcript_type: str = ""  # manual | automatic
    provider_used: str = ""
    available_languages: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ProviderDiagnostic:
    provider: str
    status: str  # success | failed | skipped
    reason: str = ""
    language: str = ""
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def format_text(self) -> str:
        lines = [
            f"Provider:\n{self.provider}",
            "",
            f"Status:\n{self.status.title()}",
        ]
        if self.reason:
            lines.extend(["", f"Reason:\n{self.reason}"])
        if self.language:
            lines.extend(["", f"Language:\n{self.language}"])
        return "\n".join(lines)


@dataclass
class TranscriptResult:
    ok: bool
    cues: List[TranscriptCue] = field(default_factory=list)
    metadata: Optional[TranscriptMetadata] = None
    diagnostics: List[ProviderDiagnostic] = field(default_factory=list)
    error: Optional["TranscriptError"] = None
    full_text: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "cues": [c.to_dict() for c in self.cues],
            "metadata": self.metadata.to_dict() if self.metadata else None,
            "diagnostics": [d.to_dict() for d in self.diagnostics],
            "error": self.error.to_dict() if self.error else None,
            "full_text": self.full_text,
        }


@dataclass
class TranscriptError:
    code: str
    message: str
    retryable: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


ERROR_INVALID_ID = "invalid_id"
ERROR_NO_CAPTIONS = "no_captions"
ERROR_DISABLED = "captions_disabled"
ERROR_PRIVATE = "private_video"
ERROR_DELETED = "deleted_video"
ERROR_LIVE = "live_stream"
ERROR_MEMBERS = "members_only"
ERROR_AGE = "age_restricted"
ERROR_REGION = "unavailable_region"
ERROR_TIMEOUT = "timeout"
ERROR_NETWORK = "network_error"
ERROR_UNKNOWN = "unknown"
