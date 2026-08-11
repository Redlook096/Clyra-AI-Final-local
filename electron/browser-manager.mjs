import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dialog, session, WebContentsView } from "electron";

const HOME_URL = "https://www.google.com/";
const MAX_TABS = 16;

function injectionSignals(lines) {
  const patterns = [
    /ignore\s+(?:all\s+)?previous\s+instructions/i,
    /reveal\s+(?:the\s+)?system\s+prompt/i,
    /disregard\s+(?:the\s+)?(?:prior|previous)\s+instructions/i,
  ];
  return [...new Set(lines
    .flatMap((line) => String(line || "").split(/(?:\n+|(?<=[.!?])\s+)/))
    .map((line) => line.trim())
    .filter((line) => line && patterns.some((pattern) => pattern.test(line)))
  )].slice(0, 12);
}

const DEFAULT_SETTINGS = {
  defaultSearchEngine: "google",
  restoreTabs: true,
  saveHistory: true,
  showBookmarksBar: false,
  showAiCursor: true,
  showAiActionLabels: true,
  aiCursorSpeed: "natural",
  reducedMotion: false,
  performanceMode: "quality",
  privateMode: false,
};

function normalizeInput(input, engine = "google") {
  const value = String(input || "").trim();
  if (!value || value === "about:blank" || /^(chrome|edge|devtools|chrome-error):/i.test(value)) return HOME_URL;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(value)) return `http://${value}`;
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(value)) return `https://${value}`;
  const query = encodeURIComponent(value);
  if (engine === "duckduckgo") return `https://duckduckgo.com/?q=${query}`;
  if (engine === "bing") return `https://www.bing.com/search?q=${query}`;
  return `https://www.google.com/search?q=${query}`;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : HOME_URL;
  } catch {
    return HOME_URL;
  }
}

export class ChromiumBrowserManager {
  constructor({ window, uiView, userDataPath, downloadsPath }) {
    this.window = window;
    this.uiView = uiView;
    this.userDataPath = userDataPath;
    this.downloadsPath = downloadsPath;
    this.profilePath = path.join(userDataPath, "chromium-browser.json");
    this.browserSession = session.fromPartition("persist:browser", { cache: true });
    this.tabs = new Map();
    this.activeTabId = null;
    this.closedTabs = [];
    this.history = [];
    this.bookmarks = [];
    this.downloads = [];
    this.settings = { ...DEFAULT_SETTINGS };
    // Keep a useful viewport even before the Browser workspace is visible.
    // Native views can be hidden without being resized to 2px, so CDP/DOM
    // inspection remains meaningful and tab state does not thrash on reopen.
    this.surface = { visible: false, bounds: { x: 0, y: 0, width: 1280, height: 720 } };
    this.saveTimer = null;
    this.agent = { status: "idle", paused: false, manualControl: false };
    this.destroyed = false;
  }

  async initialize() {
    await fs.mkdir(this.userDataPath, { recursive: true });
    await fs.mkdir(this.downloadsPath, { recursive: true });
    await this.loadProfile();
    this.configureSession();
    const restored = this.settings.restoreTabs && this.lastTabs?.length
      ? this.lastTabs.slice(0, MAX_TABS)
      : [{ url: HOME_URL }];
    for (const saved of restored) await this.createTab(saved.url, { activate: false, persist: false });
    const first = this.tabs.keys().next().value;
    if (first) this.activateTab(first, { persist: false });
    this.emitState();
  }

