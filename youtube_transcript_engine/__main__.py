#!/usr/bin/env python3
"""CLI entrypoint — prints JSON TranscriptResult to stdout."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import List, Optional

from youtube_transcript_engine.manager import retrieve_transcript


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Retrieve a YouTube transcript")
    parser.add_argument("url_or_id", help="YouTube URL or 11-char video ID")
    parser.add_argument("--lang", action="append", dest="langs", default=[], help="Preferred language (repeatable)")
    parser.add_argument("--translate", default=None, help="Optional translation language code")
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    result = retrieve_transcript(
        args.url_or_id,
        preferred_languages=args.langs or ["en"],
        translate_to=args.translate,
        use_cache=not args.no_cache,
    )
    print(json.dumps(result.to_dict(), ensure_ascii=False))
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
