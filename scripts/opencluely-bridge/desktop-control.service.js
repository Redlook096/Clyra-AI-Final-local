/**
 * OpenCluely desktop control — AI cursor, blue control glow, OS automation.
 * Linux: xdotool | macOS: cliclick/osascript | Windows: PowerShell
 *
 * Can click / type / key / scroll freely. Destructive file ops are blocked
 * unless the user's task explicitly asks (see control-safety.js).
 */
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { BrowserWindow, screen } = require('electron');
const logger = require('../core/logger').createServiceLogger('DESKTOP-CONTROL');
const { checkActionSafety } = require('./control-safety');

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MACOS_INPUT = path.join(__dirname, 'macos-input.py');

async function which(bin) {
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      timeout: 2000,
    });
    return String(stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

async function darwinInput(args, timeout = 8000) {
  // Prefer python3 Quartz CGEvent helper; falls back to /usr/bin/python3.
  const pythons = ['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3'];
  let lastError = null;
  for (const py of pythons) {
    try {
      await execFileAsync(py, [MACOS_INPUT, ...args], { timeout });
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('macOS input helper failed');
}

const CURSOR_HTML = `<!doctype html>
<html><head><meta charset="utf-8"/><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
#cursor{position:absolute;left:0;top:0;pointer-events:none;opacity:0;will-change:left,top,opacity;
  transition:left .65s cubic-bezier(.22,1,.36,1), top .65s cubic-bezier(.22,1,.36,1), opacity .2s ease}
#cursor.show{opacity:1}
#arrow{width:32px;height:32px;filter:drop-shadow(1px 2px 2px rgba(0,0,0,.55)) drop-shadow(0 0 1px rgba(0,0,0,.35))}
#label{margin-top:4px;margin-left:16px;display:inline-block;max-width:280px;padding:5px 10px;border-radius:8px;
  background:rgba(15,23,42,.92);color:#fff;font:600 11px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  box-shadow:0 8px 22px rgba(0,0,0,.28)}
#cursor.guide #label{background:#1d4ed8}
</style></head><body>
<div id="cursor">
  <!-- Classic OS pointer: black fill, white stroke, soft shadow (matches reference) -->
  <svg id="arrow" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M5 3 L5 24 L11.2 18.6 L16.8 28.2 L20.2 26.4 L14.6 16.8 L22 16.8 Z"
      fill="#000000" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>
  <div id="label"></div>
</div>
<script>
window.__ocSetCursor=function(p){
  var el=document.getElementById('cursor');
  var label=document.getElementById('label');
  el.style.left=(p.x||0)+'px';
  el.style.top=(p.y||0)+'px';
  label.textContent=p.label||'';
  el.classList.toggle('guide', !!p.guide || p.kind==='point');
  el.classList.add('show');
};
window.__ocHideCursor=function(){
  document.getElementById('cursor').classList.remove('show');
};
</script></body></html>`;

const GLOW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"/><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
#glow{position:fixed;inset:0;
  /* Even transparent light-blue wash across the whole screen */
  background:rgba(125, 211, 252, 0.22);
  box-shadow: inset 0 0 0 3px rgba(125, 211, 252, 0.48),
              inset 0 0 140px rgba(147, 197, 253, 0.28);
  opacity:0; transition: opacity .45s ease}
#glow.on{opacity:1}
#badge{position:fixed;top:18px;left:50%;transform:translateX(-50%);padding:7px 14px;border-radius:999px;
  background:rgba(56,189,248,.88);color:#fff;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  letter-spacing:.02em;box-shadow:0 10px 28px rgba(56,189,248,.28);opacity:0;transition:opacity .35s ease}
#badge.on{opacity:1}
</style></head><body>
<div id="glow"></div>
<div id="badge">AI controlling · OpenCluely</div>
<script>
window.__ocSetGlow=function(on){
  document.getElementById('glow').classList.toggle('on', !!on);
  document.getElementById('badge').classList.toggle('on', !!on);
};
</script></body></html>`;

class DesktopControlService {
  constructor() {
    this.cursorWindow = null;
    this.glowWindow = null;
    this.active = false;
    this.controlling = false;
    this.guideOnly = false;
    this.aborted = false;
    this.xdotool = null;
    this.cliclick = null;
    this.lastPoint = { x: 40, y: 40 };
    this.driver = 'none';
    this.currentTask = '';
  }

  async initialize() {
    this.xdotool = await which('xdotool');
    this.cliclick = await which('cliclick');
    if (this.xdotool) this.driver = 'xdotool';
    else if (process.platform === 'darwin') {
      // Prefer cliclick when present, otherwise Quartz CGEvent via macos-input.py
      this.driver = this.cliclick ? 'cliclick' : 'quartz';
      // Probe Quartz once so we can warn early about Accessibility.
      if (!this.cliclick) {
        try {
          await darwinInput(['move', '0', '0'], 3000);
        } catch (error) {
          this.driver = 'none';
          this.accessibilityOk = false;
          logger.warn('macOS Quartz input probe failed — enable Accessibility for OpenCluely', {
            error: error.message,
          });
        }
      }
    } else if (process.platform === 'win32') this.driver = 'powershell';
    logger.info('Desktop control ready', { driver: this.driver });
    return { ok: true, driver: this.driver };
  }

  async #overlay(kind) {
    const existing = kind === 'glow' ? this.glowWindow : this.cursorWindow;
    if (existing && !existing.isDestroyed()) return existing;
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.bounds;
    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.setIgnoreMouseEvents(true, { forward: true });
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
    } catch {
      win.setAlwaysOnTop(true);
    }
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(kind === 'glow' ? GLOW_HTML : CURSOR_HTML)}`,
    );
    if (kind === 'glow') this.glowWindow = win;
    else this.cursorWindow = win;
    return win;
  }

  async setGlow(on) {
    const win = await this.#overlay('glow');
    if (on) {
      win.showInactive();
      await win.webContents.executeJavaScript('window.__ocSetGlow(true); true', true);
    } else {
      await win.webContents.executeJavaScript('window.__ocSetGlow(false); true', true).catch(() => {});
      win.hide();
    }
    return { ok: true, on: Boolean(on) };
  }

  async setCursor(cursor) {
    if (!cursor) {
      if (this.cursorWindow && !this.cursorWindow.isDestroyed()) {
        await this.cursorWindow.webContents
          .executeJavaScript('window.__ocHideCursor(); true', true)
          .catch(() => {});
        this.cursorWindow.hide();
      }
      return { ok: true };
    }
    const win = await this.#overlay('cursor');
    const point = {
      x: Math.round(Number(cursor.x) || 0),
      y: Math.round(Number(cursor.y) || 0),
      label: String(cursor.label || ''),
      kind: String(cursor.kind || 'move'),
      guide: Boolean(cursor.guide),
    };
    this.lastPoint = { x: point.x, y: point.y };
    win.showInactive();
    await win.webContents.executeJavaScript(`window.__ocSetCursor(${JSON.stringify(point)}); true`, true);
    return { ok: true, point };
  }

  async point(x, y, label = 'Look here') {
    this.guideOnly = true;
    const point = { x: Math.round(x), y: Math.round(y) };
    this.lastPoint = point;
    await this.setCursor({ ...point, label, kind: 'point', guide: true });
    await wait(420);
    return { ok: true, point, guide: true };
  }

  async move(x, y, label = 'Moving') {
    const point = { x: Math.round(x), y: Math.round(y) };
    await this.setCursor({ ...point, label, kind: 'move', guide: this.guideOnly });
    if (this.guideOnly) {
      await wait(380);
      return { ok: true, skipped: 'guide', point };
    }
    try {
      if (this.xdotool) {
        await execFileAsync(this.xdotool, ['mousemove', '--sync', String(point.x), String(point.y)], {
          timeout: 4000,
        });
      } else if (this.cliclick) {
        await execFileAsync(this.cliclick, [`m:${point.x},${point.y}`], { timeout: 4000 });
      } else if (process.platform === 'darwin') {
        await darwinInput(['move', String(point.x), String(point.y)], 4000);
      } else if (process.platform === 'win32') {
        const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${point.x},${point.y})`;
        await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 4000 });
      }
    } catch (error) {
      logger.warn('Mouse move failed', { error: error.message, driver: this.driver });
    }
    this.lastPoint = point;
    await wait(280);
    return { ok: true, point };
  }

  async click(x, y, button = 'left', label = 'Clicking', { clicks = 1 } = {}) {
    if (this.guideOnly) {
      return this.point(x ?? this.lastPoint.x, y ?? this.lastPoint.y, label || 'Click here');
    }
    const point = { x: Math.round(x ?? this.lastPoint.x), y: Math.round(y ?? this.lastPoint.y) };
    const count = Math.max(1, Math.min(3, Number(clicks) || 1));
    await this.move(point.x, point.y, label);
    try {
      if (this.xdotool) {
        const btn = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
        await execFileAsync(this.xdotool, ['click', '--repeat', String(count), '--delay', '80', btn], {
          timeout: 6000,
        });
      } else if (this.cliclick) {
        const cmd = count >= 2 ? `dc:${point.x},${point.y}` : `c:${point.x},${point.y}`;
        await execFileAsync(this.cliclick, [cmd], { timeout: 4000 });
      } else if (process.platform === 'darwin') {
        await darwinInput(
          ['click', String(point.x), String(point.y), button === 'right' ? 'right' : 'left', String(count)],
          8000,
        );
      } else if (process.platform === 'win32') {
        const isRight = button === 'right';
        const down = isRight ? 0x0008 : 0x0002; // MOUSEEVENTF_RIGHTDOWN / LEFTDOWN
        const up = isRight ? 0x0010 : 0x0004; // MOUSEEVENTF_RIGHTUP / LEFTUP
        const downUp = `[M]::mouse_event(${down},0,0,0,0); [M]::mouse_event(${up},0,0,0,0);`;
        const ps = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${point.x},${point.y});
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M { [DllImport("user32.dll")] public static extern void mouse_event(int f,int a,int b,int c,int d); }
"@;
for ($i=0; $i -lt ${count}; $i++) { ${downUp} Start-Sleep -Milliseconds 80 }
`;
        await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000 });
      }
    } catch (error) {
      logger.warn('Click failed', { error: error.message });
    }
    await this.setCursor({
      ...point,
      label: count >= 2 ? 'Double-clicked' : 'Clicked',
      kind: 'click',
    });
    return { ok: true, point, clicks: count };
  }

  async scroll(deltaY = -3, label = 'Scrolling') {
    if (this.guideOnly) {
      await this.setCursor({ ...this.lastPoint, label, kind: 'point', guide: true });
      return { ok: true, skipped: 'guide' };
    }
    const amount = Math.max(-20, Math.min(20, Math.round(Number(deltaY) || -3)));
    await this.setCursor({ ...this.lastPoint, label, kind: 'move' });
    try {
      if (this.xdotool) {
        // positive deltaY => scroll up (button 4); negative => scroll down (button 5)
        const btn = amount >= 0 ? '4' : '5';
        const reps = Math.max(1, Math.abs(amount));
        await execFileAsync(this.xdotool, ['click', '--repeat', String(reps), '--delay', '30', btn], {
          timeout: 6000,
        });
      } else if (this.cliclick && process.platform === 'darwin') {
        // cliclick: positive = up
        const wheel = amount >= 0 ? `kd:ctrl` : '';
        void wheel;
        await execFileAsync(this.cliclick, [`m:${this.lastPoint.x},${this.lastPoint.y}`], { timeout: 4000 }).catch(() => {});
        await darwinInput(['scroll', '0', String(amount)], 6000);
      } else if (process.platform === 'darwin') {
        await darwinInput(['scroll', '0', String(amount)], 6000);
      } else if (process.platform === 'win32') {
        // Real mouse wheel via MOUSEEVENTF_WHEEL (0x0800), not Page Up/Down.
        const wheelDelta = amount >= 0 ? 120 : -120;
        const reps = Math.max(1, Math.abs(amount));
        const ps = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${this.lastPoint.x},${this.lastPoint.y});
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M { [DllImport("user32.dll")] public static extern void mouse_event(int f,int a,int b,int c,int d); }
"@;
for ($i=0; $i -lt ${reps}; $i++) { [M]::mouse_event(0x0800, 0, 0, ${wheelDelta}, 0); Start-Sleep -Milliseconds 20 }
`;
        await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 6000 });
      }
    } catch (error) {
      logger.warn('Scroll failed', { error: error.message });
    }
    return { ok: true, deltaY: amount };
  }

  async typeText(text, label = 'Typing') {
    if (this.guideOnly) {
      await this.setCursor({
        ...this.lastPoint,
        label: `Type: ${String(text || '').slice(0, 40)}`,
        kind: 'point',
        guide: true,
      });
      return { ok: true, skipped: 'guide' };
    }
    await this.setCursor({ ...this.lastPoint, label, kind: 'type' });
    const value = String(text || '');
    if (!value) return { ok: true };
    try {
      if (this.xdotool) {
        await execFileAsync(this.xdotool, ['type', '--clearmodifiers', '--delay', '12', '--', value], {
          timeout: 30000,
        });
      } else if (this.cliclick) {
        await execFileAsync(this.cliclick, [`t:${value}`], { timeout: 30000 });
      } else if (process.platform === 'darwin') {
        await darwinInput(['type', value], 30000);
      } else if (process.platform === 'win32') {
        const escaped = value.replace(/'/g, "''");
        const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
        await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 30000 });
      }
    } catch (error) {
      logger.warn('Type failed', { error: error.message });
    }
    return { ok: true };
  }

  async key(keyName, label = 'Key') {
    if (this.guideOnly) {
      await this.setCursor({ ...this.lastPoint, label: `Press ${keyName}`, kind: 'point', guide: true });
      return { ok: true, skipped: 'guide' };
    }
    await this.setCursor({ ...this.lastPoint, label, kind: 'key' });
    try {
      if (this.xdotool) {
        await execFileAsync(this.xdotool, ['key', '--clearmodifiers', String(keyName)], { timeout: 4000 });
      } else if (this.cliclick) {
        await execFileAsync(this.cliclick, [`kp:${keyName}`], { timeout: 4000 });
      } else if (process.platform === 'darwin') {
        await darwinInput(['key', String(keyName)], 8000);
      } else if (process.platform === 'win32') {
        const map = { Return: '{ENTER}', Enter: '{ENTER}', Tab: '{TAB}', Escape: '{ESC}' };
        const send = map[keyName] || `{${keyName}}`;
        const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${send}')`;
        await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 4000 });
      }
    } catch (error) {
      logger.warn('Key failed', { error: error.message });
    }
    return { ok: true };
  }

  async runAction(action, task = this.currentTask) {
    if (this.aborted) return { ok: false, aborted: true };
    if (!action || typeof action !== 'object') throw new Error('Invalid desktop action');

    const safety = checkActionSafety(action, task);
    if (safety.blocked) {
      logger.warn('Blocked unsafe desktop action', {
        type: action.type,
        reason: safety.reason,
        label: action.label,
      });
      return { ok: false, blocked: true, reason: safety.reason };
    }

    this.active = true;
    try {
      const type = String(action.type || '').toLowerCase();
      logger.info('Running desktop action', {
        type,
        x: action.x,
        y: action.y,
        label: action.label,
        textPreview: action.text ? String(action.text).slice(0, 80) : undefined,
        key: action.key,
      });
      switch (type) {
        case 'point':
          return this.point(action.x, action.y, action.label || 'Look here');
        case 'move':
          return this.move(action.x, action.y, action.label || 'Moving');
        case 'click':
          return this.click(action.x, action.y, action.button, action.label || 'Clicking', {
            clicks: 1,
          });
        case 'doubleclick':
        case 'double_click':
          return this.click(action.x, action.y, action.button, action.label || 'Double-click', {
            clicks: 2,
          });
        case 'type':
          return this.typeText(action.text, action.label || 'Typing');
        case 'key':
        case 'hotkey':
          return this.key(action.key, action.label || 'Key');
        case 'scroll':
          return this.scroll(
            action.deltaY != null ? action.deltaY : action.amount,
            action.label || 'Scrolling',
          );
        case 'wait':
          await wait(Math.max(0, Math.min(8000, Number(action.ms) || 300)));
          return { ok: true };
        default:
          throw new Error(`Unsupported desktop action: ${action.type}`);
      }
    } finally {
      this.active = false;
    }
  }

  async startControl(task = '') {
    this.aborted = false;
    this.controlling = true;
    this.guideOnly = false;
    this.currentTask = String(task || '');
    await this.setGlow(true);
    await this.setCursor({ ...this.lastPoint, label: 'Take Control', kind: 'move' });
    return { ok: true, controlling: true, driver: this.driver };
  }

  async stopControl() {
    this.aborted = true;
    this.controlling = false;
    this.guideOnly = false;
    this.currentTask = '';
    await this.setGlow(false);
    await this.setCursor(null);
    return { ok: true, controlling: false };
  }

  destroy() {
    for (const win of [this.cursorWindow, this.glowWindow]) {
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch {
        /* ignore */
      }
    }
    this.cursorWindow = null;
    this.glowWindow = null;
  }
}

module.exports = new DesktopControlService();
