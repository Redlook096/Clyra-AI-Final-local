#!/usr/bin/env python3
"""Minimal Ollama /api/generate smoke test for gemma3:4b.

Uses a tiny non-streaming payload so background memory stays low.
Exit code 0 on success, 1 on failure.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/") + "/api/generate"
# Prefer explicit OLLAMA_MODEL; otherwise OPENCLUELY_VISION_MODEL; default gemma3:4b.
MODEL = os.environ.get("OLLAMA_MODEL") or os.environ.get("OPENCLUELY_VISION_MODEL") or "gemma3:4b"


def main() -> int:
    payload = {
        "model": MODEL,
        "prompt": "Reply with exactly: OK",
        "stream": False,
        "options": {
            # Keep the generate pass tiny for a low-memory health check.
            "num_predict": 8,
            "temperature": 0,
        },
    }
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    print(f"endpoint: {ENDPOINT}")
    print(f"model:    {MODEL}")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read().decode("utf-8", errors="replace")
            status = response.status
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(f"FAIL http {error.code}: {detail[:400]}")
        return 1
    except Exception as error:  # noqa: BLE001 — surface connect/timeout clearly
        print(f"FAIL: {error}")
        return 1

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print(f"FAIL: non-JSON response ({elapsed_ms}ms): {raw[:240]}")
        return 1

    text = str(data.get("response") or "").strip()
    ok = status == 200 and bool(text)
    print(f"status:   {status}")
    print(f"elapsed:  {elapsed_ms}ms")
    print(f"response: {text[:200]!r}")
    if data.get("eval_count") is not None:
        print(f"tokens:   eval={data.get('eval_count')} prompt={data.get('prompt_eval_count')}")
    if not ok:
        print("FAIL: empty or non-200 generate response")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
