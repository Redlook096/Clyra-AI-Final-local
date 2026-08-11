/**
 * OS-level desktop control for Clyra Screen Companion.
 * Linux: xdotool. macOS: AppleScript when present.
 * Draws Atlas-style AI cursor — also used in Guide mode to point without clicking.
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
    this.guideOnly = false;
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
      guide: Boolean(cursor.guide),
    };
    this.lastPoint = { x: point.x, y: point.y };
    win.showInactive();
    await win.webContents.executeJavaScript(
      `window.__clyraSetCursor(${JSON.stringify(point)}); true`,
      true,
    );
    return { ok: true, point };
  }

  /**
   * Visual pointer only — does not move the OS mouse or click.
   * Used when the AI is explaining where to press.
   */
  async point(x, y, label = "Look here") {
    this.guideOnly = true;
    const point = { x: Math.round(x), y: Math.round(y) };
    this.lastPoint = point;
    await this.setCursor({ ...point, label, kind: "point", guide: true });
    return { ok: true, point, guide: true };
  }

  async move(x, y, label = "Moving") {
    const point = { x: Math.round(x), y: Math.round(y) };
    await this.setCursor({ ...point, label, kind: "move", guide: this.guideOnly });
    if (this.manualControl || this.guideOnly) return { ok: true, skipped: this.guideOnly ? "guide" : "manualControl", point };
    if (this.xdotool) {
      await execFileAsync(this.xdotool, ["mousemove", "--sync", String(point.x), String(point.y)], { timeout: 3_000 });
    } else if (process.platform === "darwin") {
      await execFileAsync("osascript", ["-e", `tell application "System Events" to set position of mouse to {${point.x}, ${point.y}}`], { timeout: 3_000 }).catch(() => undefined);
    }
    this.lastPoint = point;
    return { ok: true, point };
  }

  async click(x, y, button = "left", label = "Clicking") {
    if (this.guideOnly) {
      return this.point(x ?? this.lastPoint.x, y ?? this.lastPoint.y, label || "Click here");
    }
    const point = { x: Math.round(x ?? this.lastPoint.x), y: Math.round(y ?? this.lastPoint.y) };
    await this.move(point.x, point.y, label);
    if (this.manualControl) return { ok: true, skipped: "manualControl", point };
    if (this.xdotool) {
      const btn = button === "right" ? "3" : button === "middle" ? "2" : "1";
      await execFileAsync(this.xdotool, ["click", btn], { timeout: 3_000 });
    } else if (process.platform === "darwin") {
      const script = `tell application "System Events" to click at {${point.x}, ${point.y}}`;
      await execFileAsync("osascript", ["-e", script], { timeout: 3_000 });
    }
    await this.setCursor({ ...point, label: "Clicked", kind: "click" });
    return { ok: true, point };
  }

  async typeText(text, label = "Typing") {
    if (this.guideOnly) {
      await this.setCursor({ ...this.lastPoint, label: `Type: ${String(text || "").slice(0, 40)}`, kind: "point", guide: true });
      return { ok: true, skipped: "guide" };
    }
    await this.setCursor({ ...this.lastPoint, label, kind: "type" });
    if (this.manualControl) return { ok: true, skipped: "manualControl" };
    const value = String(text || "");
    if (!value) return { ok: true };
    if (this.xdotool) {
      await execFileAsync(this.xdotool, ["type", "--clearmodifiers", "--delay", "12", "--", value], { timeout: 20_000 });
    } else if (process.platform === "darwin") {
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
      await execFileAsync("osascript", ["-e", `tell application "System Events" to keystroke "${escaped}"`], { timeout: 20_000 });
    }
    return { ok: true };
  }

  async key(key, label = "Key") {
    if (this.guideOnly) {
      await this.setCursor({ ...this.lastPoint, label: `Press ${key}`, kind: "point", guide: true });
      return { ok: true, skipped: "guide" };
    }
    await this.setCursor({ ...this.lastPoint, label, kind: "key" });
    if (this.manualControl) return { ok: true, skipped: "manualControl" };
    if (this.xdotool) {
      await execFileAsync(this.xdotool, ["key", "--clearmodifiers", String(key)], { timeout: 3_000 });
    } else if (process.platform === "darwin") {
      const normalized = String(key).toLowerCase();
      if (normalized === "cmd+l" || normalized === "command+l") {
        await execFileAsync("osascript", ["-e", 'tell application "System Events" to keystroke "l" using command down'], { timeout: 3_000 });
      } else {
        await execFileAsync("osascript", ["-e", `tell application "System Events" to key code 36`], { timeout: 3_000 });
      }
    }
    return { ok: true };
  }

  setManualControl(enabled) {
    this.manualControl = Boolean(enabled);
    if (this.manualControl) void this.setCursor(null);
    return { ok: true, manualControl: this.manualControl };
  }

  setGuideOnly(enabled) {
    this.guideOnly = Boolean(enabled);
    return { ok: true, guideOnly: this.guideOnly };
  }

  async runAction(action) {
    if (!action || typeof action !== "object") throw new Error("Invalid desktop action");
    this.active = true;
    try {
      switch (action.type) {
        case "point":
          return this.point(action.x, action.y, action.label || "Look here");
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
  #screen-border{position:fixed;inset:8px;border:1px solid rgba(79,124,255,.68);border-radius:15px;box-shadow:0 0 0 1px rgba(130,171,255,.16),0 0 26px rgba(54,119,255,.22),inset 0 0 22px rgba(79,124,255,.06);opacity:0;transition:opacity .18s ease}#screen-border.active{opacity:1}
  #cursor{position:absolute;left:0;top:0;transform:translate(-4px,-2px);pointer-events:none;opacity:0;transition:opacity .14s ease,left .22s cubic-bezier(.22,1,.36,1),top .22s cubic-bezier(.22,1,.36,1)}
  #cursor.show{opacity:1}
  #ring{position:absolute;left:-14px;top:-14px;width:36px;height:36px;border-radius:50%;border:2px solid rgba(59,130,246,.85);box-shadow:0 0 0 6px rgba(59,130,246,.12);opacity:0;transform:scale(.7)}
  #cursor.guide #ring{opacity:1;animation:ring 1.4s ease-out infinite}
  @keyframes ring{0%{transform:scale(.75);opacity:.95}70%{transform:scale(1.35);opacity:0}100%{transform:scale(1.35);opacity:0}}
  #arrow{width:28px;height:32px;filter:drop-shadow(0 0 1px rgba(255,255,255,.84)) drop-shadow(0 2px 4px rgba(16,24,40,.34)) drop-shadow(0 0 10px rgba(43,128,255,.34))}
  #label{position:absolute;left:29px;top:1px;display:inline-block;max-width:260px;padding:5px 9px 5px 18px;border:1px solid rgba(36,42,52,.12);border-radius:8px;background:rgba(255,255,255,.94);color:#252a33;font-size:10.5px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 5px 16px rgba(20,32,52,.16)}
</style></head>
<body>
  <div id="screen-border"></div><div id="cursor">
    <div id="ring"></div>
    <svg id="arrow" viewBox="0 0 28 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="clyraDesktopCursor" x1="2" y1="2" x2="22" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#2b3039"/><stop offset=".42" stop-color="#15181d"/><stop offset="1" stop-color="#07080a"/></linearGradient></defs><path d="M4.62 2.72C3.09 1.91 1.57 3.43 2.39 4.96l8.36 16.3c.75 1.47 2.87 1.39 3.5-.13l2.69-6.51 6.51-2.69c1.52-.63 1.6-2.75.13-3.5L4.62 2.72Z" fill="url(#clyraDesktopCursor)" stroke="rgba(255,255,255,.55)" stroke-width=".55" stroke-linejoin="round"/>
    </svg>
    <div id="label"></div>
  </div>
  <script>
    window.__clyraSetCursor = (point) => {
      const el = document.getElementById('cursor');
      const label = document.getElementById('label');
      el.style.left = (point.x || 0) + 'px';
      el.style.top = (point.y || 0) + 'px';
      label.textContent = point.label || '';
      el.classList.toggle('guide', Boolean(point.guide) || point.kind === 'point');
      el.classList.toggle('control', !point.guide && point.kind !== 'point');
      document.getElementById('screen-border').classList.toggle('active', !point.guide && point.kind !== 'point');
      el.classList.add('show');
    };
  </script>
</body></html>`;
