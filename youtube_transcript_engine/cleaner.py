"""Normalize and clean transcript cues."""

from __future__ import annotations

import re
from typing import List

from .types import TranscriptCue

_WHITESPACE_RE = re.compile(r"\s+")
_TAG_RE = re.compile(r"<[^>]+>")


def _normalize_text(text: str) -> str:
    cleaned = _TAG_RE.sub("", text or "")
    cleaned = cleaned.replace("\xa0", " ").replace("&nbsp;", " ")
    cleaned = cleaned.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    cleaned = cleaned.replace("&#39;", "'").replace("&quot;", '"')
    cleaned = _WHITESPACE_RE.sub(" ", cleaned).strip()
    return cleaned


def clean_cues(raw_cues: List[TranscriptCue]) -> List[TranscriptCue]:
    cleaned: List[TranscriptCue] = []
    prev_text = ""
    for cue in raw_cues:
        text = _normalize_text(cue.text)
        if not text:
            continue
        # Drop exact duplicate consecutive fragments (common in auto captions).
        if text == prev_text:
            continue
        # Merge overlapping near-duplicates that only add one trailing word.
        if cleaned and text.startswith(prev_text) and len(text) - len(prev_text) < 24:
            cleaned[-1] = TranscriptCue(
                start=cleaned[-1].start,
                duration=max(cleaned[-1].duration, float(cue.duration or 0)),
                text=text,
            )
            prev_text = text
            continue
        try:
            start = float(cue.start)
            duration = float(cue.duration or 0)
        except (TypeError, ValueError):
            continue
        if start < 0:
            continue
        cleaned.append(TranscriptCue(start=start, duration=max(0.0, duration), text=text))
        prev_text = text
    return cleaned


def cues_to_full_text(cues: List[TranscriptCue]) -> str:
    return " ".join(c.text for c in cues).strip()
