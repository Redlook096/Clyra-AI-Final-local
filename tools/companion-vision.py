#!/usr/bin/env python3
"""Lightweight screen vision for Clyra Screen Companion.

Uses RapidOCR (ONNX, Apache-2.0) + Pillow for a lightning-fast, 8GB-RAM-safe
description of what's on screen. No PyTorch / large VLM required.
Optional VISION_* multimodal endpoint can refine the brief when configured.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore

_OCR = None


def _ocr_engine():
    global _OCR
    if _OCR is not None:
        return _OCR
    try:
        from rapidocr_onnxruntime import RapidOCR

        _OCR = RapidOCR()
    except Exception as error:  # pragma: no cover
        _OCR = error
    return _OCR


def _quantize(rgb: tuple[int, int, int], step: int = 36) -> str:
    r, g, b = rgb
    return "#{:02x}{:02x}{:02x}".format((r // step) * step, (g // step) * step, (b // step) * step)


def pillow_brief(path: Path) -> dict[str, Any]:
    if Image is None:
        return {"ok": False, "error": "Pillow is not installed."}
    with Image.open(path) as image:
        rgb = image.convert("RGB")
        width, height = rgb.size
        sample = rgb.resize((64, 36))
        sample_pixels = list(getattr(sample, "get_flattened_data", sample.getdata)())
        counts = Counter(_quantize(pixel) for pixel in sample_pixels)
        top = [{"color": color, "share": round(n / (64 * 36), 3)} for color, n in counts.most_common(5)]
        # Rough region brightness for layout hints.
        regions = {}
        for name, box in {
            "top": (0, 0, width, height // 3),
            "middle": (0, height // 3, width, 2 * height // 3),
            "bottom": (0, 2 * height // 3, width, height),
            "left": (0, 0, width // 3, height),
            "right": (2 * width // 3, 0, width, height),
        }.items():
            crop = rgb.crop(box).resize((24, 24))
            pixels = list(getattr(crop, "get_flattened_data", crop.getdata)())
            avg = sum(sum(p) for p in pixels) / (len(pixels) * 3)
            regions[name] = round(avg / 255, 3)
    return {
        "ok": True,
        "width": width,
        "height": height,
        "palette": top,
        "regionBrightness": regions,
        "aspect": round(width / max(1, height), 3),
    }


def ocr_text(path: Path, max_lines: int = 48) -> dict[str, Any]:
    engine = _ocr_engine()
    if isinstance(engine, Exception) or engine is None:
        return {"ok": False, "error": str(engine or "RapidOCR unavailable"), "lines": []}
    started = time.time()
    result, _ = engine(str(path))
    lines: list[dict[str, Any]] = []
    if result:
        for item in result[:max_lines]:
            # RapidOCR returns [box, text, score]
            box, text, score = item[0], item[1], item[2]
            if not text or not str(text).strip():
                continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            lines.append(
                {
                    "text": str(text).strip(),
                    "score": round(float(score), 3),
                    "bbox": {
                        "x": int(min(xs)),
                        "y": int(min(ys)),
                        "w": int(max(xs) - min(xs)),
                        "h": int(max(ys) - min(ys)),
                    },
                }
            )
    return {
        "ok": True,
        "lines": lines,
        "text": "\n".join(line["text"] for line in lines),
        "elapsedMs": int((time.time() - started) * 1000),
        "engine": "rapidocr-onnxruntime",
    }


def optional_vlm(path: Path, question: str, brief: dict[str, Any], ocr: dict[str, Any]) -> dict[str, Any] | None:
    api_key = (
        os.environ.get("VISION_API_KEY", "").strip()
        or os.environ.get("DEEPSEEK_VISION_API_KEY", "").strip()
        or os.environ.get("OPENAI_API_KEY", "").strip()
    )
    if not api_key:
        return None
    base = (
        os.environ.get("VISION_BASE_URL", "").strip()
        or os.environ.get("DEEPSEEK_VISION_BASE_URL", "").strip()
        or os.environ.get("OPENAI_BASE_URL", "").strip()
        or "https://api.openai.com/v1"
    ).rstrip("/")
    model = (
        os.environ.get("VISION_MODEL", "").strip()
        or os.environ.get("DEEPSEEK_VISION_MODEL", "").strip()
        or "gpt-4o-mini"
    )
    try:
        import urllib.request

        mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
        data_url = f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"
        prompt = (
            f"You are a fast screen companion. Answer briefly.\n"
            f"User: {question or 'What is on my screen and how can you help?'}\n"
            f"OCR excerpt:\n{(ocr.get('text') or '')[:1800]}\n"
            f"Palette: {json.dumps(brief.get('palette') or [])}"
        )
        body = json.dumps(
            {
                "model": model,
                "temperature": 0.2,
                "max_tokens": 500,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    }
                ],
            }
        ).encode()
        req = urllib.request.Request(
            f"{base}/chat/completions",
            data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=25) as response:
            payload = json.loads(response.read().decode())
        text = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
        return {"ok": True, "model": model, "text": text}
    except Exception as error:  # pragma: no cover
        return {"ok": False, "error": str(error)}


def analyse(path: Path, question: str = "") -> dict[str, Any]:
    started = time.time()
    brief = pillow_brief(path)
    ocr = ocr_text(path)
    vlm = optional_vlm(path, question, brief, ocr)
    summary_bits = []
    if brief.get("ok"):
        summary_bits.append(f"Screen {brief['width']}×{brief['height']} ({brief['aspect']}:1).")
        if brief.get("palette"):
            summary_bits.append("Dominant colours: " + ", ".join(c["color"] for c in brief["palette"][:3]) + ".")
    if ocr.get("ok") and ocr.get("lines"):
        preview = " | ".join(line["text"] for line in ocr["lines"][:8])
        summary_bits.append(f"Visible text: {preview}")
    elif ocr.get("ok"):
        summary_bits.append("No readable text detected.")
    if vlm and vlm.get("ok") and vlm.get("text"):
        summary_bits.append(vlm["text"].strip())
    return {
        "ok": True,
        "model": "rapidocr-onnx + pillow" + (" + vision-llm" if vlm and vlm.get("ok") else ""),
        "elapsedMs": int((time.time() - started) * 1000),
        "summary": " ".join(summary_bits).strip(),
        "brief": brief,
        "ocr": {"ok": ocr.get("ok"), "lines": ocr.get("lines", [])[:40], "engine": ocr.get("engine"), "elapsedMs": ocr.get("elapsedMs")},
        "vlm": vlm,
        "evidence": {
            "path": str(path),
            "bytes": path.stat().st_size if path.exists() else 0,
            "retention": "ephemeral-session",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Clyra companion vision")
    parser.add_argument("image", help="Path to PNG/JPEG screen capture")
    parser.add_argument("--question", default="", help="Optional user question")
    args = parser.parse_args()
    path = Path(args.image)
    if not path.exists():
        print(json.dumps({"ok": False, "error": f"Missing image: {path}"}))
        return 1
    print(json.dumps(analyse(path, args.question), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
