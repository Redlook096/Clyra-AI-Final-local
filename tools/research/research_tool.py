"""Lightweight web research: search, verify URLs, fetch readable text."""

from __future__ import annotations

import sys
from pathlib import Path

_TOOLS_ROOT = Path(__file__).resolve().parents[1]
if str(_TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TOOLS_ROOT))

import argparse
import json
import re
import sys
from typing import Any
from urllib.parse import urlparse

import httpx

try:
    from ddgs import DDGS
except ImportError:  # pragma: no cover - legacy package name
    from duckduckgo_search import DDGS  # type: ignore[no-redef]

try:
    import trafilatura
except ImportError:
    trafilatura = None  # type: ignore[assignment]

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None  # type: ignore[assignment,misc]

DEFAULT_TIMEOUT = 20.0
USER_AGENT = (
    "Mozilla/5.0 (compatible; AgentCanvasResearch/1.0; +https://github.com/OpenHands)"
)


def _normalize_url(url: str) -> str:
    cleaned = url.strip()
    if not cleaned:
        raise ValueError("URL is required")
    if not re.match(r"^https?://", cleaned, re.I):
        cleaned = f"https://{cleaned}"
    return cleaned


def search_web(query: str, max_results: int = 8) -> list[dict[str, str]]:
    if not query.strip():
        raise ValueError("Query is required")

    max_results = max(1, min(int(max_results), 20))
    results: list[dict[str, str]] = []

    with DDGS() as ddgs:
        for item in ddgs.text(query, max_results=max_results):
            if not isinstance(item, dict):
                continue
            href = str(item.get("href") or item.get("url") or "").strip()
            if not href:
                continue
            results.append(
                {
                    "title": str(item.get("title") or "").strip(),
                    "url": href,
                    "snippet": str(item.get("body") or item.get("snippet") or "").strip(),
                }
            )

    return results


def verify_url(url: str, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    normalized = _normalize_url(url)
    with httpx.Client(
        follow_redirects=True,
        timeout=timeout,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        response = client.get(normalized)

    content_type = response.headers.get("content-type", "")
    return {
        "url": str(response.url),
        "ok": response.status_code < 400,
        "status_code": response.status_code,
        "content_type": content_type,
        "final_url": str(response.url),
    }


def _extract_with_bs4(html: str) -> str:
    if BeautifulSoup is None:
        return ""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = soup.get_text("\n", strip=True)
    return re.sub(r"\n{3,}", "\n\n", text)


def fetch_url(url: str, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    normalized = _normalize_url(url)
    with httpx.Client(
        follow_redirects=True,
        timeout=timeout,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        response = client.get(normalized)
        response.raise_for_status()
        html = response.text

    title = ""
    text = ""
    if trafilatura is not None:
        downloaded = trafilatura.extract(
            html,
            url=str(response.url),
            include_comments=False,
            include_tables=True,
            output_format="txt",
        )
        metadata = trafilatura.extract_metadata(html, default_url=str(response.url))
        if metadata and metadata.title:
            title = metadata.title
        if downloaded:
            text = downloaded.strip()

    if not text:
        text = _extract_with_bs4(html)

    if not title and BeautifulSoup is not None:
        soup = BeautifulSoup(html, "lxml")
        if soup.title and soup.title.string:
            title = soup.title.string.strip()

    return {
        "url": str(response.url),
        "title": title,
        "text": text[:12000],
        "length": len(text),
    }


def research_topic(query: str, max_results: int = 5) -> dict[str, Any]:
    hits = search_web(query, max_results=max_results)
    verified: list[dict[str, Any]] = []

    for hit in hits:
        url = hit["url"]
        entry: dict[str, Any] = {**hit}
        try:
            host = urlparse(url).netloc.lower()
            entry["verify"] = verify_url(url)
            if entry["verify"].get("ok"):
                fetched = fetch_url(url)
                entry["fetch"] = {
                    "title": fetched.get("title"),
                    "text_preview": str(fetched.get("text", ""))[:1500],
                }
            entry["host"] = host
        except Exception as exc:  # noqa: BLE001
            entry["error"] = str(exc)
        verified.append(entry)

    return {
        "query": query,
        "result_count": len(verified),
        "results": verified,
    }


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Agent Canvas research CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    search_p = sub.add_parser("search", help="DuckDuckGo web search")
    search_p.add_argument("query")
    search_p.add_argument("max_results", nargs="?", type=int, default=8)

    verify_p = sub.add_parser("verify", help="HEAD/GET verify a URL")
    verify_p.add_argument("url")

    fetch_p = sub.add_parser("fetch", help="Fetch readable page text")
    fetch_p.add_argument("url")

    research_p = sub.add_parser("research", help="Search + verify + fetch top hits")
    research_p.add_argument("query")
    research_p.add_argument("max_results", nargs="?", type=int, default=5)

    args = parser.parse_args()

    try:
        if args.command == "search":
            payload = {"results": search_web(args.query, args.max_results)}
        elif args.command == "verify":
            payload = verify_url(args.url)
        elif args.command == "fetch":
            payload = fetch_url(args.url)
        else:
            payload = research_topic(args.query, args.max_results)
        print(json.dumps(payload, indent=2))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"success": False, "error": str(exc)}, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(_cli())
