// ChatGPT: adds a player bar (play, scrub, voice, download) under each reply. Audio comes from
// ChatGPT's read-aloud service in the voice picked in the extension.

let avsToken = null;
let avsTokenTime = 0;

async function avsGetToken() {
  if (avsToken && Date.now() - avsTokenTime < 5 * 60 * 1000) return avsToken;
  const res = await fetch('/api/auth/session', { credentials: 'include' });
  if (!res.ok) throw new Error(`Couldn't read your ChatGPT login (${res.status}).`);
  const data = await res.json();
  if (!data || !data.accessToken) throw new Error('You need to be logged in to ChatGPT.');
  avsToken = data.accessToken;
  avsTokenTime = Date.now();
  return avsToken;
}

function avsConversationId() {
  const m = location.pathname.match(/\/c\/([0-9a-zA-Z-]+)/);
  return m ? m[1] : null;
}

async function avsSynthesize(messageId, voice, format) {
  const conversationId = avsConversationId();
  if (!conversationId) throw new Error('Open a saved chat first (temporary chats can’t be read aloud).');
  const token = await avsGetToken();
  const q = new URLSearchParams({ message_id: messageId, conversation_id: conversationId, voice, format });
  const res = await fetch(`/backend-api/synthesize?${q}`, {
    credentials: 'include',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 401) avsToken = null;
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 160); } catch {}
    throw new Error(`ChatGPT refused the request (${res.status}). ${detail}`);
  }
  const blob = await res.blob();
  if (blob.size < 500) throw new Error('ChatGPT returned no audio for this reply.');
  return blob;
}

// The voice and file type picked in the extension (popup and player share these settings).
async function avsChatGPTChoice() {
  const s = await avsSettings();
  // ChatGPT voice ids are lowercase ("ember"), so "Ember" typed as a custom name still works.
  const voice = (await avsVoice('chatgpt')).toLowerCase();
  return { voice, format: s.chatgptFormat || 'aac' };
}

// Fetches one reply's audio in the chosen voice. Falls back to AAC if the chosen format is rejected.
async function avsFetchAudio(messageId, { voice, format }) {
  try {
    return { blob: await avsSynthesize(messageId, voice, format), voice, format };
  } catch (err) {
    if (format === 'aac') throw err;
    return { blob: await avsSynthesize(messageId, voice, 'aac'), voice, format: 'aac' };
  }
}

async function avsSaveMessage(messageId, suffix = '') {
  const { blob, voice, format } = await avsFetchAudio(messageId, await avsChatGPTChoice());
  avsDownloadBlob(blob, avsFilename('chatgpt', voice, format, suffix));
}

// Each assistant turn can contain several message nodes; read-aloud uses the last one.
function avsAssistantTurns() {
  const turns = new Map();
  for (const node of document.querySelectorAll('[data-message-author-role="assistant"][data-message-id]')) {
    const turn = node.closest('article, [data-testid^="conversation-turn"]') || node.parentElement;
    turns.set(turn, node);
  }
  return [...turns].map(([turn, node]) => ({ turn, node, messageId: node.getAttribute('data-message-id') }));
}

// ---------- Voice list (the popup asks for this same list, so both always match) ----------

let avsVoiceListPromise = null;

function avsGetVoiceList() {
  if (!avsVoiceListPromise) {
    avsVoiceListPromise = avsListVoices()
      .then((list) => (list.length ? list : VOICES.chatgpt))
      .catch(() => VOICES.chatgpt);
  }
  return avsVoiceListPromise;
}

// Same options as the popup: the voice list, a saved voice that isn't listed, and the custom name.
async function avsFillVoiceSelect(select) {
  const [list, s] = await Promise.all([avsGetVoiceList(), avsSettings()]);
  const saved = s.chatgptVoice;
  select.innerHTML = '';
  for (const v of list) select.add(new Option(v.name, v.id));
  if (saved && saved !== 'custom' && !list.some((v) => v.id === saved)) select.add(new Option(saved, saved));
  if (saved === 'custom' || s.chatgptCustomVoice.trim()) {
    select.add(new Option(s.chatgptCustomVoice.trim() || 'Custom', 'custom'));
  }
  select.value = saved;
}

// ---------- Player bar under each reply ----------

const AVS_ICONS = {
  play: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 4h3.5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm6.5 0H17a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1Zm-8 15a1 1 0 0 1 1 1v1h14v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z"/></svg>'
};

