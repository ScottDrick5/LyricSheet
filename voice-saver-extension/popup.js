const $ = (id) => document.getElementById(id);

let tab = null;
let site = null;
let settings = { ...DEFAULTS };
let timerHandle = null;

function siteFor(url) {
  try {
    const host = new URL(url).hostname;
    if (host === 'claude.ai') return 'claude';
    if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt';
  } catch {}
  return null;
}

function send(msg) {
  return chrome.tabs.sendMessage(tab.id, msg).catch(() => null);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'voice';
}

function currentVoice() {
  const pick = settings[site + 'Voice'];
  if (pick === 'custom') return settings[site + 'CustomVoice'].trim() || 'custom';
  return pick;
}

function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ---------- Voice picker ----------

function fillVoices(list) {
  const select = $('voice');
  const saved = settings[site + 'Voice'];
  select.innerHTML = '';
  for (const v of list) select.add(new Option(v.name, v.id));
  select.add(new Option('Custom…', 'custom'));
  // Keep a saved voice even if it isn't in the list any more.
  if (saved && saved !== 'custom' && !list.some((v) => v.id === saved)) {
    select.add(new Option(saved, saved), select.options.length - 1);
  }
  select.value = saved || list[0].id;
  $('customVoice').hidden = select.value !== 'custom';
}

async function saveSetting(key, value) {
  settings[key] = value;
  await chrome.storage.sync.set({ [key]: value });
}

function initVoicePicker() {
  fillVoices(VOICES[site]);
  $('customVoice').value = settings[site + 'CustomVoice'] || '';
  $('voiceHint').innerHTML = site === 'chatgpt'
    ? 'Replies are downloaded in this voice, whatever voice ChatGPT itself is set to.'
    : 'The player uses this voice if Claude lets it be changed. Otherwise Claude reads in the voice from its own settings, so pick that same one here and your files are named correctly.';

  $('voice').addEventListener('change', async (e) => {
    $('customVoice').hidden = e.target.value !== 'custom';
    if (e.target.value === 'custom') $('customVoice').focus();
    await saveSetting(site + 'Voice', e.target.value);
  });
  $('customVoice').addEventListener('input', (e) => saveSetting(site + 'CustomVoice', e.target.value));

  // ChatGPT can tell us its current voice list; use it if it answers.
  if (site === 'chatgpt') {
    send({ type: 'chatgpt-voices' }).then((res) => {
      if (res && Array.isArray(res.voices) && res.voices.length) fillVoices(res.voices);
    });
  }
}

// ---------- ChatGPT ----------

async function initChatGPT() {
  $('chatgptSection').hidden = false;
  $('format').value = settings.chatgptFormat;
  $('format').addEventListener('change', (e) => saveSetting('chatgptFormat', e.target.value));

  const status = await send({ type: 'chatgpt-status' });
  if (!status) {
    setStatus($('saveAllStatus'), 'Reload the ChatGPT tab to finish setting up the extension.', true);
    $('saveAll').disabled = true;
  } else if (!status.conversation) {
    setStatus($('saveAllStatus'), 'Open a saved chat to save its replies.');
    $('saveAll').disabled = true;
  }

  $('saveAll').addEventListener('click', async () => {
    $('saveAll').disabled = true;
    setStatus($('saveAllStatus'), 'Saving… you can close this popup, downloads will keep going.');
    const res = await send({ type: 'chatgpt-save-all' });
    $('saveAll').disabled = false;
    if (!res) return setStatus($('saveAllStatus'), 'Could not reach the page. Reload the tab and try again.', true);
    const msg = `Saved ${res.saved} of ${res.total} replies.` + (res.errors.length ? ' ' + res.errors[0] : '');
    setStatus($('saveAllStatus'), msg, res.saved === 0 && res.total > 0);
  });
}

// ---------- Claude ----------

function describeDiagnostics(d) {
  if (!d) return 'Press play on a Claude reply first.';
  const lines = [`Result: ${d.result}`, `Checked: ${new Date(d.time).toLocaleString()}`];
  if (d.button) lines.push(`Read-aloud button: "${d.button}"`);
  if (d.buttons) lines.push(`Buttons on the reply: ${d.buttons.map((b) => `"${b}"`).join(', ') || 'none found'}`);
  for (const r of d.requests || []) {
    if (r.method === 'EVENT') { lines.push('• ' + r.path); continue; }
    const bits = [r.method, r.path];
    if (r.params && r.params.length) bits.push(`params: ${r.params.join(', ')}`);
    if (r.bodyKeys && r.bodyKeys.length) bits.push(`body: ${r.bodyKeys.join(', ')}`);
    if (r.status) bits.push(String(r.status));
    if (r.type) bits.push(r.type);
    if (r.voiceSwapped) bits.push('voice switched');
    lines.push('• ' + bits.join(' · '));
  }
  return lines.join('\n');
}

