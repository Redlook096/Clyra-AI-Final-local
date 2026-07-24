"""Unit tests for transcript engine helpers and provider fallback."""

from __future__ import annotations

import unittest
from typing import List, Optional, Sequence

from youtube_transcript_engine.cleaner import clean_cues, cues_to_full_text
from youtube_transcript_engine.language import resolve_language_order
from youtube_transcript_engine.manager import TranscriptEngine, extract_video_id
from youtube_transcript_engine.providers.base import ProviderFailure, TranscriptProvider
from youtube_transcript_engine.types import (
    ProviderDiagnostic,
    TranscriptCue,
    TranscriptMetadata,
)


class FakeSuccessProvider(TranscriptProvider):
    name = "fake-success"

    def fetch(
        self,
        video_id: str,
        *,
        preferred_languages: Sequence[str],
        translate_to: Optional[str] = None,
    ):
        cues = [TranscriptCue(start=0.0, duration=1.0, text="Hello world")]
        meta = TranscriptMetadata(
            video_id=video_id,
            language="en",
            transcript_source=self.name,
            transcript_type="manual",
            provider_used=self.name,
        )
        diag = ProviderDiagnostic(provider=self.name, status="success", language="en")
        return cues, meta, diag


class FakeFailProvider(TranscriptProvider):
    name = "fake-fail"

    def fetch(
        self,
        video_id: str,
        *,
        preferred_languages: Sequence[str],
        translate_to: Optional[str] = None,
    ):
        raise ProviderFailure(
            ProviderDiagnostic(provider=self.name, status="failed", reason="No captions available"),
            retryable=False,
        )


class EngineTests(unittest.TestCase):
    def test_extract_video_id(self):
        self.assertEqual(extract_video_id("DZoeGR_tatA"), "DZoeGR_tatA")
        self.assertEqual(
            extract_video_id("https://youtu.be/DZoeGR_tatA?si=JkCHrAMAoz9CDw_U"),
            "DZoeGR_tatA",
        )
        self.assertEqual(
            extract_video_id("https://www.youtube.com/watch?v=DZoeGR_tatA"),
            "DZoeGR_tatA",
        )
        self.assertIsNone(extract_video_id("not-a-real-id"))

    def test_clean_duplicates(self):
        cues = clean_cues(
            [
                TranscriptCue(0, 1, "Hello"),
                TranscriptCue(1, 1, "Hello"),
                TranscriptCue(2, 1, "  "),
                TranscriptCue(3, 1, "World"),
            ]
        )
        self.assertEqual([c.text for c in cues], ["Hello", "World"])
        self.assertEqual(cues_to_full_text(cues), "Hello World")

    def test_language_order(self):
        order = resolve_language_order(["fr", "en", "de"], preferred=["de"], original="fr")
        self.assertEqual(order[0], "de")
        self.assertEqual(order[1], "en")
        self.assertEqual(order[2], "fr")

    def test_provider_fallback(self):
        engine = TranscriptEngine(providers=[FakeFailProvider(), FakeSuccessProvider()])
        result = engine.retrieve("DZoeGR_tatA", use_cache=False)
        self.assertTrue(result.ok)
        self.assertEqual(result.metadata.provider_used, "fake-success")
        self.assertEqual(result.diagnostics[0].status, "failed")
        self.assertEqual(result.diagnostics[1].status, "success")

    def test_invalid_id(self):
        engine = TranscriptEngine(providers=[FakeSuccessProvider()])
        result = engine.retrieve("bad", use_cache=False)
        self.assertFalse(result.ok)
        self.assertEqual(result.error.code, "invalid_id")


if __name__ == "__main__":
    unittest.main()
