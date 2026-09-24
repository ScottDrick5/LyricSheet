// Lyric Sheet — Mac desktop wrapper. The whole app is app/index.html (copied from www/index.html at build time).
const { app, BrowserWindow, Menu, shell, ipcMain } = require("electron");
const path = require("path");
const music = require("./music");
const updater = require("./updater");

const isMac = process.platform === "darwin";

function send(command) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send("menu-command", command);
}
const cmd = (label, accelerator, command, extra) =>
  Object.assign({ label, accelerator, click: () => send(command) }, extra || {});

// ---------- menu bar with standard Mac shortcuts ----------
function buildMenu() {
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            cmd("Settings…", "CmdOrCtrl+,", "settings"),
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        cmd("New Song", "CmdOrCtrl+N", "new-song"),
        cmd("New Folder", "Shift+CmdOrCtrl+N", "new-folder"),
        cmd("Duplicate Song", "CmdOrCtrl+D", "duplicate-song"),
        { type: "separator" },
        cmd("Import New Lyrics…", "Shift+CmdOrCtrl+V", "paste-song"),
        cmd("Copy Lyrics", "Shift+CmdOrCtrl+C", "copy-lyrics"),
        { type: "separator" },
        cmd("Sync Now", "Shift+CmdOrCtrl+S", "sync-now"),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        // the page keeps its own undo history (it redraws the lyrics as you type, which breaks the built-in one)
        cmd("Undo", "CmdOrCtrl+Z", "undo"),
        cmd("Redo", "Shift+CmdOrCtrl+Z", "redo"),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        cmd("Find Song…", "CmdOrCtrl+F", "find"),
        ...(isMac
          ? [
              { type: "separator" },
              { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
            ]
          : []),
      ],
    },
    {
      label: "Format",
      submenu: [
        cmd("Bigger", "CmdOrCtrl+=", "text-bigger"),
        cmd("Bigger", "CmdOrCtrl+Plus", "text-bigger", { visible: false, acceleratorWorksWhenHidden: true }),
        cmd("Smaller", "CmdOrCtrl+-", "text-smaller"),
        cmd("Normal Size", "CmdOrCtrl+0", "text-reset"),
        { type: "separator" },
        cmd("Bold", "CmdOrCtrl+B", "bold"),
        cmd("Italic", "CmdOrCtrl+I", "italic"),
        cmd("Underline", "CmdOrCtrl+U", "underline"),
        cmd("Strikethrough", "CmdOrCtrl+Shift+X", "strikethrough"),
        {
          label: "Highlight",
          submenu: [
            { label: "Yellow", click: () => send("highlight-yellow") },
            { label: "Green", click: () => send("highlight-green") },
            { label: "Blue", click: () => send("highlight-blue") },
            { label: "Pink", click: () => send("highlight-pink") },
            { label: "Orange", click: () => send("highlight-orange") },
            { type: "separator" },
            { label: "No Highlight", click: () => send("highlight-none") },
          ],
        },
        { type: "separator" },
        { label: "Select words first to style or resize just those words; otherwise the whole sheet changes size.", enabled: false },
      ],
    },
    {
      label: "View",
      submenu: [
        cmd("Write", "CmdOrCtrl+1", "mode-basic"),
        cmd("Sections", "CmdOrCtrl+2", "mode-advanced"),
        { type: "separator" },
        cmd("Songs as List", "Alt+CmdOrCtrl+1", "view-list"),
        cmd("Songs as Gallery", "Alt+CmdOrCtrl+2", "view-gallery"),
        { type: "separator" },
        cmd("Show / Hide Top Bar", "Shift+CmdOrCtrl+H", "toggle-bar"),
        cmd("Customize Top Bar…", undefined, "customize-bar"),
        cmd("Version History", "CmdOrCtrl+Y", "history"),
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "toggleDevTools", label: "Developer Tools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- right-click menu ----------
function attachContextMenu(win) {
  win.webContents.on("context-menu", (_event, p) => {
    const items = [];
    const hasSelection = !!(p.selectionText && p.selectionText.trim());

    if (p.misspelledWord) {
      const guesses = (p.dictionarySuggestions || []).slice(0, 6);
      if (guesses.length) {
        guesses.forEach((g) => items.push({ label: g, click: () => win.webContents.replaceMisspelling(g) }));
      } else {
        items.push({ label: "No Guesses Found", enabled: false });
      }
      items.push({ label: "Learn Spelling", click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: "separator" });
    }

    if (hasSelection) {
      const shown = p.selectionText.trim().length > 24 ? p.selectionText.trim().slice(0, 24) + "…" : p.selectionText.trim();
      if (isMac) items.push({ label: `Look Up “${shown}”`, click: () => win.webContents.showDefinitionForSelection() });
      items.push({ label: "Search with Google", click: () => shell.openExternal("https://www.google.com/search?q=" + encodeURIComponent(p.selectionText.trim())) });
      items.push({ type: "separator" });
    }

    if (p.isEditable) {
      items.push(
        { role: "cut", enabled: p.editFlags.canCut },
        { role: "copy", enabled: p.editFlags.canCopy },
        { role: "paste", enabled: p.editFlags.canPaste },
        { role: "pasteAndMatchStyle", enabled: p.editFlags.canPaste },
        { role: "selectAll", enabled: p.editFlags.canSelectAll }
      );
      if (hasSelection) {
        items.push({ type: "separator" });
        items.push({
          label: "Text Size",
          submenu: [
            { label: "Bigger", accelerator: "CmdOrCtrl+=", click: () => send("text-bigger") },
            { label: "Smaller", accelerator: "CmdOrCtrl+-", click: () => send("text-smaller") },
            { label: "Normal Size", accelerator: "CmdOrCtrl+0", click: () => send("text-reset") },
          ],
        });
        items.push({
          label: "Style",
          submenu: [
            { label: "Bold", accelerator: "CmdOrCtrl+B", click: () => send("bold") },
            { label: "Italic", accelerator: "CmdOrCtrl+I", click: () => send("italic") },
            { label: "Underline", accelerator: "CmdOrCtrl+U", click: () => send("underline") },
            { label: "Strikethrough", accelerator: "CmdOrCtrl+Shift+X", click: () => send("strikethrough") },
          ],
        });
        items.push({
          label: "Highlight",
          submenu: [
            { label: "Yellow", click: () => send("highlight-yellow") },
            { label: "Green", click: () => send("highlight-green") },
            { label: "Blue", click: () => send("highlight-blue") },
            { label: "Pink", click: () => send("highlight-pink") },
            { label: "Orange", click: () => send("highlight-orange") },
            { type: "separator" },
            { label: "No Highlight", click: () => send("highlight-none") },
          ],
        });
      }
      if (isMac && hasSelection) {
        items.push({ type: "separator" });
        items.push({ label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] });
      }
    } else if (hasSelection) {
      items.push({ role: "copy" }, { role: "selectAll" });
    } else {
      items.push({ role: "selectAll" });
    }

    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: "Lyric Sheet",
    backgroundColor: "#16181C",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.loadFile(path.join(__dirname, "app", "index.html"));
  // Any outside link opens in the normal browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  attachContextMenu(win);
}

// Music / Spotify controls for the page (Mac only; see music.js)
ipcMain.handle("music", (_event, method, options) => {
  if (!isMac) throw new Error("Music controls are only available on the Mac");
  const allowed = ["getState", "requestAccess", "play", "pause", "next", "previous", "seek", "setRepeat"];
  if (allowed.indexOf(method) === -1) throw new Error("Unknown music command");
  return music.call(method, options);
});

// Settings > Updates (see updater.js)
ipcMain.handle("updates", (_event, action) => {
  if (action === "version") return app.getVersion();
  if (action === "check") return updater.check();
  if (action === "install") return updater.install();
  throw new Error("Unknown update action");
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
