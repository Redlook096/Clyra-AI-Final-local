/**
 * OpenCluely desktop control — direct native OS automation.
 * Linux: xdotool | macOS: cliclick/osascript | Windows: PowerShell
 *
 * Can click / type / key / scroll freely. Destructive file ops are blocked
 * unless the user's task explicitly asks (see control-safety.js).
 */
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { screen } = require('electron');
const logger = require('../core/logger').createServiceLogger('DESKTOP-CONTROL');
const { checkActionSafety } = require('./control-safety');

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MACOS_INPUT = path.join(__dirname, 'macos-input.py');
const MACOS_SWIFT_INPUT = path.join(__dirname, 'macos-input.swift');

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
  // Fresh macOS installs commonly do not include PyObjC. The Swift helper uses
  // native ApplicationServices and requests Accessibility once when needed.
  try {
    await execFileAsync('/usr/bin/swift', [MACOS_SWIFT_INPUT, ...args], {
      timeout: Math.max(timeout, 12000),
    });
    return true;
  } catch (error) {
    lastError = error;
  }
  throw lastError || new Error('macOS input helper failed');
}

class DesktopControlService {
  constructor() {
    this.active = false;
    this.controlling = false;
    this.guideOnly = false;
    this.aborted = false;
    this.xdotool = null;
    this.cliclick = null;
    this.lastPoint = { x: 40, y: 40 };
    this.driver = 'none';
    this.currentTask = '';
    this.pressedButtons = new Set();
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

  async point(x, y, label = 'Look here') {
    this.guideOnly = true;
    const point = { x: Math.round(x), y: Math.round(y) };
    this.lastPoint = point;
    // Match computer-agent: use the actual system pointer, never a second
    // decorative cursor or full-screen glow. The bar remains the status UI.
    await wait(120);
    return { ok: true, point, guide: true };
  }

  async move(x, y, label = 'Moving') {
    const point = { x: Math.round(x), y: Math.round(y) };
    if (this.guideOnly) {
      await wait(120);
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
    await wait(80);
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
    return { ok: true, point, clicks: count };
  }

  async scroll(deltaY = -3, label = 'Scrolling') {
    if (this.guideOnly) {
      return { ok: true, skipped: 'guide' };
    }
    const amount = Math.max(-20, Math.min(20, Math.round(Number(deltaY) || -3)));
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
      return { ok: true, skipped: 'guide' };
    }
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
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  async key(keyName, label = 'Key') {
    if (this.guideOnly) {
      return { ok: true, skipped: 'guide' };
    }
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
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  mapFromAiSpace(x, y, screenWidth, screenHeight, aiWidth = 1280, aiHeight = 800) {
    return {
      x: Math.max(0, Math.min(screenWidth - 1, Math.round((Number(x) || 0) * screenWidth / aiWidth))),
      y: Math.max(0, Math.min(screenHeight - 1, Math.round((Number(y) || 0) * screenHeight / aiHeight))),
    };
  }

  async mouseButton(direction, button = 'left') {
    const normalized = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
    if (this.guideOnly) return { ok: true, skipped: 'guide' };
    if (this.xdotool) {
      const code = normalized === 'right' ? '3' : normalized === 'middle' ? '2' : '1';
      await execFileAsync(this.xdotool, [direction === 'down' ? 'mousedown' : 'mouseup', code], { timeout: 4000 });
    } else if (process.platform === 'darwin') {
      await darwinInput([
        direction === 'down' ? 'mouse_down' : 'mouse_up',
        String(this.lastPoint.x),
        String(this.lastPoint.y),
        normalized,
      ], 4000);
    } else if (process.platform === 'win32') {
      const flag = direction === 'down'
        ? (normalized === 'right' ? 0x0008 : normalized === 'middle' ? 0x0020 : 0x0002)
        : (normalized === 'right' ? 0x0010 : normalized === 'middle' ? 0x0040 : 0x0004);
      const ps = `Add-Type @\"\nusing System; using System.Runtime.InteropServices; public class ClyraMouse { [DllImport(\"user32.dll\")] public static extern void mouse_event(int f,int a,int b,int c,int d); }\n\"@; [ClyraMouse]::mouse_event(${flag},0,0,0,0)`;
      await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 4000 });
    } else {
      throw new Error('Desktop mouse control is unavailable');
    }
    if (direction === 'down') this.pressedButtons.add(normalized);
    else this.pressedButtons.delete(normalized);
    return { ok: true };
  }

  async drag(start, end) {
    await this.move(start.x, start.y, 'Drag start');
    await this.mouseButton('down', 'left');
    try {
      await this.move(end.x, end.y, 'Dragging');
    } finally {
      await this.mouseButton('up', 'left');
    }
    return { ok: true, start, end };
  }

  /**
   * Execute suitedaces/computer-agent ComputerAction format.
   * @see https://github.com/suitedaces/computer-agent
   */
  async performComputerAction(input, task = this.currentTask) {
    const display = screen.getPrimaryDisplay();
    const sw = display.bounds?.width || display.workArea?.width || 1920;
    const sh = display.bounds?.height || display.workArea?.height || 1080;
    const map = (coord) => {
      if (!coord || !Array.isArray(coord)) return null;
      return this.mapFromAiSpace(coord[0], coord[1], sw, sh);
    };

    const action = String(input?.action || '').toLowerCase();
    const mapped = { note: action, label: action };

    switch (action) {
      case 'screenshot':
      case 'wait':
        if (action === 'wait') await wait(1000);
        return { ok: true, type: action };
      case 'mouse_move':
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        const pt = map(input.coordinate);
        if (pt) {
          mapped.x = pt.x;
          mapped.y = pt.y;
        }
        if (action === 'mouse_move') mapped.type = 'move';
        else if (action === 'left_click') mapped.type = 'click';
        else if (action === 'right_click') {
          mapped.type = 'click';
          mapped.button = 'right';
        } else if (action === 'middle_click') {
          mapped.type = 'click';
          mapped.button = 'middle';
        } else if (action === 'double_click') mapped.type = 'doubleclick';
        else if (action === 'triple_click') {
          mapped.type = 'click';
          mapped.clicks = 3;
        }
        break;
      }
      case 'left_click_drag': {
        const start = map(input.start_coordinate);
        const end = map(input.coordinate);
        if (start && end) {
          return this.drag(start, end);
        }
        return { ok: true, type: action };
      }
      case 'left_mouse_down':
      case 'left_mouse_up': {
        const pt = map(input.coordinate);
        if (pt) await this.move(pt.x, pt.y, action === 'left_mouse_down' ? 'Mouse down' : 'Mouse up');
        return this.mouseButton(action === 'left_mouse_down' ? 'down' : 'up', 'left');
      }
      case 'hold_key':
        // Holding a modifier across tool turns is not safe/reliable in the Electron bridge.
        // The model can use a normal key chord (for example cmd+c) instead.
        throw new Error('hold_key is unsupported; use a complete key chord instead.');
      case 'type':
        mapped.type = 'type';
        mapped.text = String(input.text || '');
        break;
      case 'key':
        mapped.type = 'key';
        mapped.key = String(input.text || input.key || '');
        break;
      case 'scroll': {
        const pt = map(input.coordinate);
        if (pt) {
          mapped.x = pt.x;
          mapped.y = pt.y;
        }
        mapped.type = 'scroll';
        const dir = String(input.scroll_direction || 'down').toLowerCase();
        const amount = Number(input.scroll_amount) || 3;
        mapped.deltaY = dir === 'up' ? amount : dir === 'down' ? -amount : amount;
        break;
      }
      case 'zoom':
        return { ok: true, type: 'zoom' };
      default:
        throw new Error(`Unsupported computer action: ${action}`);
    }

    if (mapped.type === 'click' && mapped.clicks === 3) {
      for (let i = 0; i < 3; i += 1) {
        const r = await this.runAction({ ...mapped, clicks: 1 }, task);
        if (r?.blocked) return r;
      }
      return { ok: true, type: action };
    }

    return this.runAction(mapped, task);
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
    return { ok: true, controlling: true, driver: this.driver };
  }

  async stopControl() {
    this.aborted = true;
    this.controlling = false;
    this.guideOnly = false;
    this.currentTask = '';
    for (const button of [...this.pressedButtons]) {
      await this.mouseButton('up', button).catch(() => {});
    }
    return { ok: true, controlling: false };
  }

  destroy() {}
}

module.exports = new DesktopControlService();
