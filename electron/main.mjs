import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, promises as fs, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, WebContentsView } from "electron";
import { ChromiumBrowserManager } from "./browser-manager.mjs";
import { ChromiumSurfaceManager } from "./surface-manager.mjs";
import { DictationManager } from "./dictation-manager.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
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
  dictationManager = null;
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
    try {
      const url = new URL(requestingUrl);
      return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && Number(url.port) === appPort;
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => (
    permission === "media" && isClyraOrigin(requestingOrigin)
  ));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === "media" && isClyraOrigin(details.requestingUrl));
  });
}

function isRunnableFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
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
  ipcMain.handle("surface:update", (event, payload) => { authorize(event); return { ok: true, surface: surfaceManager.update(payload) }; });
  ipcMain.handle("surface:hide", (event, { id }) => { authorize(event); surfaceManager.hide(id); return { ok: true }; });
  ipcMain.handle("dictation:set-state", (event, payload) => { authorize(event); dictationManager?.setState(payload || { phase: "idle" }); return { ok: true }; });
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
  ipcMain.handle("dictation:open-microphone-settings", async (event) => {
    authorize(event);
    await dictationManager?.openMicrophoneSettings();
    return { ok: true };
  });
  ipcMain.on("dictation:pill-action", (event, action) => { authorizeDictation(event); void dictationManager?.action(String(action || "cancel")); });
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
  await browserManager.initialize();
  await dictationManager.initialize();
  registerIpc();

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
