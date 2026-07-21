const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clyraDictationPill", {
  onState(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("dictation:pill-state", listener);
    return () => ipcRenderer.removeListener("dictation:pill-state", listener);
  },
  action(action) {
    ipcRenderer.send("dictation:pill-action", action);
  },
});
