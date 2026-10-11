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

// ---------- Finding the replies on the page ----------
// ChatGPT changes its page layout now and then, so replies are found in several ways, in order:
//  1. an attribute marking the author, e.g. data-message-author-role="assistant" (or one learned
//     by scanning the page for any attribute whose value is "assistant"),
//  2. otherwise the conversation's turn blocks, matched with the chat's own record from ChatGPT.
// The message id read-aloud needs comes from the page if it's there, otherwise from that record.

const AVS_ROLE_ATTRS = ['data-message-author-role', 'data-turn', 'data-author-role', 'data-message-role', 'data-role', 'data-author'];
const AVS_TURN_SEL = '[data-testid^="conversation-turn"], article';
let avsLearnedRoleAttr = null;

const avsRoleSelector = (attr) => `[${attr}="assistant"]`;

// Finds an attribute whose value is "assistant" somewhere on the page (only when the known ones
// miss, and at most every few seconds since it looks at every element).
let avsLastLearn = 0;
function avsLearnRoleAttr() {
  if (Date.now() - avsLastLearn < 3000) return null;
  avsLastLearn = Date.now();
  const root = document.querySelector('main') || document.body;
  if (!root) return null;
  for (const el of root.querySelectorAll('*')) {
    if (el.closest('.avs-player')) continue;
    for (const a of el.attributes) {
      if (a.value === 'assistant' && !a.name.startsWith('aria-') && a.name !== 'class') return a.name;
    }
  }
  return null;
}

function avsAssistantNodes() {
  const attrs = avsLearnedRoleAttr ? [avsLearnedRoleAttr, ...AVS_ROLE_ATTRS] : AVS_ROLE_ATTRS;
  let nodes = [...document.querySelectorAll(attrs.map(avsRoleSelector).join(', '))];
  if (!nodes.length) {
    const learned = avsLearnRoleAttr();
    if (learned) {
      avsLearnedRoleAttr = learned;
      nodes = [...document.querySelectorAll(avsRoleSelector(learned))];
    }
  }
  nodes = nodes.filter((n) => !n.closest('.avs-player'));
  // Keep the innermost match (a turn block can be marked as well as the message inside it).
  return nodes.filter((n) => !nodes.some((m) => m !== n && n.contains(m)));
}

function avsDomMessageId(node) {
  const el = node.closest('[data-message-id]') || node.querySelector('[data-message-id]');
  return el ? el.getAttribute('data-message-id') : null;
}

// ---------- The chat's own record (for ids the page doesn't show) ----------

let avsRecord = { conv: null, turns: [], fetchedAt: 0, loading: null };

