import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserWindow, clipboard, globalShortcut, screen, systemPreferences } from "electron";

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PILL_WIDTH = 380;
const PILL_HEIGHT = 96;
const PILL_MARGIN = 16;

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
    // Some native controls expose no AXSelectedText. This fallback only runs
    // after an explicit global shortcut and restores every clipboard format.
  }
  const saved = snapshotClipboard();
  // A no-selection Cmd+C leaves the clipboard untouched. Seed it with a
  // per-activation marker so stale clipboard text cannot impersonate a
  // selected range and open Replace/Enhance by mistake.
  const marker = `__clyra_selection_probe_${crypto.randomUUID()}__`;
  try {
    clipboard.writeText(marker);
    await runAppleScript('tell application "System Events" to keystroke "c" using command down');
    await wait(70);
    const copied = clipboard.readText();
    return copied === marker ? "" : copied;
  } finally {
    restoreClipboard(saved);
  }
}

function isClyraProcessName(name) {
  return /^clyra$/i.test(String(name || "").trim());
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
    this.activationId = 0;
    this.shortcut = process.platform === "darwin" ? "Command+Shift+K" : "Control+Shift+K";
  }

  isSender(contents) {
    return Boolean(contents && (contents.id === this.uiContents()?.id || contents.id === this.window?.webContents.id));
  }

  async initialize() {
    globalShortcut.unregister(this.shortcut);
    if (!globalShortcut.register(this.shortcut, () => void this.toggle())) {
      throw new Error("Clyra could not register the global dictation shortcut.");
    }
  }

  destroy() {
    globalShortcut.unregister(this.shortcut);
    this.unregisterEscape();
    this.window?.destroy();
    this.window = null;
  }

  /** macOS mic / accessibility status for actionable UI copy. */
  async permissionStatus() {
    if (process.platform !== "darwin") {
      return { microphone: "unknown", accessibility: true, trusted: true };
    }
    let microphone = "unknown";
    try {
      microphone = systemPreferences.getMediaAccessStatus("microphone");
    } catch {
      microphone = "unknown";
    }
    let accessibility = true;
    try {
      accessibility = systemPreferences.isTrustedAccessibilityClient(false);
    } catch {
      accessibility = true;
    }
    return { microphone, accessibility, trusted: accessibility };
  }

  async ensureMicrophoneAccess() {
    if (process.platform !== "darwin") return { ok: true, status: "unknown" };
    let status = "unknown";
    try {
      status = systemPreferences.getMediaAccessStatus("microphone");
    } catch {
      return { ok: true, status: "unknown" };
    }
    if (status === "granted") return { ok: true, status };
    if (status === "denied" || status === "restricted") {
      return {
        ok: false,
        status,
        error: "Microphone access is blocked. Enable Clyra in System Settings → Privacy & Security → Microphone, then try Cmd+Shift+K again.",
      };
    }
    // not-determined / unknown — prompt once from the main process so a
    // background renderer does not silently fail getUserMedia.
    try {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return granted
        ? { ok: true, status: "granted" }
        : {
            ok: false,
            status: "denied",
            error: "Microphone permission was denied. Enable Clyra in System Settings → Privacy & Security → Microphone.",
          };
    } catch {
      return { ok: true, status };
    }
  }

  /**
   * Place the pill on the display under the cursor (not always the primary
   * display), near the pointer, clamped into that display's work area.
   */
  positionPill() {
    if (!this.window || this.window.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = display.workArea;
    let px = Math.round(cursor.x - PILL_WIDTH / 2);
    // Prefer just below the cursor so the expanding pill does not cover the
    // insertion caret; flip above when the pointer sits near the bottom edge.
    let py = Math.round(cursor.y + 28);
    if (py + PILL_HEIGHT > y + height - PILL_MARGIN) {
      py = Math.round(cursor.y - PILL_HEIGHT - 28);
    }
    // If the cursor is somehow outside a usable band, centre on this display.
    if (py < y + PILL_MARGIN || py + PILL_HEIGHT > y + height - PILL_MARGIN) {
      px = Math.round(x + (width - PILL_WIDTH) / 2);
      py = Math.round(y + Math.max(PILL_MARGIN, height * 0.38 - PILL_HEIGHT / 2));
    }
    px = Math.min(Math.max(px, x + PILL_MARGIN), x + width - PILL_WIDTH - PILL_MARGIN);
    py = Math.min(Math.max(py, y + PILL_MARGIN), y + height - PILL_HEIGHT - PILL_MARGIN);
    this.window.setBounds({ x: px, y: py, width: PILL_WIDTH, height: PILL_HEIGHT });
  }

  ensurePill() {
    if (this.window && !this.window.isDestroyed()) {
      this.positionPill();
      return this.window;
    }
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = display.workArea;
    this.window = new BrowserWindow({
      // The content grows from a circle within this transparent canvas, which
      // keeps the expansion optically centred on any display.
      width: PILL_WIDTH,
      height: PILL_HEIGHT,
      x: Math.round(x + (width - PILL_WIDTH) / 2),
      y: Math.round(y + Math.max(PILL_MARGIN, height * 0.38 - PILL_HEIGHT / 2)),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      fullscreenable: false,
      title: "Clyra Dictation",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window.setAlwaysOnTop(true, "floating");
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (process.platform === "darwin") {
      try {
        this.window.setWindowButtonVisibility(false);
      } catch {
        // Older Electron builds may not expose this helper.
      }
    }
    this.positionPill();
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
      const pill = this.ensurePill();
      this.positionPill();
      // showInactive keeps the user's target app focused while the overlay appears.
      pill.showInactive();
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
    if (this.phase === "error" || this.phase === "done") {
      // Same shortcut clears a prior failure and starts a fresh capture so the
      // user is not stuck on an error pill until Escape.
      this.activationId += 1;
      this.emitUi("dictation:trigger", { type: "cancel" });
      this.target = null;
    }
    // Do not wait on macOS accessibility APIs before showing the shortcut UI.
    // They can be slow when another app is busy, which used to make Cmd+Shift+K
    // feel broken even though the global shortcut had fired.
    const activationId = ++this.activationId;
    this.target = { application: "", selectedText: "" };
    this.setState({ phase: "arming", detail: "" });

    const mic = await this.ensureMicrophoneAccess();
    if (activationId !== this.activationId || this.phase === "idle") return;
    if (!mic.ok) {
      this.setState({ phase: "error", detail: mic.error });
      return;
    }

    const [application, selectedText] = await Promise.all([
      frontmostApplication().catch(() => ""),
      readSelectedText().catch(() => ""),
    ]);
    if (activationId !== this.activationId || this.phase === "idle") return;
    const target = { application, selectedText };
    this.target = target;
    if (selectedText.trim()) {
      this.setState({ phase: "selection", selectedText: selectedText.slice(0, 260), application, detail: "Selected text ready" });
      this.emitUi("dictation:trigger", { type: "selection", target });
      return;
    }
    this.setState({ phase: "listening", application, detail: "Listening" });
    this.emitUi("dictation:trigger", { type: "start", target });
  }

  async action(action) {
    if (action === "cancel") return this.cancel();
    // A click on the visible pill focuses Clyra temporarily. Restore the app
    // selected at activation before asking the renderer to open the mic so
    // the later paste cannot land in Clyra's own window.
    await focusApplication(this.target?.application).catch(() => undefined);
    // Keep the exact same full pill visible while the renderer opens the
    // microphone. Previously the compact Replace/Enhance chooser could linger
    // when Clyra was hidden, which made the next state look like a separate
    // menu rather than the normal dictation flow.
    this.setState({
      phase: "processing",
      detail: action === "enhance" || action === "optimise" ? "Preparing rewrite" : "Opening microphone",
    });
    this.emitUi("dictation:action", { action, target: this.target });
  }

  cancel() {
    this.activationId += 1;
    this.emitUi("dictation:trigger", { type: "cancel" });
    this.target = null;
    this.setState({ phase: "idle", detail: "" });
  }

  async insert({ text, target }) {
    if (!text?.trim()) throw new Error("Clyra received no text to insert.");
    if (process.platform !== "darwin") {
      throw new Error("Native insertion is not available on this platform yet. The text remains ready to copy.");
    }
    const intended = String(target?.application || "").trim();
    let current = await frontmostApplication().catch(() => "");

    if (intended && current !== intended) {
      await focusApplication(intended).catch(() => undefined);
      current = await frontmostApplication().catch(() => "");
      if (current !== intended) {
        throw new Error(`Focus moved away from ${intended}. Click back into that app, then press Cmd+Shift+K again.`);
      }
    } else if (!intended && isClyraProcessName(current)) {
      // We never learned the target app (usually missing Accessibility) and
      // Clyra is frontmost — refuse to paste into ourselves with a vague error.
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trusted) {
        throw new Error("Clyra needs Accessibility permission in System Settings → Privacy & Security → Accessibility to paste into other apps.");
      }
      throw new Error("Click into the app where you want the text, then press Cmd+Shift+K again.");
    }

    const saved = snapshotClipboard();
    try {
      clipboard.writeText(text);
      await wait(55);
      await runAppleScript('tell application "System Events" to keystroke "v" using command down');
      await wait(150);
      return { ok: true };
    } catch (error) {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trusted) {
        throw new Error("Clyra needs Accessibility permission in System Settings → Privacy & Security → Accessibility to paste into other apps.");
      }
      throw error instanceof Error ? error : new Error("Clyra could not paste the transcribed text.");
    } finally {
      restoreClipboard(saved);
    }
  }
}
