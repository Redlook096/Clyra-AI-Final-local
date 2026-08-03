#!/usr/bin/env python3
"""Isolated bridge for a separately installed video-understanding-local copy.

This file intentionally owns only protocol, resource and cache safety.  It
does not vendor upstream code or weights.  Its caller must explicitly opt in,
provide a high-memory worker, and pre-provision all model files; offline flags
ensure a request cannot trigger surprise multi-gigabyte downloads.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict


def emit(payload: Dict[str, Any], status: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(status)


def parse_json_object(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    text = str(value or "").strip()
    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[index:])
            return parsed if isinstance(parsed, dict) else {}
        except ValueError:
            continue
    return {}


def safe_verdict(value: Any) -> Dict[str, Any]:
    raw = parse_json_object(value)
    required = ("event_present", "before_state_verified", "transition_verified", "after_state_verified")
    if not all(isinstance(raw.get(key), bool) for key in required):
        return {
            "event_present": False,
            "before_state_verified": False,
            "transition_verified": False,
            "after_state_verified": False,
            "visual_evidence": [],
            "audio_evidence": [],
            "ocr_evidence": [],
            "constraintsSatisfied": [],
            "warnings": ["The upstream summary did not satisfy Clyra's structured temporal-evidence protocol."],
            "confidence": 0.0,
        }
    return raw


def require_binary(name: str) -> str:
    binary = shutil.which(name)
    if not binary:
        emit({"available": False, "reason": f"{name}_not_available"}, 2)
    return binary


def main() -> None:
    if os.environ.get("CLYRA_VIDEO_UNDERSTANDING_ALLOW_HIGH_MEMORY") != "1":
        emit({"available": False, "reason": "high_memory_worker_not_explicitly_enabled"}, 2)
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        emit({"available": False, "reason": "invalid_request_payload"}, 2)
    source = Path(str(payload.get("sourcePath") or ""))
    if not source.is_file():
        emit({"available": False, "reason": "local_source_required_for_visual_verification"}, 2)

    # The upstream project currently requires ffmpeg and ffprobe to be on
    # PATH.  Clyra does not change that global requirement; we inject only the
    # verified executable directory for this isolated child process.
    ffmpeg = require_binary("ffmpeg")
    require_binary("ffprobe")
    upstream_root = Path(str(os.environ.get("CLYRA_VIDEO_UNDERSTANDING_UPSTREAM_ROOT") or "")).expanduser()
    upstream_src = upstream_root / "src"
    if upstream_src.is_dir():
        sys.path.insert(0, str(upstream_src))
    elif os.environ.get("CLYRA_VIDEO_UNDERSTANDING_UPSTREAM_INSTALLED") != "1":
        emit({"available": False, "reason": "upstream_root_not_configured"}, 2)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        from video_understanding.video_understanding import analyze_video  # type: ignore
    except Exception as exc:
        emit({"available": False, "reason": f"upstream_import_{type(exc).__name__.lower()}"}, 2)

    candidate = payload.get("candidate") if isinstance(payload.get("candidate"), dict) else {}
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    start_ms = max(0, int(candidate.get("startMs") or 0) - max(0, int(context.get("beforeMs") or 0)))
    end_ms = max(start_ms + 1, int(candidate.get("endMs") or start_ms + 1) + max(0, int(context.get("afterMs") or 0)))
    request = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    request_text = str(request.get("originalQuery") or "the requested event")[:1_500]

    with tempfile.TemporaryDirectory(prefix="clyra-video-understanding-") as temporary:
        window = Path(temporary) / "candidate-window.mp4"
        duration = max(0.1, (end_ms - start_ms) / 1000)
        command = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{start_ms / 1000:.3f}", "-i", str(source), "-t", f"{duration:.3f}",
            "-map", "0:v:0", "-map", "0:a?", "-c", "copy", str(window),
        ]
        try:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=90)
        except (OSError, subprocess.SubprocessError):
            emit({"available": False, "reason": "candidate_window_extraction_failed"}, 2)

        prompt = f"""
You are a strict video-event verifier. The user requested: {request_text!r}.
This window represents original video timestamps {start_ms}ms to {end_ms}ms.
Use only what is visibly/audibly present. Return ONLY one JSON object with
these boolean fields: event_present, before_state_verified,
transition_verified, after_state_verified. Also return visual_evidence,
audio_evidence, ocr_evidence, constraintsSatisfied and warnings as arrays of
short strings, plus confidence from 0 to 1. Never infer an event merely from
spoken words. Mark every required temporal boolean false when evidence is
ambiguous or the ending state is not visible.
""".strip()
        previous_cwd = os.getcwd()
        try:
            os.chdir(temporary)
            # Upstream logs to stdout; retain it privately and emit precisely
            # one JSON response for Clyra's parent process.
            with contextlib.redirect_stdout(io.StringIO()):
                summary = analyze_video(str(window), prompt)
        except Exception as exc:
            emit({"available": False, "reason": f"upstream_analysis_{type(exc).__name__.lower()}"}, 2)
        finally:
            os.chdir(previous_cwd)
    emit({"available": True, "provider": "video-understanding-local", "verdict": safe_verdict(summary)})


if __name__ == "__main__":
    main()
