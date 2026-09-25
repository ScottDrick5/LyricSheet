// Compares Lyric Sheet's rhyme highlights with Rhymers Block's on songs copied from screen recordings.
// Each song file lists stanzas of lines; words in UPPERCASE are the ones Rhymers Block highlights.
//   node tools/rhyme-check/check.js
const fs = require("fs"), path = require("path");
global.window = {};
require("../../www/rhymes.js");
const src = fs.readFileSync(path.join(__dirname, "../../www/index.html"), "utf8");
const code = src.slice(src.indexOf("  // ---------- Rhymes ----------"), src.indexOf("  function rhymeFinderOn()"));
function stripParentheticals(l) { let p; do { p = l; l = l.replace(/\([^()]*\)/g, " "); } while (l !== p); return l; }
eval(code);
const dict = buildRhymeDict(window.LYRIC_RHYMES);
fs.readdirSync(__dirname).filter((f) => f !== "check.js" && f.endsWith(".js")).forEach((f) => {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  require(path.join(__dirname, f)).forEach((st) => {
    const res = analyzeRhymes(dict, [st]);
    st.forEach((line, li) => {
      lineWords(line, true).forEach((w) => {
        if (!w.word || SOUND_SKIP[w.word] || !pronOf(dict, w.word)) return;
        const raw = line.slice(w.start, w.end);
        const theirs = /[A-Z]/.test(raw) && raw === raw.toUpperCase() && raw.length > 1;
        const ours = res[0][li].boxes.some((b) => b.start === w.start);
        if (ours && theirs) tp++; else if (ours) fp++; else if (theirs) fn++; else tn++;
      });
    });
  });
  console.log(f + ": Rhymers Block highlights " + (tp + fn) + ", Lyric Sheet " + (tp + fp) +
    ", same call on " + ((tp + tn) / (tp + fp + fn + tn) * 100).toFixed(1) + "% of " + (tp + fp + fn + tn) + " words");
});
