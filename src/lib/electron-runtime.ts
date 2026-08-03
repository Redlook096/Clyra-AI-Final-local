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
  taskView: {
    capture: (payload: { bounds: ElectronSurfaceBounds; nativeBrowser?: boolean }) => Promise<{
      ok: boolean;
      src: string;
      width: number;
      height: number;
      nativeLayer?: {
        src: string;
        left: number;
        top: number;
        width: number;
        height: number;
        imageWidth: number;
        imageHeight: number;
      };
    }>;
    onToggle: (callback: () => void) => () => void;
  };
  dictation: {
    toggle?: () => Promise<{ ok: boolean }>;
    shortcutStatus?: () => Promise<{ registered: boolean }>;
    setState: (payload: unknown) => Promise<any>;
    serviceUrl: () => Promise<string>;
    insert: (payload: { text: string; target?: unknown }) => Promise<any>;
    ensurePermissions?: () => Promise<{ ok: boolean; status?: string; error?: string; microphone?: string; accessibility?: boolean }>;
    openMicrophoneSettings?: () => Promise<{ ok: boolean }>;
    onTrigger: (callback: (payload: any) => void) => () => void;
    onAction: (callback: (payload: any) => void) => () => void;
  };
  google: {
    status: () => Promise<{ connected: boolean; email?: string }>;
    signIn: () => Promise<{ ok: boolean; pending?: boolean; error?: string }>;
    disconnect: () => Promise<{ ok: boolean }>;
    execute: (payload: { tool?: "gmail" | "calendar" | "docs" | "sheets" | "slides" | "drive"; prompt?: string; runId?: string; service?: "docs" | "drive" | "sheets" | "gmail" | "calendar" | "contacts" | "youtube"; action?: string; args?: Record<string, unknown>; confirmed?: boolean }) => Promise<{ ok: boolean; text: string; action?: string; detail?: string; needsAuth?: boolean; needsInput?: boolean; requiresConfirmation?: boolean; confirmationKind?: string; gmailResults?: unknown; gmailThread?: unknown; gmailEmail?: unknown; gmailMutation?: unknown; gmailFollowUp?: { id?: string; dueAt?: string }; workspaceResult?: unknown }>;
    diagnostic: (payload?: { forceRefresh?: boolean }) => Promise<{ ok: boolean; stage?: string; httpStatus?: number; errorCode?: string; driveListed?: boolean; documentCreated?: boolean; documentRead?: boolean; documentDeleted?: boolean; refreshVerified?: boolean; accessibleFileCount?: number }>;
    onAuthState: (callback: (payload: { connected: boolean; email?: string; pending?: boolean; error?: string }) => void) => () => void;
    onAgentProgress: (callback: (payload: { runId: string; service: "clyra" | "research" | "gmail" | "calendar" | "docs" | "sheets" | "slides" | "drive"; state: "running" | "completed" | "failed"; label: string; detail: string }) => void) => () => void;
  };
  research: {
    execute: (payload: { prompt: string; runId?: string; checkpointId?: string; answers?: string; action?: "start" | "continue" | "cancel" }) => Promise<{ ok: boolean; text: string; needsClarification?: boolean; checkpointId?: string; questions?: string[]; analysisPrompt?: string; sources?: Array<{ url: string; publisher: string; branch: string }>; assumptions?: string[]; paused?: boolean; cancelled?: boolean }>;
    onAgentProgress: (callback: (payload: { runId: string; service: "clyra" | "research"; state: "running" | "completed" | "failed"; label: string; detail: string }) => void) => () => void;
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
