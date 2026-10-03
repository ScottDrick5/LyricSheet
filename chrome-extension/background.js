// Service worker: owns the recording state, creates the offscreen document that
// does the actual capture + encoding, and saves finished files via chrome.downloads.

const OFFSCREEN_URL = 'offscreen.html';

const DEFAULT_SETTINGS = {
  format: 'mp3',        // 'mp3' | 'wav' | 'both'
  bitrate: 192,         // MP3 kbps
  keepPlaying: true,    // keep the tab audible while recording
  includeMic: false,    // mix the microphone in
  autoStopMinutes: 0,   // 0 = never
  folder: '',           // subfolder inside Downloads ('' = straight into Downloads)
  saveAs: false,        // ask where to save each file
  splitOnSilence: false, // save each song as its own file
  silenceSeconds: 2,     // this much quiet ends a song
  silenceDb: -50,        // anything quieter than this counts as silence
  endAfterSilenceMinutes: 2, // stop the whole recording when nothing plays this long (0 = never)
  stopAtPlaylistEnd: true, // stop when the page plays a song that isn't in the playlist
  keepSilence: false,      // stems: keep silences, split only when the song changes
  useOriginal: true,       // save the page's original audio file instead of the recording, when possible
  maxSongs: 0              // stop after this many songs (0 = no limit)
};

// Older versions saved into Downloads/Audio Grabber/; files now go straight into Downloads.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'update') return;
  const { settings } = await chrome.storage.local.get('settings');
  if (settings && settings.folder === 'Audio Grabber') {
    await chrome.storage.local.set({ settings: { ...settings, folder: '' } });
  }
});

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
    reasons: ['USER_MEDIA', 'BLOBS'],
    justification: 'Capture tab audio and encode it to MP3 / WAV'
  });
}

// True while "Save exact copies" is fetching songs.
let grabbing = false;

async function closeOffscreenIfIdle() {
  const state = await getState();
  if (state.recording || grabbing || pendingDownloads.size) return;
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
  // The capture delay measured on an earlier stems recording, until this one measures it again.
  const { captureLatency = 0 } = await chrome.storage.local.get('captureLatency');
  const res = await sendToOffscreen({ type: 'start', streamId, settings: { ...settings, captureLatency } });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start recording.');

  await setState({
    recording: true,
    paused: false,
    muted: !settings.keepPlaying,
    split: !!settings.splitOnSilence,
    keepSilence: !!settings.keepSilence,
    stopAtPlaylistEnd: !!settings.stopAtPlaylistEnd,
    tabId,
    title: tab.title || 'Recording',
    startedAt: Date.now(),
    warning: res.warning || ''
  });
  await startSongWatch(tabId, !!(settings.splitOnSilence && settings.keepSilence));
  return { ok: true, warning: res.warning || '' };
}

// fromPopup: the popup shows its own message, so skip the notification.
async function stopRecording(fromPopup) {
  const state = await getState();
  if (!state.recording) return { ok: true };
  // The offscreen page sends back one 'save' message per file, then replies here.
  const res = await sendToOffscreen({ type: 'stop' }).catch(() => null);
  chrome.tabs.sendMessage(state.tabId, { type: 'songwatch-stop' }).catch(() => {});
  await setState({ recording: false });
  await closeOffscreenIfIdle();
  if (!fromPopup) await notifyDone(state, 'stopped', (res && res.saved) || 0, (res && res.exact) || 0);
  return res || { ok: true };
}

// ---- Save exact copies of the songs listed on a Suno page -------------------
//
// Suno serves every song as an MP3 at cdn1.suno.ai/<song id>.mp3, and its pages
// link each song as /song/<id>. So the originals can be downloaded directly:
// exact, original quality, nothing played or recorded.

