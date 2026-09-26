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
  saveAs: false,        // ask where to save each file
  splitOnSilence: false, // save each song as its own file
  silenceSeconds: 2,     // this much quiet ends a song
  silenceDb: -50,        // anything quieter than this counts as silence
  endAfterSilenceMinutes: 2 // stop the whole recording when nothing plays this long (0 = never)
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
    muted: !settings.keepPlaying,
    split: !!settings.splitOnSilence,
    tabId,
    title: tab.title || 'Recording',
    startedAt: Date.now(),
    warning: res.warning || ''
  });
  await startSongWatch(tabId);
  return { ok: true, warning: res.warning || '' };
}

async function stopRecording() {
  const state = await getState();
  if (!state.recording) return { ok: true };
  // The offscreen page sends back one 'save' message per file, then replies here.
  const res = await sendToOffscreen({ type: 'stop' }).catch(() => null);
  chrome.tabs.sendMessage(state.tabId, { type: 'songwatch-stop' }).catch(() => {});
  await setState({ recording: false });
  await closeOffscreenIfIdle();
  return res || { ok: true };
}

async function toggleMute() {
  const state = await getState();
  if (!state.recording) return { ok: false };
  const muted = !state.muted;
  await sendToOffscreen({ type: 'setMuted', muted });
  await setState({ ...state, muted });
  return { ok: true, muted };
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

// "(3) Song name - YouTube" -> "Song name"
function cleanTitle(title) {
  return (title || '')
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s+[-|•]\s+(Suno|YouTube|YouTube Music|SoundCloud|Spotify|Bandcamp|Apple Music|Deezer|TIDAL)$/i, '')
    .trim();
}

async function setTrackTitle(track, title) {
  const { trackTitles = {} } = await chrome.storage.session.get('trackTitles');
  trackTitles[track] = title;
  await chrome.storage.session.set({ trackTitles });
}

// A new song file was started (split mode). Name it after what the page says is
// playing (Suno's song name, YouTube's video title...). If the page doesn't say,
// use the tab title a few seconds in, once the page has caught up.
async function noteTrackStart(track) {
  const at = Date.now();
  await chrome.storage.session.set({ lastTrack: { track, at } });
  const { nowPlaying } = await chrome.storage.session.get('nowPlaying');
  if (nowPlaying && nowPlaying.title) return setTrackTitle(track, nowPlaying.title);

  await new Promise((r) => setTimeout(r, 3000));
  const now = await chrome.storage.session.get(['nowPlaying', 'lastTrack']);
  // The page reported the song name meanwhile, or this was a blip that got
  // thrown away and a newer file has started: leave the name alone.
  if ((now.nowPlaying && now.nowPlaying.title) || !now.lastTrack || now.lastTrack.at !== at) return;
  const state = await getState();
  const tab = state.tabId && (await chrome.tabs.get(state.tabId).catch(() => null));
  if (tab) await setTrackTitle(track, tab.title);
}

// The song watcher in the recorded tab saw a new song.
async function onSong(msg, sender) {
  const state = await getState();
  if (!state.recording || !sender.tab || sender.tab.id !== state.tabId) return { keep: false };
  const { nowPlaying, lastTrack, songsSeen = 0 } =
    await chrome.storage.session.get(['nowPlaying', 'lastTrack', 'songsSeen']);
  const changed = !!nowPlaying && nowPlaying.key !== msg.key;
  const newTitle = msg.title && (!nowPlaying || nowPlaying.title !== msg.title);
  await chrome.storage.session.set({
    nowPlaying: { title: msg.title, key: msg.key },
    songsSeen: songsSeen + (newTitle ? 1 : 0)
  });
  // The audio of a new song can arrive a moment before the page reports its name.
  if (msg.title && lastTrack && Date.now() - lastTrack.at < 4000) await setTrackTitle(lastTrack.track, msg.title);
  // Cut to a new file right at the song change, even if there was no silent gap.
  if (changed && state.split) await sendToOffscreen({ type: 'songChange' }).catch(() => {});
  return { keep: true };
}

async function startSongWatch(tabId) {
  await chrome.storage.session.set({ nowPlaying: null, lastTrack: null, songsSeen: 0, trackTitles: {} });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['songwatch-relay.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['songwatch-main.js'], world: 'MAIN' });
  } catch (err) {
    console.warn('Audio Grabber: song names unavailable on this page:', err.message);
  }
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function saveFile({ url, ext, track }) {
  const settings = await getSettings();
  const state = await getState();
  const folder = settings.folder ? sanitize(settings.folder) : '';
  let base;
  let dir = folder;
  if (track) {
    // Split mode: one subfolder per session, songs numbered in play order.
    const { trackTitles = {} } = await chrome.storage.session.get('trackTitles');
    const title = sanitize(cleanTitle(trackTitles[track] || state.title) || 'Track');
    base = `${String(track).padStart(2, '0')} - ${title}.${ext}`;
    const session = `${sanitize(cleanTitle(state.title) || 'Session')} ${stamp(new Date(state.startedAt || Date.now()))}`;
    dir = folder ? `${folder}/${session}` : session;
  } else {
    // One file: if exactly one song played, name it after that song.
    const { nowPlaying, songsSeen } = await chrome.storage.session.get(['nowPlaying', 'songsSeen']);
    const name = songsSeen === 1 && nowPlaying && nowPlaying.title ? nowPlaying.title : cleanTitle(state.title);
    base = `${sanitize(name || 'Recording')} ${stamp(new Date())}.${ext}`;
  }
  const filename = dir ? `${dir}/${base}` : base;

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
    toggleMute,
    // From the offscreen page:
    save: () => saveFile(msg),
    trackStart: () => { noteTrackStart(msg.track); return { ok: true }; },
    // From the song watcher in the recorded tab:
    song: () => onSong(msg, sender),
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
