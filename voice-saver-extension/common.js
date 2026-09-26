// Shared helpers for the content scripts (all content scripts share one isolated world per page).

const AVS_SITE = /claude\.ai$/.test(location.hostname) ? 'claude' : 'chatgpt';

async function avsSettings() {
  try {
    return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  } catch {
    return { ...DEFAULTS };
  }
}

// The voice currently chosen in the popup for this site (custom name if "Custom…" was picked).
async function avsVoice(site = AVS_SITE) {
  const s = await avsSettings();
  const pick = s[site + 'Voice'];
  if (pick === 'custom') return (s[site + 'CustomVoice'] || '').trim() || 'custom';
  return pick;
}

function avsStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function avsSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'voice';
}

function avsFilename(site, voice, ext, suffix = '') {
  return `${site}-${avsSlug(voice)}-${avsStamp()}${suffix ? '-' + suffix : ''}.${ext}`;
}

function avsExtForType(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('aac')) return 'aac';
  if (t.includes('mp4') || t.includes('m4a')) return 'm4a';
  if (t.includes('ogg') || t.includes('opus')) return 'ogg';
  if (t.includes('webm')) return 'webm';
  if (t.includes('wav') || t.includes('wave')) return 'wav';
  if (t.includes('flac')) return 'flac';
  return 'audio';
}

function avsDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  (document.body || document.documentElement).appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function avsToast(text, isError = false) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText =
    'position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);' +
    'padding:10px 16px;border-radius:10px;font:14px/1.3 system-ui,sans-serif;color:#fff;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:80vw;' +
    (isError ? 'background:#b3261e;' : 'background:#1f1f1f;');
  (document.body || document.documentElement).appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 2500);
}
