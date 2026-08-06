/**
 * OS-level desktop control for Clyra Screen Companion.
 * Linux: xdotool. macOS: AppleScript / cliclick when present.
 * Draws the same black AI cursor language as the Atlas browser agent.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserWindow, screen } from "electron";

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function which(bin) {
  try {
    const { stdout } = await execFileAsync("which", [bin], { timeout: 2_000 });
    return String(stdout || "").trim() || null;
  } catch {
    return null;
  }
}

export class DesktopControlService {
  constructor() {
    this.cursorWindow = null;
    this.manualControl = false;
    this.active = false;
    this.xdotool = null;
    this.lastPoint = { x: 0, y: 0 };
  }

  async initialize() {
    this.xdotool = await which("xdotool");
    return { ok: true, driver: this.xdotool ? "xdotool" : process.platform === "darwin" ? "applescript" : "none" };
  }

  async ensureCursorOverlay() {
    if (this.cursorWindow && !this.cursorWindow.isDestroyed()) return this.cursorWindow;
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.bounds;
    this.cursorWindow = new BrowserWindow({
      width,
      height,
      x: display.bounds.x,
      y: display.bounds.y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    this.cursorWindow.setIgnoreMouseEvents(true, { forward: true });
    this.cursorWindow.setAlwaysOnTop(true, "screen-saver");
    await this.cursorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CURSOR_HTML)}`);
    return this.cursorWindow;
  }

  async setCursor(cursor) {
    if (!cursor) {
      if (this.cursorWindow && !this.cursorWindow.isDestroyed()) this.cursorWindow.hide();
      return { ok: true };
    }
    const win = await this.ensureCursorOverlay();
    const point = {
      x: Math.round(Number(cursor.x) || 0),
      y: Math.round(Number(cursor.y) || 0),
      label: String(cursor.label || "Working"),
      kind: String(cursor.kind || "move"),
    };
    this.lastPoint = { x: point.x, y: point.y };
    win.showInactive();
    await win.webContents.executeJavaScript(
      `window.__clyraSetCursor(${JSON.stringify(point)}); true`,
      true,
    );
    return { ok: true, point };
  }

  async move(x, y, label = "Moving") {
    const point = { x: Math.round(x), y: Math.round(y) };
    await this.setCursor({ ...point, label, kind: "move" });
    if (this.manualControl) return { ok: true, skipped: "manualControl", point };
    if (this.xdotool) {
      await execFileAsync(this.xdotool, ["mousemove", "--sync", String(point.x), String(point.y)], { timeout: 3_000 });
    } else if (process.platform === "darwin") {
      await execFileAsync("osascript", ["-e", `tell application "System Events" to set position of mouse to {${point.x}, ${point.y}}`], { timeout: 3_000 }).catch(() => undefined);
    }
    this.lastPoint = point;
    return { ok: true, point };
  }

  async click(x, y, button = "left", label = "Clicking") {
    const point = { x: Math.round(x ?? this.lastPoint.x), y: Math.round(y ?? this.lastPoint.y) };
    await this.move(point.x, point.y, label);
    if (this.manualControl) return { ok: true, skipped: "manualControl", point };
    if (this.xdotool) {
      const btn = button === "right" ? "3" : button === "middle" ? "2" : "1";
      await execFileAsync(this.xdotool, ["click", btn], { timeout: 3_000 });
    }
    await this.setCursor({ ...point, label: "Clicked", kind: "click" });
    return { ok: true, point };
  }

  async typeText(text, label = "Typing") {
    await this.setCursor({ ...this.lastPoint, label, kind: "type" });
    if (this.manualControl) return { ok: true, skipped: "manualControl" };
    const value = String(text || "");
    if (!value) return { ok: true };
    if (this.xdotool) {
      await execFileAsync(this.xdotool, ["type", "--clearmodifiers", "--delay", "12", "--", value], { timeout: 20_000 });
    }
    return { ok: true };
  }

  async key(key, label = "Key") {
    await this.setCursor({ ...this.lastPoint, label, kind: "key" });
    if (this.manualControl) return { ok: true, skipped: "manualControl" };
    if (this.xdotool) {
      await execFileAsync(this.xdotool, ["key", "--clearmodifiers", String(key)], { timeout: 3_000 });
    }
    return { ok: true };
  }

  setManualControl(enabled) {
    this.manualControl = Boolean(enabled);
    if (this.manualControl) void this.setCursor(null);
    return { ok: true, manualControl: this.manualControl };
  }

  async runAction(action) {
    if (!action || typeof action !== "object") throw new Error("Invalid desktop action");
    this.active = true;
    try {
      switch (action.type) {
        case "move":
          return this.move(action.x, action.y, action.label || "Moving");
        case "click":
          return this.click(action.x, action.y, action.button, action.label || "Clicking");
        case "type":
          return this.typeText(action.text, action.label || "Typing");
        case "key":
          return this.key(action.key, action.label || "Key");
        case "wait":
          await wait(Math.max(0, Math.min(5_000, Number(action.ms) || 300)));
          return { ok: true };
        default:
          throw new Error(`Unsupported desktop action: ${action.type}`);
      }
    } finally {
      this.active = false;
    }
  }

  destroy() {
    try {
      if (this.cursorWindow && !this.cursorWindow.isDestroyed()) this.cursorWindow.destroy();
    } catch {
      /* ignore */
    }
    this.cursorWindow = null;
  }
}

const CURSOR_HTML = `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  #cursor{position:absolute;left:0;top:0;transform:translate(-2px,-2px);pointer-events:none;opacity:0;transition:opacity .12s ease}
  #cursor.show{opacity:1}
  #pointer{width:14px;height:14px;border-radius:50%;background:#111;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35)}
  #label{margin-top:6px;display:inline-block;max-width:240px;padding:4px 8px;border-radius:6px;background:#171817;color:#fff;font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head>
<body>
  <div id="cursor"><div id="pointer"></div><div id="label"></div></div>
  <script>
    window.__clyraSetCursor = (point) => {
      const el = document.getElementById('cursor');
      const label = document.getElementById('label');
      el.style.left = (point.x || 0) + 'px';
      el.style.top = (point.y || 0) + 'px';
      label.textContent = point.label || '';
      el.classList.add('show');
    };
  </script>
</body></html>`;
