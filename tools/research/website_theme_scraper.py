"""Extract colors, typography, and layout cues from a verified website."""

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
from collections import Counter
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

try:
    import tinycss2
except ImportError:
    tinycss2 = None  # type: ignore[assignment]

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None  # type: ignore[assignment,misc]

from research.research_tool import USER_AGENT, _normalize_url, verify_url

HEX_RE = re.compile(r"#(?:[0-9a-fA-F]{3,8})\b")
RGB_RE = re.compile(
    r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})",
    re.I,
)


def _rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


def _collect_hex_colors(text: str) -> list[str]:
    found: list[str] = []
    for match in HEX_RE.findall(text):
        value = match.lower()
        if len(value) == 4:
            value = "#" + "".join(ch * 2 for ch in value[1:])
        found.append(value)
    for match in RGB_RE.finditer(text):
        found.append(_rgb_to_hex(int(match[1]), int(match[2]), int(match[3])))
    return found


def _extract_css_vars(css_text: str) -> dict[str, str]:
    variables: dict[str, str] = {}
    if not css_text:
        return variables
    for match in re.finditer(
        r"--([a-zA-Z0-9_-]+)\s*:\s*([^;}{]+)",
        css_text,
    ):
        variables[f"--{match.group(1)}"] = match.group(2).strip()
    return variables


def _font_families(css_text: str, html: str) -> list[str]:
    families: list[str] = []
    for match in re.finditer(r"font-family\s*:\s*([^;}{]+)", css_text, re.I):
        raw = match.group(1).strip().strip('"').strip("'")
        if raw:
            families.append(raw.split(",")[0].strip().strip('"').strip("'"))
    if BeautifulSoup is not None:
        soup = BeautifulSoup(html, "lxml")
        for link in soup.find_all("link", href=True):
            href = str(link.get("href", ""))
            if "fonts.googleapis.com" in href:
                families.append(href)
    return list(dict.fromkeys(families))[:12]


def _structure(soup: Any) -> dict[str, Any]:
    nav_links: list[str] = []
    nav = soup.find("nav")
    if nav:
        for a in nav.find_all("a", href=True):
            label = a.get_text(" ", strip=True)
            if label:
                nav_links.append(label[:80])

    headings = [
        el.get_text(" ", strip=True)[:120]
        for el in soup.find_all(re.compile(r"^h[1-3]$", re.I))
        if el.get_text(strip=True)
    ][:12]

    buttons = [
        el.get_text(" ", strip=True)[:80]
        for el in soup.find_all(["button", "a"], class_=re.compile(r"btn|button|cta", re.I))
        if el.get_text(strip=True)
    ][:12]

    sections = [
        (el.get("id") or el.get("class", [""])[0] if el.get("class") else el.name or "section")
        for el in soup.find_all("section")
    ][:12]

    return {
        "nav_links": nav_links,
        "headings": headings,
        "buttons": buttons,
        "sections": [str(s) for s in sections if s],
        "layout_notes": (
            "dark" if soup.find(class_=re.compile(r"dark|theme-dark", re.I)) else "unknown"
        ),
    }


def _primary_section(soup: Any) -> Any | None:
    for selector in ["main section", "main > div", "header", "[class*=hero i]", "section"]:
        node = soup.select_one(selector)
        if node is not None:
            return node
    return None


def _describe_background(css_text: str, colors: list[str], theme_color: str) -> str:
    lowered = css_text.lower()
    if "gradient" in lowered:
        return "gradient"
    palette = [theme_color, *colors[:4]]
    dark_hits = sum(
        1
        for color in palette
        if color and color.startswith("#") and len(color) >= 7 and int(color[1:3], 16) < 80
    )
    light_hits = sum(
        1
        for color in palette
        if color and color.startswith("#") and len(color) >= 7 and int(color[1:3], 16) > 180
    )
    if dark_hits >= 2:
        return "dark solid"
    if light_hits >= 2:
        return "light solid"
    return "mixed"


def _infer_spacing_density(css_text: str) -> str:
    spacing_values = [
        int(match.group(1))
        for match in re.finditer(r"(?:padding|margin|gap)\s*:\s*(\d+)px", css_text, re.I)
    ]
    if not spacing_values:
        return "unknown"
    average = sum(spacing_values[:120]) / len(spacing_values[:120])
    if average >= 28:
        return "spacious"
    if average <= 12:
        return "compact"
    return "balanced"


def _infer_shape_language(css_text: str) -> dict[str, str]:
    radii = [
        int(match.group(1))
        for match in re.finditer(r"border-radius\s*:\s*(\d+)px", css_text, re.I)
    ]
    average_radius = (sum(radii[:120]) / len(radii[:120])) if radii else 0
    lowered = css_text.lower()
    button_style = "filled"
    if "backdrop-filter" in lowered or "glass" in lowered:
        button_style = "glass"
    elif "outline" in lowered or "border:" in lowered:
        button_style = "outlined"
    elif "gradient" in lowered:
        button_style = "gradient"

    if average_radius >= 22:
        geometry = "pill"
    elif average_radius >= 10:
        geometry = "rounded rectangle"
    elif average_radius > 0:
        geometry = "soft rectangle"
    else:
        geometry = "sharp"

    card_style = "bordered" if "border:" in lowered else "flat"
    if "box-shadow" in lowered:
        card_style = "shadowed"
    if "backdrop-filter" in lowered:
        card_style = "glass"

    return {
        "buttons": f"{geometry} / {button_style}",
        "cards": card_style,
        "containers": (
            "centered max width"
            if re.search(r"max-width\s*:\s*(?:1[01]\d{2}|12\d{2})px", lowered)
            else "full width"
        ),
    }


