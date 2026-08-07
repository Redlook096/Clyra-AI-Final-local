import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, promises as fs, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, session, shell, WebContentsView } from "electron";
import { ChromiumBrowserManager } from "./browser-manager.mjs";
import { ChromiumSurfaceManager } from "./surface-manager.mjs";
import { DictationManager } from "./dictation-manager.mjs";
import { SmartToolbarManager } from "./smart-toolbar-manager.mjs";
import { GoogleWorkspaceManager } from "./google-workspace-manager.mjs";
import { DeepResearchManager } from "./deep-research-manager.mjs";
import { LocalMemoryManager } from "./local-memory-manager.mjs";
import { ScreenCaptureService } from "./screen-capture.mjs";
import { DesktopControlService } from "./desktop-control.mjs";
import { CompanionManager } from "./companion-manager.mjs";

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
// OAuth credentials stay in the local ignored .env file and are only read by
// this Electron main process. They are deliberately never sent over IPC.
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
const isDevelopment = process.env.CLYRA_ELECTRON_DEV === "1";
const appPort = Number(process.env.CLYRA_DESKTOP_PORT || 31_415);
const cdpPort = Number(process.env.CLYRA_CDP_PORT || 9_223);
const bridgePort = Number(process.env.CLYRA_BROWSER_BRIDGE_PORT || 9_224);
const bridgeToken = crypto.randomBytes(24).toString("hex");

app.setName("Clyra");
// QA and support launches can use an isolated profile without touching a
// person's active Clyra session or its persistent browser profile.
if (process.env.CLYRA_USER_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.CLYRA_USER_DATA_DIR));
}
nativeTheme.themeSource = "light";

app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

let mainWindow = null;
let uiView = null;
let browserManager = null;
let surfaceManager = null;
let dictationManager = null;
let smartToolbarManager = null;
let googleWorkspaceManager = null;
let deepResearchManager = null;
let localMemoryManager = null;
let companionManager = null;
let screenCaptureService = null;
let desktopControlService = null;
let serviceProcess = null;
let serviceLaunchError = null;
let serviceFallbackStarted = false;
let bridgeServer = null;
let quitting = false;
let createWindowPromise = null;
let bootPromise = null;
let ipcRegistered = false;
let nativeManagersDestroyed = false;

