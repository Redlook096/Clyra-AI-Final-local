const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("clyraCompanion", {
  getState: () => ipcRenderer.invoke("companion:get-state"),
  show: () => ipcRenderer.invoke("companion:show"),
  hide: () => ipcRenderer.invoke("companion:hide"),
  ask: (text) => ipcRenderer.invoke("companion:ask", { text }),
  seeScreen: (question) => ipcRenderer.invoke("companion:see", { question }),
  startControl: () => ipcRenderer.invoke("companion:start-control"),
  takeManualControl: () => ipcRenderer.invoke("companion:take-control"),
  resumeAi: () => ipcRenderer.invoke("companion:resume"),
  stopControl: () => ipcRenderer.invoke("companion:stop"),
  runAction: (action) => ipcRenderer.invoke("companion:action", { action }),
  onState: (callback) => subscribe("companion:state", callback),
});