const avsPlayers = new Map(); // messageId -> player
let avsPlaying = null;

function avsFmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Decoded audio as a WAV file, so the scrub bar knows the exact length and can jump anywhere.
function avsToWav(buffer) {
  const ch = buffer.numberOfChannels, rate = buffer.sampleRate, len = buffer.length;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * ch * 2, true); out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

async function avsPlayableUrl(blob) {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    return URL.createObjectURL(avsToWav(decoded));
  } catch {
    return URL.createObjectURL(blob); // let the browser try the original file
  }
}

function avsCreatePlayer(messageId) {
  const el = document.createElement('div');
  el.className = 'avs-player';
  el.innerHTML =
    `<button type="button" class="avs-play" title="Play">${AVS_ICONS.play}</button>` +
    '<input type="range" class="avs-seek" min="0" max="0" step="0.01" value="0" disabled aria-label="Scrub">' +
    '<span class="avs-time">0:00</span>' +
    '<select class="avs-voice" title="Voice"></select>' +
    `<button type="button" class="avs-dl" title="Download">${AVS_ICONS.download}</button>`;

  const p = {
    messageId, el,
    playBtn: el.querySelector('.avs-play'),
    seek: el.querySelector('.avs-seek'),
    time: el.querySelector('.avs-time'),
    voice: el.querySelector('.avs-voice'),
    dlBtn: el.querySelector('.avs-dl'),
    audio: new Audio(),
    key: null, // "voice|format" the loaded audio was made with
    clip: null, // { blob, voice, format }
    url: null,
    loading: null,
    gen: 0, // bumped on reset so a slow load for an old voice is ignored
    dragging: false
  };

  // Keep ChatGPT from treating clicks here as clicks on the message.
  for (const t of ['click', 'mousedown', 'pointerdown', 'keydown']) el.addEventListener(t, (e) => e.stopPropagation());

  const showTime = () => {
    const d = p.audio.duration;
    p.time.textContent = isFinite(d) ? `${avsFmtTime(p.audio.currentTime)} / ${avsFmtTime(d)}` : avsFmtTime(p.audio.currentTime);
  };
  const setPlaying = (on) => {
    p.playBtn.innerHTML = on ? AVS_ICONS.pause : AVS_ICONS.play;
    p.playBtn.title = on ? 'Pause' : 'Play';
    el.classList.toggle('avs-on', on);
  };

  p.audio.addEventListener('loadedmetadata', () => {
    p.seek.max = isFinite(p.audio.duration) ? p.audio.duration : 0;
    p.seek.disabled = !isFinite(p.audio.duration);
    showTime();
  });
  p.audio.addEventListener('timeupdate', () => {
    if (!p.dragging) p.seek.value = p.audio.currentTime;
    showTime();
  });
  p.audio.addEventListener('play', () => {
    if (avsPlaying && avsPlaying !== p) avsPlaying.audio.pause();
    avsPlaying = p;
    setPlaying(true);
  });
  p.audio.addEventListener('pause', () => setPlaying(false));
  p.audio.addEventListener('ended', () => setPlaying(false));

  p.seek.addEventListener('input', () => {
    p.dragging = true;
    p.time.textContent = `${avsFmtTime(+p.seek.value)} / ${avsFmtTime(p.audio.duration)}`;
  });
  p.seek.addEventListener('change', () => {
    p.audio.currentTime = +p.seek.value;
    p.dragging = false;
  });

  // Gets the audio for the voice picked right now (reuses it if nothing changed).
  p.load = async () => {
    const choice = await avsChatGPTChoice();
    const key = `${choice.voice}|${choice.format}`;
    if (p.key === key && p.clip) return p.clip;
    if (p.loading && p.loading.key === key) return p.loading.promise;
    const gen = p.gen;
    const promise = (async () => {
      const clip = await avsFetchAudio(p.messageId, choice);
      const url = await avsPlayableUrl(clip.blob);
      if (p.gen !== gen) { URL.revokeObjectURL(url); return clip; } // voice changed while loading
      if (p.url) URL.revokeObjectURL(p.url);
      p.key = key;
      p.clip = clip;
      p.url = url;
      p.audio.src = url;
      return clip;
    })();
    p.loading = { key, promise };
    el.classList.add('avs-loading');
    try {
      return await promise;
    } finally {
      if (p.loading && p.loading.promise === promise) {
        p.loading = null;
        el.classList.remove('avs-loading');
      }
    }
  };

  // Forget loaded audio (after a voice or file-type change).
  p.reset = () => {
    p.gen++;
    p.loading = null;
    el.classList.remove('avs-loading');
    p.audio.pause();
    p.audio.removeAttribute('src');
    p.audio.load();
    if (p.url) URL.revokeObjectURL(p.url);
    p.key = p.clip = p.url = null;
    p.seek.value = 0;
    p.seek.max = 0;
    p.seek.disabled = true;
    p.time.textContent = '0:00';
    setPlaying(false);
  };

  p.playBtn.addEventListener('click', async () => {
    if (p.clip && !p.audio.paused) return p.audio.pause();
    try {
      await p.load();
      await p.audio.play();
    } catch (err) {
      if (err && err.name === 'NotAllowedError') avsToast('Ready — press play again.');
      else avsToast(err.message || String(err), true);
    }
  });

  p.dlBtn.addEventListener('click', async () => {
    if (el.classList.contains('avs-loading')) return;
    try {
      const { blob, voice, format } = await p.load();
      avsDownloadBlob(blob, avsFilename('chatgpt', voice, format));
      avsToast('Voice saved to your Downloads folder');
    } catch (err) {
      avsToast(err.message || String(err), true);
    }
  });

  // Picking a voice here changes the extension's voice, same as the popup.
  p.voice.addEventListener('change', () => chrome.storage.sync.set({ chatgptVoice: p.voice.value }));

  avsFillVoiceSelect(p.voice);
  return p;
}

