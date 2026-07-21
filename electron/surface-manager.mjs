import { session, WebContentsView } from "electron";

function isAllowedUrl(value) {
  try {
    return ["http:", "https:", "data:", "about:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export class ChromiumSurfaceManager {
  constructor({ window }) {
    this.window = window;
    this.surfaces = new Map();
  }

  create(id, url, kind) {
    const partition = kind === "vibe-runtime" ? "persist:vibe-runtime" : "persist:preview";
    session.fromPartition(partition, { cache: true });
    const view = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
      },
    });
    const record = { id, kind, url, view, visible: false, bounds: null, failed: false };
    this.surfaces.set(id, record);
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      void view.webContents.loadURL(popupUrl);
      return { action: "deny" };
    });
    view.webContents.on("render-process-gone", (_event, details) => {
      record.failed = details.reason !== "clean-exit";
      if (record.failed) setTimeout(() => view.webContents.reload(), 350);
    });
    void view.webContents.loadURL(url);
    return record;
  }

  update({ id, url, kind = "preview", bounds, visible }) {
    if (!id || !isAllowedUrl(url)) throw new Error("A valid Chromium surface URL is required.");
    let record = this.surfaces.get(id);
    if (!record) record = this.create(id, url, kind);
    if (record.url !== url) {
      record.url = url;
      void record.view.webContents.loadURL(url);
    }
    if (bounds) {
      const next = {
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
        width: Math.max(2, Math.round(bounds.width)),
        height: Math.max(2, Math.round(bounds.height)),
      };
      if (!record.bounds || Object.keys(next).some((key) => next[key] !== record.bounds[key])) {
        record.bounds = next;
        record.view.setBounds(next);
      }
    }
    record.visible = Boolean(visible);
    record.view.setVisible(record.visible);
    return { id, visible: record.visible, url: record.url };
  }

  hide(id) {
    const record = this.surfaces.get(id);
    if (!record) return;
    record.visible = false;
    record.view.setVisible(false);
  }

  hideAll() {
    for (const record of this.surfaces.values()) {
      record.visible = false;
      record.view.setVisible(false);
    }
  }

  destroy() {
    for (const record of this.surfaces.values()) {
      this.window.contentView.removeChildView(record.view);
      if (!record.view.webContents.isDestroyed()) record.view.webContents.close({ waitForBeforeUnload: false });
    }
    this.surfaces.clear();
  }
}
