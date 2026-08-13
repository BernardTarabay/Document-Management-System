// The only bridge between the sandboxed renderer and the privileged main
// process. Every channel is listed explicitly -- the renderer can call
// exactly these five things and nothing else. No generic "invoke(channel)"
// escape hatch, because that would hand the renderer the whole IPC surface
// and defeat contextIsolation.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentApi", {
  getStatus: () => ipcRenderer.invoke("agent:getStatus"),
  saveConfig: (patch) => ipcRenderer.invoke("agent:saveConfig", patch),
  connect: () => ipcRenderer.invoke("agent:connect"),
  disconnect: () => ipcRenderer.invoke("agent:disconnect"),
  chooseDirectory: () => ipcRenderer.invoke("agent:chooseDirectory"),

  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent:event", listener);
    // Returning an unsubscribe keeps the renderer from accumulating
    // listeners across re-renders.
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
});
