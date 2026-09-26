// Tab audio recorder: records whatever the ChatGPT/Claude tab plays (works for live
// voice-mode conversations too). The actual recording happens in offscreen.html.

const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Record the audio played by the ChatGPT or Claude tab.'
  });
}

async function getRecording() {
  const { recording } = await chrome.storage.session.get('recording');
  return recording || null;
}

async function setBadge(on) {
  await chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

async function startRecording({ streamId, tabId, filename }) {
  if (await getRecording()) return { ok: false, error: 'Already recording.' };
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId });
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'Could not start recording.' };
  await chrome.storage.session.set({ recording: { tabId, filename, startedAt: Date.now() } });
  await setBadge(true);
  return { ok: true };
}

async function stopRecording() {
  if (!(await getRecording())) return { ok: false, error: 'Not recording.' };
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  return { ok: true };
}

async function recordingReady({ url, size }) {
  const rec = await getRecording();
  await chrome.storage.session.remove('recording');
  await setBadge(false);
  if (!size) return;
  const filename = (rec && rec.filename) || `ai-voice-${Date.now()}.webm`;
  await chrome.downloads.download({ url, filename, saveAs: false });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'background') return;
  const handlers = {
    'start-recording': startRecording,
    'stop-recording': stopRecording,
    'recording-ready': recordingReady
  };
  const fn = handlers[msg.type];
  if (!fn) return;
  fn(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true;
});

// Stop and save if the recorded tab is closed.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRecording();
  if (rec && rec.tabId === tabId) stopRecording();
});

// A service-worker restart can't resume a recording the offscreen page no longer has.
chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.session.remove('recording');
  await setBadge(false);
});