// The visible turns of the current branch: [{ role: 'user'|'assistant', id }]. For an assistant
// turn, the id of its last text message (what read-aloud reads).
function avsLoadRecord() {
  const conv = avsConversationId();
  if (!conv) return Promise.resolve([]);
  if (avsRecord.loading) return avsRecord.loading;
  if (avsRecord.conv === conv && Date.now() - avsRecord.fetchedAt < 5000) return Promise.resolve(avsRecord.turns);
  avsRecord.loading = (async () => {
    let turns = avsRecord.conv === conv ? avsRecord.turns : [];
    try {
      const token = await avsGetToken();
      const res = await avsSiteFetch(`/backend-api/conversation/${conv}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const path = [];
      for (let id = data.current_node; id && data.mapping[id]; id = data.mapping[id].parent) path.push(data.mapping[id]);
      path.reverse();
      const list = [];
      for (const n of path) {
        const m = n.message;
        if (!m || !m.author) continue;
        if ((m.metadata || {}).is_visually_hidden_from_conversation) continue;
        const role = m.author.role;
        if (role === 'user') { list.push({ role: 'user', id: m.id }); continue; }
        if (role !== 'assistant' && role !== 'tool') continue;
        let last = list[list.length - 1];
        if (!last || last.role !== 'assistant') { last = { role: 'assistant', id: null }; list.push(last); }
        const ct = (m.content && m.content.content_type) || '';
        if (role === 'assistant' && (m.recipient || 'all') === 'all' && /text/.test(ct)) last.id = m.id;
      }
      turns = list.filter((t) => t.role === 'user' || t.id);
    } catch {}
    avsRecord = { conv, turns, fetchedAt: Date.now(), loading: null };
    return turns;
  })();
  return avsRecord.loading;
}

// Pairs page items with record entries, counting back from the newest.
function avsAlignFromEnd(items, entries) {
  const offset = entries.length - items.length;
  return items.map((_, i) => (i + offset >= 0 ? entries[i + offset] : null));
}

// Each assistant turn can contain several message nodes; read-aloud uses the last one.
function avsAssistantTurns() {
  const nodes = avsAssistantNodes();
  const record = avsRecord.conv === avsConversationId() ? avsRecord.turns : [];
  if (nodes.length) {
    const turns = new Map();
    for (const node of nodes) turns.set(node.closest(AVS_TURN_SEL) || node, node);
    const list = [...turns].map(([turn, node]) => ({ turn, node, messageId: avsDomMessageId(node) }));
    if (list.some((t) => !t.messageId)) {
      const ids = avsAlignFromEnd(list, record.filter((t) => t.role === 'assistant'));
      list.forEach((t, i) => { if (!t.messageId && ids[i]) t.messageId = ids[i].id; });
    }
    return list;
  }
  // No author markers at all: use the turn blocks in order, matched to the record's turns.
  const blocks = [...document.querySelectorAll(AVS_TURN_SEL)].filter((b) => !(b.parentElement && b.parentElement.closest(AVS_TURN_SEL)));
  if (!blocks.length || !record.length) return [];
  const matched = avsAlignFromEnd(blocks, record);
  return blocks
    .map((block, i) => ({ turn: block, node: block, entry: matched[i] }))
    .filter((t) => t.entry && t.entry.role === 'assistant')
    .map(({ turn, node, entry }) => ({ turn, node, messageId: entry.id }));
}

// The record is needed when the page doesn't show message ids or author markers, and is
// re-read only when the page has more turns than the record knows about (a new reply).
function avsRecordNeeded() {
  const nodes = avsAssistantNodes();
  if (nodes.length && nodes.every((n) => avsDomMessageId(n))) return false;
  if (avsRecord.conv !== avsConversationId()) return true;
  if (nodes.length) {
    const replies = new Set(nodes.map((n) => n.closest(AVS_TURN_SEL) || n)).size;
    return replies > avsRecord.turns.filter((t) => t.role === 'assistant').length;
  }
  return document.querySelectorAll(AVS_TURN_SEL).length > avsRecord.turns.length;
}

// A short description of how the page is built, for when replies can't be found.
// Attribute names, counts and short marker values only; no chat text.
function avsLayoutReport() {
  const root = document.body;
  const attrCounts = {};
  const markers = {};
  const testids = {};
  let shadowHosts = 0;
  const idPattern = /[0-9a-f]{8}-[0-9a-f-]{27,}/gi;
  for (const el of root.querySelectorAll('*')) {
    if (el.closest('.avs-player')) continue;
    if (el.shadowRoot) shadowHosts++;
    for (const a of el.attributes) {
      if (!a.name.startsWith('data-')) continue;
      attrCounts[a.name] = (attrCounts[a.name] || 0) + 1;
      if (/^(assistant|user|model|bot|ai|system|tool)$/i.test(a.value)) {
        const k = `${a.name}="${a.value}"`;
        markers[k] = (markers[k] || 0) + 1;
      }
      if (a.name === 'data-testid') {
        const v = a.value.replace(idPattern, '{id}').replace(/\d+/g, '#');
        testids[v] = (testids[v] || 0) + 1;
      }
    }
  }
  const top = (o, n) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k} x${v}`).join(', ') || 'none';
  const describe = (el) => {
    const data = [...el.attributes].filter((a) => a.name.startsWith('data-'))
      .map((a) => (a.name === 'data-testid' ? `${a.name}=${a.value.replace(idPattern, '{id}').replace(/\d+/g, '#')}` : a.name));
    return el.tagName.toLowerCase() + (data.length ? `[${data.join(' ')}]` : '');
  };
  const chain = (el) => {
    const out = [];
    for (let e = el, i = 0; e && e !== root && i < 8; e = e.parentElement, i++) out.push(describe(e));
    return out.join(' < ');
  };
  const button = (re) => [...root.querySelectorAll('button')]
    .find((b) => !b.closest('.avs-player') && (re.test(b.getAttribute('aria-label') || '') || re.test(b.getAttribute('data-testid') || '')));
  const copy = button(/copy/i);
  const read = button(/read.?aloud|voice-play|speak/i);
  return [
    `ChatGPT layout report (extension v${chrome.runtime.getManifest().version})`,
    `Page: ${location.pathname.replace(idPattern, '{id}')}`,
    `Author markers: ${top(markers, 10)}`,
    `Turn blocks: ${document.querySelectorAll(AVS_TURN_SEL).length}, articles: ${document.querySelectorAll('article').length}, sections: ${document.querySelectorAll('section').length}, shadow roots: ${shadowHosts}, iframes: ${document.querySelectorAll('iframe').length}`,
    `Chat record: ${avsRecord.turns.length} turns, ${avsRecord.turns.filter((t) => t.role === 'assistant').length} replies`,
    `Test ids: ${top(testids, 25)}`,
    `Data attributes: ${top(attrCounts, 25)}`,
    `Copy button: ${copy ? chain(copy) : 'not found'}`,
    `Read-aloud button: ${read ? chain(read) : 'not found'}`
  ].join('\n');
}

// True while ChatGPT is still writing a reply (its Stop button is showing).
function avsGenerating() {
  return !!document.querySelector('[data-testid="stop-button"], button[aria-label^="Stop" i]');
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
  if (!avsRecord.loading && Date.now() - avsRecord.fetchedAt > 5000 && avsRecordNeeded()) {
    avsLoadRecord().then(avsInjectPlayers);
  }
  const turns = avsAssistantTurns();
  const generating = avsGenerating();
  turns.forEach(({ turn, node, messageId }, i) => {
    if (!messageId) return;
    // Wait until the reply has finished writing.
    if ((generating && i === turns.length - 1) || node.querySelector('.result-streaming')) return;

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
    const scope = turn === node ? node.parentElement || node : turn;
    for (const old of scope.querySelectorAll('.avs-player')) if (old !== p.el && old.previousElementSibling === node) old.remove();
    if (p.el.previousElementSibling !== node) node.insertAdjacentElement('afterend', p.el);
  });
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
    const turns = avsAssistantTurns();
    sendResponse({
      conversation: !!avsConversationId(),
      replies: turns.length,
      withIds: turns.filter((t) => t.messageId).length,
      players: document.querySelectorAll('.avs-player').length,
      generating: avsGenerating()
    });
  } else if (msg.type === 'chatgpt-layout') {
    const reply = () => sendResponse({ report: avsLayoutReport() });
    avsLoadRecord().then(reply, reply);
    return true;
  } else if (msg.type === 'chatgpt-save-all') {
    avsSaveAll().then(sendResponse, (err) => sendResponse({ saved: 0, total: 0, errors: [String(err.message || err)] }));
    return true;
  } else if (msg.type === 'chatgpt-voices') {
    avsGetVoiceList().then((voices) => sendResponse({ voices }), () => sendResponse({ voices: null }));
    return true;
  }
});
