/**
 * Floating Screen Companion window — OpenCluely-inspired overlay for general
 * desktop help (not interview stealth). Talks via Clyra STT/TTS, sees the
 * screen via RapidOCR vision, and can take over with Atlas-style controls.
 */
import { BrowserWindow, globalShortcut, screen } from "electron";
import path from "node:path";

const WIDTH = 380;
const HEIGHT = 560;
const MARGIN = 18;

export class CompanionManager {
  /**
   * @param {{
   *   preloadPath: string,
   *   htmlPath: string,
   *   getServiceUrl: () => string,
   *   capture: import("./screen-capture.mjs").ScreenCaptureService,
   *   desktop: import("./desktop-control.mjs").DesktopControlService,
   *   analyseVision: (imagePath: string, question: string) => Promise<object>,
   *   askModel: (payload: object) => Promise<object>,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.window = null;
    this.shortcutRegistered = false;
    this.state = {
      phase: "idle",
      listening: false,
      seeing: false,
      controlling: false,
      manualControl: false,
      status: "Ready",
      transcript: "",
      reply: "",
    };
  }

  async initialize() {
    await this.options.desktop.initialize();
    try {
      this.shortcutRegistered = globalShortcut.register("CommandOrControl+Shift+J", () => {
        void this.toggle();
      });
    } catch {
      this.shortcutRegistered = false;
    }
  }

  isSender(webContents) {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.webContents === webContents);
  }

  async ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const display = screen.getPrimaryDisplay();
    const { width, height, x, y } = display.workArea;
    this.window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: x + width - WIDTH - MARGIN,
      y: y + height - HEIGHT - MARGIN,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window.setAlwaysOnTop(true, "floating");
    this.window.on("closed", () => {
      this.window = null;
      void this.options.desktop.setCursor(null);
    });
    await this.window.loadFile(this.options.htmlPath);
    return this.window;
  }

  async show() {
    const win = await this.ensureWindow();
    win.show();
    win.focus();
    this.#pushState({ phase: "open", status: "Ready — ask me anything about your screen" });
  }

  hide() {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
    this.#pushState({ phase: "idle", controlling: false, listening: false, seeing: false });
    void this.options.desktop.setManualControl(false);
    void this.options.desktop.setCursor(null);
  }

  async toggle() {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) this.hide();
    else await this.show();
  }

  #pushState(patch = {}) {
    this.state = { ...this.state, ...patch };
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("companion:state", this.state);
    }
    return this.state;
  }

  getState() {
    return { ...this.state, serviceUrl: this.options.getServiceUrl() };
  }

  async seeScreen(question = "") {
    this.#pushState({ seeing: true, status: "Looking at your screen…" });
    try {
      const capture = await this.options.capture.capture({ maxWidth: 1280, jpegQuality: 70 });
      const vision = await this.options.analyseVision(capture.path, question);
      this.#pushState({
        seeing: false,
        status: vision?.summary ? "Saw your screen" : "Screen captured",
        lastVision: vision,
        lastCapture: {
          path: capture.path,
          dimensions: capture.dimensions,
          capturedAt: capture.capturedAt,
        },
      });
      return { ok: true, capture, vision };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#pushState({ seeing: false, status: message });
      return { ok: false, error: message };
    }
  }

  async ask(text) {
    const question = String(text || "").trim();
    if (!question) return { ok: false, error: "Say or type something first." };
    this.#pushState({ phase: "thinking", status: "Thinking", transcript: question });
    const seen = await this.seeScreen(question);
    const visionSummary = seen.vision?.summary || "";
    const reply = await this.options.askModel({
      question,
      visionSummary,
      ocrText: seen.vision?.ocr?.lines?.map((line) => line.text).join("\n") || "",
      controlling: this.state.controlling,
    });
    this.#pushState({
      phase: "open",
      status: "Ready",
      reply: reply.text || "",
      transcript: question,
    });
    return { ok: true, reply, vision: seen.vision };
  }

  async startControl() {
    this.#pushState({ controlling: true, manualControl: false, status: "AI has control" });
    await this.options.desktop.setManualControl(false);
    const display = screen.getPrimaryDisplay();
    const cx = display.bounds.x + display.bounds.width / 2;
    const cy = display.bounds.y + display.bounds.height / 2;
    await this.options.desktop.move(cx, cy, "Ready to help");
    return { ok: true };
  }

  async takeManualControl() {
    this.#pushState({ manualControl: true, status: "You have control" });
    await this.options.desktop.setManualControl(true);
    await this.options.desktop.setCursor(null);
    return { ok: true };
  }

  async resumeAi() {
    this.#pushState({ manualControl: false, controlling: true, status: "AI has control" });
    await this.options.desktop.setManualControl(false);
    return { ok: true };
  }

  async stopControl() {
    this.#pushState({ controlling: false, manualControl: false, status: "Stopped" });
    await this.options.desktop.setManualControl(false);
    await this.options.desktop.setCursor(null);
    return { ok: true };
  }

  async runDesktopAction(action) {
    if (!this.state.controlling) await this.startControl();
    return this.options.desktop.runAction(action);
  }

  async runSmoke() {
    const artifactsDir = process.env.CLYRA_COMPANION_ARTIFACTS || "/opt/cursor/artifacts";
    const report = {
      ok: false,
      steps: [],
      at: new Date().toISOString(),
    };
    try {
      await this.show();
      report.steps.push({ step: "show", ok: true });
      const seen = await this.seeScreen("What is on my screen?");
      report.steps.push({
        step: "see",
        ok: Boolean(seen?.ok),
        summary: seen?.vision?.summary || seen?.error || "",
        capturePath: seen?.capture?.path || null,
      });
      await this.startControl();
      report.steps.push({ step: "startControl", ok: true });
      const display = screen.getPrimaryDisplay();
      const x = display.bounds.x + Math.round(display.bounds.width * 0.42);
      const y = display.bounds.y + Math.round(display.bounds.height * 0.38);
      await this.runDesktopAction({ type: "move", x, y, label: "Helping with your screen" });
      report.steps.push({ step: "move", ok: true, x, y });
      await this.runDesktopAction({ type: "wait", ms: 500 });
      const ask = await this.ask("What am I looking at? Help me briefly.");
      report.steps.push({
        step: "ask",
        ok: Boolean(ask?.ok),
        reply: String(ask?.reply?.text || "").slice(0, 400),
        source: ask?.reply?.source || null,
      });
      await this.takeManualControl();
      report.steps.push({ step: "takeManualControl", ok: true });
      await this.resumeAi();
      report.steps.push({ step: "resumeAi", ok: true });
      await this.stopControl();
      report.steps.push({ step: "stopControl", ok: true });
      report.ok = report.steps.every((step) => step.ok);
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      report.ok = false;
    }
    try {
      const { promises: fs } = await import("node:fs");
      await fs.mkdir(artifactsDir, { recursive: true });
      await fs.writeFile(
        path.join(artifactsDir, "companion-smoke.json"),
        JSON.stringify(report, null, 2),
      );
    } catch {
      /* ignore artifact write failures in smoke */
    }
    return report;
  }

  destroy() {
    try {
      if (this.shortcutRegistered) globalShortcut.unregister("CommandOrControl+Shift+J");
    } catch {
      /* ignore */
    }
    try {
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
    } catch {
      /* ignore */
    }
    this.window = null;
    this.options.desktop.destroy();
  }
}
