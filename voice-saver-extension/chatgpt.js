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

let avsRecord = { conv: null, turns: [], node: null, fetchedAt: 0, loading: null };
// Re-reads since the replies last changed: the first few come quickly (ChatGPT's record can lag a
// moment behind the page), then they slow down.
let avsRecordTries = 0;
const avsRecordWait = () => (avsRecordTries < 4 ? 1500 : Math.min(1500 * 2 ** (avsRecordTries - 3), 60000));

// Letters only, lowercased: the page shows rendered text and the record holds markdown, so this
// is what the two have in common (list numbers, for one, are in the record but not the page text).
// Digits are kept only for a reply with no letters at all.
const avsNorm = (s) => {
  const t = String(s || '').toLowerCase();
  return t.replace(/[^\p{L}]+/gu, '') || t.replace(/[^\p{N}]+/gu, '');
};

// The visible turns of the current branch: [{ role, id, text }]. For an assistant turn, the id and
// text of its last text message (what read-aloud reads).
function avsLoadRecord() {
  const conv = avsConversationId();
  if (!conv) return Promise.resolve([]);
  if (avsRecord.loading) return avsRecord.loading;
  avsRecord.loading = (async () => {
    let turns = avsRecord.conv === conv ? avsRecord.turns : [];
    let node = avsRecord.conv === conv ? avsRecord.node : null;
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
        const c = m.content || {};
        const text = (c.parts || [c.text]).filter((x) => typeof x === 'string').join('\n');
        const role = m.author.role;
        if (role === 'user') { list.push({ role: 'user', id: m.id, text: avsNorm(text) }); continue; }
        if (role !== 'assistant' && role !== 'tool') continue;
        let last = list[list.length - 1];
        if (!last || last.role !== 'assistant') { last = { role: 'assistant', id: null, text: '' }; list.push(last); }
        if (role === 'assistant' && (m.recipient || 'all') === 'all' && /text/.test(c.content_type || '')) {
          last.id = m.id;
          last.text = avsNorm(text);
        }
      }
      node = data.current_node;
      turns = list.filter((t) => t.role === 'user' || t.id);
    } catch {}
    avsRecordTries++;
    avsRecord = { conv, turns, node, fetchedAt: Date.now(), loading: null };
    return turns;
  })();
  return avsRecord.loading;
}

// A reply's text on the page, without our player bar's text.
function avsPageText(el) {
  let t = el.textContent || '';
  for (const p of el.querySelectorAll('.avs-player')) t = t.replace(p.textContent, '');
  return t;
}

// A reply's text for matching: without the author marker (when it's a separate label) or the
// text of buttons (Copy, Read aloud, …).
function avsReplyText(src, node) {
  let t = avsPageText(src);
  const drop = [...src.querySelectorAll('button')].map((b) => b.textContent);
  if (node !== src && src.contains(node) && (node.textContent || '').length < 60) drop.push(node.textContent);
  for (const d of drop) if (d) t = t.replace(d, ' ');
  return t;
}

// How well a reply on the page matches a record entry: short replies must match exactly; longer
// ones by how many of five 12-character samples (start, quarters, end) appear in the entry.
// The page text can carry extras the record doesn't (a "ChatGPT said:" label, "Thought for 5s",
// button text) and the record extras the page doesn't (markdown, citation markers), so:
// a short reply must appear in the page text with little else around it; a longer one matches when
// at least 4 of 10 12-character samples spread across the page text appear in the entry.
const AVS_SAMPLES = 10;

function avsSampleHits(pageNorm, entryNorm) {
  const L = Math.max(0, pageNorm.length - 12);
  let hits = 0;
  for (let k = 0; k < AVS_SAMPLES; k++) {
    const i = Math.floor((L * k) / (AVS_SAMPLES - 1));
    if (entryNorm.includes(pageNorm.slice(i, i + 12))) hits++;
  }
  return hits;
}

function avsMatches(pageNorm, entryNorm) {
  if (!entryNorm || !pageNorm) return false;
  if (entryNorm.length < 24) return pageNorm.includes(entryNorm) && pageNorm.length - entryNorm.length < 60;
  if (pageNorm.length < 24) return false;
  return avsSampleHits(pageNorm, entryNorm) >= 4;
}

// Which message a reply on the page is, remembered per reply block until its text changes
// (a regenerated reply, or one still being written, gets matched again).
const avsTurnIds = new WeakMap(); // turn element -> { conv, id, len }

