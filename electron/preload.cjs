const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("clyraDesktop", {
  runtime: "electron",
  browser: {
    getState: () => ipcRenderer.invoke("browser:get-state"),
    setSurface: (payload) => ipcRenderer.invoke("browser:set-surface", payload),
    navigate: (target) => ipcRenderer.invoke("browser:navigate", { target }),
    action: (action) => ipcRenderer.invoke("browser:action", { action }),
    find: (text) => ipcRenderer.invoke("browser:find", { text }),
    zoom: (delta) => ipcRenderer.invoke("browser:zoom", { delta }),
    updateSettings: (patch) => ipcRenderer.invoke("browser:update-settings", { patch }),
    addBookmark: () => ipcRenderer.invoke("browser:add-bookmark"),
    removeBookmark: (id) => ipcRenderer.invoke("browser:remove-bookmark", { id }),
    clearHistory: (ids) => ipcRenderer.invoke("browser:clear-history", { ids }),
    inspect: () => ipcRenderer.invoke("browser:inspect"),
    setCursor: (cursor) => ipcRenderer.invoke("browser:set-cursor", cursor),
    openDevTools: () => ipcRenderer.invoke("browser:devtools"),
    onState: (callback) => subscribe("browser:state", callback),
    onFocusAddress: (callback) => subscribe("browser:focus-address", callback),
    onFocusFind: (callback) => subscribe("browser:focus-find", callback),
  },
  surfaces: {
    update: (payload) => ipcRenderer.invoke("surface:update", payload),
    hide: (id) => ipcRenderer.invoke("surface:hide", { id }),
  },
  dictation: {
    setState: (payload) => ipcRenderer.invoke("dictation:set-state", payload),
    serviceUrl: () => ipcRenderer.invoke("dictation:service-url"),
    insert: (payload) => ipcRenderer.invoke("dictation:insert", payload),
    ensurePermissions: () => ipcRenderer.invoke("dictation:ensure-permissions"),
    onTrigger: (callback) => subscribe("dictation:trigger", callback),
    onAction: (callback) => subscribe("dictation:action", callback),
  },
});
