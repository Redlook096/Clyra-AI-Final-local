import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, WebContentsView } from "electron";
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
let bridgeServer = null;
let quitting = false;
let createWindowPromise = null;
let bootPromise = null;
let ipcRegistered = false;

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
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
      } else {
        sendJson(response, 404, { ok: false, error: "Unknown browser bridge route" });
      }
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return new Promise((resolve, reject) => {
    bridgeServer.once("error", reject);
    bridgeServer.listen(bridgePort, "127.0.0.1", resolve);
  });
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
    // A fixed Vite HMR port prevents a second desktop-development launch from
    // starting at all. Keep it tied to this isolated local service instead.
    HMR_PORT: process.env.HMR_PORT || String(appPort + 1),
  };
}

function startLocalService() {
  const env = serviceEnvironment();
  if (isDevelopment) {
    const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
    serviceProcess = spawn(process.execPath, [tsxCli, "server.ts"], {
      cwd: projectRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    const executable = path.join(process.resourcesPath, process.platform === "win32" ? "clyra-server.exe" : "clyra-server");
    serviceProcess = spawn(executable, [], {
      cwd: app.getPath("userData"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  serviceProcess.stdout?.on("data", (chunk) => console.log(`[service] ${String(chunk).trimEnd()}`));
  serviceProcess.stderr?.on("data", (chunk) => console.error(`[service] ${String(chunk).trimEnd()}`));
  serviceProcess.once("exit", (code, signal) => console.log(`[service] stopped (${code ?? signal})`));
}

async function waitForService(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
  ipcMain.handle("browser:set-surface", (event, payload) => { authorize(event); browserManager.setSurface(payload || {}); return { ok: true }; });
  ipcMain.handle("browser:navigate", async (event, { target }) => { authorize(event); return { ok: true, state: await browserManager.navigate(target) }; });
  ipcMain.handle("browser:action", async (event, { action }) => { authorize(event); return { ok: true, ...(await browserManager.action(action)) }; });
  ipcMain.handle("browser:find", (event, { text }) => { authorize(event); return { ok: true, ...browserManager.find(text) }; });
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
  ipcMain.on("dictation:pill-action", (event, action) => { authorizeDictation(event); void dictationManager?.action(String(action || "cancel")); });
}

function resizeUi() {
  if (!mainWindow || !uiView) return;
  const [width, height] = mainWindow.getContentSize();
  uiView.setBounds({ x: 0, y: 0, width, height });
  browserManager?.setSurface({ visible: browserManager.surface.visible });
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
  mainWindow.on("closed", () => {
    browserManager?.destroy();
    surfaceManager?.destroy();
    dictationManager?.destroy();
    dictationManager = null;
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
  await startBrowserBridge();
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
  if (process.platform !== "darwin") app.quit();
});

process.once("SIGINT", () => app.quit());
process.once("SIGTERM", () => app.quit());

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  bridgeServer?.close();
  dictationManager?.destroy();

  const service = serviceProcess;
  if (!service || service.exitCode != null || service.killed) {
    app.quit();
    return;
  }

  const finish = () => {
    clearTimeout(forceTimer);
    app.quit();
  };
  const forceTimer = setTimeout(() => {
    if (service.exitCode == null) service.kill("SIGKILL");
    finish();
  }, 8_000);
  service.once("exit", finish);
  service.kill("SIGTERM");
});
