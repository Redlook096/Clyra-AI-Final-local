import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { BrowserWindow, clipboard, globalShortcut, screen } from "electron";

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshotClipboard() {
  const formats = clipboard.availableFormats();
  return formats.flatMap((format) => {
    try {
      return [{ format, value: clipboard.readBuffer(format).toString("base64") }];
    } catch {
      return [];
    }
  });
}

function restoreClipboard(snapshot) {
  clipboard.clear();
  for (const item of snapshot || []) {
    try {
      clipboard.writeBuffer(item.format, Buffer.from(item.value, "base64"));
    } catch {
      // Individual proprietary formats can be rejected by the OS; restoring
      // the remaining formats is still safer than leaving dictation text there.
    }
  }
}

async function runAppleScript(script) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
    timeout: 4_000,
    maxBuffer: 64 * 1024,
  });
  return String(stdout || "").trim();
}

async function frontmostApplication() {
  if (process.platform !== "darwin") return "";
  return runAppleScript('tell application "System Events" to get name of first process whose frontmost is true');
}

async function focusApplication(name) {
  if (process.platform !== "darwin" || !name) return;
  const escaped = String(name).replace(/\\/g, "\\\\").replace(/\"/g, '\\\"');
  await runAppleScript(`tell application "${escaped}" to activate`);
  await wait(70);
}

async function readSelectedText() {
  if (process.platform !== "darwin") return "";
  const direct = 'tell application "System Events" to tell (first process whose frontmost is true) to tell (focused UI element of front window) to get value of attribute "AXSelectedText"';
  try {
    const selected = await runAppleScript(direct);
    if (selected) return selected;
  } catch {
    // Some apps expose no AXSelectedText. The fallback remains explicit: this
    // only runs immediately after the user invokes Clyra's global shortcut.
  }
  const saved = snapshotClipboard();
  try {
    await runAppleScript('tell application "System Events" to keystroke "c" using command down');
    await wait(80);
    return clipboard.readText();
  } finally {
    restoreClipboard(saved);
  }
}

export class DictationManager {
  constructor({ uiContents, preloadPath, pillPath }) {
    this.uiContents = uiContents;
    this.preloadPath = preloadPath;
    this.pillPath = pillPath;
    this.window = null;
    this.phase = "idle";
    this.payload = { phase: "idle" };
    this.target = null;
    this.escapeRegistered = false;
  }

  isSender(contents) {
    return Boolean(contents && (contents.id === this.uiContents()?.id || contents.id === this.window?.webContents.id));
  }

  async initialize() {
    const shortcut = process.platform === "darwin" ? "CommandOrControl+Shift+K" : "Control+Shift+K";
    globalShortcut.unregister(shortcut);
    if (!globalShortcut.register(shortcut, () => void this.toggle())) {
      throw new Error("Clyra could not register the global dictation shortcut.");
    }
  }

  destroy() {
    globalShortcut.unregisterAll();
    this.window?.destroy();
    this.window = null;
  }

  ensurePill() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.workArea;
    this.window = new BrowserWindow({
      width: 420,
      height: 92,
      x: Math.round(x + (width - 420) / 2),
      y: Math.round(y + height - 150),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: "Clyra Dictation",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window.setAlwaysOnTop(true, "floating");
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.loadFile(this.pillPath).catch(() => undefined);
    this.window.webContents.once("did-finish-load", () => this.emitPill());
    this.window.on("closed", () => { this.window = null; });
    return this.window;
  }

  emitPill() {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("dictation:pill-state", this.payload);
  }

  emitUi(channel, payload) {
    const contents = this.uiContents();
    if (contents && !contents.isDestroyed()) contents.send(channel, payload);
  }

  setState(payload) {
    this.payload = { ...this.payload, ...payload };
    this.phase = this.payload.phase || "idle";
    if (this.phase === "idle") {
      this.unregisterEscape();
      const current = this.window;
      if (current && !current.isDestroyed()) setTimeout(() => current.hide(), 650);
    } else {
      this.ensurePill().showInactive();
      this.registerEscape();
    }
    this.emitPill();
  }

  registerEscape() {
    if (this.escapeRegistered) return;
    this.escapeRegistered = globalShortcut.register("Escape", () => this.cancel());
  }

  unregisterEscape() {
    if (!this.escapeRegistered) return;
    globalShortcut.unregister("Escape");
    this.escapeRegistered = false;
  }

  async toggle() {
    if (["listening", "processing", "optimising"].includes(this.phase)) {
      this.emitUi("dictation:trigger", { type: "stop" });
      return;
    }
    if (this.phase === "selection" || this.phase === "preview") {
      this.cancel();
      return;
    }
    const target = { application: await frontmostApplication().catch(() => ""), selectedText: "" };
    target.selectedText = await readSelectedText().catch(() => "");
    this.target = target;
    if (target.selectedText.trim()) {
      this.setState({ phase: "selection", selectedText: target.selectedText.slice(0, 260), application: target.application, detail: "Selected text ready" });
      this.emitUi("dictation:trigger", { type: "selection", target });
    } else {
      this.setState({ phase: "listening", application: target.application, detail: "Listening" });
      this.emitUi("dictation:trigger", { type: "start", target });
    }
  }

  async action(action) {
    if (action === "cancel") return this.cancel();
    // A click on the visible pill focuses Clyra temporarily. Restore the app
    // selected at activation before asking the renderer to open the mic so
    // the later paste cannot land in Clyra's own window.
    await focusApplication(this.target?.application).catch(() => undefined);
    this.emitUi("dictation:action", { action, target: this.target });
  }

  cancel() {
    this.emitUi("dictation:trigger", { type: "cancel" });
    this.target = null;
    this.setState({ phase: "idle", detail: "" });
  }

  async insert({ text, target }) {
    if (!text?.trim()) throw new Error("Clyra received no text to insert.");
    if (process.platform !== "darwin") {
      throw new Error("Native insertion is not available on this platform yet. The text remains ready to copy.");
    }
    const current = await frontmostApplication();
    if (!target?.application || current !== target.application) {
      throw new Error("The active application changed while dictation was processing. Nothing was pasted.");
    }
    const saved = snapshotClipboard();
    try {
      clipboard.writeText(text);
      await wait(55);
      await runAppleScript('tell application "System Events" to keystroke "v" using command down');
      await wait(150);
      return { ok: true };
    } finally {
      restoreClipboard(saved);
    }
  }
}
