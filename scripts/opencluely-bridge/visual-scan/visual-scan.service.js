/**
 * Visual Intelligence Scan — Electron main-process orchestrator (CJS).
 * Precomputes window geometry, captures one desktop backdrop, then renders a
 * transparent/opaque always-on-top overlay with a centre-out radial wave,
 * NameDrop-style liquid-glass deformation (GPU), and optional contour traces.
 */
const { BrowserWindow, screen, desktopCapturer } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const execFileAsync = promisify(execFile);

class VisualScanService {
  constructor({ logger } = {}) {
    this.logger = logger || console;
    this.overlay = null;
    this.running = false;
    this._ttlTimer = null;
    this._backdropTmp = null;
    this._startedAt = 0;
    this._durationMs = 2000;
  }

  isAvailable() {
    return true;
  }

  async collectWindows() {
    if (process.platform === "darwin") {
      const script = path.join(__dirname, "macos-windows.py");
      if (fs.existsSync(script)) {
        try {
          const { stdout } = await execFileAsync("python3", [script], {
            timeout: 2500,
            maxBuffer: 2 * 1024 * 1024,
          });
          const parsed = JSON.parse(String(stdout || "{}"));
          if (parsed?.ok && Array.isArray(parsed.windows)) {
            return parsed.windows;
          }
        } catch (error) {
          this.logger.warn?.("[visual-scan] window enum failed", error?.message || error);
        }
      }
    }

    if (process.platform === "linux") {
      try {
        const { stdout } = await execFileAsync("wmctrl", ["-lG"], {
          timeout: 2000,
          maxBuffer: 1024 * 1024,
        });
        const windows = [];
        for (const line of String(stdout || "").split("\n")) {
          const m = line.match(
            /^(0x[0-9a-fA-F]+)\s+\S+\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)$/,
          );
          if (!m) continue;
          const x = Number(m[2]);
          const y = Number(m[3]);
          const w = Number(m[4]);
          const h = Number(m[5]);
          const title = String(m[6] || "").trim();
          if (w < 80 || h < 60) continue;
          if (/opencluely|clyra visual|visual scan/i.test(title)) continue;
          windows.push({
            id: m[1],
            app: title.split(" ").slice(0, 2).join(" ") || "App",
            title,
            frame: { x, y, w, h },
          });
        }
        if (windows.length) return windows.slice(0, 60);
      } catch (_) {
        /* wmctrl optional */
      }
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const b = display.bounds;
    return [
      {
        id: 1,
        app: "Desktop",
        title: "",
        frame: { x: b.x + 48, y: b.y + 64, w: b.width - 96, h: b.height - 120 },
      },
    ];
  }

  #syntheticStructure(frame, app) {
    const els = [];
    const { x, y, w, h } = frame;
    if (w < 120 || h < 100) return els;

    els.push({
      role: "toolbar",
      frame: { x: x + 8, y: y + 8, w: Math.max(40, w - 16), h: Math.min(44, Math.round(h * 0.08)) },
      importance: 0.55,
      hierarchyDepth: 1,
      cornerRadius: 8,
    });

    if (/safari|chrome|firefox|edge|brave|arc|example/i.test(app || "")) {
      const barH = Math.min(32, Math.round(h * 0.05));
      const barW = Math.min(w * 0.55, Math.max(160, w - 180));
      els.push({
        role: "search",
        frame: {
          x: x + Math.round((w - barW) / 2),
          y: y + 12,
          w: barW,
          h: barH,
        },
        importance: 0.4,
        hierarchyDepth: 2,
        cornerRadius: 8,
      });
      els.push({
        role: "tabs",
        frame: { x: x + 12, y: y + 48, w: Math.max(80, w - 24), h: 28 },
        importance: 0.45,
        hierarchyDepth: 2,
        cornerRadius: 6,
      });
    }

