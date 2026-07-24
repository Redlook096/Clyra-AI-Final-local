"""Download images into public/images/{slug}/ via icrawler or DDGS fallback."""

from __future__ import annotations

import concurrent.futures
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

import httpx

DEFAULT_MAX_IMAGES = 6
MAX_IMAGES_CAP = 12
DEFAULT_TIMEOUT_SECONDS = 40
DOWNLOAD_TIMEOUT = 15.0
USER_AGENT = "Mozilla/5.0 (compatible; AgentCanvasImageDownloader/1.0)"


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")[:70] or "images"


def _to_web_path(path: str) -> str:
    normalized = path.replace("\\", "/")
    return normalized if normalized.startswith("/") else f"/{normalized}"


def _extension_from_url(url: str, content_type: str = "") -> str:
    path = urlparse(url).path.lower()
    for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        if path.endswith(ext):
            return ext if ext != ".jpeg" else ".jpg"
    if "png" in content_type:
        return ".png"
    if "webp" in content_type:
        return ".webp"
    if "gif" in content_type:
        return ".gif"
    return ".jpg"


def _list_image_files(folder: Path) -> list[str]:
    return sorted(
        _to_web_path(str(path))
        for path in folder.iterdir()
        if path.is_file()
    )


def _run_icrawler(folder: Path, query: str, max_images: int) -> None:
    from icrawler.builtin import GoogleImageCrawler

    crawler = GoogleImageCrawler(
        feeder_threads=1,
        parser_threads=1,
        downloader_threads=4,
        storage={"root_dir": str(folder)},
    )
    crawler.crawl(
        keyword=query,
        filters={"size": "medium"},
        max_num=max_images,
        file_idx_offset=0,
    )


def _download_via_ddgs(folder: Path, query: str, max_images: int) -> list[str]:
    try:
        from ddgs import DDGS
    except ImportError:  # pragma: no cover
        from duckduckgo_search import DDGS  # type: ignore[no-redef]

    image_urls: list[str] = []
    with DDGS() as ddgs:
        for item in ddgs.images(query, max_results=max_images * 2):
            if not isinstance(item, dict):
                continue
            url = str(item.get("image") or item.get("url") or "").strip()
            if url.startswith(("http://", "https://")):
                image_urls.append(url)
            if len(image_urls) >= max_images:
                break

    saved: list[str] = []
    if not image_urls:
        return saved

    with httpx.Client(
        follow_redirects=True,
        timeout=DOWNLOAD_TIMEOUT,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        for idx, url in enumerate(image_urls, start=1):
            if len(saved) >= max_images:
                break
            try:
                response = client.get(url)
                if response.status_code >= 400:
                    continue
                content_type = response.headers.get("content-type", "")
                if content_type and not content_type.startswith("image/"):
                    continue
                ext = _extension_from_url(url, content_type)
                dest = folder / f"{idx:06d}{ext}"
                dest.write_bytes(response.content)
                saved.append(_to_web_path(str(dest)))
            except Exception:
                continue

    return saved


def download_google_images(
    query: str,
    max_images: int = DEFAULT_MAX_IMAGES,
    output_base: str = "public/images",
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
):
    if not query or not query.strip():
        raise ValueError("Query is required")

    max_images = max(1, min(int(max_images), MAX_IMAGES_CAP))

    folder = Path(output_base) / slugify(query)
    folder.mkdir(parents=True, exist_ok=True)

    icrawler_error: str | None = None
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(_run_icrawler, folder, query, max_images)
            try:
                future.result(timeout=timeout_seconds)
            except concurrent.futures.TimeoutError as exc:
                icrawler_error = f"icrawler timed out after {timeout_seconds}s"
                raise TimeoutError(icrawler_error) from exc
    except Exception as exc:  # noqa: BLE001
        icrawler_error = str(exc)

    files = _list_image_files(folder)
    source = "icrawler"

    if len(files) < max_images:
        ddgs_files = _download_via_ddgs(folder, query, max_images)
        if ddgs_files:
            files = _list_image_files(folder)
            source = "ddgs_fallback" if not files or icrawler_error else "icrawler+ddgs"

    if len(files) == 0 and icrawler_error:
        ddgs_only = _download_via_ddgs(folder, query, max_images)
        files = ddgs_only or _list_image_files(folder)
        source = "ddgs_fallback"

    result = {
        "success": len(files) > 0,
        "query": query,
        "folder": _to_web_path(str(folder)),
        "count": len(files),
        "files": files,
        "source": source,
    }
    if len(files) == 0:
        result["error"] = icrawler_error or "No images downloaded"
    return result


if __name__ == "__main__":
    try:
        query = sys.argv[1]
        max_images = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MAX_IMAGES
        result = download_google_images(query, max_images)
        print(json.dumps(result, indent=2))
        sys.exit(0 if result.get("success") else 1)
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