  configureSession() {
    this.browserSession.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
      const allowedWithoutPrompt = new Set(["clipboard-sanitized-write", "fullscreen"]);
      const blockedWithoutPrompt = new Set([
        "geolocation",
        "notifications",
        "midi",
        "midiSysex",
        "idle-detection",
        "pointerLock",
        "openExternal",
      ]);
      if (allowedWithoutPrompt.has(permission)) {
        callback(true);
        return;
      }
      // Search engines and news sites commonly request these on page load.
      // Blocking them quietly avoids a modal before the user has asked for the
      // capability; camera, microphone, clipboard reads, and screen capture
      // still cross the explicit native confirmation boundary below.
      if (blockedWithoutPrompt.has(permission)) {
        callback(false);
        return;
      }
      const host = (() => {
        try { return new URL(details.requestingUrl || webContents.getURL()).hostname; } catch { return "this site"; }
      })();
      const result = await dialog.showMessageBox(this.window, {
        type: "question",
        buttons: ["Allow", "Block"],
        defaultId: 1,
        cancelId: 1,
        title: "Site permission",
        message: `Allow ${host} to use ${permission.replaceAll("-", " ")}?`,
        detail: "This permission applies only to the Clyra browser session.",
      });
      callback(result.response === 0);
    });

    this.browserSession.on("will-download", (_event, item, webContents) => {
      const id = crypto.randomUUID();
      const filename = item.getFilename();
      const destination = path.join(this.downloadsPath, filename);
      item.setSavePath(destination);
      const download = {
        id,
        filename,
        url: webContents.getURL(),
        status: "running",
        path: destination,
        startedAt: new Date().toISOString(),
      };
      this.downloads.unshift(download);
      this.downloads = this.downloads.slice(0, 100);
      item.on("updated", () => this.emitState());
      item.once("done", (_doneEvent, state) => {
        download.status = state === "completed" ? "complete" : state === "cancelled" ? "cancelled" : "failed";
        this.scheduleSave();
        this.emitState();
      });
      this.emitState();
    });
  }

  async loadProfile() {
    try {
      const profile = JSON.parse(await fs.readFile(this.profilePath, "utf8"));
      this.history = Array.isArray(profile.history) ? profile.history.slice(0, 2000) : [];
      this.bookmarks = Array.isArray(profile.bookmarks) ? profile.bookmarks.slice(0, 500) : [];
      this.closedTabs = Array.isArray(profile.closedTabs) ? profile.closedTabs.slice(0, 20) : [];
      this.downloads = Array.isArray(profile.downloads) ? profile.downloads.slice(0, 100) : [];
      this.settings = { ...DEFAULT_SETTINGS, ...(profile.settings || {}) };
      this.lastTabs = Array.isArray(profile.lastTabs) ? profile.lastTabs.map((tab) => ({ url: safeUrl(tab.url) })) : [];
    } catch {
      this.lastTabs = [];
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveProfile(), 180);
  }

  async saveProfile() {
    // A window-close event can arrive after Electron has torn down a child
    // WebContentsView. Persist the tabs that remain readable and quietly skip
    // views already released by Chromium.
    const lastTabs = [...this.tabs.values()].flatMap((tab) => {
      try {
        const contents = tab?.view?.webContents;
        if (!contents || contents.isDestroyed()) return [];
        return [{ url: contents.getURL() || HOME_URL }];
      } catch {
        return [];
      }
    });
    const payload = {
      version: 1,
      history: this.history,
      bookmarks: this.bookmarks,
      closedTabs: this.closedTabs,
      downloads: this.downloads,
      settings: this.settings,
      lastTabs,
    };
    await fs.writeFile(this.profilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8").catch(() => undefined);
  }

  async createTab(url = HOME_URL, { activate = true, persist = true } = {}) {
    if (this.tabs.size >= MAX_TABS) throw new Error(`Clyra Browser supports up to ${MAX_TABS} open tabs.`);
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:browser",
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        autoplayPolicy: "no-user-gesture-required",
        spellcheck: true,
        backgroundThrottling: true,
      },
    });
    const id = view.webContents.getOrCreateDevToolsTargetId();
    const tab = {
      id,
      view,
      title: "New tab",
      favicon: undefined,
      loading: true,
      zoom: 1,
      lastActiveAt: Date.now(),
      crashed: false,
    };
    this.tabs.set(id, tab);
    this.window.contentView.addChildView(view);
    // Hidden tabs still need a real layout viewport for DOM/accessibility
    // inspection and warm navigation. Visibility only controls compositing.
    view.setBounds(this.surface.bounds);
    view.setVisible(false);
    this.wireTab(tab);
    // `nativeTheme.themeSource = "light"` is inherited by Chromium renderers.
    // Do not attach the Electron debugger before the first navigation: an
    // emulation command issued against an uninitialised renderer can block the
    // desktop boot sequence and competes with the agent's CDP session.
    void view.webContents.loadURL(normalizeInput(url, this.settings.defaultSearchEngine)).catch(() => undefined);
    if (activate) this.activateTab(id, { persist: false });
    if (persist) this.scheduleSave();
    this.emitState();
    // Native WebContentsView activation steals focus from the React chrome.
    // A new tab is an explicit request to type, so return focus to Clyra's
    // omnibox after Chromium has completed that activation turn.
    if (activate) this.focusAddressSoon();
    return tab;
  }

  focusAddressSoon() {
    setTimeout(() => {
      if (!this.destroyed && this.uiView?.webContents && !this.uiView.webContents.isDestroyed()) {
        this.uiView.webContents.send("browser:focus-address");
      }
    }, 32);
  }

  wireTab(tab) {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      void this.createTab(url);
      return { action: "deny" };
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      this.emitState();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      this.recordHistory(tab);
      if (tab.id === this.activeTabId) void this.syncAgentChrome();
      this.emitState();
    });
    contents.on("did-navigate", () => {
      tab.crashed = false;
      this.recordHistory(tab);
      this.scheduleSave();
      this.emitState();
    });
    contents.on("did-navigate-in-page", () => {
      this.scheduleSave();
      this.emitState();
    });
    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      tab.title = title || tab.title;
      this.emitState();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = favicons[0];
      this.emitState();
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.crashed = true;
      tab.loading = false;
      this.emitState();
      if (details.reason !== "clean-exit") setTimeout(() => contents.reload(), 350);
    });
    contents.on("unresponsive", () => this.emitState());
    contents.on("enter-html-full-screen", () => this.window.setFullScreen(true));
    contents.on("leave-html-full-screen", () => this.window.setFullScreen(false));
    contents.on("before-input-event", (event, input) => this.handleShortcut(event, input));
  }

  handleShortcut(event, input) {
    if (input.type !== "keyDown") return;
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    const key = String(input.key || "").toLowerCase();
    if (!modifier && key !== "f12") return;
    if (modifier && key === "j") this.uiView.webContents.send("taskview:toggle");
    else if (modifier && key === "l") this.uiView.webContents.send("browser:focus-address");
    else if (modifier && key === "t") void this.createTab();
    else if (modifier && input.shift && key === "t") void this.restoreClosedTab();
    else if (modifier && key === "w") void this.closeTab(this.activeTabId);
    else if (modifier && key === "r") this.activeContents()?.reload();
    else if (modifier && key === "f") this.uiView.webContents.send("browser:focus-find");
    else if (key === "f12" || (modifier && input.alt && key === "i")) this.activeContents()?.openDevTools({ mode: "detach" });
    else return;
    event.preventDefault();
  }

  activeContents() {
    return this.activeTabId ? this.tabs.get(this.activeTabId)?.view.webContents : null;
  }

  contentsFor(tabId = this.activeTabId) {
    return tabId ? this.tabs.get(tabId)?.view.webContents : null;
  }

  activateTab(id, { persist = true } = {}) {
    const next = this.tabs.get(id);
    if (!next) throw new Error("That browser tab no longer exists.");
    for (const [tabId, tab] of this.tabs) {
      const show = tabId === id && this.surface.visible;
      tab.view.setVisible(show);
      tab.view.webContents.setBackgroundThrottling(!show);
    }
    this.activeTabId = id;
    next.lastActiveAt = Date.now();
    if (this.surface.visible) {
      next.view.setBounds(this.surface.bounds);
      next.view.webContents.focus();
    }
    void this.syncAgentChrome();
    if (persist) this.scheduleSave();
    this.emitState();
    return this.getState();
  }

  async closeTab(id = this.activeTabId) {
    const tab = id ? this.tabs.get(id) : null;
    if (!tab) return this.getState();
    if (this.tabs.size === 1) {
      await tab.view.webContents.loadURL(HOME_URL);
      return this.getState();
    }
    this.closedTabs.unshift({ id: crypto.randomUUID(), url: tab.view.webContents.getURL(), title: tab.title, closedAt: new Date().toISOString() });
    this.closedTabs = this.closedTabs.slice(0, 20);
    const ids = [...this.tabs.keys()];
    const index = ids.indexOf(id);
    this.window.contentView.removeChildView(tab.view);
    tab.view.webContents.close({ waitForBeforeUnload: false });
    this.tabs.delete(id);
    if (this.activeTabId === id) this.activateTab(ids[index - 1] || ids[index + 1], { persist: false });
    this.scheduleSave();
    this.emitState();
    return this.getState();
  }

  async duplicateTab(id = this.activeTabId) {
    const source = id ? this.tabs.get(id) : null;
    return this.createTab(source?.view.webContents.getURL() || HOME_URL);
  }

  async restoreClosedTab() {
    const closed = this.closedTabs.shift();
    if (!closed) return this.getState();
    await this.createTab(closed.url);
    this.scheduleSave();
    return this.getState();
  }

  async setSurface({ bounds, visible }) {
    // A stale/corrupt persisted profile must never leave the native browser
    // with an empty tab strip. Restore one durable Google tab before display.
    if (this.tabs.size === 0) await this.createTab(HOME_URL, { activate: true, persist: true });
    const wasVisible = this.surface.visible;
    if (bounds) {
      this.surface.bounds = {
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
        width: Math.max(2, Math.round(bounds.width)),
        height: Math.max(2, Math.round(bounds.height)),
      };
    }
    this.surface.visible = Boolean(visible);
    for (const [id, tab] of this.tabs) {
      const show = this.surface.visible && id === this.activeTabId;
      tab.view.setBounds(this.surface.bounds);
      tab.view.setVisible(show);
      tab.view.webContents.setBackgroundThrottling(!show);
      if (show) {
        tab.view.setBounds(this.surface.bounds);
        if (!wasVisible) tab.view.webContents.focus();
      }
    }
    this.emitState();
  }

  async navigate(target, tabId = this.activeTabId) {
    const contents = this.contentsFor(tabId);
    if (!contents) throw new Error("No active browser tab.");
    const destination = normalizeInput(target, this.settings.defaultSearchEngine);
    try {
      await contents.loadURL(destination);
    } catch (error) {
      // Chromium can reject a redundant Google new-tab recovery while the
      // existing native tab is already usable. Keep that recovery local and
      // surface genuine navigation failures for every other destination.
      if (destination !== HOME_URL || !/^https:\/\/(?:www\.)?google\.com\/?$/i.test(contents.getURL())) throw error;
    }
    return this.getState();
  }

  async action(action) {
    const contents = this.activeContents();
    if (!contents) throw new Error("No active browser tab.");
    contents.focus();
    switch (action?.type) {
      case "back": case "go_back": if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
      case "forward": case "go_forward": if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
      case "reload": contents.reload(); break;
      case "stop_loading": contents.stop(); break;
      case "open_tab": await this.createTab(action.url || HOME_URL); break;
      case "switch_tab": this.activateTab(action.tabId || [...this.tabs.keys()][action.tabIndex || 0]); break;
      case "close_tab": await this.closeTab(action.tabId || [...this.tabs.keys()][action.tabIndex || 0]); break;
      case "duplicate_tab": await this.duplicateTab(action.tabId || [...this.tabs.keys()][action.tabIndex || 0]); break;
      case "restore_closed_tab": await this.restoreClosedTab(); break;
      case "navigate": await this.navigate(action.url); break;
      case "search": await this.navigate(action.query); break;
      case "press": case "press_key": contents.sendInputEvent({ type: "keyDown", keyCode: action.key }); contents.sendInputEvent({ type: "keyUp", keyCode: action.key }); break;
      case "type": contents.insertText(String(action.text || "")); if (action.submit) { contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" }); contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" }); } break;
      case "click_at": contents.sendInputEvent({ type: "mouseDown", x: Math.round(action.x), y: Math.round(action.y), button: "left", clickCount: 1 }); contents.sendInputEvent({ type: "mouseUp", x: Math.round(action.x), y: Math.round(action.y), button: "left", clickCount: 1 }); break;
      case "scroll": contents.sendInputEvent({ type: "mouseWheel", x: 0, y: 0, deltaY: action.direction === "up" ? Math.abs(action.amount || 500) : -Math.abs(action.amount || 500), canScroll: true }); break;
      default: break;
    }
    this.emitState();
    return { state: this.getState() };
  }

  async observe(tabId = this.activeTabId) {
    const contents = this.contentsFor(tabId);
    if (!contents || contents.isDestroyed()) throw new Error("The requested browser tab is no longer available.");
    const tab = tabId ? this.tabs.get(tabId) : null;
    const maxChars = 30_000;
    const page = await contents.executeJavaScript(`(() => {
      const clean = (value, max = 220) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max);
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width >= 2 && rect.height >= 2 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > .01;
      };
      const elements = [];
      let index = 1;
      for (const element of document.querySelectorAll("a,button,input,textarea,select,summary,[role='button'],[role='link'],[role='textbox'],[role='checkbox'],[role='radio'],[role='menuitem'],[contenteditable='true'],[tabindex]")) {
        if (!visible(element)) continue;
        const rect = element.getBoundingClientRect();
        let id = element.getAttribute("data-clyra-browser-id");
        if (!id) {
          id = "native-" + (++window.__clyraNativeElementSequence || (window.__clyraNativeElementSequence = 1));
          element.setAttribute("data-clyra-browser-id", id);
        }
        const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element : null;
        const anchor = element instanceof HTMLAnchorElement ? element : null;
        const labels = "labels" in element ? Array.from(element.labels || []).map((label) => label.innerText).join(" ") : "";
        const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean).map((part) => document.getElementById(part)?.textContent || "").join(" ");
        const role = element.getAttribute("role") || (element.tagName === "A" ? "link" : element.tagName === "BUTTON" ? "button" : element.tagName === "SELECT" ? "combobox" : element.tagName === "INPUT" || element.tagName === "TEXTAREA" ? "textbox" : "");
        const name = clean(element.getAttribute("aria-label") || labelledBy || labels || element.getAttribute("title") || element.innerText || input?.getAttribute("placeholder") || input?.value || "", 180);
        if (role === "link" && /^(?:skip|jump)\\s+(?:to\\s+)?(?:main\\s+)?(?:content|navigation|search)$/i.test(name)) continue;
        elements.push({ index, id, tag: element.tagName.toLowerCase(), role, name, text: clean(element.innerText || "", 220), label: clean(labels || labelledBy || element.getAttribute("aria-label") || "", 180), placeholder: clean(element.getAttribute("placeholder") || "", 160), type: clean(element.getAttribute("type") || "", 40), value: clean(input?.value || element.getAttribute("aria-valuetext") || "", 220), href: clean(anchor?.href || "", 400), testId: clean(element.getAttribute("data-testid") || "", 100), visible: true, enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true", checked: element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type) ? element.checked : element.getAttribute("aria-checked") == null ? undefined : element.getAttribute("aria-checked") === "true", selected: element.getAttribute("aria-selected") == null ? undefined : element.getAttribute("aria-selected") === "true", box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } });
        index += 1;
        if (elements.length >= 220) break;
      }
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")).filter(visible).slice(0, 40).map((heading) => ({ level: Number(heading.getAttribute("aria-level") || heading.tagName.slice(1) || 2), text: clean(heading.innerText, 240) })).filter((heading) => heading.text);
      const lines = Array.from(document.querySelectorAll("main p,main li,main td,main th,article p,article li,[role='main'] p,[role='main'] li,h1,h2,h3,label")).filter(visible).map((node) => clean(node.innerText, 500)).filter(Boolean);
      const root = document.querySelector("main,article,[role='main']") || document.body || document.documentElement;
      const pageHeight = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0, innerHeight);
      return { url: location.href, title: document.title, loading: document.readyState === "loading", viewport: { width: innerWidth, height: innerHeight, scrollX: scrollX, scrollY: scrollY, pageHeight, zoom: 1 }, headings, elements, visibleText: [...new Set(lines)].slice(0, 160), mainText: clean(root?.innerText || "", ${maxChars}), structuredData: [] };
    })()`, true);
    const signals = injectionSignals([...page.visibleText, page.mainText]);
    const fingerprint = crypto.createHash("sha1").update(`${page.url}|${page.title}|${page.visibleText.slice(0, 80).join("|")}|${page.elements.map((item) => `${item.id}:${item.value}:${item.checked}`).join("|")}`).digest("hex").slice(0, 16);
    return {
      page: { url: page.url, title: page.title, loading: page.loading, fingerprint },
      viewport: page.viewport,
      headings: page.headings,
      elements: page.elements,
      visibleText: page.visibleText.filter((line) => !signals.includes(line)),
      mainText: signals.reduce((text, signal) => text.replaceAll(signal, "[untrusted instruction-like page text removed]"), page.mainText),
      structuredData: page.structuredData,
      promptInjectionSignals: signals,
      tabs: this.getState().tabs,
      diff: { urlChanged: false, titleChanged: false, addedText: [], removedText: [] },
      activeTabId: tab?.id,
    };
  }

  async agentAction(action, observation, source = "agent", tabId = this.activeTabId) {
    const contents = this.contentsFor(tabId);
    if (!contents || contents.isDestroyed()) throw new Error("The requested browser tab is no longer available.");
    // An agent run may continue in a tab the user has left. Keep that renderer
    // responsive without stealing focus or changing the visible tab.
    contents.setBackgroundThrottling(false);
    const tabIsVisible = this.surface.visible && tabId === this.activeTabId;
    const elements = observation?.elements || [];
    const target = action?.target;
    const resolved = typeof target === "number"
      ? elements.find((element) => element.index === target)
      : target?.elementId
        ? elements.find((element) => element.id === target.elementId)
        : target && elements.find((element) => (!target.role || element.role === target.role) && (!target.name || element.name.toLowerCase().includes(String(target.name).toLowerCase())) && (!target.label || element.label.toLowerCase().includes(String(target.label).toLowerCase())) && (!target.placeholder || element.placeholder.toLowerCase().includes(String(target.placeholder).toLowerCase())) && (!target.text || element.text.toLowerCase().includes(String(target.text).toLowerCase())) && (!target.testId || element.testId === target.testId));
    const point = resolved?.center || (typeof target === "object" ? target.coordinates : null);
    const withDebugger = async (operation) => {
      const attachedHere = !contents.debugger.isAttached();
      if (attachedHere) contents.debugger.attach("1.3");
      try {
        return await operation((method, params) => contents.debugger.sendCommand(method, params));
      } finally {
        if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
      }
    };
    const click = async (clickCount = 1, button = "left") => {
      if (!point) throw new Error("The requested target is no longer visible.");
      // A hidden native view has no compositor target for dispatchMouseEvent.
      // Use the actual page node in that same WebContents until the user opens
      // Browser again; visible browser actions always retain CDP coordinates.
      if (!tabIsVisible && resolved) {
        await contents.executeJavaScript(`document.querySelector(${JSON.stringify(`[data-clyra-browser-id="${resolved.id}"]`)})?.click()`, true);
        return;
      }
      await withDebugger(async (send) => {
        const params = { x: Math.round(point.x), y: Math.round(point.y), button, clickCount };
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...params });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...params });
      });
    };
    const focus = async () => {
      if (!resolved) return;
      await contents.executeJavaScript(`document.querySelector(${JSON.stringify(`[data-clyra-browser-id="${resolved.id}"]`)})?.focus()`, true);
    };
    const key = async (keyCode, modifiers = 0) => {
      await withDebugger(async (send) => {
        const code = String(keyCode).length === 1 ? `Key${String(keyCode).toUpperCase()}` : String(keyCode);
        const key = keyCode === "Backspace" ? "Backspace" : keyCode === "Enter" ? "Enter" : String(keyCode);
        await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode === "Enter" ? 13 : keyCode === "Backspace" ? 8 : String(keyCode).toUpperCase().charCodeAt(0), nativeVirtualKeyCode: keyCode === "Enter" ? 13 : keyCode === "Backspace" ? 8 : String(keyCode).toUpperCase().charCodeAt(0), modifiers });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode === "Enter" ? 13 : keyCode === "Backspace" ? 8 : String(keyCode).toUpperCase().charCodeAt(0), nativeVirtualKeyCode: keyCode === "Enter" ? 13 : keyCode === "Backspace" ? 8 : String(keyCode).toUpperCase().charCodeAt(0), modifiers });
      });
    };
    if (tabIsVisible) contents.focus();
    switch (action?.type) {
      case "navigate": await this.navigate(action.url, tabId); break;
      case "search": await this.navigate(action.query, tabId); break;
      case "back": case "go_back": if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
      case "forward": case "go_forward": if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
      case "reload": contents.reload(); break;
      case "stop_loading": contents.stop(); break;
      case "open_tab": await this.createTab(action.url || HOME_URL); break;
      case "switch_tab": this.activateTab(action.tabId || [...this.tabs.keys()][action.tabIndex || 0]); break;
      case "close_tab": await this.closeTab(action.tabId || [...this.tabs.keys()][action.tabIndex || 0]); break;
      case "duplicate_tab": await this.duplicateTab(action.tabId || [...this.tabs.keys()][action.tabIndex || 0]); break;
      case "restore_closed_tab": await this.restoreClosedTab(); break;
      case "click": case "focus": await focus(); if (action.type === "click") await click(); break;
      case "double_click": await click(2); break;
      case "right_click": await click(1, "right"); break;
      case "hover": break;
      case "click_at": await withDebugger(async (send) => {
        const params = { x: Math.round(action.x), y: Math.round(action.y), button: "left", clickCount: 1 };
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...params });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...params });
      }); break;
      case "type": {
        await focus();
        if (!tabIsVisible && resolved) {
          await contents.executeJavaScript(`(() => {
            const node = document.querySelector(${JSON.stringify(`[data-clyra-browser-id="${resolved.id}"]`)});
            if (!node) return;
            const value = ${JSON.stringify(String(action.text || ""))};
            if ("value" in node) node.value = ${action.clearFirst !== false ? "\"\"" : "node.value"} + value;
            else if (node.isContentEditable) node.textContent = ${action.clearFirst !== false ? "value" : "node.textContent + value"};
            node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
            node.dispatchEvent(new Event("change", { bubbles: true }));
          })()`, true);
          if (action.submit) await contents.executeJavaScript(`document.querySelector(${JSON.stringify(`[data-clyra-browser-id="${resolved.id}"]`)})?.form?.requestSubmit?.()`, true);
          break;
        }
        if (action.clearFirst !== false) {
          await contents.executeJavaScript(`(() => { const node = document.activeElement; if (node && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) node.select(); else document.execCommand("selectAll"); })()`, true);
        }
        const delay = source === "agent" ? (String(action.text).length > 180 ? 28 : 38) : 0;
        for (const character of String(action.text || "")) {
          await withDebugger((send) => send("Input.insertText", { text: character }));
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (action.submit) await key("Enter");
        break;
      }
      case "check":
      case "uncheck": {
        if (!resolved) throw new Error("The requested control is no longer visible.");
        const desired = action.type === "check";
        await contents.executeJavaScript(`(() => { const node = document.querySelector(${JSON.stringify(`[data-clyra-browser-id="${resolved.id}"]`)}); if (node && node.checked !== ${desired}) node.click(); })()`, true);
        break;
      }
      case "select_option": {
        if (!resolved) throw new Error("The requested control is no longer visible.");
        const selected = await contents.executeJavaScript(`(() => {
          const node = document.querySelector(${JSON.stringify(`[data-clyra-browser-id="${resolved.id}"]`)});
          if (!(node instanceof HTMLSelectElement)) return false;
          const comparable = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9.]+/g, "");
          const needle = comparable(${JSON.stringify(String(action.value ?? action.label ?? ""))});
          const option = [...node.options].find((candidate) => comparable(candidate.value) === needle || comparable(candidate.label) === needle || comparable(candidate.textContent) === needle);
          if (!option) return false;
          node.value = option.value;
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`, true);
        if (!selected) throw new Error("The requested select option was not found.");
        break;
      }
      case "press": case "press_key": await key(action.key); break;
      case "key_combination": {
        const keys = action.keys || [];
        const modifiers = keys.slice(0, -1).reduce((value, item) => value | (/^(?:control|ctrl|controlormeta)$/i.test(String(item)) ? 2 : /^(?:meta|command|cmd)$/i.test(String(item)) ? 4 : /^(?:alt|option)$/i.test(String(item)) ? 1 : /^(?:shift)$/i.test(String(item)) ? 8 : 0), 0);
        await key(keys[keys.length - 1], modifiers);
        break;
      }
      case "scroll": {
        const amount = Math.abs(Number(action.amount || 600));
        if (!tabIsVisible) {
          const x = action.direction === "left" ? -amount : action.direction === "right" ? amount : 0;
          const y = action.direction === "up" ? -amount : amount;
          await contents.executeJavaScript(`window.scrollBy({ left: ${x}, top: ${y}, behavior: "instant" })`, true);
        } else {
          contents.sendInputEvent({ type: "mouseWheel", x: Math.round(point?.x || 8), y: Math.round(point?.y || 8), deltaX: action.direction === "left" ? Math.abs(amount) : action.direction === "right" ? -Math.abs(amount) : 0, deltaY: action.direction === "up" ? Math.abs(amount) : -Math.abs(amount), canScroll: true });
        }
        break;
      }
      case "scroll_to_top": await contents.executeJavaScript("window.scrollTo({top:0,behavior:'smooth'})", true); break;
      case "scroll_to_bottom": await contents.executeJavaScript("window.scrollTo({top:document.documentElement.scrollHeight,behavior:'smooth'})", true); break;
      case "scroll_to": await contents.executeJavaScript(`document.querySelector(${JSON.stringify(resolved ? `[data-clyra-browser-id="${resolved.id}"]` : "")})?.scrollIntoView({block:'center',behavior:'smooth'})`, true); break;
      case "drag": case "wait": case "read_page": case "extract": case "inspect_element": case "find_text": case "ask_user": case "done": break;
      default: break;
    }
    await new Promise((resolve) => setTimeout(resolve, action?.type === "navigate" || action?.type === "search" ? 350 : 90));
    // Tab lifecycle actions can destroy the WebContents referenced by tabId
    // (most notably Close). Observe the tab that survived / became active,
    // rather than attempting to inspect a just-destroyed renderer.
    const lifecycleAction = ["open_tab", "switch_tab", "close_tab", "duplicate_tab", "restore_closed_tab"].includes(action?.type);
    const observationTabId = lifecycleAction ? this.activeTabId : tabId;
    const after = await this.observe(observationTabId);
    // close_tab intentionally destroys `contents`; never touch it after the
    // lifecycle operation has completed.
    if (tabId && tabId !== this.activeTabId && !contents.isDestroyed()) contents.setBackgroundThrottling(true);
    return { ok: true, state: this.getState(), observation: after };
  }

  async setCursor(cursor, tabId = this.activeTabId) {
    // Keep the human's visible tab undisturbed while an agent continues in a
    // different tab. The cursor becomes visible automatically when that tab
    // is brought back to the foreground on the next agent event.
    if (tabId && tabId !== this.activeTabId) return;
    const contents = this.contentsFor(tabId);
    if (!contents || contents.isDestroyed()) return;
    const payload = cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)
      ? {
          x: Math.round(cursor.x),
          y: Math.round(cursor.y),
          label: String(cursor.label || "Clyra").slice(0, 80),
          kind: String(cursor.kind || "move"),
          showLabel: cursor.showLabel !== false,
          reducedMotion: Boolean(cursor.reducedMotion),
        }
      : null;
    await contents.executeJavaScript(`(() => {
      const id = "__clyra_native_agent_cursor__";
      const existing = document.getElementById(id);
      const data = ${JSON.stringify(payload)};
      if (!data) { existing?.remove(); return; }
      const root = existing || Object.assign(document.createElement("div"), { id });
      if (!existing) {
        root.setAttribute("aria-hidden", "true");
        root.style.cssText = "position:fixed;left:0;top:0;width:27px;height:33px;z-index:2147483647;pointer-events:none;will-change:transform;contain:layout style paint;transition:opacity 120ms ease;";
        const glow = document.createElement("div");
        glow.dataset.part = "glow";
        glow.style.cssText = "position:absolute;left:-13px;top:-13px;width:49px;height:49px;border-radius:999px;background:radial-gradient(circle,rgba(87,151,255,.24),rgba(63,128,255,.11) 39%,transparent 70%);filter:blur(4px);";
        const pointer = document.createElement("div");
        pointer.dataset.part = "pointer";
        pointer.style.cssText = "position:absolute;left:0;top:0;width:28px;height:32px;filter:drop-shadow(0 0 1px rgba(255,255,255,.82)) drop-shadow(0 2px 4px rgba(16,24,40,.32)) drop-shadow(0 0 10px rgba(43,128,255,.32));transform-origin:5px 2px;";
        pointer.innerHTML = '<svg viewBox="0 0 28 32" width="28" height="32" aria-hidden="true"><defs><linearGradient id="clyraNativeCursor" x1="2" y1="2" x2="22" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#2b3039"/><stop offset=".42" stop-color="#15181d"/><stop offset="1" stop-color="#07080a"/></linearGradient></defs><path d="M4.62 2.72C3.09 1.91 1.57 3.43 2.39 4.96l8.36 16.3c.75 1.47 2.87 1.39 3.5-.13l2.69-6.51 6.51-2.69c1.52-.63 1.6-2.75.13-3.5L4.62 2.72Z" fill="url(#clyraNativeCursor)" stroke="rgba(255,255,255,.55)" stroke-width=".55" stroke-linejoin="round"/></svg>';
        const caret = document.createElement("div");
        caret.dataset.part = "caret";
        caret.style.cssText = "display:none;position:absolute;left:16px;top:6px;width:2px;height:22px;border-radius:999px;background:#1d1f24;box-shadow:0 0 0 1px rgba(255,255,255,.9),0 1px 5px rgba(52,97,177,.22);";
        const click = document.createElement("div");
        click.dataset.part = "click";
        click.style.cssText = "display:none;position:absolute;left:-8px;top:-8px;width:26px;height:26px;border:1.5px solid rgba(83,145,255,.78);border-radius:999px;box-shadow:0 0 0 3px rgba(79,124,255,.11);";
        const label = document.createElement("span");
        label.dataset.part = "label";
        label.style.cssText = "position:absolute;left:29px;top:1px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid rgba(36,42,52,.12);border-radius:8px;background:rgba(255,255,255,.93);padding:5px 9px 5px 18px;color:#252a33;font:650 10.5px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:-.01em;box-shadow:0 5px 16px rgba(20,32,52,.16),inset 0 1px 0 rgba(255,255,255,.72);";
        const labelDot = document.createElement("i");
        labelDot.style.cssText = "position:absolute;left:8px;top:50%;width:4px;height:4px;margin-top:-2px;border-radius:999px;background:#4f7cff;box-shadow:0 0 0 2px rgba(79,124,255,.12);";
        label.append(labelDot);
        root.append(glow, pointer, caret, click, label);
        document.documentElement.appendChild(root);
      }
      const label = root.querySelector('[data-part="label"]');
      if (label) {
        const text = label.lastChild && label.lastChild.nodeType === Node.TEXT_NODE ? label.lastChild : document.createTextNode("");
        text.textContent = data.label;
        if (!text.parentNode) label.append(text);
        label.style.display = data.showLabel ? "block" : "none";
      }
      root.style.transition = data.reducedMotion ? "none" : "transform 280ms cubic-bezier(.16,1,.3,1), opacity 120ms ease";
      root.style.transform = "translate3d(" + (data.x - 3) + "px," + (data.y - 2) + "px,0)";
      root.style.opacity = "1";
      const pointer = root.querySelector('[data-part="pointer"]');
      const caret = root.querySelector('[data-part="caret"]');
      const click = root.querySelector('[data-part="click"]');
      if (caret) {
        caret.style.display = data.kind === "type" ? "block" : "none";
        caret.animate?.([{ opacity: 1 }, { opacity: .2 }, { opacity: 1 }], { duration: 880, iterations: data.kind === "type" ? Infinity : 1, easing: "steps(2,end)" });
      }
      if (pointer) pointer.style.opacity = data.kind === "type" ? ".7" : "1";
      if (click) {
        click.style.display = data.kind.includes("click") ? "block" : "none";
        if (data.kind.includes("click")) click.animate?.([{ transform: "scale(.42)", opacity: .88 }, { transform: "scale(1.52)", opacity: 0 }], { duration: 520, easing: "cubic-bezier(.16,1,.3,1)" });
      }
      if (pointer) {
        pointer.animate?.(
          data.kind.includes("click") ? [{ transform: "scale(1)" }, { transform: "scale(.82)" }, { transform: "scale(1)" }] : [{ opacity: 1 }, { opacity: 1 }],
          { duration: data.kind.includes("click") ? 190 : 1, easing: "ease-out" },
        );
      }
    })()`, true).catch(() => undefined);
  }

  async find(text) {
    const contents = this.activeContents();
    const query = String(text || "").trim();
    if (!contents || !query) {
      contents?.stopFindInPage?.("clearSelection");
      return { result: { total: 0, current: 0 }, state: this.getState() };
    }

    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        contents.removeListener("found-in-page", onFound);
        resolve(payload);
      };
      const onFound = (_event, detail) => {
        if (detail.finalUpdate) finish({ total: detail.matches || 0, current: detail.activeMatchOrdinal || 0 });
      };
      const timeout = setTimeout(() => finish({ total: 0, current: 0 }), 2_000);
      contents.on("found-in-page", onFound);
      contents.findInPage(query, { findNext: true, forward: true, findMatchCase: false });
    });
    return { result, state: this.getState() };
  }

  zoom(delta) {
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    if (!tab) return this.getState();
    tab.zoom = delta === "reset" ? 1 : Math.max(0.5, Math.min(3, tab.zoom + Number(delta || 0)));
    tab.view.webContents.setZoomFactor(tab.zoom);
    this.emitState();
    return this.getState();
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...(patch || {}) };
    this.scheduleSave();
    this.emitState();
    return this.getState();
  }

  addBookmark(input = {}) {
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    if (!tab) return this.getState();
    const url = input.url || tab.view.webContents.getURL();
    const existing = this.bookmarks.find((bookmark) => bookmark.url === url);
    if (existing) {
      existing.title = input.title || existing.title;
      existing.folder = input.folder || existing.folder;
    } else {
      this.bookmarks.unshift({ id: crypto.randomUUID(), url, title: input.title || tab.title || url, folder: input.folder || "Bookmarks", createdAt: new Date().toISOString() });
      this.scheduleSave();
    }
    this.emitState();
    return this.getState();
  }

  removeBookmark(id) {
    this.bookmarks = this.bookmarks.filter((bookmark) => bookmark.id !== id);
    this.scheduleSave();
    this.emitState();
    return this.getState();
  }

  clearHistory(ids) {
    const selected = Array.isArray(ids) ? new Set(ids) : null;
    this.history = selected ? this.history.filter((entry) => !selected.has(entry.id)) : [];
    this.scheduleSave();
    this.emitState();
    return this.getState();
  }

  recordHistory(tab) {
    if (!this.settings.saveHistory || this.settings.privateMode) return;
    const url = tab.view.webContents.getURL();
    if (!/^https?:\/\//i.test(url)) return;
    const now = new Date().toISOString();
    const existing = this.history.find((entry) => entry.url === url);
    this.history = this.history.filter((entry) => entry.url !== url);
    this.history.unshift({
      id: existing?.id || crypto.randomUUID(),
      url,
      title: tab.title || url,
      visitedAt: now,
      visitCount: (existing?.visitCount || 0) + 1,
      favicon: tab.favicon,
    });
    this.history = this.history.slice(0, 2000);
    this.scheduleSave();
  }

  async inspect() {
    const contents = this.activeContents();
    if (!contents) throw new Error("No active browser tab.");
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    await contents.debugger.sendCommand("DOM.enable");
    await contents.debugger.sendCommand("Accessibility.enable");
    const [document, accessibility, layout] = await Promise.all([
      contents.debugger.sendCommand("DOM.getDocument", { depth: 2, pierce: true }),
      contents.debugger.sendCommand("Accessibility.getFullAXTree", { depth: 4 }),
      contents.debugger.sendCommand("Page.getLayoutMetrics"),
    ]);
    return {
      targetId: contents.getOrCreateDevToolsTargetId(),
      url: contents.getURL(),
      title: contents.getTitle(),
      activeElement: await contents.executeJavaScript("document.activeElement ? {tag: document.activeElement.tagName, role: document.activeElement.getAttribute('role'), name: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent?.trim().slice(0,120)} : null", true),
      document,
      accessibility,
      layout,
    };
  }

  setAgentState(agent) {
    this.agent = { ...this.agent, ...(agent || {}) };
    void this.syncAgentChrome();
    this.emitState();
    return this.agent;
  }

  async syncAgentChrome() {
    const contents = this.activeContents();
    if (!contents || contents.isDestroyed()) return;
    const active = ![
      "idle",
      "completed",
      "failed",
      "cancelled",
      "waiting_for_user",
      "paused",
    ].includes(String(this.agent.status || "idle")) && !this.agent.manualControl;
    const reducedMotion = Boolean(this.settings.reducedMotion);
    await contents.executeJavaScript(`(() => {
      const rootId = "__clyra_native_agent_border__";
      const styleId = "__clyra_native_agent_border_style__";
      const active = ${JSON.stringify(active)};
      document.getElementById(rootId)?.remove();
      document.getElementById(styleId)?.remove();
      if (!active) return;
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = ${JSON.stringify(`
        @keyframes clyra-agent-beam-x { from { transform: translate3d(-42vw,0,0); } to { transform: translate3d(142vw,0,0); } }
        @keyframes clyra-agent-beam-x-back { from { transform: translate3d(142vw,0,0); } to { transform: translate3d(-42vw,0,0); } }
        @keyframes clyra-agent-beam-y { from { transform: translate3d(0,-42vh,0); } to { transform: translate3d(0,142vh,0); } }
        @keyframes clyra-agent-beam-y-back { from { transform: translate3d(0,142vh,0); } to { transform: translate3d(0,-42vh,0); } }
        #__clyra_native_agent_border__ .clyra-beam { position:absolute; border-radius:999px; background:linear-gradient(90deg,transparent,rgba(96,165,250,.45),#2563eb,rgba(125,211,252,.7),transparent); filter:drop-shadow(0 0 5px rgba(37,99,235,.85)); will-change:transform; }
      `)};
      document.documentElement.appendChild(style);
      const root = document.createElement("div");
      root.id = rootId;
      root.setAttribute("aria-hidden", "true");
      root.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;overflow:hidden;contain:layout style paint;box-shadow:inset 0 0 0 1px rgba(59,130,246,.62),inset 0 0 18px rgba(59,130,246,.12);";
      const specs = [
        "left:0;top:0;width:34vw;height:2px;animation:clyra-agent-beam-x 2.35s linear infinite",
        "right:0;top:0;width:2px;height:34vh;animation:clyra-agent-beam-y 2.35s .58s linear infinite",
        "left:0;bottom:0;width:34vw;height:2px;animation:clyra-agent-beam-x-back 2.35s 1.16s linear infinite",
        "left:0;top:0;width:2px;height:34vh;animation:clyra-agent-beam-y-back 2.35s 1.74s linear infinite",
      ];
      for (const css of specs) {
        const beam = document.createElement("span");
        beam.className = "clyra-beam";
        beam.style.cssText = css + ${JSON.stringify(reducedMotion ? ";animation:none;opacity:.6" : "")};
        root.appendChild(beam);
      }
      document.documentElement.appendChild(root);
    })()`, true).catch(() => undefined);
  }

  getState() {
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    const contents = active?.view?.webContents;
    const readableContents = contents && !contents.isDestroyed() ? contents : null;
    const url = readableContents?.getURL() || HOME_URL;
    const bounds = this.surface.bounds;
    return {
      url,
      title: active?.title || "New tab",
      frameVersion: 0,
      viewport: { width: bounds.width, height: bounds.height, scrollX: 0, scrollY: 0, pageHeight: bounds.height },
      loading: Boolean(active?.loading),
      elements: [],
      tabs: [...this.tabs.values()].flatMap((tab) => {
        try {
          const tabContents = tab?.view?.webContents;
          if (!tabContents || tabContents.isDestroyed()) return [];
          return [{
            id: tab.id,
            title: tab.title,
            url: tabContents.getURL(),
            active: tab.id === this.activeTabId,
            loading: tab.loading,
            favicon: tab.favicon,
            zoom: tab.zoom,
          }];
        } catch {
          return [];
        }
      }),
      activeTabId: this.activeTabId,
      canGoBack: Boolean(readableContents?.navigationHistory.canGoBack()),
      canGoForward: Boolean(readableContents?.navigationHistory.canGoForward()),
      secure: url.startsWith("https://"),
      zoom: active?.zoom || 1,
      history: this.history,
      bookmarks: this.bookmarks,
      recentlyClosed: this.closedTabs,
      downloads: this.downloads,
      settings: this.settings,
      agent: this.agent,
    };
  }

  /**
   * Capture the actual native Chromium surface for API consumers such as the
   * AI browser workspace.  This deliberately captures the active WebContents
   * rather than the host window: the browser remains observable even while
   * its WebContentsView is temporarily hidden behind another Clyra workspace.
   */
  async captureFrame() {
    const contents = this.activeContents();
    if (!contents || contents.isDestroyed()) {
      throw new Error("The active browser tab is unavailable for capture.");
    }
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    // Electron may indefinitely defer capturePage for a hidden WebContentsView.
    // Briefly composite just this view, without focusing it, then restore its
    // hidden state. This keeps the browser preview available to the UI/API
    // while the user is in another Clyra workspace.
    const restoreHidden = Boolean(tab && !this.surface.visible);
    if (restoreHidden && tab) {
      tab.view.setBounds(this.surface.bounds);
      tab.view.setVisible(true);
      contents.setBackgroundThrottling(false);
      await new Promise((resolve) => setTimeout(resolve, 24));
    }
    try {
      const image = await Promise.race([
        contents.capturePage(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Browser frame capture timed out.")), 8_000)),
      ]);
      if (!image || image.isEmpty()) throw new Error("The active browser tab returned an empty frame.");
      return image.toJPEG(82);
    } finally {
      if (restoreHidden && tab && !tab.view.webContents.isDestroyed()) {
        tab.view.setVisible(false);
        tab.view.webContents.setBackgroundThrottling(true);
      }
    }
  }

  emitState() {
    if (this.destroyed) return;
    try {
      if (this.uiView?.webContents && !this.uiView.webContents.isDestroyed()) {
        this.uiView.webContents.send("browser:state", this.getState());
      }
    } catch {
      // The shell may already be closing. Native browser state no longer has a
      // renderer to update in that case.
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.saveTimer);
    void this.saveProfile();
    for (const tab of this.tabs.values()) {
      try {
        if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      } catch {
        // The BrowserWindow owns this view and can release it first on macOS.
      }
      try {
        if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
          tab.view.webContents.close({ waitForBeforeUnload: false });
        }
      } catch {
        // Closing a renderer that Chromium has already destroyed is harmless.
      }
    }
    this.tabs.clear();
    this.activeTabId = null;
  }
}

export { HOME_URL, normalizeInput };