// Runs in the page: every song linked there, with its title and cover image.
function scanSongsInPage() {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const idOf = (a) => ((a.getAttribute('href') || '').match(UUID) || [])[0];
  const unwrap = (src) => {
    try {
      const u = new URL(src, location.href);
      if (u.pathname.includes('/_next/image') && u.searchParams.get('url')) return new URL(u.searchParams.get('url'), location.href).href;
    } catch (err) {}
    return src;
  };
  const songs = new Map();
  for (const a of document.querySelectorAll('a[href*="/song/"]')) {
    const raw = idOf(a);
    if (!raw) continue;
    const id = raw.toLowerCase();
    const title = (a.getAttribute('title') || a.textContent || '').trim().replace(/\s+/g, ' ');
    // The cover: the nearest image around the link, without straying into another song's row.
    let img = '';
    for (let el = a, depth = 0; el && depth < 6 && !img; el = el.parentElement, depth++) {
      if ([...el.querySelectorAll('a[href*="/song/"]')].some((o) => (idOf(o) || '').toLowerCase() !== id)) break;
      const im = el.querySelector('img');
      if (im && (im.currentSrc || im.src)) img = unwrap(im.currentSrc || im.src);
    }
    const prev = songs.get(id);
    if (!prev) songs.set(id, { id, title: title.length < 150 ? title : '', img });
    else {
      if (!prev.title && title.length < 150) prev.title = title;
      if (!prev.img) prev.img = img;
    }
  }
  return [...songs.values()].map((s) => ({ ...s, title: s.title || 'Untitled' }));
}

