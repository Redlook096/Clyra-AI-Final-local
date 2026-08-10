#!/usr/bin/swift
// Native macOS input fallback for OpenCluely. This avoids requiring PyObjC on
// the user's Python installation while retaining the same Quartz CGEvent API.
import AppKit
import ApplicationServices
import Foundation

let args = Array(CommandLine.arguments.dropFirst())

func accessibilityReady() -> Bool {
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  return AXIsProcessTrustedWithOptions(options)
}

func number(_ index: Int) -> CGFloat? {
  guard args.indices.contains(index), let value = Double(args[index]) else { return nil }
  return CGFloat(value)
}

func mouseEvent(_ type: CGEventType, _ x: CGFloat, _ y: CGFloat, _ button: CGMouseButton = .left) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button)?.post(tap: .cghidEventTap)
}

func keyPress(_ raw: String) {
  let parts = raw.lowercased().replacingOccurrences(of: "-", with: "+").split(separator: "+").map(String.init)
  guard let key = parts.last, !key.isEmpty else { exit(2) }
  var flags: CGEventFlags = []
  for modifier in parts.dropLast() {
    switch modifier {
    case "cmd", "command", "meta": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    default: break
    }
  }
  let codes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126
  ]
  guard let keyCode = codes[key] else {
    fputs("Unsupported key: \(raw)\n", stderr)
    exit(2)
  }
  let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
  let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
  down?.flags = flags
  up?.flags = flags
  down?.post(tap: .cghidEventTap)
  up?.post(tap: .cghidEventTap)
}

guard !args.isEmpty else { exit(2) }
if args[0] == "status" {
  let ready = accessibilityReady()
  print(ready ? "ready" : "denied")
  exit(ready ? 0 : 77)
}
guard accessibilityReady() else {
  fputs("Accessibility is not enabled for the OpenCluely input helper.\n", stderr)
  exit(77)
}

switch args[0] {
case "move":
  guard let x = number(1), let y = number(2) else { exit(2) }
  mouseEvent(.mouseMoved, x, y)
case "click", "mouse_down", "mouse_up":
  guard let x = number(1), let y = number(2) else { exit(2) }
  let button: CGMouseButton = args.count > 3 && args[3] == "right" ? .right : .left
  if args[0] == "mouse_down" {
    mouseEvent(button == .right ? .rightMouseDown : .leftMouseDown, x, y, button)
  } else if args[0] == "mouse_up" {
    mouseEvent(button == .right ? .rightMouseUp : .leftMouseUp, x, y, button)
  } else {
    mouseEvent(.mouseMoved, x, y, button)
    mouseEvent(button == .right ? .rightMouseDown : .leftMouseDown, x, y, button)
    mouseEvent(button == .right ? .rightMouseUp : .leftMouseUp, x, y, button)
  }
case "scroll":
  let dx = Int(number(1) ?? 0)
  let dy = Int(number(2) ?? 0)
  CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)?.post(tap: .cghidEventTap)
case "type":
  let text = args.dropFirst().joined(separator: " ")
  let utf16 = Array(text.utf16)
  let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
  down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
  down?.post(tap: .cghidEventTap)
  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
  up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
  up?.post(tap: .cghidEventTap)
case "key":
  guard args.count >= 2 else { exit(2) }
  keyPress(args[1])
default:
  fputs("Unsupported command: \(args[0])\n", stderr)
  exit(2)
}
