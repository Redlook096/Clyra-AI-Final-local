#!/usr/bin/env python3
"""Enumerate on-screen windows via CGWindowList (macOS). No Accessibility required."""
from __future__ import annotations

import json
import sys

try:
    from Quartz import (
        CGWindowListCopyWindowInfo,
        kCGNullWindowID,
        kCGWindowListOptionOnScreenOnly,
        kCGWindowListExcludeDesktopElements,
    )
except Exception as exc:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"Quartz unavailable: {exc}", "windows": []}))
    sys.exit(0)


def main() -> None:
    options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
    raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) or []
    windows = []
    for item in raw:
        try:
            layer = int(item.get("kCGWindowLayer", 0) or 0)
            if layer != 0:
                continue
            bounds = item.get("kCGWindowBounds") or {}
            w = float(bounds.get("Width", 0) or 0)
            h = float(bounds.get("Height", 0) or 0)
            if w < 48 or h < 48:
                continue
            owner = str(item.get("kCGWindowOwnerName") or "")
            name = str(item.get("kCGWindowName") or "")
            # Skip our own overlays / helpers
            if owner.lower() in {"opencluely", "clyra", "window server"}:
                continue
            if "visual intelligence" in name.lower() or "visual-scan" in name.lower():
                continue
            windows.append(
                {
                    "id": int(item.get("kCGWindowNumber") or 0),
                    "app": owner,
                    "title": name,
                    "pid": int(item.get("kCGWindowOwnerPID") or 0),
                    "frame": {
                        "x": float(bounds.get("X", 0) or 0),
                        "y": float(bounds.get("Y", 0) or 0),
                        "w": w,
                        "h": h,
                    },
                    "alpha": float(item.get("kCGWindowAlpha", 1) or 1),
                }
            )
        except Exception:
            continue
    # Front-to-back: CGWindowList is already ordered front to back
    print(json.dumps({"ok": True, "windows": windows[:80]}))


if __name__ == "__main__":
    main()
