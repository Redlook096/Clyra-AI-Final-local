#!/usr/bin/env python3
"""macOS desktop input via Quartz CGEvent (no cliclick required).

Usage:
  python3 macos-input.py move X Y
  python3 macos-input.py click X Y [left|right] [count]
  python3 macos-input.py scroll DX DY
  python3 macos-input.py type "text"
  python3 macos-input.py key Return
"""
from __future__ import annotations

import sys
import time


def check_accessibility_permission() -> bool:
    try:
        import ctypes
        app_services = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
        return bool(app_services.AXIsProcessTrusted())
    except Exception:
        return True


def diagnose() -> dict:
    import os, platform
    trusted = check_accessibility_permission()
    return {
        "executable": sys.executable,
        "pid": os.getpid(),
        "arch": platform.machine(),
        "accessibility_granted": trusted,
        "driver": "QuartzMacOSDriver",
        "quartz_available": True,
    }


def enforce_accessibility() -> None:
    if not check_accessibility_permission():
        import os
        err_msg = f"ACCESSIBILITY_DENIED: macOS Accessibility permission is not enabled for process {sys.executable} (PID: {os.getpid()}). Open System Settings -> Privacy & Security -> Accessibility."
        print(err_msg, file=sys.stderr)
        raise SystemExit(err_msg)


def move(x: float, y: float) -> None:
    enforce_accessibility()
    Q = _quartz()
    event = Q.CGEventCreateMouseEvent(None, Q.kCGEventMouseMoved, (x, y), Q.kCGMouseButtonLeft)
    Q.CGEventPost(Q.kCGHIDEventTap, event)


def click(x: float, y: float, button: str = "left", count: int = 1) -> None:
    enforce_accessibility()
    Q = _quartz()
    btn = Q.kCGMouseButtonLeft
    down = Q.kCGEventLeftMouseDown
    up = Q.kCGEventLeftMouseUp
    if button == "right":
        btn = Q.kCGMouseButtonRight
        down = Q.kCGEventRightMouseDown
        up = Q.kCGEventRightMouseUp
    elif button == "middle":
        btn = Q.kCGMouseButtonCenter
        down = Q.kCGEventOtherMouseDown
        up = Q.kCGEventOtherMouseUp

    # Move mouse cursor to target coordinates so target window receives click event
    m = Q.CGEventCreateMouseEvent(None, Q.kCGEventMouseMoved, (x, y), btn)
    Q.CGEventPost(Q.kCGHIDEventTap, m)
    time.sleep(0.02)

    for i in range(max(1, min(3, count))):
        d = Q.CGEventCreateMouseEvent(None, down, (x, y), btn)
        u = Q.CGEventCreateMouseEvent(None, up, (x, y), btn)
        Q.CGEventSetIntegerValueField(d, Q.kCGMouseEventClickState, i + 1)
        Q.CGEventSetIntegerValueField(u, Q.kCGMouseEventClickState, i + 1)
        Q.CGEventPost(Q.kCGHIDEventTap, d)
        Q.CGEventPost(Q.kCGHIDEventTap, u)
        time.sleep(0.05)


def mouse_button(direction: str, x: float, y: float, button: str = "left") -> None:
    enforce_accessibility()
    Q = _quartz()
    btn = Q.kCGMouseButtonLeft
    event_type = Q.kCGEventLeftMouseDown if direction == "down" else Q.kCGEventLeftMouseUp
    if button == "right":
        btn = Q.kCGMouseButtonRight
        event_type = Q.kCGEventRightMouseDown if direction == "down" else Q.kCGEventRightMouseUp
    elif button == "middle":
        btn = Q.kCGMouseButtonCenter
        event_type = Q.kCGEventOtherMouseDown if direction == "down" else Q.kCGEventOtherMouseUp
    event = Q.CGEventCreateMouseEvent(None, event_type, (x, y), btn)
    Q.CGEventPost(Q.kCGHIDEventTap, event)


def scroll(dx: int, dy: int) -> None:
    enforce_accessibility()
    Q = _quartz()
    # Quartz wheel delta: positive Y scrolls up
    event = Q.CGEventCreateScrollWheelEvent(None, Q.kCGScrollEventUnitLine, 2, int(dy), int(dx))
    Q.CGEventPost(Q.kCGHIDEventTap, event)


