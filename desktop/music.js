// Music controls for the Mac app: reads and controls the Music app or Spotify through AppleScript
// (both apps are scriptable). The page calls this through the "music" IPC channel with the same
// methods as the iPhone app's MusicControl add-on: getState, requestAccess, play, pause, next,
// previous, seek. The first call makes macOS ask "Lyric Sheet wants to control Music/Spotify".
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APPS = ["Music", "Spotify"];
let current = null; // the app the bar is showing (and that the buttons control)
let lastUsed = "Music";

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeout || 5000 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ""); reject(err); } else resolve(String(stdout).trim());
    });
  });
}
function osa(lines, args) { return run("osascript", ["-e", lines.join("\n")].concat(args || [])); }

// Only talk to apps that are already open: telling a closed app anything would launch it.
async function isRunning(name) {
  try { await run("pgrep", ["-xq", name], 2000); return true; } catch (e) { return false; }
}
function num(s) { const n = parseFloat(String(s || "").replace(",", ".")); return isFinite(n) ? n : 0; }
function notAllowed(err) { return /-1743|not allowed|Not authorized/i.test((err && (err.stderr || err.message)) || ""); }

// state + current track, tab separated
async function readApp(name) {
  const durExpr = name === "Spotify" ? "((duration of t) / 1000)" : "(duration of t)";
  const idExpr = name === "Spotify" ? "(id of t)" : "(persistent ID of t)";
  // Music: song repeat is off / one / all. Spotify only has repeating on or off.
  const repeatExpr = name === "Spotify" ? "(repeating as text)" : "(song repeat as text)";
  const out = await osa([
    `tell application "${name}"`,
    "  set ps to (player state as text)",
    "  if ps is \"stopped\" then return ps",
    "  set t to current track",
    `  return ps & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & ${durExpr} & tab & (player position) & tab & ${idExpr} & tab & ${repeatExpr}`,
    "end tell"
  ]);
  const f = out.split("\t");
  return { app: name, state: f[0], title: f[1] || "", artist: f[2] || "", album: f[3] || "",
           duration: num(f[4]), position: num(f[5]), id: f[6] ? name + ":" + f[6] : "",
           repeat: name === "Spotify" ? (f[7] === "true" ? "all" : "off") : (/^(one|all)$/.test(f[7] || "") ? f[7] : "off") };
}

async function artwork(name) {
  if (name === "Spotify") {
    try { return await osa(['tell application "Spotify" to return artwork url of current track']); } catch (e) { return ""; }
  }
  const file = path.join(os.tmpdir(), "lyricsheet-artwork");
  try {
    await osa([
      "on run argv",
      '  tell application "Music" to set d to raw data of artwork 1 of current track',
      "  set f to open for access (POSIX file (item 1 of argv)) with write permission",
      "  set eof f to 0",
      "  write d to f",
      "  close access f",
      "end run"
    ], [file]);
    const buf = fs.readFileSync(file);
    const type = buf[0] === 0x89 ? "image/png" : "image/jpeg";
    return "data:" + type + ";base64," + buf.toString("base64");
  } catch (e) { return ""; }
}

async function getState(opts) {
  const running = [];
  for (const a of APPS) if (await isRunning(a)) running.push(a);
  const infos = [];
  for (const a of running) {
    try { infos.push(await readApp(a)); }
    catch (e) { if (notAllowed(e)) return { access: "denied", app: a }; }
  }
  // show whichever is playing; otherwise the one used last; otherwise any open one
  const pick = infos.find((i) => i.state === "playing")
    || infos.find((i) => i.app === lastUsed)
    || infos[0];
  current = pick ? pick.app : null;
  if (!pick) return { access: "authorized", playing: false };
  lastUsed = pick.app;
  const res = { access: "authorized", app: pick.app, playing: pick.state === "playing" };
  if (pick.state !== "stopped" && pick.title) {
    Object.assign(res, { id: pick.id, title: pick.title, artist: pick.artist, album: pick.album,
                         duration: pick.duration, position: pick.position, repeat: pick.repeat,
                         repeatModes: pick.app === "Spotify" ? ["off", "all"] : ["off", "all", "one"] });
    if (opts && opts.artwork) res.artwork = await artwork(pick.app);
  }
  return res;
}

function target() { return current || lastUsed || "Music"; }

async function command(method, opts) {
  const a = target();
  // Music's "back track" is its ⏮ button: back to the start of the song, or to the previous one
  const verbs = { play: "play", pause: "pause", next: "next track", previous: a === "Music" ? "back track" : "previous track" };
  if (method === "setRepeat") {
    const mode = (opts && opts.mode) || "off";
    if (a === "Spotify") return osa([`tell application "Spotify" to set repeating to ${mode === "off" ? "false" : "true"}`]);
    const value = mode === "one" ? "one" : mode === "all" ? "all" : "off";
    return osa([`tell application "Music" to set song repeat to ${value}`]);
  }
  if (method === "seek") {
    // whole seconds: a decimal point would be misread on Macs set to a decimal-comma language
    const pos = Math.max(0, Math.round(Number(opts && opts.position) || 0));
    return osa(["on run argv", `  tell application "${a}" to set player position to ((item 1 of argv) as integer)`, "end run"], [String(pos)]);
  }
  if (verbs[method]) return osa([`tell application "${a}" to ${verbs[method]}`]);
  throw new Error("Unknown music command: " + method);
}

async function call(method, opts) {
  if (method === "getState") return getState(opts || {});
  if (method === "requestAccess") return getState({});  // macOS asks on the first real request
  await command(method, opts || {});
  return {};
}

module.exports = { call };
