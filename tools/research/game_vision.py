"""Visual analysis helpers for game remake fidelity.

Uses an OpenAI-compatible vision LLM when VISION_API_KEY / VISION_BASE_URL /
VISION_MODEL (or DEEPSEEK_VISION_*) are set. Falls back to Pillow-based color /
layout analysis so text-only models (e.g. DeepSeek V4) still get a structured
visual brief to drive UI matching.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore[misc, assignment]


SUPPORTED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def _vision_config() -> dict[str, str | None]:
    api_key = (
        os.environ.get("VISION_API_KEY", "").strip()
        or os.environ.get("OPENAI_API_KEY", "").strip()
        or os.environ.get("DEEPSEEK_VISION_API_KEY", "").strip()
    )
    base_url = (
        os.environ.get("VISION_BASE_URL", "").strip()
        or os.environ.get("DEEPSEEK_VISION_BASE_URL", "").strip()
        or os.environ.get("OPENAI_BASE_URL", "").strip()
        or "https://api.openai.com/v1"
    )
    model = (
        os.environ.get("VISION_MODEL", "").strip()
        or os.environ.get("DEEPSEEK_VISION_MODEL", "").strip()
        or "gpt-4o-mini"
    )
    return {"api_key": api_key or None, "base_url": base_url.rstrip("/"), "model": model}


def _data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def _quantize_color(rgb: tuple[int, int, int], step: int = 32) -> str:
    r, g, b = rgb
    return "#{:02x}{:02x}{:02x}".format(
        (r // step) * step,
        (g // step) * step,
        (b // step) * step,
    )


def analyze_image_local(path: Path) -> dict[str, Any]:
    """Pillow-based visual brief (works without a vision LLM)."""
    if Image is None:
        return {
            "path": str(path),
            "error": "Pillow not installed — pip install pillow",
        }
    if not path.is_file():
        return {"path": str(path), "error": "file not found"}

    with Image.open(path) as img:
        rgb = img.convert("RGB")
        w, h = rgb.size
        # Sample for speed
        sample = rgb.resize((max(1, w // 8), max(1, h // 8)))
        pixels = list(sample.getdata())
        counts = Counter(_quantize_color(p) for p in pixels)
        top = [{"hex": c, "share": round(n / max(1, len(pixels)), 3)} for c, n in counts.most_common(8)]

        # Region averages: top / mid / bottom thirds
        regions: dict[str, str] = {}
        for name, y0, y1 in (
            ("top", 0, h // 3),
            ("middle", h // 3, 2 * h // 3),
            ("bottom", 2 * h // 3, h),
        ):
            crop = rgb.crop((0, y0, w, y1)).resize((32, 16))
            data = list(crop.getdata())
            avg = tuple(
                sum(p[i] for p in data) // max(1, len(data)) for i in range(3)
            )
            regions[name] = "#{:02x}{:02x}{:02x}".format(*avg)

        # Edge brightness heuristic (UI chrome often high-contrast borders)
        edge = rgb.crop((0, 0, w, max(1, h // 20)))
        edge_data = list(edge.resize((64, 4)).getdata())
        edge_lum = sum(0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2] for p in edge_data) / max(
            1, len(edge_data)
        )

    return {
        "path": str(path),
        "width": w,
        "height": h,
        "aspect": round(w / max(1, h), 3),
        "dominant_colors": top,
        "region_avg_colors": regions,
        "top_edge_luminance": round(edge_lum, 1),
        "notes": _heuristic_notes(top, regions, edge_lum),
    }


def _heuristic_notes(
    top: list[dict[str, Any]],
    regions: dict[str, str],
    edge_lum: float,
) -> list[str]:
    notes: list[str] = []
    if top:
        notes.append(f"Dominant palette led by {top[0]['hex']} ({top[0]['share'] * 100:.0f}%).")
    if regions.get("top") and regions.get("bottom"):
        notes.append(
            f"Vertical color bands — top {regions['top']}, mid {regions['middle']}, bottom {regions['bottom']}."
        )
    if edge_lum > 180:
        notes.append("Bright top edge — possible light HUD / sky / title bar.")
    elif edge_lum < 40:
        notes.append("Very dark top edge — night scene, dark menu, or vignette.")
    browns = [c for c in top if c["hex"][1:3] > c["hex"][5:7] and c["hex"][3:5] < "a0"]
    if browns:
        notes.append("Warm brown tones present — dirt / wood / military camo possible.")
    yellows = [
        c
        for c in top
        if c["hex"][1:3] >= "c0" and c["hex"][3:5] >= "a0" and c["hex"][5:7] <= "66"
    ]
    if yellows:
        notes.append("Yellow/gold accents — title splash or highlight UI likely.")
    return notes


def call_vision_llm(
    prompt: str,
    image_paths: list[Path],
    *,
    timeout: float = 90.0,
) -> dict[str, Any]:
    cfg = _vision_config()
    if not cfg["api_key"]:
        print(
            "[game_vision] FALLBACK MODE: no VISION_API_KEY / DEEPSEEK_VISION_* — "
            "using Pillow + genre briefs (not a real vision LLM).",
            flush=True,
        )
        return {
            "ok": False,
            "reason": "no_vision_api",
            "fallback_mode": "pillow_local",
            "hint": (
                "Set VISION_API_KEY + VISION_BASE_URL + VISION_MODEL "
                "(OpenAI-compatible multimodal), or DEEPSEEK_VISION_BASE_URL "
                "for a self-hosted DeepSeek-VL / Qwen2.5-VL / GLM-4.6V endpoint. "
                "DeepSeek hosted V4 is text-only."
            ),
        }

    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for path in image_paths:
        if path.is_file():
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": _data_url(path)},
                }
            )

    url = f"{cfg['base_url']}/chat/completions"
    payload = {
        "model": cfg["model"],
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 1200,
        "temperature": 0.2,
    }
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
        text = data["choices"][0]["message"]["content"]
        print(
            f"[game_vision] REAL VISION active: model={cfg['model']} base={cfg['base_url']}",
            flush=True,
        )
        return {
            "ok": True,
            "model": cfg["model"],
            "base_url": cfg["base_url"],
            "analysis": text,
            "fallback_mode": None,
        }
    except Exception as exc:  # noqa: BLE001
        print(
            f"[game_vision] FALLBACK MODE: vision request failed ({exc}) — Pillow only.",
            flush=True,
        )
        return {
            "ok": False,
            "reason": "vision_request_failed",
            "error": str(exc),
            "fallback_mode": "pillow_local",
        }


def _detect_genre(paths: list[str], focus: str | None = None) -> str | None:
    blob = " ".join(paths) + " " + (focus or "")
    blob_l = blob.lower()
    if any(k in blob_l for k in ("minecraft", "voxel", "dirt", "hotbar", "creeper")):
        return "minecraft"
    if any(k in blob_l for k in ("call of duty", "mw3", "cod ", "fps", "crosshair")):
        return "fps"
    return None


def _genre_reference_brief(genre: str | None) -> list[str]:
    """Actionable UI/gameplay brief when a real vision LLM is unavailable."""
    if genre == "minecraft":
        return [
            "CLASSIC MINECRAFT TITLE (must match): dirt/grass panorama or dirt-tiled background; "
            "large yellow Minecraft-style logo with dark outline; centered stone-gray buttons "
            "(Singleplayer, Multiplayer, Options, Quit) with beveled 3D edges and darker hover.",
            "OPTIONS/GRAPHICS: same stone button chrome; sliders or rows for FOV, Render Distance, "
            "Graphics Quality, Fog, Sensitivity, Volume — not a modern dark SaaS panel.",
            "IN-GAME HUD: centered crosshair (+); bottom 9-slot hotbar with dark translucent bar "
            "and selected-slot highlight; hearts/hunger optional; no modern glassmorphism.",
            "PAUSE (Esc): Game Menu overlay with Resume / Options / Title Screen stone buttons.",
            "INVENTORY (E): 2D panel with slots, not a floating card UI.",
            "WORLD LOOK: 16×16 nearest-neighbor block atlas from Canvas painting; mesher AO in "
            "corners; slow day/night; custom GLSL sky (not solid color clear).",
            "AUDIO: WebAudio dig/place/step/UI clicks — no binary audio files.",
        ]
    if genre == "fps":
        return [
            "Military FPS HUD: minimap/compass, ammo counter, stance indicator, crosshair or iron sights.",
            "Main/lobby menu: dark military chrome matching references — not generic purple UI.",
            "Post FX: fog, color grade, vignette via GLSL; Options → Graphics from title and pause.",
            "Audio: synthesized gun/UI cues via WebAudio.",
        ]
    return []


def _merge_build_brief(
    local: list[dict[str, Any]],
    vision: dict[str, Any],
    *,
    genre: str | None = None,
) -> str:
    lines = ["## Visual build brief (from reference screenshots)"]
    if vision.get("ok"):
        lines.append("### Vision model analysis (REAL VISION)")
        lines.append(str(vision.get("analysis", "")).strip())
    else:
        lines.append(
            f"### ⚠ FALLBACK MODE — Vision LLM unavailable "
            f"({vision.get('reason', 'unknown')}) — NOT real image understanding"
        )
        if vision.get("hint"):
            lines.append(vision["hint"])
        lines.append(
            "Treat local color/layout signals + genre brief below as the build brief. "
            "Still download screenshots and iterate with compare mode."
        )
    genre_lines = _genre_reference_brief(genre)
    if genre_lines:
        lines.append(f"### Genre fidelity brief ({genre})")
        for item in genre_lines:
            lines.append(f"- {item}")
    lines.append("### Local color / layout signals")
    for item in local:
        if item.get("error"):
            lines.append(f"- {item.get('path')}: {item['error']}")
            continue
        lines.append(
            f"- {item.get('path')}: {item.get('width')}x{item.get('height')}, "
            f"colors={[c['hex'] for c in item.get('dominant_colors', [])[:4]]}, "
            f"regions={item.get('region_avg_colors')}"
        )
        for note in item.get("notes", []):
            lines.append(f"  - {note}")
    lines.append(
        "Use this brief to match UI chrome, HUD, menus, and atmosphere. "
        "Prefer custom GLSL shaders and detailed Canvas2D / atlas textures over flat colors."
    )
    return "\n".join(lines)


def capture_preview_screenshot(preview_url: str, out_path: Path) -> dict[str, Any]:
    """Capture a page screenshot with Playwright if available."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {
            "ok": False,
            "error": "playwright not installed — agent should screenshot via browser tools or pip install playwright",
        }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 720})
            page.goto(preview_url, wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(2500)
            page.screenshot(path=str(out_path), full_page=False)
            browser.close()
        return {"ok": True, "path": str(out_path)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def resolve_image_paths(paths: list[str], *, cwd: Path | None = None) -> list[Path]:
    root = cwd or Path.cwd()
    resolved: list[Path] = []
    for raw in paths:
        p = Path(raw)
        if not p.is_absolute():
            p = (root / p).resolve()
        if p.is_dir():
            for child in sorted(p.rglob("*")):
                if child.suffix.lower() in SUPPORTED_SUFFIXES and child.is_file():
                    resolved.append(child)
        elif p.is_file():
            resolved.append(p)
    return resolved


def inspect_references(paths: list[str], *, question: str | None = None, focus: str | None = None) -> dict[str, Any]:
    files = resolve_image_paths(paths)
    local = [analyze_image_local(p) for p in files[:8]]
    genre = _detect_genre(paths + [str(p) for p in files], focus)
    prompt = question or (
        "You are helping remake a video game UI 1:1. Describe each screenshot: "
        "layout regions, colors, typography feel, HUD elements, button chrome, "
        "crosshair, menus, and anything the remake must match. Be specific and actionable."
    )
    vision = call_vision_llm(prompt, files[:4]) if files else {
        "ok": False,
        "reason": "no_images",
        "fallback_mode": "pillow_local",
    }
    return {
        "success": bool(files),
        "mode": "inspect",
        "files": [str(p) for p in files],
        "genre_detected": genre,
        "vision_fallback": not bool(vision.get("ok")),
        "local_analysis": local,
        "vision": vision,
        "build_brief": _merge_build_brief(local, vision, genre=genre),
    }


def compare_images(
    reference_paths: list[str],
    candidate_paths: list[str],
    *,
    focus: str | None = None,
) -> dict[str, Any]:
    refs = resolve_image_paths(reference_paths)[:4]
    cands = resolve_image_paths(candidate_paths)[:4]
    ref_local = [analyze_image_local(p) for p in refs]
    cand_local = [analyze_image_local(p) for p in cands]
    genre = _detect_genre(
        reference_paths + candidate_paths + [str(p) for p in refs],
        focus,
    )

    mismatches = _local_mismatches(ref_local, cand_local)
    # Genre checklist mismatches when vision unavailable
    if genre == "minecraft":
        for item in cand_local:
            notes = " ".join(item.get("notes", [])).lower()
            colors = {c["hex"] for c in item.get("dominant_colors", [])[:5]}
            # Yellow/gold title accent heuristic
            has_warm = any(
                c[1:3] >= "a0" and c[3:5] >= "80" and c[5:7] <= "66" for c in colors
            )
            if not has_warm and focus and "menu" in focus.lower():
                mismatches.append(
                    "Minecraft title likely missing yellow/gold logo accents vs classic splash"
                )
            if "dark" in notes and focus and "menu" in (focus or "").lower():
                mismatches.append(
                    "Menu appears very dark — classic Minecraft title uses dirt/grass warm tones, not pure black UI"
                )

    score = max(0, 100 - 12 * len(mismatches))

    prompt = (
        "Compare REFERENCE game screenshots to CANDIDATE remake screenshots. "
        "List concrete visual mismatches for UI/HUD/menu/gameplay look (layout, colors, "
        "chrome, typography, crosshair, hotbar, buttons, atmosphere). "
        "Rate fidelity 0-100. Focus: "
        + (focus or "overall UI and gameplay look")
        + ". Reply with: SCORE: N then bullet mismatches then FIX PRIORITIES."
    )
    vision = call_vision_llm(prompt, refs + cands) if refs and cands else {
        "ok": False,
        "reason": "missing_images",
        "fallback_mode": "pillow_local",
    }

    if vision.get("ok") and isinstance(vision.get("analysis"), str):
        m = re.search(r"SCORE:\s*(\d{1,3})", vision["analysis"], re.I)
        if m:
            score = max(score, min(100, int(m.group(1))))

    return {
        "success": bool(refs and cands),
        "mode": "compare",
        "genre_detected": genre,
        "vision_fallback": not bool(vision.get("ok")),
        "reference_files": [str(p) for p in refs],
        "candidate_files": [str(p) for p in cands],
        "fidelity_score": score,
        "local_reference": ref_local,
        "local_candidate": cand_local,
        "local_mismatches": mismatches,
        "vision": vision,
        "pass": score >= 75,
        "next_steps": mismatches[:6]
        or [
            "Iterate shaders/textures/UI chrome until vision score ≥ 75",
            "Re-capture preview and call game_vision_compare again",
        ],
        "genre_brief": _genre_reference_brief(genre),
    }


def _local_mismatches(
    refs: list[dict[str, Any]],
    cands: list[dict[str, Any]],
) -> list[str]:
    if not refs or not cands:
        return ["Missing reference or candidate images for comparison"]
    r, c = refs[0], cands[0]
    out: list[str] = []
    if "error" in r or "error" in c:
        return [r.get("error") or c.get("error") or "analysis error"]

    r_colors = {x["hex"] for x in r.get("dominant_colors", [])[:5]}
    c_colors = {x["hex"] for x in c.get("dominant_colors", [])[:5]}
    if r_colors and c_colors and len(r_colors & c_colors) == 0:
        out.append(
            f"Palette mismatch — reference colors {sorted(r_colors)[:4]} vs remake {sorted(c_colors)[:4]}"
        )

    for band in ("top", "middle", "bottom"):
        rb = r.get("region_avg_colors", {}).get(band)
        cb = c.get("region_avg_colors", {}).get(band)
        if rb and cb and rb[:3] != cb[:3]:
            # rough distance
            def lum(h: str) -> float:
                return int(h[1:3], 16) * 0.299 + int(h[3:5], 16) * 0.587 + int(h[5:7], 16) * 0.114

            if abs(lum(rb) - lum(cb)) > 55:
                out.append(f"{band.capitalize()} region brightness differs (ref {rb} vs remake {cb})")

    if abs(r.get("aspect", 1) - c.get("aspect", 1)) > 0.35:
        out.append("Aspect ratio / framing differs significantly from reference")

    return out


def is_probably_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
    except Exception:  # noqa: BLE001
        return False


def run_game_vision(
    *,
    mode: str,
    reference_paths: list[str] | None = None,
    candidate_paths: list[str] | None = None,
    preview_url: str | None = None,
    focus: str | None = None,
    question: str | None = None,
    capture_out: str | None = None,
) -> dict[str, Any]:
    refs = reference_paths or []
    cands = list(candidate_paths or [])

    if preview_url and is_probably_url(preview_url):
        out = Path(capture_out or "public/images/game-preview-capture/preview.png")
        cap = capture_preview_screenshot(preview_url, out)
        if cap.get("ok"):
            cands.append(str(out))
        else:
            # still continue with provided candidates
            pass
        capture_meta = cap
    else:
        capture_meta = None

    if mode == "inspect":
        result = inspect_references(refs, question=question, focus=focus)
    elif mode == "compare":
        result = compare_images(refs, cands, focus=focus)
    else:
        result = {"success": False, "error": f"Unknown mode: {mode}"}

    if capture_meta is not None:
        result["capture"] = capture_meta
    result["vision_config"] = {
        k: (v if k != "api_key" else ("set" if v else None))
        for k, v in _vision_config().items()
    }
    if result.get("vision_fallback"):
        print(
            "[game_vision] RESULT marked vision_fallback=true — agent must still follow genre brief.",
            flush=True,
        )
    return result