    if (/code|cursor|finder|terminal|slack|notion|figma/i.test(app || "") && w > 420) {
      els.push({
        role: "sidebar",
        frame: {
          x: x + 10,
          y: y + Math.round(h * 0.12),
          w: Math.min(220, Math.round(w * 0.22)),
          h: Math.max(80, Math.round(h * 0.72)),
        },
        importance: 0.5,
        hierarchyDepth: 1,
        cornerRadius: 10,
      });
      els.push({
        role: "editor",
        frame: {
          x: x + Math.min(230, Math.round(w * 0.24)),
          y: y + Math.round(h * 0.12),
          w: Math.max(120, w - Math.min(250, Math.round(w * 0.28))),
          h: Math.max(80, Math.round(h * 0.72)),
        },
        importance: 0.48,
        hierarchyDepth: 1,
        cornerRadius: 10,
      });
    }

    return els;
  }

  async start(opts = {}) {
    // Interrupt policy: finish quietly if almost done; otherwise restart.
    if (this.running && !opts.force) {
      return { ok: true, already: true };
    }
    if (this.running && opts.force) {
      const remaining = this._durationMs - (Date.now() - this._startedAt);
      if (remaining > 0 && remaining < 300) {
        return { ok: true, already: true, finishing: true };
      }
      await this.stop();
    }
    this.running = true;
    this._startedAt = Date.now();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = display.bounds;
    const scale = display.scaleFactor || 1;
    let windows = [];
    try {
      windows = await this.collectWindows();
    } catch (_) {
      windows = [];
    }

    const filtered = [];
    const originX = bounds.width / 2;
    const originY = bounds.height / 2;

    const pushElement = (el) => {
      const f = el.frame;
      if (!f || f.w < 12 || f.h < 12) return;
      for (const prev of filtered) {
        if (rectIoU(prev.frame, f) > 0.92) return;
      }
      const nearestX = Math.min(Math.max(originX, f.x), f.x + f.w);
      const nearestY = Math.min(Math.max(originY, f.y), f.y + f.h);
      const activationRadius = Math.hypot(nearestX - originX, nearestY - originY);
      filtered.push({
        id: el.id || `el-${filtered.length}`,
        app: el.app || "",
        title: el.title || "",
        role: el.role || "window",
        frame: f,
        importance: el.importance ?? 1,
        hierarchyDepth: el.hierarchyDepth || 0,
        activationRadius,
        cornerRadius:
          el.cornerRadius ??
          Math.min(12, Math.max(8, Math.min(f.w, f.h) * 0.03)),
      });
    };

    for (const win of windows) {
      const f = win.frame || {};
      if (!f.w || !f.h) continue;
      const local = {
        x: f.x - bounds.x,
        y: f.y - bounds.y,
        w: f.w,
        h: f.h,
      };
      if (local.x + local.w < 0 || local.y + local.h < 0) continue;
      if (local.x > bounds.width || local.y > bounds.height) continue;
      const clipped = {
        x: Math.max(0, local.x),
        y: Math.max(0, local.y),
        w: Math.min(local.w, bounds.width - Math.max(0, local.x)),
        h: Math.min(local.h, bounds.height - Math.max(0, local.y)),
      };
      if (clipped.w < 40 || clipped.h < 40) continue;

      pushElement({
        id: win.id,
        app: win.app,
        title: win.title,
        role: "window",
        frame: clipped,
        importance: 1,
        hierarchyDepth: 0,
        cornerRadius: Math.min(12, Math.max(9, Math.min(clipped.w, clipped.h) * 0.03)),
      });

      for (const child of this.#syntheticStructure(clipped, win.app || win.title || "")) {
        pushElement(child);
      }
      if (filtered.length >= 120) break;
    }

    // Liquid NameDrop warp needs a one-shot desktop texture on every platform.
    // Linux also needs it for reliable compositing. Opt out with liquidWarp:false.
    const liquidWarp = opts.liquidWarp !== false;
    const needsBackdrop =
      liquidWarp || process.platform === "linux" || opts.forceBackdrop === true;
    const durationMs = Number(opts.durationMs) > 0 ? Number(opts.durationMs) : 2000;
    this._durationMs = durationMs;

    const scene = {
      width: bounds.width,
      height: bounds.height,
      scale,
      durationMs,
      origin: { x: originX, y: originY },
      maxRadius: Math.hypot(bounds.width / 2, bounds.height / 2) * 1.08,
      elements: filtered,
      reason: opts.reason || "scan",
      backdropPath: null,
      hasBackdrop: false,
      needsBackdrop,
      liquidWarp,
    };

    try {
      // Do not block the HTTP/IPC caller on renderer animation start.
      void this.#openOverlay(bounds, scene);
      return {
        ok: true,
        elements: filtered.length,
        backdrop: needsBackdrop,
        liquidWarp,
        durationMs,
      };
    } catch (error) {
      this.running = false;
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async stop() {
    this.#closeOverlay();
    this.running = false;
    return { ok: true };
  }

  async #captureBackdropFile(bounds) {
    const tmp = path.join(os.tmpdir(), `oc-scan-backdrop-${process.pid}-${Date.now()}.png`);
    const scale =
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor || 1;
    const physW = Math.max(640, Math.round(bounds.width * scale));
    const physH = Math.max(400, Math.round(bounds.height * scale));

    // macOS: native screencapture is sharp and includes the full display.
    if (process.platform === "darwin") {
      const displays = screen.getAllDisplays();
      const nearest = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const idx = Math.max(0, displays.findIndex((d) => d.id === nearest.id));
      const attempts = [
        // Prefer explicit display when multi-monitor; -D is 1-based.
        ["-x", `-D${idx + 1}`, tmp],
        // Fallback: full interactive capture of main/current display.
        ["-x", tmp],
      ];
      for (const args of attempts) {
        try {
          await execFileAsync("screencapture", args, { timeout: 5000 });
          if (fs.existsSync(tmp) && fs.statSync(tmp).size > 8000) {
            this._backdropTmp = tmp;
            this.logger.info?.("[visual-scan] macOS backdrop captured", {
              bytes: fs.statSync(tmp).size,
              args: args.slice(0, -1).join(" "),
            });
            return tmp;
          }
        } catch (error) {
          this.logger.warn?.("[visual-scan] screencapture attempt failed", {
            args: args.slice(0, -1).join(" "),
            error: error?.message || String(error),
          });
        }
      }
    }

    // On Linux with GPU disabled, desktopCapturer thumbnails are often black.
    // Prefer scrot/import for a real framebuffer snapshot.
    if (process.platform === "linux") {
      try {
        await execFileAsync("scrot", ["-o", tmp], { timeout: 2500 });
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 8000) {
          this._backdropTmp = tmp;
          return tmp;
        }
      } catch (_) {
        /* try import */
      }
      try {
        const display = process.env.DISPLAY || ":0";
        await execFileAsync(
          "import",
          ["-window", "root", "-display", display, "-quality", "90", tmp],
          { timeout: 4000, env: { ...process.env, DISPLAY: display } },
        );
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 8000) {
          this._backdropTmp = tmp;
          return tmp;
        }
      } catch (_) {
        /* fall through */
      }
    }

    // Windows (and fallback): PowerShell virtual-screen capture when available.
    if (process.platform === "win32") {
      try {
        const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${tmp.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;
        await execFileAsync(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
          { timeout: 5000 },
        );
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 8000) {
          this._backdropTmp = tmp;
          return tmp;
        }
      } catch (_) {
        /* fall through */
      }
    }

    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: {
          width: physW,
          height: physH,
        },
      });
      const match =
        sources.find(
          (s) =>
            String(s.display_id) ===
            String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id),
        ) || sources[0];
      if (match?.thumbnail && !match.thumbnail.isEmpty()) {
        const resized = match.thumbnail.resize({
          width: Math.round(bounds.width * scale),
          height: Math.round(bounds.height * scale),
          quality: "good",
        });
        // Reject near-black captures (common when GPU compositing is off).
        const size = resized.getSize();
        const sample = resized.crop({
          x: Math.floor(size.width / 2),
          y: Math.floor(size.height / 2),
          width: 8,
          height: 8,
        });
        const avg =
          sample.toBitmap().reduce((sum, b, i) => (i % 4 === 3 ? sum : sum + b), 0) /
          (8 * 8 * 3);
        if (avg > 8) {
          fs.writeFileSync(tmp, resized.toPNG());
          this._backdropTmp = tmp;
          return tmp;
        }
      }
    } catch (_) {
      /* ignore */
    }
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  async #openOverlay(bounds, scene) {
    this.#closeOverlay();
    this.running = true;

    if (scene.needsBackdrop) {
      try {
        scene.backdropPath = await this.#captureBackdropFile(bounds);
        scene.hasBackdrop = Boolean(scene.backdropPath);
      } catch (error) {
        this.logger.warn?.("[visual-scan] backdrop capture failed", error?.message || error);
      }
    }

    const overlayPath = path.join(__dirname, "overlay.html");
    const useBackdrop = Boolean(scene.backdropPath || scene.hasBackdrop);
    this.logger.info?.("[visual-scan] opening overlay", {
      overlayPath,
      useBackdrop,
      hasBackdropPath: Boolean(scene.backdropPath),
      liquidWarp: Boolean(scene.liquidWarp),
      elements: scene.elements?.length || 0,
      w: bounds.width,
      h: bounds.height,
      durationMs: scene.durationMs,
    });

    this.overlay = new BrowserWindow({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      frame: false,
      // Liquid warp paints a full-screen desktop texture; use opaque surface then.
      // Without a backdrop, stay transparent so the live desktop shows through.
      transparent: !useBackdrop,
      backgroundColor: useBackdrop ? "#000000" : "#00000000",
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      fullscreenable: false,
      show: false,
      title: "Clyra Visual Scan",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        // Keep WebGL available for the liquid deformation pass.
        webgl: true,
        offscreen: false,
      },
    });
    this.overlay.setIgnoreMouseEvents(true, { forward: true });
    try {
      this.overlay.setAlwaysOnTop(true, "screen-saver");
    } catch (_) {
      try {
        this.overlay.setAlwaysOnTop(true, "pop-up-menu");
      } catch (_) {
        this.overlay.setAlwaysOnTop(true);
      }
    }
    try {
      this.overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (_) {
      /* ignore */
    }

    const payload = JSON.stringify(scene).replace(/</g, "\\u003c");

    this.overlay.webContents.on("did-finish-load", () => {
      if (!this.overlay || this.overlay.isDestroyed()) return;
      try {
        if (process.platform === "linux") this.overlay.show();
        else this.overlay.showInactive();
        try {
          this.overlay.moveTop();
        } catch (_) {
          /* ignore */
        }
        this.overlay.webContents
          .executeJavaScript(`window.__runVisualScan && window.__runVisualScan(${payload});`, true)
          .then(() => this.logger.info?.("[visual-scan] animation started"))
          .catch((error) =>
            this.logger.warn?.("[visual-scan] run failed", error?.message || error),
          );
      } catch (error) {
        this.logger.warn?.("[visual-scan] show/run failed", error?.message || error);
      }
    });

    try {
      await this.overlay.loadFile(overlayPath);
    } catch (error) {
      this.logger.warn?.("[visual-scan] loadFile failed", error?.message || error);
      this.#closeOverlay();
      this.running = false;
      return;
    }

    const ttl = (scene.durationMs || 2000) + 600;
    if (this._ttlTimer) clearTimeout(this._ttlTimer);
    this._ttlTimer = setTimeout(() => {
      this.#closeOverlay();
      this.running = false;
    }, ttl);
  }

  #closeOverlay() {
    if (this._ttlTimer) {
      clearTimeout(this._ttlTimer);
      this._ttlTimer = null;
    }
    if (this.overlay && !this.overlay.isDestroyed()) {
      try {
        this.overlay.close();
      } catch (_) {
        /* ignore */
      }
    }
    this.overlay = null;
    if (this._backdropTmp) {
      try {
        fs.unlinkSync(this._backdropTmp);
      } catch (_) {
        /* ignore */
      }
      this._backdropTmp = null;
    }
  }
}

function rectIoU(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

module.exports = { VisualScanService };
