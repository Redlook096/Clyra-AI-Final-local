const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clyraSmartToolbar", {
  onState(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("smart-toolbar:state", listener);
    return () => ipcRenderer.removeListener("smart-toolbar:state", listener);
  },
  action(action, value) {
    ipcRenderer.send("smart-toolbar:action", { action, value });
  },
});
