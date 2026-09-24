// Lets the Mac menu bar and right-click menu send commands to the page (nothing else is exposed).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyricDesktop", {
  onCommand: (callback) => {
    ipcRenderer.on("menu-command", (_event, command) => callback(command));
  },
});
