// ChatGPT: adds a player bar (play, scrub, voice, download) under each reply. Audio comes from
// ChatGPT's read-aloud service in the voice picked in the extension.

let avsToken = null;
let avsTokenTime = 0;

async function avsGetToken() {
  if (avsToken && Date.now() - avsTokenTime < 5 * 60 * 1000) return avsToken;
  const res = await avsSiteFetch('/api/auth/session', { credentials: 'include' });
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
  const res = await avsSiteFetch(`/backend-api/synthesize?${q}`, {
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

async function avsFillVoiceSelect(select) {
  avsFillVoiceOptions(select, 'chatgpt', await avsGetVoiceList());
}

// ---------- Player bar under each reply ----------

const avsChatPlayers = new Map(); // messageId -> player

function avsInjectPlayers() {
  const anyActionBar = !!document.querySelector('[data-testid="copy-turn-action-button"]');
  for (const { turn, node, messageId } of avsAssistantTurns()) {
    if (!messageId) continue;
    // Wait until the reply has finished writing (its Copy button shows up then).
    if (anyActionBar && !turn.querySelector('[data-testid="copy-turn-action-button"]')) continue;

    let p = avsChatPlayers.get(messageId);
    if (!p) {
      p = avsCreatePlayer({
        site: 'chatgpt',
        choice: async () => {
          const c = await avsChatGPTChoice();
          return { ...c, key: `${c.voice}|${c.format}` };
        },
        fetch: async (choice) => {
          const { blob, voice, format } = await avsFetchAudio(messageId, choice);
          return { blob, voice, ext: format };
        },
        fillVoices: avsFillVoiceSelect
      });
      avsChatPlayers.set(messageId, p);
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
  const res = await avsSiteFetch('/backend-api/settings/voices', {
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
