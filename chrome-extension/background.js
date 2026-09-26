// Service worker: owns the recording state, creates the offscreen document that
// does the actual capture + encoding, and saves finished files via chrome.downloads.

const OFFSCREEN_URL = 'offscreen.html';

const DEFAULT_SETTINGS = {
  format: 'mp3',        // 'mp3' | 'wav' | 'both'
  bitrate: 192,         // MP3 kbps
  keepPlaying: true,    // keep the tab audible while recording
  includeMic: false,    // mix the microphone in
  autoStopMinutes: 0,   // 0 = never
  folder: 'Audio Grabber',
  saveAs: false         // ask where to save each file
};

// downloadId -> true, for files still being written to disk
const pendingDownloads = new Set();

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return state || { recording: false };
}

async function setState(state) {
  await chrome.storage.session.set({ state });
  await updateBadge(state);
}

async function updateBadge(state) {
  if (state.recording) {
    await chrome.action.setBadgeBackgroundColor({ color: state.paused ? '#8a8a8a' : '#e5372c' });
    await chrome.action.setBadgeText({ text: state.paused ? 'II' : 'REC' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio and encode it to MP3 / WAV'
  });
}

async function closeOffscreenIfIdle() {
  const state = await getState();
  if (state.recording || pendingDownloads.size) return;
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

async function startRecording(tabId) {
  const state = await getState();
  if (state.recording) throw new Error('Already recording. Stop the current recording first.');

  const tab = await chrome.tabs.get(tabId);
  if (/^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url || '')) {
    throw new Error("Chrome doesn't allow recording its own pages. Switch to a normal website tab.");
  }

  const settings = await getSettings();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await ensureOffscreen();
  const res = await sendToOffscreen({ type: 'start', streamId, settings });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start recording.');

  await setState({
    recording: true,
    paused: false,
    tabId,
    title: tab.title || 'Recording',
    startedAt: Date.now(),
    warning: res.warning || ''
  });
  return { ok: true, warning: res.warning || '' };
}

async function stopRecording() {
  const state = await getState();
  if (!state.recording) return { ok: true };
  // The offscreen page sends back one 'save' message per file, then replies here.
  const res = await sendToOffscreen({ type: 'stop' }).catch(() => null);
  await setState({ recording: false });
  await closeOffscreenIfIdle();
  return res && res.ok === false ? res : { ok: true };
}

async function togglePause() {
  const state = await getState();
  if (!state.recording) return { ok: false };
  const paused = !state.paused;
  await sendToOffscreen({ type: paused ? 'pause' : 'resume' });
  await setState({ ...state, paused });
  return { ok: true, paused };
}

function sanitize(name) {
  return name
    .replace(/[\\/:*?"<>|~\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100) || 'Recording';
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function saveFile({ url, ext }) {
  const settings = await getSettings();
  const state = await getState();
  const title = sanitize(state.title || 'Recording');
  const folder = settings.folder ? sanitize(settings.folder) : '';
  const base = `${title} ${stamp(new Date())}.${ext}`;
  const filename = folder ? `${folder}/${base}` : base;

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: !!settings.saveAs,
    conflictAction: 'uniquify'
  });
  pendingDownloads.add(downloadId);

  const { recent = [] } = await chrome.storage.local.get('recent');
  recent.unshift({ downloadId, name: base, at: Date.now() });
  await chrome.storage.local.set({ recent: recent.slice(0, 10) });
  return downloadId;
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!pendingDownloads.has(delta.id) || !delta.state) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    pendingDownloads.delete(delta.id);
    await closeOffscreenIfIdle();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return false;

  const handlers = {
    getState: async () => ({ state: await getState(), settings: await getSettings() }),
    saveSettings: async () => {
      await chrome.storage.local.set({ settings: { ...(await getSettings()), ...msg.settings } });
      return { ok: true };
    },
    start: () => startRecording(msg.tabId),
    stop: stopRecording,
    togglePause,
    // From the offscreen page:
    save: () => saveFile(msg),
    ended: async () => {
      // Tab closed / auto-stop hit: offscreen already saved the files.
      const state = await getState();
      if (state.recording) await setState({ recording: false });
      await closeOffscreenIfIdle();
      return { ok: true };
    }
  };

  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(handler)
    .then(sendResponse, (err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  const state = await getState();
  if (state.recording) return stopRecording();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) startRecording(tab.id).catch((err) => console.warn('Audio Grabber:', err.message));
});

// Service worker restarted after a browser restart: nothing can still be recording.
chrome.runtime.onStartup.addListener(() => setState({ recording: false }));
