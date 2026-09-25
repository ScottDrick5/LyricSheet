// File > Import from Apple Notes (Mac only): reads folders and notes from the Notes app through
// AppleScript, like music.js does for Music and Spotify. The first call makes macOS ask
// "Lyric Sheet wants to control Notes". Notes are only read, never changed.
const { execFile } = require("child_process");

const RS = String.fromCharCode(30), US = String.fromCharCode(31);   // record / field separators

function osa(lines, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", lines.join("\n")].concat(args || []),
      { timeout: timeout || 120000, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || "");
          if (/-1743|not allowed|Not authorized/i.test(msg)) {
            return reject(new Error("Lyric Sheet isn't allowed to read Notes. Turn it on in System Settings › Privacy & Security › Automation › Lyric Sheet › Notes, then try again."));
          }
          return reject(new Error(msg.replace(/^\d+:\d+: execution error: /, "").trim() || "Couldn't read Notes"));
        }
        resolve(String(stdout));
      });
  });
}

// Every folder (with subfolders), as { id, account, name, path, count }. Depending on the macOS version
// an account's folder list may already include subfolders, so repeats are dropped by id below.
async function folders() {
  const out = await osa([
    "global out, RS, US",
    "on addFolder(f, prefix, acct)",
    "  global out, RS, US",
    "  tell application \"Notes\"",
    "    set p to prefix & (name of f)",
    "    set out to out & acct & US & p & US & (name of f) & US & (id of f) & US & (count of notes of f) & RS",
    "    repeat with sub in folders of f",
    "      my addFolder(sub, p & \" / \", acct)",
    "    end repeat",
    "  end tell",
    "end addFolder",
    "set RS to character id 30",
    "set US to character id 31",
    "set out to \"\"",
    "tell application \"Notes\"",
    "  repeat with a in accounts",
    "    set acct to name of a",
    "    repeat with f in folders of a",
    "      my addFolder(f, \"\", acct)",
    "    end repeat",
    "  end repeat",
    "end tell",
    "return out",
  ]);
  const seen = {};
  return out.split(RS).filter((r) => r.trim()).map((r) => {
    const f = r.split(US);
    return { account: f[0], path: f[1], name: f[2], id: f[3], count: parseInt(f[4], 10) || 0 };
  }).filter((f) => {
    if (!f.id || seen[f.id] || /^recently deleted$/i.test(f.name)) return false;
    seen[f.id] = true;
    return true;
  });
}

// The notes in one folder: { id, name, html, created, modified, locked }. Dates are sent as
// seconds from now (so they don't depend on the Mac's date format) and turned into times here.
async function notesIn(folderId) {
  const now = Date.now();
  const out = await osa([
    "on run argv",
    "  set RS to character id 30",
    "  set US to character id 31",
    "  set nowD to current date",
    "  set out to \"\"",
    "  tell application \"Notes\"",
    "    set f to folder id (item 1 of argv)",
    "    repeat with n in notes of f",
    "      set locked to password protected of n",
    "      if locked then",
    "        set b to \"\"",
    "      else",
    "        set b to body of n",
    "      end if",
    "      set out to out & (id of n) & US & (name of n) & US & ((creation date of n) - nowD) & US & ((modification date of n) - nowD) & US & locked & US & b & RS",
    "    end repeat",
    "  end tell",
    "  return out",
    "end run",
  ], [String(folderId)], 600000);
  return out.split(RS).filter((r) => r.trim()).map((r) => {
    const f = r.split(US);
    return {
      id: f[0], name: f[1],
      created: now + (parseFloat(f[2]) || 0) * 1000,
      modified: now + (parseFloat(f[3]) || 0) * 1000,
      locked: f[4] === "true",
      html: f.slice(5).join(US),
    };
  });
}

async function call(action, arg) {
  if (action === "folders") return folders();
  if (action === "notes") return notesIn(arg);
  throw new Error("Unknown Notes action");
}

module.exports = { call };