// Learn where Suno's player really fetches audio from: any audio request a
// page makes whose address contains a song id becomes a pattern ("…{id}…")
// that "Save exact copies" tries first.
const SONG_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
chrome.webRequest.onCompleted.addListener(async (d) => {
  if (d.tabId < 0 || d.statusCode >= 400 || !/^https?:/.test(d.url)) return;
  const type = ((d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type') || {}).value || '';
  if (d.type !== 'media' && !/^audio\//i.test(type)) return;
  const id = (d.url.match(SONG_ID) || [])[0];
  if (!id) return;
  const pattern = d.url.split(id).join('{id}');
  const { learnedAudio = [] } = await chrome.storage.local.get('learnedAudio');
  if (learnedAudio[0] === pattern) return;
  await chrome.storage.local.set({ learnedAudio: [pattern, ...learnedAudio.filter((p) => p !== pattern)].slice(0, 5) });
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

async function scanTab(tabId) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: scanSongsInPage });
  return (res && res.result) || [];
}

async function grabSongs(songs) {
  if (grabbing) throw new Error('Already saving songs.');
  if (!songs || !songs.length) throw new Error('No songs selected.');
  grabbing = true;
  await chrome.storage.session.set({ grab: { active: true, done: 0, total: songs.length, failed: 0 } });
  await ensureOffscreen();
  const { learnedAudio = [] } = await chrome.storage.local.get('learnedAudio');
  await sendToOffscreen({ type: 'grab', songs, settings: { ...(await getSettings()), learnedAudio } });
  return { ok: true };
}

async function grabDone(msg) {
  grabbing = false;
  await chrome.storage.session.set({ grab: { active: false, done: msg.total, total: msg.total, failed: msg.failed.length, saved: msg.saved, detail: msg.detail || '' } });
  const settings = await getSettings();
  const where = settings.folder ? `Downloads/${settings.folder}` : 'Downloads';
  await notify(
    msg.saved ? 'Audio Grabber: songs saved' : 'Audio Grabber: nothing saved',
    `${msg.saved} exact cop${msg.saved === 1 ? 'y' : 'ies'} saved to ${where}.` +
      (msg.failed.length ? ` Couldn't get: ${msg.failed.slice(0, 3).join(', ')}${msg.failed.length > 3 ? '…' : ''}` : '')
  );
  await closeOffscreenIfIdle();
  return { ok: true };
}

// Desktop notification when a recording finishes, so you don't have to keep checking.
async function notifyDone(state, reason, saved, exact = 0) {
  const settings = await getSettings();
  const copies = exact ? (exact === saved ? ' (all exact copies of the originals)' : ` (${exact} exact copies of the originals)`) : '';
  const what = state.split
    ? `${saved} song${saved === 1 ? '' : 's'} saved${copies}`
    : saved ? 'Recording saved' : 'Nothing was recorded';
  const where = saved ? ` to ${settings.folder ? `Downloads/${settings.folder}` : 'Downloads'}.` : '.';
  const why = {
    playlistEnd: 'Your playlist finished.',
    songLimit: `Reached your ${settings.maxSongs}-song limit.`,
    silence: `Nothing played for ${settings.endAfterSilenceMinutes} min, so it stopped.`,
    autoStop: 'Auto-stop time reached.',
    tabClosed: 'The tab was closed.',
    stopped: 'Recording stopped.'
  }[reason] || 'Recording stopped.';
  await notify(saved ? 'Audio Grabber: done recording' : 'Audio Grabber stopped', `${why} ${what}${where}`, state.title || '');
}

// A plain notification. (Not "stay on screen until dismissed": on a Mac those go
// through a separate "Google Chrome Helper (Alerts)" app, and if that isn't
// allowed in System Settings they silently never appear.) Any error is kept so
// the popup can say why nothing showed up.
async function notify(title, message, contextMessage = '') {
  try {
    await chrome.notifications.create(`audio-grabber-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      contextMessage
    });
    await chrome.storage.local.set({ notifyError: '' });
  } catch (err) {
    await chrome.storage.local.set({ notifyError: err.message || String(err) });
  }
}

// Clicking a notification opens the Downloads folder.
chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith('audio-grabber-')) return;
  chrome.downloads.showDefaultFolder();
  chrome.notifications.clear(id);
});

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

// info: { title, artist, art: [cover image URLs to try] }
async function setTrackInfo(track, info) {
  const { trackTitles = {} } = await chrome.storage.session.get('trackTitles');
  trackTitles[track] = info;
  await chrome.storage.session.set({ trackTitles });
}

// A new song file was started (split mode). Name it after what the page says is
// playing (Suno's song name, YouTube's video title...). If the page doesn't say,
// use the tab title a few seconds in, once the page has caught up.
async function noteTrackStart(track) {
  const at = Date.now();
  await chrome.storage.session.set({ lastTrack: { track, at } });
  const { nowPlaying } = await chrome.storage.session.get('nowPlaying');
  if (nowPlaying && nowPlaying.title) return setTrackInfo(track, nowPlaying);

  await new Promise((r) => setTimeout(r, 3000));
  const now = await chrome.storage.session.get(['nowPlaying', 'lastTrack']);
  // The page reported the song name meanwhile, or this was a blip that got
  // thrown away and a newer file has started: leave the name alone.
  if ((now.nowPlaying && now.nowPlaying.title) || !now.lastTrack || now.lastTrack.at !== at) return;
  const state = await getState();
  const tab = state.tabId && (await chrome.tabs.get(state.tabId).catch(() => null));
  if (tab) await setTrackInfo(track, { title: tab.title });
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
    nowPlaying: { title: msg.title, artist: msg.artist, art: msg.art || [], key: msg.key, src: msg.src || '' },
    songsSeen: songsSeen + (newTitle ? 1 : 0)
  });
  // The audio of a new song can arrive a moment before the page reports its name.
  if (msg.title && lastTrack && Date.now() - lastTrack.at < 4000) {
    await setTrackInfo(lastTrack.track, { title: msg.title, artist: msg.artist, art: msg.art || [], key: msg.key, src: msg.src || '' });
  }
  // Remember which songs make up the playlist on the page when playback starts,
  // and only trust that list if it checks out: it must list several songs and
  // include the first song that played. Otherwise ending the recording on an
  // "unknown" song could stop after one song, so playlist-end is switched off.
  let { playlistIds = [], playlistCheck = '' } = await chrome.storage.session.get(['playlistIds', 'playlistCheck']);
  if (!playlistCheck && msg.id) {
    const ids = msg.playlistIds || [];
    playlistCheck = ids.length >= 2 && ids.includes(msg.id) ? 'ok' : 'off';
    playlistIds = playlistCheck === 'ok' ? ids : [];
    await chrome.storage.session.set({ playlistIds, playlistCheck });
    await sendToOffscreen({ type: 'playlistInfo', size: playlistIds.length }).catch(() => {});
  }
  // Cut to a new file right at the song change, even if there was no silent gap.
  // If the new song isn't in the playlist (Suno moving on to other people's
  // songs), make that cut the end of the recording.
  const final = !!(state.stopAtPlaylistEnd && playlistCheck === 'ok' && msg.id && !playlistIds.includes(msg.id));
  await chrome.storage.session.set({ songFinal: { key: msg.key, final } });
  if (changed && state.split) await sendToOffscreen({ type: 'songChange', final }).catch(() => {});
  // Stems: start the file the moment playback starts, keeping any silent intro.
  if (msg.playing && state.split && !final) await sendToOffscreen({ type: 'songStart' }).catch(() => {});
  return { keep: true };
}

// Stems: the page measured exactly when this song's position 0 played. The
// recorder cuts at that sample, so stems recorded one after another line up.
async function onSongTiming(msg, sender) {
  const state = await getState();
  if (!state.recording || !state.split || !state.keepSilence || !sender.tab || sender.tab.id !== state.tabId) return { ok: true };
  const { songFinal } = await chrome.storage.session.get('songFinal');
  const final = !!(songFinal && songFinal.key === msg.key && songFinal.final);
  await sendToOffscreen({ type: 'songTiming', zero: msg.zero, final }).catch(() => {});
  return { ok: true };
}

async function startSongWatch(tabId, calibrate) {
  await chrome.storage.session.set({ nowPlaying: null, lastTrack: null, songsSeen: 0, trackTitles: {}, playlistIds: [], playlistCheck: '', songFinal: null });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['songwatch-relay.js'] });
    if (calibrate) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => { window.__audioGrabberCalibrate = true; }
      });
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['songwatch-main.js'], world: 'MAIN' });
  } catch (err) {
    console.warn('Audio Grabber: song names unavailable on this page:', err.message);
  }
}

// Title and cover art for a saved file: a numbered song in split mode,
// or (track undefined) the single file, which gets the song's details only if
// exactly one song played.
async function trackInfo(track) {
  const state = await getState();
  const { trackTitles = {}, nowPlaying, songsSeen } =
    await chrome.storage.session.get(['trackTitles', 'nowPlaying', 'songsSeen']);
  let info = track ? trackTitles[track] : songsSeen === 1 ? nowPlaying : null;
  if (!info || !info.title) info = { title: state.title };
  return { title: cleanTitle(info.title), art: info.art || [], key: info.key || '', src: info.src || '' };
}

async function saveFile({ url, ext, track, name }) {
  const settings = await getSettings();
  const folder = settings.folder ? sanitize(settings.folder) : '';
  // Just the song name (in single-file mode: the song if exactly one played,
  // else the tab title). Chrome adds " (1)" if a file by that name exists.
  const title = name || (await trackInfo(track)).title;
  const base = `${sanitize(title || (track ? 'Track' : 'Recording'))}.${ext}`;
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
    stop: () => stopRecording(true),
    togglePause,
    toggleMute,
    // From the offscreen page:
    save: () => saveFile(msg),
    scan: () => scanTab(msg.tabId).then((songs) => ({ songs })),
    grab: () => grabSongs(msg.songs),
    grabProgress: async () => {
      await chrome.storage.session.set({ grab: { active: true, done: msg.done, total: msg.total, failed: msg.failed } });
      return { ok: true };
    },
    grabDone: () => grabDone(msg),
    testNotify: async () => {
      await notify('Audio Grabber: test', 'Notifications are working. You will get one like this when a recording finishes.');
      const { notifyError } = await chrome.storage.local.get('notifyError');
      return { ok: !notifyError, error: notifyError };
    },
    trackMeta: () => trackInfo(msg.track),
    trackStart: () => { noteTrackStart(msg.track); return { ok: true }; },
    // From the song watcher in the recorded tab:
    song: () => onSong(msg, sender),
    songTiming: () => onSongTiming(msg, sender),
    // The page's own copy of a song's audio (it plays it from memory).
    original: async () => {
      const state = await getState();
      if (state.recording && sender.tab && sender.tab.id === state.tabId) {
        await sendToOffscreen({ type: 'original', key: msg.key, dataUrl: msg.dataUrl }).catch(() => {});
      }
      return { ok: true };
    },
    calib: async () => {
      const state = await getState();
      if (state.recording && state.keepSilence && sender.tab && sender.tab.id === state.tabId) {
        await sendToOffscreen({ type: 'calib', walls: msg.walls }).catch(() => {});
      }
      return { ok: true };
    },
    // The recorder measured this computer's capture delay: remember it for next time.
    saveLatency: async () => {
      await chrome.storage.local.set({ captureLatency: msg.frames });
      return { ok: true };
    },
    ended: async () => {
      // Tab closed / auto-stop hit: offscreen already saved the files.
      const state = await getState();
      if (msg.reason === 'playlistEnd' || msg.reason === 'songLimit') {
        // Stop the site from carrying on with songs we aren't recording.
        chrome.scripting.executeScript({
          target: { tabId: state.tabId },
          world: 'MAIN',
          func: () => document.querySelectorAll('audio, video').forEach((el) => el.pause())
        }).catch(() => {});
      }
      if (state.recording) {
        await setState({ recording: false, endReason: msg.reason || '', saved: msg.saved || 0, exact: msg.exact || 0, split: state.split });
      }
      await closeOffscreenIfIdle();
      await notifyDone(state, msg.reason, msg.saved || 0, msg.exact || 0);
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