async function initClaude() {
  $('claudeSection').hidden = false;
  const show = async () => {
    const { claudeDiagnostics } = await chrome.storage.local.get('claudeDiagnostics');
    $('diag').textContent = describeDiagnostics(claudeDiagnostics);
    $('copyDiag').hidden = !claudeDiagnostics;
  };
  await show();
  chrome.storage.local.onChanged.addListener(show);
  $('copyDiag').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('diag').textContent);
    $('copyDiag').textContent = 'Copied';
    setTimeout(() => ($('copyDiag').textContent = 'Copy'), 1500);
  });
}

// ---------- Settings ----------

async function initSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  for (const key of ['showPlayerChatgpt', 'showPlayerClaude']) {
    const box = $(key);
    box.checked = s[key] !== false;
    box.addEventListener('change', () => chrome.storage.sync.set({ [key]: box.checked }));
  }
}

// ---------- Recorder ----------

function showTimer(startedAt) {
  clearInterval(timerHandle);
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('timer').textContent = `● ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  timerHandle = setInterval(tick, 500);
}

async function refreshRecorder() {
  const { recording } = await chrome.storage.session.get('recording');
  const btn = $('record');
  clearInterval(timerHandle);
  $('timer').textContent = '';
  btn.disabled = false;
  if (recording) {
    btn.textContent = 'Stop and save';
    btn.classList.add('on');
    if (recording.tabId !== tab.id) {
      setStatus($('recordStatus'), 'Recording another tab.');
    }
    showTimer(recording.startedAt);
  } else {
    btn.textContent = 'Start recording';
    btn.classList.remove('on');
  }
  return recording;
}

async function initRecorder() {
  await refreshRecorder();
  $('record').addEventListener('click', async () => {
    const btn = $('record');
    btn.disabled = true;
    setStatus($('recordStatus'), '');
    const { recording } = await chrome.storage.session.get('recording');
    let res;
    if (recording) {
      res = await chrome.runtime.sendMessage({ target: 'background', type: 'stop-recording' });
      if (res && res.ok) setStatus($('recordStatus'), 'Saved to your Downloads folder.');
    } else {
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        const filename = `${site}-${slug(currentVoice())}-recording-${stamp()}.webm`;
        res = await chrome.runtime.sendMessage({ target: 'background', type: 'start-recording', streamId, tabId: tab.id, filename });
      } catch (err) {
        res = { ok: false, error: err.message || String(err) };
      }
      if (res && res.ok) setStatus($('recordStatus'), 'Recording. Play the voice now, then come back here to stop.');
    }
    if (!res || !res.ok) setStatus($('recordStatus'), (res && res.error) || 'Something went wrong.', true);
    setTimeout(refreshRecorder, 300);
  });
  chrome.storage.session.onChanged.addListener(refreshRecorder);
}

// ---------- Captured clips ----------

function fmtSize(bytes) {
  return bytes > 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.round(bytes / 1e3) + ' KB';
}

async function refreshClips() {
  const res = await send({ type: 'list-clips' });
  const list = $('clips');
  list.innerHTML = '';
  const clips = (res && res.clips) || [];
  $('clipsEmpty').hidden = clips.length > 0;
  if (!res) $('clipsEmpty').textContent = 'Reload the tab to start catching audio.';
  for (const c of clips) {
    const li = document.createElement('li');
    const label = document.createElement('div');
    const time = new Date(c.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    label.innerHTML = `${time} <span>${(c.type || 'audio').replace('audio/', '').replace('mpeg', 'mp3')} · ${fmtSize(c.size)}</span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Save';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await send({ type: 'download-clip', id: c.id });
      btn.disabled = false;
      btn.textContent = r && r.ok ? 'Saved' : 'Failed';
    });
    li.append(label, btn);
    list.appendChild(li);
  }
}

// ---------- Start ----------

(async () => {
  initSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  site = tab && siteFor(tab.url);
  if (!site) {
    $('unsupported').hidden = false;
    return;
  }
  $('main').hidden = false;
  $('site').textContent = site === 'chatgpt' ? 'ChatGPT' : 'Claude';
  settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

  initVoicePicker();
  if (site === 'chatgpt') initChatGPT();
  if (site === 'claude') initClaude();
  initRecorder();
  refreshClips();
  $('refresh').addEventListener('click', refreshClips);
})();
