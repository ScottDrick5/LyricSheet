// "Check for updates" for the Mac app. Looks at the latest GitHub Release of the (public) repo,
// and if it's newer than this app, downloads LyricSheet-mac.zip, unzips it, and swaps the app in
// place after this one quits, then opens the new version.
const { app } = require("electron");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const REPO = "ScottDrick5/LyricSheet";
const ASSET = "LyricSheet-mac.zip";
let latest = null; // the release found by the last check

function get(url, asFile, redirects) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "LyricSheet-updater", Accept: asFile ? "application/octet-stream" : "application/vnd.github+json" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 5) {
        res.resume();
        return resolve(get(res.headers.location, asFile, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("GitHub answered " + res.statusCode)); }
      if (asFile) {
        const out = fs.createWriteStream(asFile);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve(asFile)));
        out.on("error", reject);
      } else {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { body += d; });
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("GitHub didn't answer in time")));
  });
}

// 1.2.10 > 1.2.9
function newer(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function check() {
  const current = app.getVersion();
  const rel = await get(`https://api.github.com/repos/${REPO}/releases/latest`);
  const version = String(rel.tag_name || "").replace(/^v/, "");
  const asset = (rel.assets || []).find((a) => a.name === ASSET);
  latest = asset ? { version, url: asset.browser_download_url } : null;
  return {
    current,
    latest: version,
    available: !!asset && newer(version, current),
    page: rel.html_url,
    notes: rel.body || ""
  };
}

function run(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, (err) => (err ? reject(err) : resolve())));
}

// The .app bundle this copy is running from
function currentBundle() {
  let p = process.execPath;
  while (p !== "/" && !p.endsWith(".app")) p = path.dirname(p);
  return p.endsWith(".app") ? p : null;
}

async function install() {
  if (!app.isPackaged) throw new Error("Updates only work in the built app.");
  if (!latest) await check();
  if (!latest) throw new Error("The latest release doesn't have a Mac app yet.");
  const dest = currentBundle();
  if (!dest) throw new Error("Couldn't find where Lyric Sheet is installed.");
  if (dest.includes("/AppTranslocation/")) {
    throw new Error("Move Lyric Sheet to your Applications folder first (drag it there from Downloads), open it from there, then try again.");
  }
  try { fs.accessSync(path.dirname(dest), fs.constants.W_OK); }
  catch (e) { throw new Error("Lyric Sheet can't replace itself in " + path.dirname(dest) + ". Download the new version from the release page instead."); }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lyricsheet-update-"));
  const zip = path.join(work, ASSET);
  await get(latest.url, zip);
  const unpacked = path.join(work, "new");
  await run("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
  const found = fs.readdirSync(unpacked).find((n) => n.endsWith(".app"));
  if (!found) throw new Error("The download didn't contain the app.");
  const fresh = path.join(unpacked, found);

  // After this app quits: swap the bundles (putting the old one back if anything fails), then open the new one.
  const script = path.join(work, "swap.sh");
  fs.writeFileSync(script, [
    "#!/bin/bash",
    'PID="$1"; DEST="$2"; NEW="$3"',
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done',
    'rm -rf "$DEST.old"',
    'if mv "$DEST" "$DEST.old" && /usr/bin/ditto "$NEW" "$DEST"; then',
    '  rm -rf "$DEST.old"',
    "else",
    '  rm -rf "$DEST"; mv "$DEST.old" "$DEST"',
    "fi",
    'xattr -dr com.apple.quarantine "$DEST" 2>/dev/null',
    'open "$DEST"',
    ""
  ].join("\n"), { mode: 0o755 });
  spawn("/bin/bash", [script, String(process.pid), dest, fresh], { detached: true, stdio: "ignore" }).unref();
  setTimeout(() => app.quit(), 300);
  return { installing: latest.version };
}

module.exports = { check, install };