function avsRecordIdFor(turn, node, used) {
  const conv = avsConversationId();
  // The reply's text: its text block if one is recognisable, otherwise the whole reply block
  // (never just the author marker, which can be a bare "ChatGPT said:" label).
  const text = avsReplyText(avsReplyAnchor(turn, node) || turn, node);
  const cached = avsTurnIds.get(turn);
  if (cached && cached.conv === conv && cached.len === text.length && !used.has(cached.id)) return cached.id;
  if (avsRecord.conv !== conv) return null;
  const pageNorm = avsNorm(text);
  const entry = avsRecord.turns.find((t) => t.role === 'assistant' && !used.has(t.id) && avsMatches(pageNorm, t.text));
  if (!entry) return null;
  avsTurnIds.set(turn, { conv, id: entry.id, len: text.length });
  return entry.id;
}

// The block holding a whole reply: a known turn block, else the outermost marked element around
// the marker, else (for a small marker like a "ChatGPT said:" label) its parent if that holds
// no other reply.
function avsTurnOf(node, nodes) {
  const block = node.closest(AVS_TURN_SEL);
  if (block) return block;
  const attrs = avsLearnedRoleAttr ? [avsLearnedRoleAttr, ...AVS_ROLE_ATTRS] : AVS_ROLE_ATTRS;
  const sel = attrs.map(avsRoleSelector).join(', ');
  let outer = node;
  for (let e = node.parentElement; e; e = e.parentElement) if (e.matches(sel)) outer = e;
  if (outer !== node) return outer;
  const parent = node.parentElement;
  if (parent && (node.textContent || '').trim().length < 60 && !nodes.some((m) => m !== node && parent.contains(m))) return parent;
  return node;
}

// The replies on the page, each with the message id read-aloud needs (null until known).
// Each assistant turn can contain several message nodes; read-aloud uses the last one.
function avsAssistantTurns() {
  const nodes = avsAssistantNodes();
  let list;
  let fromBlocks = false;
  if (nodes.length) {
    const turns = new Map();
    for (const node of nodes) turns.set(avsTurnOf(node, nodes), node);
    list = [...turns].map(([turn, node]) => ({ turn, node, messageId: avsDomMessageId(node) }));
  } else {
    // No author markers at all: every turn block, kept below only if it matches a reply.
    fromBlocks = true;
    list = [...document.querySelectorAll(AVS_TURN_SEL)]
      .filter((b) => !(b.parentElement && b.parentElement.closest(AVS_TURN_SEL)))
      .map((b) => ({ turn: b, node: b, messageId: null }));
  }
  if (list.some((t) => !t.messageId)) {
    const used = new Set(list.map((t) => t.messageId).filter(Boolean));
    if (avsRecordHasText()) {
      for (const t of list) {
        if (t.messageId) continue;
        t.messageId = avsRecordIdFor(t.turn, t.node, used);
        if (t.messageId) used.add(t.messageId);
      }
    } else {
      avsMatchByPosition(list, fromBlocks);
    }
  }
  return fromBlocks ? list.filter((t) => t.messageId) : list;
}

// Normally the record holds each message's text. If it doesn't, fall back to matching by position
// (counting back from the newest), but only with a record read after the page last changed.
function avsRecordHasText() {
  return avsRecord.turns.some((t) => t.role === 'assistant' && t.text);
}

function avsMatchByPosition(list, fromBlocks) {
  if (avsRecord.conv !== avsConversationId() || avsRecord.fetchedAt < avsPageState.since) return;
  const entries = fromBlocks ? avsRecord.turns : avsRecord.turns.filter((t) => t.role === 'assistant');
  const offset = entries.length - list.length;
  list.forEach((t, i) => {
    const e = entries[i + offset];
    if (!t.messageId && e && e.role === 'assistant') t.messageId = e.id;
  });
}

// Page state used to decide when to re-read the record: wait until replies stop changing.
let avsPageState = { sig: '', since: 0 };

function avsNoteChanges(turns) {
  const sig = turns.map((t) => avsPageText(t.turn).length).join(',') + '|' + document.querySelectorAll(AVS_TURN_SEL).length;
  if (sig !== avsPageState.sig) avsPageState = { sig, since: Date.now() };
}

// Re-read the record when a reply has no id yet, the page has settled, ChatGPT isn't writing,
// and enough time has passed (longer each time a re-read brings nothing new).
function avsRecordNeeded(turns) {
  if (avsRecord.loading || avsGenerating()) return false;
  if (avsRecord.conv !== avsConversationId()) return true;
  const missing = turns.some((t) => !t.messageId) || (!turns.length && document.querySelector(AVS_TURN_SEL));
  if (!missing) return false;
  if (Date.now() - avsPageState.since < 1500) return false;
  if (avsPageState.since > avsRecord.fetchedAt) avsRecordTries = 0;
  return Date.now() - avsRecord.fetchedAt > avsRecordWait();
}

