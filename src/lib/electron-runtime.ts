export type ElectronSurfaceBounds = { x: number; y: number; width: number; height: number };

export type ClyraDesktopBridge = {
  runtime: "electron";
  browser: {
    getState: () => Promise<any>;
    setSurface: (payload: { bounds?: ElectronSurfaceBounds; visible: boolean }) => Promise<any>;
    navigate: (target: string) => Promise<any>;
    action: (action: unknown) => Promise<any>;
    find: (text: string) => Promise<any>;
    zoom: (delta: number | "reset") => Promise<any>;
    updateSettings: (patch: unknown) => Promise<any>;
    addBookmark: () => Promise<any>;
    removeBookmark: (id: string) => Promise<any>;
    clearHistory: (ids?: string[]) => Promise<any>;
    inspect: () => Promise<any>;
    setCursor: (cursor: unknown) => Promise<any>;
    openDevTools: () => Promise<any>;
    onState: (callback: (state: any) => void) => () => void;
    onFocusAddress: (callback: () => void) => () => void;
    onFocusFind: (callback: () => void) => () => void;
  };
  surfaces: {
    update: (payload: {
      id: string;
      url: string;
      kind: "preview" | "vibe-runtime";
      bounds: ElectronSurfaceBounds;
      visible: boolean;
    }) => Promise<any>;
    hide: (id: string) => Promise<any>;
  };
  dictation: {
    setState: (payload: unknown) => Promise<any>;
    serviceUrl: () => Promise<string>;
    insert: (payload: { text: string; target?: unknown }) => Promise<any>;
    onTrigger: (callback: (payload: any) => void) => () => void;
    onAction: (callback: (payload: any) => void) => () => void;
  };
};

declare global {
  interface Window {
    clyraDesktop?: ClyraDesktopBridge;
  }
}

export function getElectronDesktop() {
  return typeof window !== "undefined" && window.clyraDesktop?.runtime === "electron"
    ? window.clyraDesktop
    : undefined;
}

export function isElectronRuntime() {
  return Boolean(getElectronDesktop());
}

export async function requestElectronBrowser(
  path: string,
  options: { body?: any } = {},
) {
  const desktop = getElectronDesktop();
  if (!desktop) return null;
  const body = options.body || {};
  if (path === "/api/openbrowser/state") return desktop.browser.getState();
  if (path === "/api/openbrowser/navigate") return desktop.browser.navigate(String(body.target || ""));
  if (path === "/api/openbrowser/action") return desktop.browser.action(body.action);
  if (path === "/api/openbrowser/find") return desktop.browser.find(String(body.text || ""));
  if (path === "/api/openbrowser/zoom") return desktop.browser.zoom(body.delta);
  if (path === "/api/openbrowser/settings") return desktop.browser.updateSettings(body);
  if (path === "/api/openbrowser/bookmarks") return desktop.browser.addBookmark();
  if (path.startsWith("/api/openbrowser/bookmarks/")) {
    return desktop.browser.removeBookmark(decodeURIComponent(path.split("/").at(-1) || ""));
  }
  if (path === "/api/openbrowser/history") return desktop.browser.clearHistory(body.ids);
  if (path === "/api/openbrowser/viewport") return desktop.browser.getState();
  return null;
}