function destroyNativeManagers() {
  if (nativeManagersDestroyed) return;
  nativeManagersDestroyed = true;
  try { browserManager?.destroy(); } catch (error) { console.warn("[browser] teardown failed:", error); }
  try { surfaceManager?.destroy(); } catch (error) { console.warn("[surface] teardown failed:", error); }
  try { dictationManager?.destroy(); } catch (error) { console.warn("[dictation] teardown failed:", error); }
  try { smartToolbarManager?.destroy(); } catch (error) { console.warn("[smart-toolbar] teardown failed:", error); }
  try { companionManager?.destroy(); } catch (error) { console.warn("[companion] teardown failed:", error); }
  dictationManager = null;
  smartToolbarManager = null;
  companionManager = null;
  googleWorkspaceManager?.finishAuth?.();
  googleWorkspaceManager = null;
  deepResearchManager = null;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function reportDesktopLifecycle(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  void fs.appendFile(path.join(app.getPath("userData"), "desktop-runtime.log"), line, "utf8").catch(() => undefined);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Bridge request is too large.");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function startBrowserBridge() {
  bridgeServer = http.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${bridgeToken}`) {
      sendJson(response, 401, { ok: false, error: "Unauthorized" });
      return;
    }
    try {
      const url = new URL(request.url || "/", `http://127.0.0.1:${bridgePort}`);
      const body = request.method === "GET" ? {} : await readJson(request);
      if (request.method === "GET" && url.pathname === "/state") {
        sendJson(response, 200, { ok: true, state: browserManager?.getState() });
      } else if (request.method === "POST" && url.pathname === "/tabs") {
        const tab = await browserManager.createTab(body.url, { activate: body.activate !== false });
        sendJson(response, 200, { ok: true, tabId: tab.id, state: browserManager.getState() });
      } else if (request.method === "POST" && url.pathname === "/tabs/activate") {
        sendJson(response, 200, { ok: true, state: browserManager.activateTab(body.id) });
      } else if (request.method === "POST" && url.pathname === "/tabs/close") {
        sendJson(response, 200, { ok: true, state: await browserManager.closeTab(body.id) });
      } else if (request.method === "POST" && url.pathname === "/tabs/duplicate") {
        await browserManager.duplicateTab(body.id);
        sendJson(response, 200, { ok: true, state: browserManager.getState() });
      } else if (request.method === "POST" && url.pathname === "/tabs/restore") {
        sendJson(response, 200, { ok: true, state: await browserManager.restoreClosedTab() });
      } else if (request.method === "POST" && url.pathname === "/agent") {
        sendJson(response, 200, { ok: true, agent: browserManager.setAgentState(body) });
      } else if (request.method === "GET" && url.pathname === "/observe") {
        sendJson(response, 200, { ok: true, observation: await browserManager.observe() });
      } else if (request.method === "POST" && url.pathname === "/action") {
        sendJson(response, 200, await browserManager.agentAction(body.action, body.observation, body.source || "agent"));
      } else if (request.method === "POST" && url.pathname === "/cursor") {
        await browserManager.setCursor(body.cursor || null);
        sendJson(response, 200, { ok: true });
      } else if (request.method === "POST" && url.pathname === "/find") {
        sendJson(response, 200, { ok: true, ...(await browserManager.find(body.text)) });
      } else if (request.method === "POST" && url.pathname === "/zoom") {
        sendJson(response, 200, { ok: true, state: browserManager.zoom(body.delta) });
      } else if (request.method === "POST" && url.pathname === "/settings") {
        sendJson(response, 200, { ok: true, state: browserManager.updateSettings(body.patch || {}) });
      } else if (request.method === "POST" && url.pathname === "/bookmarks") {
        sendJson(response, 200, { ok: true, state: browserManager.addBookmark(body) });
      } else if (request.method === "POST" && url.pathname === "/bookmarks/remove") {
        sendJson(response, 200, { ok: true, state: browserManager.removeBookmark(body.id) });
      } else if (request.method === "POST" && url.pathname === "/history/clear") {
        sendJson(response, 200, { ok: true, state: browserManager.clearHistory(body.ids) });
      } else {
        sendJson(response, 404, { ok: false, error: "Unknown browser bridge route" });
      }
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  // Electron's Finder launch can bind the HTTP socket before invoking the
  // Node listen callback. Waiting on that callback stalls the complete boot
  // sequence even though the bridge is available. Bind it independently and
  // let the local service start immediately; bridge errors are still recorded
  // and surfaced through the normal boot error path when they occur first.
  bridgeServer.once("error", (error) => {
    reportDesktopLifecycle(`browser bridge error: ${error.message}`);
    console.error("[browser bridge]", error);
  });
  bridgeServer.listen(bridgePort, "127.0.0.1");
  reportDesktopLifecycle(`browser bridge binding port=${bridgePort}`);
  return Promise.resolve();
}

function serviceEnvironment() {
  const resourceRoot = isDevelopment ? projectRoot : process.resourcesPath;
  return {
    ...process.env,
    NODE_ENV: isDevelopment ? "development" : "production",
    PORT: String(appPort),
    CLYRA_RESOURCE_ROOT: resourceRoot,
    CLYRA_DATA_ROOT: app.getPath("userData"),
    CLYRA_ELECTRON_BROWSER_BRIDGE: `http://127.0.0.1:${bridgePort}`,
    CLYRA_ELECTRON_BROWSER_TOKEN: bridgeToken,
    CLYRA_BROWSER_CDP_URL: `http://127.0.0.1:${cdpPort}`,
    // The M1 launcher owns several helper processes. In a packaged Electron
    // child it can race macOS process cleanup during boot and terminate the
    // local service before the UI is reachable. Keep the service responsive
    // first; Vibe launches M1 on demand while its welcome page remains shown.
    CLYRA_M1_WARMUP: process.env.CLYRA_M1_WARMUP || (isDevelopment ? "1" : "0"),
    // A fixed Vite HMR port prevents a second desktop-development launch from
    // starting at all. Keep it tied to this isolated local service instead.
    HMR_PORT: process.env.HMR_PORT || String(appPort + 1),
  };
}

function configureUiSession() {
  // Voice is part of Clyra itself, not an untrusted webpage. Keep this narrow:
  // only our local service can request media, while all remote embedded pages
  // remain in the isolated persistent browser session and follow its policy.
  const isClyraOrigin = (requestingUrl = "") => {
    if (!requestingUrl) return false;
    try {
      const url = new URL(requestingUrl);
      const hostOk = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      if (!hostOk) return false;
      const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
      return port === appPort;
    } catch {
      return false;
    }
  };
  const allowMediaFrom = (webContents, requestingOrigin, details = {}) => {
    const candidates = [
      requestingOrigin,
      details.securityOrigin,
      details.requestingUrl,
    ];
    try {
      candidates.push(webContents?.getURL?.() || "");
    } catch {
      // Contents may already be destroyed during shutdown.
    }
    return candidates.some((candidate) => isClyraOrigin(String(candidate || "")));
  };
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission !== "media") return false;
    // Allow mic and camera for Clyra origins (voice call + camera vision).
    return allowMediaFrom(webContents, requestingOrigin, details || {});
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(false);
      return;
    }
    // Allow audio and/or video from Clyra windows (voice call camera uses video-only).
    callback(allowMediaFrom(webContents, details?.requestingUrl || details?.securityOrigin, details || {}));
  });
}

function isRunnableFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** POST JSON to OpenCluely's local control API; try current + legacy ports. */
async function postOpenCluelyControl(pathname, body = {}) {
  const ports = [
    Number(process.env.CLYRA_CONTROL_PORT || 0),
    3848,
    3847,
  ].filter((port, index, all) => Number.isFinite(port) && port > 0 && all.indexOf(port) === index);

  const payload = JSON.stringify(body);
  for (const port of ports) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: pathname,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
            timeout: 1_500,
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              resolve({
                ok: (res.statusCode || 500) < 400,
                status: res.statusCode || 0,
                port,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          },
        );
        req.on("timeout", () => {
          req.destroy(new Error("timeout"));
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
      if (result.ok) return result;
    } catch {
      // Try the next control port.
    }
  }
  return null;
}

async function toggleOpenCluelyOverlay() {
  const toggled = await postOpenCluelyControl("/toggle");
  if (toggled?.ok) return toggled;
  const shown = await postOpenCluelyControl("/show", { windows: ["main"] });
  if (shown?.ok) return shown;
  console.warn("[opencluely] Cmd+/ — OpenCluely control API not reachable on 3848/3847");
  return null;
}

function attachLocalService(child, label, { onSpawnError, onUnexpectedExit } = {}) {
  let lastStderr = "";
  reportDesktopLifecycle(`service ${label} spawned pid=${child.pid ?? "unknown"}`);
  child.stdout?.on("data", (chunk) => console.log(`[service] ${String(chunk).trimEnd()}`));
  child.stderr?.on("data", (chunk) => {
    lastStderr = `${lastStderr}${String(chunk)}`.slice(-4_000);
    console.error(`[service] ${String(chunk).trimEnd()}`);
  });
  child.once("error", (error) => {
    console.error(`[service] ${label} could not start:`, error);
    reportDesktopLifecycle(`service ${label} spawn error: ${error.message}`);
    if (serviceProcess === child) serviceProcess = null;
    onSpawnError?.(error);
  });
  child.once("exit", (code, signal) => {
    console.log(`[service] ${label} stopped (${code ?? signal})`);
    reportDesktopLifecycle(`service ${label} exited code=${code ?? "null"} signal=${signal ?? "none"}`);
    if (lastStderr.trim()) {
      reportDesktopLifecycle(`service ${label} stderr: ${lastStderr.trim().replace(/\s+/g, " ").slice(-1_600)}`);
    }
    if (!quitting && serviceProcess === child) onUnexpectedExit?.(code, signal);
  });
  return child;
}