// For the layout report: how close each reply on the page comes to a record entry (numbers only).
function avsMatchReport() {
  const entries = avsRecord.turns.filter((t) => t.role === 'assistant' && t.text);
  const nodes = avsAssistantNodes();
  const turns = new Map();
  for (const node of nodes) turns.set(avsTurnOf(node, nodes), node);
  const out = [...turns].slice(-5).map(([turn, node]) => {
    const src = avsReplyAnchor(turn, node) || turn;
    const page = avsNorm(avsReplyText(src, node));
    let best = 0;
    for (const e of entries) best = Math.max(best, avsSampleHits(page, e.text));
    const lens = entries.map((e) => e.text.length);
    return `page ${page.length} chars (${src === turn ? 'whole block' : 'text block'}), best ${best}/${AVS_SAMPLES}, closest record length ${lens.length ? lens.reduce((a, b) => (Math.abs(b - page.length) < Math.abs(a - page.length) ? b : a)) : '-'}`;
  });
  return out.join('; ') || 'no replies';
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
    `Chat record: ${avsRecord.turns.length} turns, ${avsRecord.turns.filter((t) => t.role === 'assistant').length} replies, ${avsRecord.turns.filter((t) => t.role === 'assistant' && t.text).length} with text`,
    `Matching: ${avsMatchReport()}`,
    `Test ids: ${top(testids, 25)}`,
    `Data attributes: ${top(attrCounts, 25)}`,
    `Replies found: ${avsAssistantTurns().length}, bars: ${document.querySelectorAll('.avs-player').length}, last check ${Math.round((Date.now() - avsInjectState.time) / 1000)}s ago, skipped: ${avsInjectState.reasons.join('; ') || 'none'}`,
    `First reply: ${(() => { const t = avsAssistantTurns()[0]; return t ? chain(t.node) + (t.node.parentElement ? '' : ' (no parent)') : 'none'; })()}`,
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
  const turns = avsAssistantTurns();
  avsNoteChanges(turns);
  if (avsRecordNeeded(turns)) avsLoadRecord().then(avsInjectPlayers);
  const generating = avsGenerating();
  const reasons = [];
  avsInjectState = { time: Date.now(), reasons };
  turns.forEach(({ turn, node, messageId }, i) => {
    // No bar while the reply is unknown or still being written (a regenerated reply keeps no old bar).
    if (!messageId) {
      avsRemoveBars(turn, node);
      return reasons.push("waiting to match it with ChatGPT's record of the chat");
    }
    if ((generating && i === turns.length - 1) || node.querySelector('.result-streaming')) {
      avsRemoveBars(turn, node);
      return reasons.push('still being written');
    }
    try {
      avsPlaceChatPlayer(turn, node, messageId);
      if (!avsChatPlayers.get(messageId).el.isConnected) reasons.push('bar was added but the page removed it');
    } catch (err) {
      reasons.push('error: ' + (err.message || err));
    }
  });
}

let avsInjectState = { time: 0, reasons: [] };

function avsRemoveBars(turn, node) {
  const bars = [...turn.querySelectorAll('.avs-player')];
  const next = turn.nextElementSibling;
  if (turn === node && next && next.classList.contains('avs-player')) bars.push(next);
  for (const el of bars) {
    for (const p of avsChatPlayers.values()) if (p.el === el) p.audio.pause();
    el.remove();
  }
}

function avsPlaceChatPlayer(turn, node, messageId) {
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
  if (turn !== node) for (const old of turn.querySelectorAll('.avs-player')) if (old !== p.el) old.remove();
  // Under the reply's text (before ChatGPT's own buttons), or at the end of the turn.
  const anchor = avsReplyAnchor(turn, node);
  if (anchor) {
    if (p.el.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', p.el);
  } else if (turn !== node) {
    if (turn.lastElementChild !== p.el) turn.appendChild(p.el);
  } else if (p.el.previousElementSibling !== node) {
    node.insertAdjacentElement('afterend', p.el);
  }
}

// The element holding the reply's text, so the bar goes below the reply. The author marker
// isn't always it (it can be a small label at the top of the reply).
function avsReplyAnchor(turn, node) {
  const len = (el) => avsPageText(el).trim().length; // our bar's own text doesn't count
  const total = len(turn);
  if (node !== turn && len(node) >= total * 0.5) return node;
  let best = null;
  for (const el of turn.querySelectorAll('[data-message-id], .markdown, [class*="markdown"], .prose')) {
    if (el.closest('.avs-player') || el === turn) continue;
    if (len(el) >= total * 0.5) best = el;
  }
  return best;
}

avsWatchPage(avsInjectPlayers);

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
      generating: avsGenerating(),
      reasons: avsInjectState.reasons,
      lastRun: Date.now() - avsInjectState.time
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