function avsInjectPlayers() {
  const anyActionBar = !!document.querySelector('[data-testid="copy-turn-action-button"]');
  for (const { turn, node, messageId } of avsAssistantTurns()) {
    if (!messageId) continue;
    // Wait until the reply has finished writing (its Copy button shows up then).
    if (anyActionBar && !turn.querySelector('[data-testid="copy-turn-action-button"]')) continue;

    let p = avsPlayers.get(messageId);
    if (!p) {
      p = avsCreatePlayer(messageId);
      avsPlayers.set(messageId, p);
    }
    // A regenerated reply gets a new id; drop the old bar in this turn.
    for (const old of turn.querySelectorAll('.avs-player')) if (old !== p.el) old.remove();
    if (p.el.previousElementSibling !== node) node.insertAdjacentElement('afterend', p.el);
  }
}

let avsScanTimer = null;
new MutationObserver(() => {
  clearTimeout(avsScanTimer);
  avsScanTimer = setTimeout(avsInjectPlayers, 400);
}).observe(document.documentElement, { childList: true, subtree: true });
avsInjectPlayers();

// Keep every player's voice in step with the popup; a new voice or file type means new audio.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (!changes.chatgptVoice && !changes.chatgptCustomVoice && !changes.chatgptFormat) return;
  for (const p of avsPlayers.values()) {
    avsFillVoiceSelect(p.voice);
    if (p.key || p.loading) p.reset();
  }
});

async function avsSaveAll() {
  const turns = avsAssistantTurns().filter((t) => t.messageId);
  let saved = 0;
  const errors = [];
  for (let i = 0; i < turns.length; i++) {
    try {
      await avsSaveMessage(turns[i].messageId, String(i + 1).padStart(2, '0'));
      saved++;
    } catch (err) {
      errors.push(`Reply ${i + 1}: ${err.message || err}`);
      if (/logged in|login|Open a saved chat/.test(String(err.message))) break;
    }
  }
  return { saved, total: turns.length, errors };
}

async function avsListVoices() {
  const token = await avsGetToken();
  const res = await fetch('/backend-api/settings/voices', {
    credentials: 'include',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.voices || [];
  return list
    .map((v) => (typeof v === 'string' ? { id: v, name: v } : { id: v.voice || v.id, name: v.name || v.voice || v.id }))
    .filter((v) => v.id);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'chatgpt-status') {
    sendResponse({ conversation: !!avsConversationId(), replies: avsAssistantTurns().length });
  } else if (msg.type === 'chatgpt-save-all') {
    avsSaveAll().then(sendResponse, (err) => sendResponse({ saved: 0, total: 0, errors: [String(err.message || err)] }));
    return true;
  } else if (msg.type === 'chatgpt-voices') {
    avsGetVoiceList().then((voices) => sendResponse({ voices }), () => sendResponse({ voices: null }));
    return true;
  }
});