def _infer_brand_identity(
    title: str,
    headings: list[str],
    source_host: str,
    colors: list[str],
) -> dict[str, str]:
    text = " ".join([title, *headings[:8], source_host]).lower()
    personality = "consumer"
    audience = "broad audience"
    feeling = "informative"
    if re.search(r"developer|api|sdk|docs|cli|code|terminal", text):
        personality = "developer-focused"
        audience = "developers and technical teams"
        feeling = "precise"
    elif re.search(r"enterprise|security|platform|cloud|workflow|team", text):
        personality = "enterprise"
        audience = "business teams"
        feeling = "trustworthy"
    elif re.search(r"game|wars|xbox|playstation|battle|campaign|hero", text):
        personality = "futuristic"
        audience = "players and fans"
        feeling = "cinematic"
    elif re.search(r"luxury|collection|atelier|signature", text):
        personality = "luxury"
        audience = "premium consumers"
        feeling = "editorial"
    elif len(colors) > 0 and any(color in {"#000000", "#111111", "#050505"} for color in colors[:4]):
        personality = "minimal"
        feeling = "premium"

    return {
        "personality": personality,
        "target_audience": audience,
        "emotional_feeling": feeling,
    }


def _extract_layout_blueprint(soup: Any, structure: dict[str, Any]) -> dict[str, Any]:
    hero = _primary_section(soup)
    hero_text = hero.get_text(" ", strip=True)[:320] if hero is not None else ""
    images = hero.find_all(["img", "picture", "video"]) if hero is not None else []
    links = hero.find_all(["a", "button"]) if hero is not None else []
    hero_layout = "centered"
    if len(images) >= 1 and len(hero.find_all(recursive=False)) >= 2 if hero is not None else False:
        hero_layout = "split"
    elif len(images) == 0 and len(hero_text.split()) > 20:
        hero_layout = "editorial"

    section_order = structure.get("sections") or []
    section_density = "dense" if len(section_order) >= 7 else "balanced"

    return {
        "navigation": {
            "alignment": "logo left / nav right" if structure.get("nav_links") else "minimal",
            "link_count": len(structure.get("nav_links") or []),
            "style": "transparent overlay" if hero_layout in {"split", "centered"} else "solid",
        },
        "hero": {
            "layout": hero_layout,
            "cta_count": min(len(links), 3),
            "media_count": len(images),
            "text_alignment": "center" if hero_layout == "centered" else "left",
        },
        "sections": {
            "count": len(section_order),
            "order": section_order,
            "content_density": section_density,
            "visual_rhythm": "spacious" if len(section_order) <= 5 else "modular",
        },
    }


def scrape_website_theme(url: str, timeout: float = 25.0) -> dict[str, Any]:
    if BeautifulSoup is None:
        raise RuntimeError("beautifulsoup4 is required")

    normalized = _normalize_url(url)
    verification = verify_url(normalized, timeout=timeout)
    if not verification.get("ok"):
        raise ValueError(f"URL not reachable: {verification}")

    with httpx.Client(
        follow_redirects=True,
        timeout=timeout,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        response = client.get(normalized)
        response.raise_for_status()
        html = response.text
        base_url = str(response.url)

    soup = BeautifulSoup(html, "lxml")
    inline_css = "\n".join(
        style.get_text() for style in soup.find_all("style") if style.get_text()
    )

    linked_css: list[str] = []
    for link in soup.find_all("link", rel=True, href=True):
        rel = " ".join(link.get("rel", [])).lower()
        if "stylesheet" not in rel:
            continue
        href = urljoin(base_url, str(link["href"]))
        try:
            with httpx.Client(timeout=timeout, headers={"User-Agent": USER_AGENT}) as client:
                css_response = client.get(href)
                if css_response.status_code < 400:
                    linked_css.append(css_response.text[:50000])
        except Exception:
            continue

    css_blob = "\n".join([inline_css, *linked_css])
    color_counts = Counter(_collect_hex_colors(css_blob + html))
    top_colors = [color for color, _ in color_counts.most_common(12)]

    theme_color = ""
    meta_theme = soup.find("meta", attrs={"name": re.compile(r"theme-color", re.I)})
    if meta_theme and meta_theme.get("content"):
        theme_color = str(meta_theme["content"]).strip()

    css_vars = _extract_css_vars(css_blob)
    fonts = _font_families(css_blob, html)
    structure = _structure(soup)

    title = soup.title.get_text(strip=True) if soup.title else ""
    visual_system = {
        "primary_colors": top_colors[:3],
        "secondary_colors": top_colors[3:6],
        "background_style": _describe_background(css_blob, top_colors, theme_color),
        "contrast": "high"
        if any(color in {"#000000", "#ffffff", "#050505"} for color in top_colors[:4])
        else "medium",
        "typography": {
            "primary_font": fonts[0] if fonts else "",
            "font_stack": fonts[:4],
            "spacing_density": _infer_spacing_density(css_blob),
        },
        "shape_language": _infer_shape_language(css_blob),
    }
    brand_identity = _infer_brand_identity(
        title,
        structure.get("headings", []),
        urlparse(base_url).netloc,
        top_colors,
    )
    layout_blueprint = _extract_layout_blueprint(soup, structure)

    return {
        "success": True,
        "url": base_url,
        "title": title,
        "theme_color": theme_color,
        "colors": top_colors,
        "css_variables": css_vars,
        "fonts": fonts,
        "structure": structure,
        "source_host": urlparse(base_url).netloc,
        "brand_identity": brand_identity,
        "visual_system": visual_system,
        "layout_blueprint": layout_blueprint,
    }


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Scrape website theme tokens")
    parser.add_argument("url")
    args = parser.parse_args()

    try:
        result = scrape_website_theme(args.url)
        print(json.dumps(result, indent=2))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"success": False, "error": str(exc)}, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(_cli())
