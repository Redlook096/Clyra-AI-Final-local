"""Download a website favicon/logo into public/icons/."""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from PIL import Image

_TOOLS_ROOT = Path(__file__).resolve().parents[1]
if str(_TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TOOLS_ROOT))

DEFAULT_TIMEOUT = 12.0
USER_AGENT = (
    "Mozilla/5.0 (compatible; AgentCanvasIconDownloader/1.0; +https://github.com/OpenHands)"
)
ICON_SELECTORS = [
    ('link[rel="icon"]', "href"),
    ('link[rel="shortcut icon"]', "href"),
    ('link[rel="apple-touch-icon"]', "href"),
    ('link[rel="mask-icon"]', "href"),
    ('meta[property="og:image"]', "content"),
]
LOGO_IMG_SELECTORS = [
    ('img[alt*="logo" i]', "src"),
    ('img[src*="logo" i]', "src"),
    ('header img[alt]', "src"),
    ('nav img[alt]', "src"),
    ('a[aria-label*="logo" i] img', "src"),
]
LOGO_SVG_SELECTORS = [
    "header svg",
    "nav svg",
    'svg[aria-label*="logo" i]',
    '[class*="logo" i] svg',
]


def _normalize_url(url: str) -> str:
    cleaned = url.strip()
    if not cleaned:
        raise ValueError("URL is required")
    if not re.match(r"^https?://", cleaned, re.I):
        cleaned = f"https://{cleaned}"
    return cleaned


def _slugify_domain(url: str) -> str:
    host = urlparse(url).netloc.lower().replace("www.", "")
    slug = re.sub(r"[^a-z0-9]+", "-", host).strip("-")
    return slug or "site"


def _abs_url(base: str, candidate: str) -> str:
    return urljoin(base, candidate.strip())


