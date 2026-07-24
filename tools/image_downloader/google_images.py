"""Download images from Google Images into public/images/{slug}/."""

from __future__ import annotations

import concurrent.futures
import json
import re
import sys
from pathlib import Path

from icrawler.builtin import GoogleImageCrawler

DEFAULT_MAX_IMAGES = 6
MAX_IMAGES_CAP = 12
DEFAULT_TIMEOUT_SECONDS = 40


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")[:70] or "images"


def _to_web_path(path: str) -> str:
    normalized = path.replace("\\", "/")
    return normalized if normalized.startswith("/") else f"/{normalized}"


def _run_crawl(crawler: GoogleImageCrawler, query: str, max_images: int) -> None:
    crawler.crawl(
        keyword=query,
        filters={"size": "medium"},
        max_num=max_images,
        file_idx_offset=0,
    )


def download_google_images(
    query: str,
    max_images: int = DEFAULT_MAX_IMAGES,
    output_base: str = "public/images",
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> dict:
    if not query or not query.strip():
        raise ValueError("Query is required")

    max_images = max(1, min(int(max_images), MAX_IMAGES_CAP))

    folder = Path(output_base) / slugify(query)
    folder.mkdir(parents=True, exist_ok=True)

    crawler = GoogleImageCrawler(
        feeder_threads=1,
        parser_threads=1,
        downloader_threads=4,
        storage={"root_dir": str(folder)},
    )

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(_run_crawl, crawler, query, max_images)
        try:
            future.result(timeout=timeout_seconds)
        except concurrent.futures.TimeoutError as exc:
            raise TimeoutError(
                f"Image download timed out after {timeout_seconds}s"
            ) from exc

    files = sorted(
        _to_web_path(str(path))
        for path in folder.iterdir()
        if path.is_file()
    )

    return {
        "success": True,
        "query": query,
        "folder": _to_web_path(str(folder)),
        "count": len(files),
        "files": files,
    }


if __name__ == "__main__":
    try:
        query = sys.argv[1]
        max_images = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MAX_IMAGES
        result = download_google_images(query, max_images)
        print(json.dumps(result, indent=2))
    except Exception as exc:  # noqa: BLE001
        print(
            json.dumps(
                {
                    "success": False,
                    "error": str(exc),
                },
                indent=2,
            )
        )
        sys.exit(1)
