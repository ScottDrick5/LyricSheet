// Lets the Mac menu bar and right-click menu send commands to the page, and the page use the
// Music / Spotify controls, check for updates, save backup files, share lyrics and read Apple Notes for importing (nothing else is exposed).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyricDesktop", {
  onCommand: (callback) => {
    ipcRenderer.on("menu-command", (_event, command) => callback(command));
  },
  platform: process.platform,
  music: (method, options) => ipcRenderer.invoke("music", method, options || {}),
  updates: (action) => ipcRenderer.invoke("updates", action),
  saveFile: (name, text) => ipcRenderer.invoke("save-file", name, text),
  notes: (action, arg) => ipcRenderer.invoke("notes", action, arg),
  share: (text) => ipcRenderer.invoke("share", text),
});