function startPackagedNodeFallback(env) {
  if (serviceFallbackStarted) return;
  serviceFallbackStarted = true;
  const entry = path.join(process.resourcesPath, "dist", "server.js");
  if (!isRunnableFile(entry)) {
    serviceLaunchError = new Error(`Clyra service is missing from the application bundle (${entry}).`);
    return;
  }
  serviceProcess = attachLocalService(
    spawn(process.execPath, [entry], {
      cwd: app.getPath("userData"),
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    "Node fallback",
    { onSpawnError: (error) => { serviceLaunchError = error; } },
  );
}

function startLocalService() {
  serviceLaunchError = null;
  serviceFallbackStarted = false;
  const env = serviceEnvironment();
  reportDesktopLifecycle(`starting local service mode=${isDevelopment ? "development" : "packaged"}`);
  if (isDevelopment) {
    const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
    serviceProcess = attachLocalService(
      spawn(process.execPath, [tsxCli, "server.ts"], {
        cwd: projectRoot,
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      "development service",
      { onSpawnError: (error) => { serviceLaunchError = error; } },
    );
    return;
  }

  // The compiled Bun sidecar works when invoked from a shell, but macOS
  // LaunchServices can refuse to execute that standalone binary from an
  // unsigned Electron bundle without emitting a usable spawn error. The
  // Electron binary is already a signed, bundled Node runtime and has proved
  // reliable in both direct and Finder launches, so use it for production by
  // default. Keep the sidecar available for explicit diagnostics only.
  if (process.env.CLYRA_USE_BUNDLED_SIDECAR !== "1") {
    reportDesktopLifecycle("using packaged Node local service");
    startPackagedNodeFallback(env);
    return;
  }

  const executable = path.join(process.resourcesPath, process.platform === "win32" ? "clyra-server.exe" : "clyra-server");
  if (!isRunnableFile(executable)) {
    console.warn(`[service] bundled sidecar is unavailable at ${executable}; using packaged Node fallback.`);
    startPackagedNodeFallback(env);
    return;
  }
  reportDesktopLifecycle(`launching bundled sidecar ${executable}`);
  serviceProcess = attachLocalService(
    spawn(executable, [], {
      cwd: app.getPath("userData"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    "bundled sidecar",
    {
      onSpawnError: () => {
        // A relocated or malformed bundle can produce ENOENT/ENOTDIR after
        // the file check. Recover with the separately packaged server entry.
        console.warn("[service] falling back to packaged Node service.");
        startPackagedNodeFallback(env);
      },
      onUnexpectedExit: (code, signal) => {
        // Finder/LaunchServices can reject an unsigned sidecar after spawn
        // without surfacing a ChildProcess `error`. A clean app boot should
        // still recover using Electron's packaged Node runtime.
        console.warn(`[service] bundled sidecar exited early (${code ?? signal}); using packaged Node fallback.`);
        startPackagedNodeFallback(env);
      },
    },
  );
}

async function waitForService(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serviceLaunchError) {
      throw new Error(`Clyra's local service could not start: ${serviceLaunchError.message}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/health`, { signal: AbortSignal.timeout(700) });
      if (response.ok) return;
    } catch {
      // The service is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("Clyra's local service did not become ready.");
}

function authorize(event) {
  if (!uiView || event.sender.id !== uiView.webContents.id) throw new Error("Untrusted desktop IPC sender.");
}

function authorizeDictation(event) {
  if (!dictationManager?.isSender(event.sender)) throw new Error("Untrusted dictation IPC sender.");
}

function authorizeCompanion(event) {
  if (!companionManager?.isSender(event.sender)) throw new Error("Untrusted companion IPC sender.");
}

async function analyseCompanionVision(imagePath, question = "") {
  try {
    const { analyseVisionFrame } = await import("../tools/ollama-vision.mjs");
    const buffer = await fs.readFile(imagePath);
    const ext = path.extname(imagePath).toLowerCase() === ".png" ? "png" : "jpeg";
    const dataUrl = `data:image/${ext};base64,${buffer.toString("base64")}`;
    return await analyseVisionFrame(dataUrl, String(question || ""));
  } catch (error) {
    // Fallback RapidOCR
    const script = path.join(projectRoot, "tools", "companion-vision.py");
    const { stdout } = await execFileAsync("python3", [script, imagePath, "--question", String(question || "")], {
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    return JSON.parse(String(stdout || "{}"));
  }
}

function companionVisionFallback({ question, visionSummary, ocrText, controlling, guiding, pointer }) {
  const seen = String(visionSummary || "").trim();
  const ocr = String(ocrText || "").trim().split("\n").filter(Boolean).slice(0, 6).join(" · ");
  const bits = [];
  if (seen) bits.push(seen);
  else if (ocr) bits.push(`I can read: ${ocr}`);
  else bits.push("I captured your screen but could not read much text yet.");
  if (pointer?.label) {
    bits.push(`I'm pointing at “${pointer.label}” with the blue guide cursor — I have not clicked it.`);
  } else if (guiding) {
    bits.push("Guide mode is on: I can point at UI with a visible cursor without taking control.");
  } else if (controlling) {
    bits.push("I have desktop control ready — say what to click or type.");
  } else {
    bits.push("Ask me about what you're doing, tap Guide me to point, or Take over to drive the cursor.");
  }
  if (question) bits.push(`For “${question}”: use the visible text and layout above as the source of truth.`);
  return bits.join(" ");
}

async function askCompanionModel({ question, visionSummary, ocrText, controlling, guiding, pointer }) {
  const system = [
    "You are Clyra Screen Companion — a calm desktop helper with an OpenCluely-style overlay UI.",
    "You can see the user's screen via RapidOCR (open-source ONNX) vision evidence and talk with them.",
    "Help with whatever they are doing. Be concise and practical.",
    guiding
      ? "Guide mode: you show a visible pointer at UI targets but do NOT click or move the OS mouse. Describe what the blue ring is highlighting."
      : controlling
        ? "You currently may control the desktop. Propose concrete next clicks/keys when useful."
        : "You are observing only unless the user asks you to Guide (point) or Take control.",
    pointer?.label ? `You are currently pointing at: ${pointer.label}.` : "",
    "Never claim stealth or hidden overlays. Capture is user-visible.",
  ]
    .filter(Boolean)
    .join(" ");
  const user = [
    `User: ${question}`,
    visionSummary ? `\nScreen vision:\n${visionSummary}` : "",
    ocrText ? `\nOCR text:\n${String(ocrText).slice(0, 2500)}` : "",
  ].join("");
  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/companion/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        visionSummary,
        ocrText,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.3,
        max_tokens: 700,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const text =
      payload?.choices?.[0]?.message?.content ||
      payload?.message?.content ||
      payload?.reply ||
      payload?.text ||
      payload?.content ||
      "";
    if (response.ok && String(text).trim()) return { text: String(text), source: payload?.source || "clyra-api" };
  } catch {
    /* fall through to vision-local reply */
  }
  return {
    text: companionVisionFallback({ question, visionSummary, ocrText, controlling, guiding, pointer }),
    source: "vision-local",
  };
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("browser:get-state", (event) => { authorize(event); return { ok: true, state: browserManager.getState() }; });
  ipcMain.handle("browser:set-surface", async (event, payload) => { authorize(event); await browserManager.setSurface(payload || {}); return { ok: true }; });
  ipcMain.handle("browser:navigate", async (event, { target }) => { authorize(event); return { ok: true, state: await browserManager.navigate(target) }; });
  ipcMain.handle("browser:action", async (event, { action }) => { authorize(event); return { ok: true, ...(await browserManager.action(action)) }; });
  ipcMain.handle("browser:find", async (event, { text }) => { authorize(event); return { ok: true, ...(await browserManager.find(text)) }; });
  ipcMain.handle("browser:zoom", (event, { delta }) => { authorize(event); return { ok: true, state: browserManager.zoom(delta) }; });
  ipcMain.handle("browser:update-settings", (event, { patch }) => { authorize(event); return { ok: true, state: browserManager.updateSettings(patch) }; });
  ipcMain.handle("browser:add-bookmark", (event) => { authorize(event); return { ok: true, state: browserManager.addBookmark() }; });
  ipcMain.handle("browser:remove-bookmark", (event, { id }) => { authorize(event); return { ok: true, state: browserManager.removeBookmark(id) }; });
  ipcMain.handle("browser:clear-history", (event, { ids }) => { authorize(event); return { ok: true, state: browserManager.clearHistory(ids) }; });
  ipcMain.handle("browser:inspect", async (event) => { authorize(event); return { ok: true, snapshot: await browserManager.inspect() }; });
  ipcMain.handle("browser:set-cursor", async (event, cursor) => { authorize(event); await browserManager.setCursor(cursor); return { ok: true }; });
  ipcMain.handle("browser:devtools", (event) => { authorize(event); browserManager.activeContents()?.openDevTools({ mode: "detach" }); return { ok: true }; });
  // Task View previews are real pixels from the already-rendered workspace.
  // The renderer sends the exact workspace bounds before it reveals the
  // overview, so no tool is remounted, resized, or asked to recreate itself.
  ipcMain.handle("taskview:capture", async (event, payload = {}) => {
    authorize(event);
    const bounds = payload.bounds || {};
    const x = Math.max(0, Math.round(Number(bounds.x) || 0));
    const y = Math.max(0, Math.round(Number(bounds.y) || 0));
    const width = Math.max(2, Math.round(Number(bounds.width) || 2));
    const height = Math.max(2, Math.round(Number(bounds.height) || 2));
    const nativeOnly = Boolean(payload.nativeOnly);
    const contents = uiView?.webContents;
    if (!nativeOnly && (!contents || contents.isDestroyed())) {
      throw new Error("The active workspace is unavailable for capture.");
    }
    let src = "";
    let size = { width, height };
    // While Task View is open, re-capturing the UI shell would snapshot the
    // overview overlay itself. nativeOnly refreshes just the live browser page.
    if (!nativeOnly) {
      const image = await contents.capturePage({ x, y, width, height });
      size = image.getSize();
      src = image.toDataURL();
    }
    let nativeLayer;
    if (payload.nativeBrowser) {
      const nativeContents = browserManager?.activeContents();
      const nativeBounds = browserManager?.surface?.bounds;
      if (nativeContents && !nativeContents.isDestroyed() && nativeBounds) {
        // capturePage works even when the WebContentsView is hidden for Task View.
        const nativeImage = await nativeContents.capturePage();
        const nativeSize = nativeImage.getSize();
        nativeLayer = {
          src: nativeImage.toDataURL(),
          // BrowserViews are positioned in the same BrowserWindow coordinate
          // system as the UI capture. These offsets restore the real page
          // exactly inside its captured toolbar/sidebar shell.
          left: nativeBounds.x - x,
          top: nativeBounds.y - y,
          width: nativeBounds.width,
          height: nativeBounds.height,
          imageWidth: nativeSize.width,
          imageHeight: nativeSize.height,
        };
      }
    }
    if (nativeOnly && !nativeLayer) {
      return { ok: false, src: "", width: size.width, height: size.height };
    }
    return { ok: true, src, width: size.width, height: size.height, nativeLayer };
  });
  ipcMain.handle("surface:update", (event, payload) => { authorize(event); return { ok: true, surface: surfaceManager.update(payload) }; });
  ipcMain.handle("surface:hide", (event, { id }) => { authorize(event); surfaceManager.hide(id); return { ok: true }; });
  ipcMain.handle("dictation:set-state", (event, payload) => { authorize(event); dictationManager?.setState(payload || { phase: "idle" }); return { ok: true }; });
  ipcMain.handle("dictation:toggle", (event) => { authorize(event); void dictationManager?.toggle(); return { ok: true }; });
  ipcMain.handle("dictation:shortcut-status", (event) => { authorize(event); return { registered: Boolean(dictationManager?.shortcutRegistered) }; });
  ipcMain.handle("dictation:service-url", (event) => {
    authorize(event);
    return `http://127.0.0.1:${appPort}`;
  });
  ipcMain.handle("dictation:insert", async (event, payload) => { authorize(event); return dictationManager?.insert(payload || {}); });
  ipcMain.handle("dictation:ensure-permissions", async (event) => {
    authorize(event);
    const mic = await dictationManager?.ensureMicrophoneAccess();
    const status = await dictationManager?.permissionStatus();
    if (mic && mic.ok === false) return { ...status, ...mic };
    return { ok: true, ...(status || {}), ...(mic || {}) };
  });
  ipcMain.handle("dictation:ensure-camera", async (event) => {
    authorize(event);
    const camera = await dictationManager?.ensureCameraAccess();
    const status = await dictationManager?.permissionStatus();
    if (camera && camera.ok === false) return { ...status, ...camera };
    return { ok: true, ...(status || {}), ...(camera || {}) };
  });
  ipcMain.handle("dictation:open-microphone-settings", async (event) => {
    authorize(event);
    await dictationManager?.openMicrophoneSettings();
    return { ok: true };
  });
  ipcMain.handle("dictation:open-camera-settings", async (event) => {
    authorize(event);
    await dictationManager?.openCameraSettings();
    return { ok: true };
  });
  ipcMain.on("dictation:pill-action", (event, action) => { authorizeDictation(event); void dictationManager?.action(String(action || "cancel")); });
  ipcMain.handle("companion:get-state", (event) => {
    authorizeCompanion(event);
    return companionManager?.getState() || { phase: "idle" };
  });
  ipcMain.handle("companion:show", async (event) => { authorizeCompanion(event); await companionManager?.show(); return { ok: true }; });
  ipcMain.handle("companion:hide", (event) => { authorizeCompanion(event); companionManager?.hide(); return { ok: true }; });
  ipcMain.handle("companion:ask", async (event, payload) => {
    authorizeCompanion(event);
    return companionManager?.ask(String(payload?.text || ""));
  });
  ipcMain.handle("companion:see", async (event, payload) => {
    // Allow Companion overlay OR main Clyra window (voice call camera/screen vision)
    try {
      authorizeCompanion(event);
    } catch {
      authorize(event);
    }
    return companionManager?.seeScreen(String(payload?.question || ""));
  });
  ipcMain.handle("desktop:see-screen", async (event, payload) => {
    authorize(event);
    return companionManager?.seeScreen(String(payload?.question || ""));
  });
  ipcMain.handle("companion:start-guide", async (event, payload) => {
    authorizeCompanion(event);
    return companionManager?.startGuide(String(payload?.question || ""));
  });
  ipcMain.handle("companion:start-control", async (event) => {
    authorizeCompanion(event);
    return companionManager?.startControl();
  });
  ipcMain.handle("companion:take-control", async (event) => {
    authorizeCompanion(event);
    return companionManager?.takeManualControl();
  });
  ipcMain.handle("companion:resume", async (event) => {
    authorizeCompanion(event);
    return companionManager?.resumeAi();
  });
  ipcMain.handle("companion:stop", async (event) => {
    authorizeCompanion(event);
    return companionManager?.stopControl();
  });
  ipcMain.handle("companion:action", async (event, payload) => {
    authorizeCompanion(event);
    return companionManager?.runDesktopAction(payload?.action || {});
  });
  // Main renderer may open the companion overlay.
  ipcMain.handle("companion:toggle", async (event) => {
    authorize(event);
    await companionManager?.toggle();
    return { ok: true, registered: Boolean(companionManager?.shortcutRegistered) };
  });
  ipcMain.on("smart-toolbar:action", (event, payload) => {
    if (!smartToolbarManager?.isSender(event.sender)) throw new Error("Untrusted smart toolbar IPC sender.");
    void smartToolbarManager.action(payload || {});
  });
  ipcMain.handle("google:status", (event) => { authorize(event); return googleWorkspaceManager?.status() || { connected:false }; });
  ipcMain.handle("google:sign-in", (event) => { authorize(event); return googleWorkspaceManager?.signIn() || { ok:false, error:"Google integration is unavailable." }; });
  ipcMain.handle("google:disconnect", (event) => { authorize(event); return googleWorkspaceManager?.disconnect() || { ok:true }; });
  ipcMain.handle("google:execute", (event, payload) => {
    authorize(event);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Google Workspace IPC payload.");
    // Renderer input is only a request envelope. Tokens, credentials, raw API
    // responses, and filesystem paths never cross this boundary.
    const keys = Object.keys(payload);
    if (keys.some((key) => !["tool", "prompt", "runId", "service", "action", "args", "confirmed"].includes(key))) throw new Error("Unsupported Google Workspace IPC field.");
    return googleWorkspaceManager?.execute(payload) || { ok:false, text:"Google integration is unavailable." };
  });
  ipcMain.handle("research:execute", (event, payload) => {
    authorize(event);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Deep Research IPC payload.");
    const keys = Object.keys(payload);
    if (keys.some((key) => !["prompt", "runId", "checkpointId", "answers", "action"].includes(key))) throw new Error("Unsupported Deep Research IPC field.");
    return deepResearchManager?.execute(payload) || { ok:false, text:"Deep Research is unavailable." };
  });
  ipcMain.handle("memory:list", (event, payload) => { authorize(event); return localMemoryManager?.list(String(payload?.userId || "local")) || []; });
  ipcMain.handle("memory:search", (event, payload) => { authorize(event); return localMemoryManager?.search({ userId:String(payload?.userId || "local"), query:String(payload?.query || ""), limit:Number(payload?.limit || 5) }) || []; });
  ipcMain.handle("memory:add", (event, payload) => { authorize(event); return localMemoryManager?.add({ userId:String(payload?.userId || "local"), text:String(payload?.text || ""), force:Boolean(payload?.force) }) || {saved:false}; });
  ipcMain.handle("memory:update", (event, payload) => { authorize(event); return localMemoryManager?.update({ userId:String(payload?.userId || "local"), id:String(payload?.id || ""), text:String(payload?.text || "") }) || {ok:false}; });
  ipcMain.handle("memory:remove", (event, payload) => { authorize(event); return localMemoryManager?.remove({ userId:String(payload?.userId || "local"), id:String(payload?.id || "") }) || {ok:false}; });
  ipcMain.handle("memory:clear", (event, payload) => { authorize(event); return localMemoryManager?.clear(String(payload?.userId || "local")) || {ok:false}; });
  if (isDevelopment) ipcMain.handle("google:diagnostic", (event, payload) => { authorize(event); return googleWorkspaceManager?.diagnostic(payload || {}) || { ok:false, stage:"desktop", errorCode:"GOOGLE_UNAVAILABLE" }; });
}

function resizeUi() {
  if (!mainWindow || !uiView) return;
  const [width, height] = mainWindow.getContentSize();
  uiView.setBounds({ x: 0, y: 0, width, height });
  void browserManager?.setSurface({ visible: browserManager.surface.visible });
}

async function createWindow() {
  if (mainWindow) return mainWindow;
  if (createWindowPromise) return createWindowPromise;

  createWindowPromise = (async () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#ffffff",
    titleBarStyle: "hidden",
    title: "Clyra",
  });
  uiView = new WebContentsView({
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      // Keep dictation capture + IPC responsive while Clyra is in the background.
      backgroundThrottling: false,
    },
  });
  mainWindow.contentView.addChildView(uiView);
  resizeUi();

  browserManager = new ChromiumBrowserManager({
    window: mainWindow,
    uiView,
    userDataPath: path.join(app.getPath("userData"), "browser"),
    downloadsPath: app.getPath("downloads"),
  });
  surfaceManager = new ChromiumSurfaceManager({ window: mainWindow });
  dictationManager = new DictationManager({
    uiContents: () => uiView?.webContents ?? null,
    preloadPath: path.join(here, "dictation-preload.cjs"),
    pillPath: path.join(here, "dictation-pill.html"),
  });
  smartToolbarManager = new SmartToolbarManager({
    uiContents: () => uiView?.webContents ?? null,
    preloadPath: path.join(here, "smart-toolbar-preload.cjs"),
    toolbarPath: path.join(here, "smart-toolbar.html"),
    serviceUrl: () => `http://127.0.0.1:${appPort}`,
    isSuppressed: () => Boolean(dictationManager && dictationManager.phase !== "idle"),
  });
  googleWorkspaceManager = new GoogleWorkspaceManager({
    tokenPath: path.join(app.getPath("userData"), "google-workspace.dat"),
    uiContents: () => uiView?.webContents ?? null,
    development: isDevelopment,
    clientId: process.env.CLYRA_GOOGLE_CLIENT_ID,
    clientSecret: process.env.CLYRA_GOOGLE_CLIENT_SECRET,
    serviceUrl: () => `http://127.0.0.1:${appPort}`,
  });
  deepResearchManager = new DeepResearchManager({
    uiContents: () => uiView?.webContents ?? null,
    development: isDevelopment,
    serviceUrl: () => `http://127.0.0.1:${appPort}`,
  });
  localMemoryManager = new LocalMemoryManager({ filePath:path.join(app.getPath("userData"), "clyra-memory.dat"), development:isDevelopment });
  screenCaptureService = new ScreenCaptureService();
  desktopControlService = new DesktopControlService();
  companionManager = new CompanionManager({
    preloadPath: path.join(here, "companion-preload.cjs"),
    htmlPath: path.join(here, "companion.html"),
    getServiceUrl: () => `http://127.0.0.1:${appPort}`,
    capture: screenCaptureService,
    desktop: desktopControlService,
    analyseVision: analyseCompanionVision,
    askModel: askCompanionModel,
  });
  await browserManager.initialize();
  await dictationManager.initialize();
  await smartToolbarManager.initialize();
  await companionManager.initialize();
  registerIpc();

  // Global Task View — works even when a BrowserView page owns keyboard focus.
  try {
    globalShortcut.register("CommandOrControl+J", () => {
      if (uiView && !uiView.webContents.isDestroyed()) {
        uiView.webContents.send("taskview:toggle");
      }
    });
  } catch (error) {
    console.warn("[taskview] global shortcut unavailable:", error);
  }

  // ⌘/ — activate OpenCluely overlay (show/hide via local control API).
  try {
    const registered = globalShortcut.register("CommandOrControl+/", () => {
      void toggleOpenCluelyOverlay();
    });
    if (!registered) {
      console.warn("[opencluely] Cmd+/ is already owned by another app (OpenCluely may handle it).");
    }
  } catch (error) {
    console.warn("[opencluely] Cmd+/ shortcut unavailable:", error);
  }

  if (process.env.CLYRA_COMPANION_SMOKE === "1") {
    setTimeout(() => {
      void companionManager?.runSmoke().then((report) => {
        console.log("[companion-smoke]", JSON.stringify(report));
        if (process.env.CLYRA_COMPANION_SMOKE_EXIT === "1") {
          destroyNativeManagers();
          app.exit(report?.ok ? 0 : 1);
        }
      });
    }, 2500);
  }

  mainWindow.on("resize", resizeUi);
  // The window close control is an application exit, not a hide-to-tray
  // action. Route it through Electron's quit lifecycle so the browser bridge,
  // local server, and dictation resources all release cleanly.
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    // Release native children while the parent BrowserWindow is still valid.
    // Electron otherwise may destroy a child WebContentsView before its
    // manager receives the later `closed` event.
    destroyNativeManagers();
    app.quit();
  });
  mainWindow.on("closed", () => {
    destroyNativeManagers();
    if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.close({ waitForBeforeUnload: false });
    uiView = null;
    mainWindow = null;
  });

  uiView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const hideNativeSurfaces = () => {
    browserManager?.setSurface({ visible: false });
    surfaceManager?.hideAll();
  };
  uiView.webContents.on("did-start-loading", hideNativeSurfaces);
  uiView.webContents.on("render-process-gone", () => {
    hideNativeSurfaces();
    uiView?.webContents.reload();
  });
  uiView.webContents.on("did-finish-load", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  await uiView.webContents.loadURL(`http://127.0.0.1:${appPort}`);
  return mainWindow;
  })();

  try {
    return await createWindowPromise;
  } finally {
    createWindowPromise = null;
  }
}

async function boot() {
  Menu.setApplicationMenu(null);
  configureUiSession();
  reportDesktopLifecycle("booting browser bridge");
  await startBrowserBridge();
  reportDesktopLifecycle("browser bridge resolved; starting service");
  startLocalService();
  await waitForService();
  await createWindow();
}

app.whenReady().then(() => {
  bootPromise = boot();
  return bootPromise;
}).catch(async (error) => {
  console.error(error);
  await dialog.showMessageBox({ type: "error", title: "Clyra could not start", message: error.message || String(error) });
  app.quit();
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    return;
  }
  // macOS can emit `activate` during initial boot. Wait for the boot service
  // before creating a window so we never race `loadURL` or register IPC twice.
  if (bootPromise) {
    void bootPromise.then(() => {
      if (!mainWindow) return createWindow();
      mainWindow.show();
      return mainWindow;
    }).catch(() => undefined);
  }
});

app.on("window-all-closed", () => {
  // Match the close control on every platform. Clyra does not use a hidden
  // tray window as its primary lifecycle any more.
  app.quit();
});

process.once("SIGINT", () => app.quit());
process.once("SIGTERM", () => app.quit());

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  bridgeServer?.close();
  destroyNativeManagers();

  const service = serviceProcess;
  if (!service || service.exitCode != null || service.killed) {
    app.exit(0);
    return;
  }

  const finish = () => {
    clearTimeout(forceTimer);
    // The original quit event was intentionally prevented to give the local
    // service time to stop. Exit explicitly once cleanup is complete; calling
    // app.quit() here can be ignored on macOS after that cancelled event.
    app.exit(0);
  };
  const forceTimer = setTimeout(() => {
    if (service.exitCode == null) service.kill("SIGKILL");
    finish();
  }, 8_000);
  service.once("exit", finish);
  service.kill("SIGTERM");
});
