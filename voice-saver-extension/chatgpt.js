// ChatGPT: adds a "Save voice" button under each reply and downloads it from ChatGPT's
// read-aloud service in the voice picked in the popup.

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

// Downloads one reply. Falls back to AAC if the chosen format is rejected.
async function avsSaveMessage(messageId, suffix = '') {
  const s = await avsSettings();
  // ChatGPT voice ids are lowercase ("ember"), so "Ember" typed as a custom name still works.
  const voice = (await avsVoice('chatgpt')).toLowerCase();
  let format = s.chatgptFormat || 'aac';
  let blob;
  try {
    blob = await avsSynthesize(messageId, voice, format);
  } catch (err) {
    if (format === 'aac') throw err;
    format = 'aac';
    blob = await avsSynthesize(messageId, voice, format);
  }
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

function avsMakeButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'avs-save-btn';
  btn.title = 'Save this reply as audio (AI Voice Saver)';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1Zm-8 15a1 1 0 0 1 1 1v1h14v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z"/></svg>' +
    '<span>Voice</span>';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.messageId;
    if (!id || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('avs-busy');
    try {
      await avsSaveMessage(id);
      avsToast('Voice saved to your Downloads folder');
    } catch (err) {
      avsToast(err.message || String(err), true);
    } finally {
      btn.disabled = false;
      btn.classList.remove('avs-busy');
    }
  });
  return btn;
}

function avsInjectButtons() {
  for (const { turn, node, messageId } of avsAssistantTurns()) {
    if (!messageId) continue;
    const copyBtn = turn.querySelector('[data-testid="copy-turn-action-button"]');
    let btn = turn.querySelector('.avs-save-btn');
    if (!btn) btn = avsMakeButton();
    btn.dataset.messageId = messageId;

    if (copyBtn && copyBtn.parentElement) {
      // Sit in ChatGPT's own row of reply buttons (copy, read aloud, …).
      if (btn.parentElement !== copyBtn.parentElement) copyBtn.parentElement.appendChild(btn);
      btn.classList.remove('avs-fallback');
    } else if (!btn.isConnected) {
      btn.classList.add('avs-fallback');
      node.insertAdjacentElement('afterend', btn);
    }
  }
}

let avsScanTimer = null;
new MutationObserver(() => {
  clearTimeout(avsScanTimer);
  avsScanTimer = setTimeout(avsInjectButtons, 400);
}).observe(document.documentElement, { childList: true, subtree: true });
avsInjectButtons();

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
    avsListVoices().then((voices) => sendResponse({ voices }), () => sendResponse({ voices: null }));
    return true;
  }
});