def _detect_icon_urls(html: str, page_url: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    found: list[str] = []
    seen: set[str] = set()

    for selector, attr in ICON_SELECTORS:
        for node in soup.select(selector):
            value = node.get(attr)
            if not value or not isinstance(value, str):
                continue
            absolute = _abs_url(page_url, value)
            if absolute not in seen:
                seen.add(absolute)
                found.append(absolute)

    favicon_fallback = _abs_url(page_url, "/favicon.ico")
    if favicon_fallback not in seen:
        found.append(favicon_fallback)

    return found


def _text_score(value: str) -> int:
    score = 0
    lowered = value.lower()
    if "logo" in lowered:
        score += 5
    if "brand" in lowered or "wordmark" in lowered:
        score += 3
    if "icon" in lowered:
        score += 1
    return score


def _detect_logo_candidates(html: str, page_url: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    found: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    for selector, attr in LOGO_IMG_SELECTORS:
        for node in soup.select(selector):
            value = node.get(attr)
            if not value or not isinstance(value, str):
                continue
            absolute = _abs_url(page_url, value)
            if absolute in seen_urls:
                continue
            seen_urls.add(absolute)
            alt_text = str(node.get("alt") or "")
            class_text = " ".join(node.get("class", []))
            found.append(
                {
                    "kind": "img",
                    "url": absolute,
                    "score": 20 + _text_score(f"{selector} {alt_text} {class_text}"),
                    "selector": selector,
                    "alt_text": alt_text,
                }
            )

    for selector in LOGO_SVG_SELECTORS:
        for node in soup.select(selector):
            view_box = node.get("viewBox") or node.get("viewbox")
            if not view_box:
                continue
            class_text = " ".join(node.get("class", []))
            aria_label = str(node.get("aria-label") or "")
            svg_markup = str(node)
            found.append(
                {
                    "kind": "inline_svg",
                    "svg": svg_markup,
                    "score": 18 + _text_score(f"{selector} {aria_label} {class_text}"),
                    "selector": selector,
                    "alt_text": aria_label,
                }
            )

    return found


def _download_bytes(client: httpx.Client, url: str) -> bytes | None:
    try:
        response = client.get(url, follow_redirects=True)
        if response.status_code >= 400:
            return None
        content_type = response.headers.get("content-type", "")
        if "text/html" in content_type and not url.endswith(".ico"):
            return None
        data = response.content
        return data if data else None
    except httpx.HTTPError:
        return None


def _image_dimensions(data: bytes) -> tuple[int, int]:
    try:
        with Image.open(io.BytesIO(data)) as img:
            return img.size
    except Exception:
        return (0, 0)


def _pick_best(candidates: list[tuple[str, bytes]]) -> tuple[str, bytes] | None:
    if not candidates:
        return None

    scored: list[tuple[int, str, bytes]] = []
    for url, data in candidates:
        width, height = _image_dimensions(data)
        area = width * height
        score = area if area > 0 else len(data)
        if url.endswith(".ico"):
            score = max(score, 32 * 32)
        scored.append((score, url, data))

    scored.sort(key=lambda item: item[0], reverse=True)
    best = scored[0]
    return best[1], best[2]


def _pick_best_logo_candidate(
    candidates: list[dict[str, Any]],
    client: httpx.Client,
) -> tuple[dict[str, Any], bytes | None] | None:
    ranked: list[tuple[int, dict[str, Any], bytes | None]] = []
    for candidate in candidates:
        if candidate["kind"] == "inline_svg":
            ranked.append((int(candidate["score"]), candidate, None))
            continue

        url = str(candidate["url"])
        data = _download_bytes(client, url)
        if not data:
            continue
        width, height = _image_dimensions(data)
        area = width * height
        score = int(candidate["score"]) * 10 + area
        ranked.append((score, candidate, data))

    if not ranked:
        return None

    ranked.sort(key=lambda item: item[0], reverse=True)
    best_score, best_candidate, best_bytes = ranked[0]
    if best_score <= 0:
        return None
    return best_candidate, best_bytes


def download_site_icon(url: str, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    source_url = _normalize_url(url)
    icons_dir = Path.cwd() / "public" / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)

    headers = {"User-Agent": USER_AGENT}
    with httpx.Client(timeout=timeout, headers=headers) as client:
        try:
            page = client.get(source_url, follow_redirects=True)
            page.raise_for_status()
        except httpx.HTTPError as exc:
            return {
                "success": False,
                "source_url": source_url,
                "error": f"Failed to fetch page: {exc}",
            }

        page_url = str(page.url)
        logo_candidates = _detect_logo_candidates(page.text, page_url)
        best_logo = _pick_best_logo_candidate(logo_candidates, client)
        if best_logo:
            logo_candidate, logo_bytes = best_logo
            slug = _slugify_domain(page_url)
            if logo_candidate["kind"] == "inline_svg":
                local_path = icons_dir / f"{slug}-logo.svg"
                local_path.write_text(str(logo_candidate["svg"]), encoding="utf-8")
                rel_path = f"public/icons/{local_path.name}"
                return {
                    "success": True,
                    "source_url": source_url,
                    "icon_url": None,
                    "local_path": rel_path,
                    "width": 0,
                    "height": 0,
                    "asset_kind": "logo",
                    "selector": logo_candidate.get("selector"),
                    "alt_text": logo_candidate.get("alt_text"),
                }

            if logo_bytes:
                width, height = _image_dimensions(logo_bytes)
                icon_url = str(logo_candidate["url"])
                ext = ".png"
                if icon_url.lower().endswith(".svg"):
                    ext = ".svg"
                elif icon_url.lower().endswith(".webp"):
                    ext = ".webp"
                elif icon_url.lower().endswith(".gif"):
                    ext = ".gif"
                elif icon_url.lower().endswith(".jpg") or icon_url.lower().endswith(
                    ".jpeg"
                ):
                    ext = ".jpg"
                local_path = icons_dir / f"{slug}-logo{ext}"
                local_path.write_bytes(logo_bytes)
                rel_path = f"public/icons/{local_path.name}"
                return {
                    "success": True,
                    "source_url": source_url,
                    "icon_url": icon_url,
                    "local_path": rel_path,
                    "width": width,
                    "height": height,
                    "asset_kind": "logo",
                    "selector": logo_candidate.get("selector"),
                    "alt_text": logo_candidate.get("alt_text"),
                }

        icon_urls = _detect_icon_urls(page.text, page_url)

        downloaded: list[tuple[str, bytes]] = []
        for icon_url in icon_urls:
            data = _download_bytes(client, icon_url)
            if data:
                downloaded.append((icon_url, data))

        best = _pick_best(downloaded)
        if not best:
            return {
                "success": False,
                "source_url": source_url,
                "error": "No icon found in HTML or /favicon.ico",
            }

        icon_url, icon_bytes = best
        width, height = _image_dimensions(icon_bytes)
        slug = _slugify_domain(page_url)
        ext = ".png"
        if icon_url.lower().endswith(".svg"):
            ext = ".svg"
        elif icon_url.lower().endswith(".ico"):
            ext = ".png"
            try:
                with Image.open(io.BytesIO(icon_bytes)) as img:
                    out = io.BytesIO()
                    img.save(out, format="PNG")
                    icon_bytes = out.getvalue()
                    width, height = img.size
            except Exception:
                pass

        local_path = icons_dir / f"{slug}-icon{ext}"
        local_path.write_bytes(icon_bytes)
        rel_path = f"public/icons/{local_path.name}"

        return {
            "success": True,
            "source_url": source_url,
            "icon_url": icon_url,
            "local_path": rel_path,
            "width": width,
            "height": height,
            "asset_kind": "icon",
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Download a website icon")
    parser.add_argument("url", help="Website URL")
    args = parser.parse_args()
    result = download_site_icon(args.url)
    print(json.dumps(result, indent=2))
    if not result.get("success"):
        sys.exit(1)


if __name__ == "__main__":
    main()
