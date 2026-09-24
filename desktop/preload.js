// Lets the Mac menu bar and right-click menu send commands to the page, and the page use the
// Music / Spotify controls (nothing else is exposed).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyricDesktop", {
  onCommand: (callback) => {
    ipcRenderer.on("menu-command", (_event, command) => callback(command));
  },
  platform: process.platform,
  music: (method, options) => ipcRenderer.invoke("music", method, options || {}),
});