def type_text(text: str) -> None:
    enforce_accessibility()
    import subprocess
    Q = _quartz()
    try:
        u_len = len(text)
        utf16_buf = text.encode('utf-16-le')
        d = Q.CGEventCreateKeyboardEvent(None, 0, True)
        u = Q.CGEventCreateKeyboardEvent(None, 0, False)
        Q.CGEventKeyboardSetUnicodeString(d, u_len, utf16_buf)
        Q.CGEventKeyboardSetUnicodeString(u, u_len, utf16_buf)
        Q.CGEventPost(Q.kCGHIDEventTap, d)
        Q.CGEventPost(Q.kCGHIDEventTap, u)
        return
    except Exception:
        pass

    escaped = (
        text.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "")
    )
    script = f'tell application "System Events" to keystroke "{escaped}"'
    subprocess.run(["osascript", "-e", script], check=False, timeout=30)


KEY_MAP = {
    "return": 36,
    "enter": 36,
    "tab": 48,
    "escape": 53,
    "esc": 53,
    "delete": 51,
    "backspace": 51,
    "space": 49,
    "up": 126,
    "down": 125,
    "left": 123,
    "right": 124,
    "cmd": 55,
    "command": 55,
    "shift": 56,
    "option": 58,
    "alt": 58,
    "control": 59,
    "ctrl": 59,
}


def key_press(name: str) -> None:
    Q = _quartz()
    raw = str(name or "").strip()
    lower = raw.lower()
    # Support chords like "cmd+c" / "command+shift+s"
    if "+" in lower or "-" in lower:
        parts = [p for p in lower.replace("-", "+").split("+") if p]
        flags = 0
        keycode = None
        for part in parts:
            if part in ("cmd", "command", "meta"):
                flags |= Q.kCGEventFlagMaskCommand
            elif part in ("shift",):
                flags |= Q.kCGEventFlagMaskShift
            elif part in ("alt", "option"):
                flags |= Q.kCGEventFlagMaskAlternate
            elif part in ("ctrl", "control"):
                flags |= Q.kCGEventFlagMaskControl
            else:
                keycode = KEY_MAP.get(part)
                if keycode is None and len(part) == 1:
                    # Fall back to System Events for letters
                    import subprocess

                    mods = []
                    if flags & Q.kCGEventFlagMaskCommand:
                        mods.append("command down")
                    if flags & Q.kCGEventFlagMaskShift:
                        mods.append("shift down")
                    if flags & Q.kCGEventFlagMaskAlternate:
                        mods.append("option down")
                    if flags & Q.kCGEventFlagMaskControl:
                        mods.append("control down")
                    using = f' using {{{", ".join(mods)}}}' if mods else ""
                    script = f'tell application "System Events" to keystroke "{part}"{using}'
                    subprocess.run(["osascript", "-e", script], check=False, timeout=8)
                    return
        if keycode is None:
            raise SystemExit(f"Unknown key chord: {name}")
        down = Q.CGEventCreateKeyboardEvent(None, keycode, True)
        up = Q.CGEventCreateKeyboardEvent(None, keycode, False)
        Q.CGEventSetFlags(down, flags)
        Q.CGEventSetFlags(up, flags)
        Q.CGEventPost(Q.kCGHIDEventTap, down)
        Q.CGEventPost(Q.kCGHIDEventTap, up)
        return

    keycode = KEY_MAP.get(lower)
    if keycode is None:
        type_text(raw)
        return
    down = Q.CGEventCreateKeyboardEvent(None, keycode, True)
    up = Q.CGEventCreateKeyboardEvent(None, keycode, False)
    Q.CGEventPost(Q.kCGHIDEventTap, down)
    Q.CGEventPost(Q.kCGHIDEventTap, up)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == "move" and len(argv) >= 4:
        move(float(argv[2]), float(argv[3]))
        return 0
    if cmd == "click" and len(argv) >= 4:
        button = argv[4] if len(argv) > 4 else "left"
        count = int(argv[5]) if len(argv) > 5 else 1
        click(float(argv[2]), float(argv[3]), button, count)
        return 0
    if cmd in ("mouse_down", "mouse_up") and len(argv) >= 4:
        mouse_button(
            "down" if cmd == "mouse_down" else "up",
            float(argv[2]),
            float(argv[3]),
            argv[4] if len(argv) > 4 else "left",
        )
        return 0
    if cmd == "scroll" and len(argv) >= 4:
        scroll(int(argv[2]), int(argv[3]))
        return 0
    if cmd == "type" and len(argv) >= 3:
        type_text(" ".join(argv[2:]))
        return 0
    if cmd == "key" and len(argv) >= 3:
        key_press(argv[2])
        return 0
    if cmd == "diagnose":
        import json
        print(json.dumps(diagnose(), indent=2))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
