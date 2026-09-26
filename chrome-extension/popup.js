const $ = (id) => document.getElementById(id);

const bg = (type, extra = {}) => chrome.runtime.sendMessage({ target: 'background', type, ...extra });

let activeTab = null;
let state = { recording: false };
let pollTimer = null;

function fmtTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function showMessage(text, kind = 'error') {
  const el = $('message');
  el.textContent = text;
  el.className = 'message' + (kind === 'info' ? ' info' : '');
  el.hidden = !text;
}

function render() {
  const rec = state.recording;
  $('recordBtn').classList.toggle('on', rec);
  $('recordText').textContent = rec ? 'Stop & Save' : 'Record';
  $('pauseBtn').hidden = !rec;
  $('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
  $('settings').classList.toggle('locked', rec);
  $('sourceLabel').textContent = rec ? 'Recording' : 'Source';
  $('tabTitle').textContent = rec ? state.title : (activeTab ? activeTab.title : '—');
  if (!rec) {
    $('time').textContent = '00:00';
    $('meterFill').style.width = '0%';
  }
  if (rec && !pollTimer) pollTimer = setInterval(poll, 100);
  if (!rec && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function poll() {
  const s = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' }).catch(() => null);
  if (!s || !s.recording) {
    // Stopped elsewhere (tab closed, auto-stop, keyboard shortcut).
    await refresh();
    return;
  }
  $('time').textContent = fmtTime(s.seconds);
  // Log-ish scale so quiet audio still moves the meter.
  const db = 20 * Math.log10(Math.max(s.level, 1e-5));
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  $('meterFill').style.width = (state.paused ? 0 : pct) + '%';
}

function applySettings(settings) {
  document.querySelectorAll('#format button').forEach((b) => b.classList.toggle('sel', b.dataset.v === settings.format));
  $('bitrateRow').hidden = settings.format === 'wav';
  $('bitrate').value = String(settings.bitrate);
  $('keepPlaying').checked = settings.keepPlaying;
  $('includeMic').checked = settings.includeMic;
  $('autoStopMinutes').value = String(settings.autoStopMinutes);
  $('folder').value = settings.folder;
  $('saveAs').checked = settings.saveAs;
}

async function save(patch) {
  await bg('saveSettings', { settings: patch });
  const { settings } = await bg('getState');
  applySettings(settings);
}

async function renderRecent() {
  const { recent = [] } = await chrome.storage.local.get('recent');
  const list = $('recentList');
  list.textContent = '';
  if (!recent.length) {
    list.innerHTML = '<li class="empty">Nothing yet</li>';
    return;
  }
  for (const r of recent) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = r.name;
    a.title = 'Show in folder';
    a.onclick = (e) => { e.preventDefault(); chrome.downloads.show(r.downloadId); };
    li.appendChild(a);
    list.appendChild(li);
  }
}

async function refresh() {
  const res = await bg('getState');
  state = res.state;
  applySettings(res.settings);
  render();
  renderRecent();
}

$('recordBtn').onclick = async () => {
  $('recordBtn').disabled = true;
  showMessage('');
  try {
    if (state.recording) {
      const res = await bg('stop');
      if (res && res.ok === false) showMessage(res.error);
      else showMessage('Saved to your Downloads folder.', 'info');
    } else {
      if (!activeTab) throw new Error('No tab to record.');
      const res = await bg('start', { tabId: activeTab.id });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start recording.');
      if (res.warning) showMessage(res.warning);
    }
  } catch (err) {
    showMessage(err.message);
  }
  $('recordBtn').disabled = false;
  await refresh();
};

$('pauseBtn').onclick = async () => {
  await bg('togglePause');
  await refresh();
};

document.querySelectorAll('#format button').forEach((b) => {
  b.onclick = () => save({ format: b.dataset.v });
});
$('bitrate').onchange = (e) => save({ bitrate: Number(e.target.value) });
$('keepPlaying').onchange = (e) => save({ keepPlaying: e.target.checked });
$('includeMic').onchange = (e) => save({ includeMic: e.target.checked });
$('autoStopMinutes').onchange = (e) => save({ autoStopMinutes: Number(e.target.value) });
$('folder').onchange = (e) => save({ folder: e.target.value.trim() });
$('saveAs').onchange = (e) => save({ saveAs: e.target.checked });

$('micSetup').onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
};
$('openFolder').onclick = (e) => {
  e.preventDefault();
  chrome.downloads.showDefaultFolder();
};

chrome.storage.onChanged.addListener((changes) => {
  if (changes.recent) renderRecent();
});

(async () => {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
})();
