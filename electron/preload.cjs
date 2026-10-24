const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sundayDesktop", {
  isDesktop: true,
  onSummon(cb) {
    const handler = () => cb();
    ipcRenderer.on("sunday:summon", handler);
    return () => ipcRenderer.removeListener("sunday:summon", handler);
  },
  onLock(cb) {
    const handler = () => cb();
    ipcRenderer.on("sunday:lock", handler);
    return () => ipcRenderer.removeListener("sunday:lock", handler);
  },
  onUnlock(cb) {
    const handler = () => cb();
    ipcRenderer.on("sunday:unlock", handler);
    return () => ipcRenderer.removeListener("sunday:unlock", handler);
  },
  minimize: () => ipcRenderer.send("win:minimize"),
  hide: () => ipcRenderer.send("win:hide"),
  toggleFullscreen: () => ipcRenderer.send("win:fullscreen"),
  getAutoStart: () => ipcRenderer.invoke("autostart:get"),
  setAutoStart: (on) => ipcRenderer.invoke("autostart:set", Boolean(on)),
});
