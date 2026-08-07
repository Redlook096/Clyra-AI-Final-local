import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, BrowserWindow, clipboard, globalShortcut, screen, shell, systemPreferences } from "electron";

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
    this.shortcutRegistered = false;
    this.activationId = 0;
    this.shortcut = process.platform === "darwin" ? "Command+Shift+K" : "Control+Shift+K";
  }

  isSender(contents) {
    return Boolean(contents && (contents.id === this.uiContents()?.id || contents.id === this.window?.webContents.id));
  }

  async initialize() {
    globalShortcut.unregister(this.shortcut);
    this.shortcutRegistered = globalShortcut.register(this.shortcut, () => void this.toggle());
    if (!this.shortcutRegistered) console.warn("[dictation] global Cmd/Ctrl+Shift+K is already owned by another app.");
  }

  destroy() {
    globalShortcut.unregister(this.shortcut);
    this.shortcutRegistered = false;
    this.unregisterEscape();
    this.window?.destroy();
    this.window = null;
  }

  /** macOS mic / camera / accessibility status for actionable UI copy. */
  async permissionStatus() {
    if (process.platform !== "darwin") {
      return { microphone: "unknown", camera: "unknown", accessibility: true, trusted: true };
    }
    let microphone = "unknown";
    let camera = "unknown";
    try {
      microphone = systemPreferences.getMediaAccessStatus("microphone");
    } catch {
      microphone = "unknown";
    }
    try {
      camera = systemPreferences.getMediaAccessStatus("camera");
    } catch {
      camera = "unknown";
    }
    let accessibility = true;
    try {
      accessibility = systemPreferences.isTrustedAccessibilityClient(false);
    } catch {
      accessibility = true;
    }
    return { microphone, camera, accessibility, trusted: accessibility };
  }

  micAppLabel() {
    // After tools/patch-electron-macos-privacy.mjs, desktop:dev lists as "Clyra".
    // Fall back to Electron only when the patched name is unavailable.
    try {
      const name = String(app.getName?.() || "").trim();
      if (name && !/^electron$/i.test(name)) return name;
    } catch {
      // ignore
    }
    return process.env.CLYRA_ELECTRON_DEV === "1" ? "Clyra" : "Clyra";
  }

  mediaBlockedMessage(kind = "microphone", status = "denied") {
    const appLabel = this.micAppLabel();
    const label = kind === "camera" ? "Camera" : "Microphone";
    if (process.platform === "win32") {
      return `${label} access is blocked. Opening Windows Settings → Privacy → ${label} so you can enable ${appLabel}.`;
    }
    if (status === "restricted") {
      return `${label} access is restricted by the system. Opening System Settings → Privacy & Security → ${label} so you can enable ${appLabel}.`;
    }
    return `${label} access is blocked. Opening System Settings → Privacy & Security → ${label} and turn on “${appLabel}”.`;
  }

  micBlockedMessage(status = "denied") {
    return this.mediaBlockedMessage("microphone", status);
  }

  async ensureMediaAccess(mediaType = "microphone") {
    if (process.platform === "linux") return { ok: true, status: "unknown", mediaType };
    if (process.platform === "win32") {
      // Windows has no askForMediaAccess equivalent; Chromium still prompts /
      // respects Privacy settings. If getUserMedia later fails we open Settings.
      return { ok: true, status: "unknown", mediaType };
    }
    const kind = mediaType === "camera" ? "camera" : "microphone";
    let status = "unknown";
    try {
      status = systemPreferences.getMediaAccessStatus(kind);
    } catch {
      // Prefer attempting capture over hard-failing when the TCC query fails.
      return { ok: true, status: "unknown", mediaType: kind };
    }
    if (status === "granted") return { ok: true, status, mediaType: kind };

    // Always attempt the native prompt once. After we re-identity Electron.app
    // for TCC, a stale "denied" from the shared com.github.Electron bundle can
    // clear into a real prompt for ai.clyra.desktop.dev / "Clyra".
    if (status === "not-determined" || status === "unknown" || status === "denied") {
      try {
        const granted = await systemPreferences.askForMediaAccess(kind);
        if (granted) return { ok: true, status: "granted", mediaType: kind };
      } catch (error) {
        await this.openPrivacySettings(kind);
        return {
          ok: false,
          status: "denied",
          mediaType: kind,
          error: this.mediaBlockedMessage(kind, "denied"),
          cause: error instanceof Error ? error.message : String(error || ""),
        };
      }
    }

    if (status === "restricted") {
      await this.openPrivacySettings(kind);
      return {
        ok: false,
        status,
        mediaType: kind,
        error: this.mediaBlockedMessage(kind, status),
      };
    }

    await this.openPrivacySettings(kind);
    return {
      ok: false,
      status: "denied",
      mediaType: kind,
      error: this.mediaBlockedMessage(kind, "denied"),
    };
  }

  async ensureMicrophoneAccess() {
    return this.ensureMediaAccess("microphone");
  }

  async ensureCameraAccess() {
    return this.ensureMediaAccess("camera");
  }

  /**
   * Place the pill near the bottom of the display under the cursor,
   * horizontally centred — stable and easy to find outside the app.
   */
  positionPill() {
    if (!this.window || this.window.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = display.workArea;
    const px = Math.round(x + (width - PILL_WIDTH) / 2);
    const py = Math.round(y + height - PILL_HEIGHT - Math.max(PILL_MARGIN, 28));
    this.window.setBounds({ x: px, y: py, width: PILL_WIDTH, height: PILL_HEIGHT });
  }

  async openPrivacySettings(kind = "microphone") {
    // Prefer the OS `open` / `start` CLIs — shell.openExternal often no-ops on
    // preference-pane URLs (especially on newer macOS System Settings).
    const pane = kind === "camera" ? "Privacy_Camera" : "Privacy_Microphone";
    if (process.platform === "darwin") {
      const candidates = [
        `x-apple.systempreferences:com.apple.preference.security?${pane}`,
        `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?${pane}`,
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
      ];
      for (const url of candidates) {
        try {
          await execFileAsync("open", [url], { timeout: 4_000 });
          return { ok: true };
        } catch {
          // Try the next deep-link style used across macOS versions.
        }
      }
      try {
        await execFileAsync("open", ["/System/Library/PreferencePanes/Security.prefPane"], { timeout: 4_000 });
        return { ok: true };
      } catch {
        await shell.openExternal(candidates[0]).catch(() => undefined);
        return { ok: true };
      }
    }
    if (process.platform === "win32") {
      const uri = kind === "camera" ? "ms-settings:privacy-webcam" : "ms-settings:privacy-microphone";
      try {
        // Empty title arg keeps `start` from treating the URI as a window title.
        await execFileAsync("cmd", ["/c", "start", "", uri], { timeout: 4_000, windowsHide: true });
        return { ok: true };
      } catch {
        await shell.openExternal(uri).catch(() => undefined);
        return { ok: true };
      }
    }
    return { ok: false };
  }

  async openMicrophoneSettings() {
    return this.openPrivacySettings("microphone");
  }

  async openCameraSettings() {
    return this.openPrivacySettings("camera");
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
      y: Math.round(y + height - PILL_HEIGHT - Math.max(PILL_MARGIN, 28)),
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
