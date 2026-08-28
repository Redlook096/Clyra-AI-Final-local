const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("clyraDesktop", {
  runtime: "electron",
  preview: {
    launch: (payload) => ipcRenderer.invoke("preview:launch-desktop", payload),
  },
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
    snip: (tabId) => ipcRenderer.invoke("browser:snip", { tabId }),
    cancelSnip: (tabId) => ipcRenderer.invoke("browser:cancel-snip", { tabId }),
    onState: (callback) => subscribe("browser:state", callback),
    onFocusAddress: (callback) => subscribe("browser:focus-address", callback),
    onFocusFind: (callback) => subscribe("browser:focus-find", callback),
    onAskSelection: (callback) => subscribe("browser:ask-selection", callback),
  },
  surfaces: {
    update: (payload) => ipcRenderer.invoke("surface:update", payload),
    hide: (id) => ipcRenderer.invoke("surface:hide", { id }),
  },
  taskView: {
    capture: (payload) => ipcRenderer.invoke("taskview:capture", payload),
    onToggle: (callback) => subscribe("taskview:toggle", callback),
  },
  dictation: {
    toggle: () => ipcRenderer.invoke("dictation:toggle"),
    shortcutStatus: () => ipcRenderer.invoke("dictation:shortcut-status"),
    setState: (payload) => ipcRenderer.invoke("dictation:set-state", payload),
    serviceUrl: () => ipcRenderer.invoke("dictation:service-url"),
    insert: (payload) => ipcRenderer.invoke("dictation:insert", payload),
    ensurePermissions: () => ipcRenderer.invoke("dictation:ensure-permissions"),
    ensureCamera: () => ipcRenderer.invoke("dictation:ensure-camera"),
    openMicrophoneSettings: () => ipcRenderer.invoke("dictation:open-microphone-settings"),
    openCameraSettings: () => ipcRenderer.invoke("dictation:open-camera-settings"),
    onTrigger: (callback) => subscribe("dictation:trigger", callback),
    onAction: (callback) => subscribe("dictation:action", callback),
  },
  companion: {
    toggle: () => ipcRenderer.invoke("companion:toggle"),
    seeScreen: (question) => ipcRenderer.invoke("companion:see", { question }),
    ask: (text) => ipcRenderer.invoke("companion:ask", { text }),
  },
  seeScreen: (question) => ipcRenderer.invoke("desktop:see-screen", { question }),
  openCluely: {
    ensure: (payload) => ipcRenderer.invoke("opencluely:ensure", payload || {}),
    show: (payload) => ipcRenderer.invoke("opencluely:show", payload || {}),
  },
  google: {
    status: () => ipcRenderer.invoke("google:status"),
    signIn: () => ipcRenderer.invoke("google:sign-in"),
    disconnect: () => ipcRenderer.invoke("google:disconnect"),
    execute: (payload) => ipcRenderer.invoke("google:execute", payload),
    diagnostic: (payload) => ipcRenderer.invoke("google:diagnostic", payload),
    onAuthState: (callback) => subscribe("google:auth-state", callback),
    onAgentProgress: (callback) => subscribe("google:agent-progress", callback),
  },
  research: {
    execute: (payload) => ipcRenderer.invoke("research:execute", payload),
    onAgentProgress: (callback) => subscribe("research:agent-progress", callback),
  },
  terminal: {
    open: (payload) => ipcRenderer.invoke("terminal:open", payload),
    write: (payload) => ipcRenderer.invoke("terminal:write", payload),
    resize: (payload) => ipcRenderer.invoke("terminal:resize", payload),
    kill: (payload) => ipcRenderer.invoke("terminal:kill", payload),
    onData: (callback) => subscribe("terminal:data", callback),
    onExit: (callback) => subscribe("terminal:exit", callback),
  },
  selectFolder: () => ipcRenderer.invoke("dialog:select-folder"),
});
