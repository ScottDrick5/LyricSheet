// Keeps the audio clips page-hook.js spots on this page so the popup can list and save them,
// and passes clips and request notes from a player capture on to claude.js.

const avsClips = [];
const AVS_MAX_CLIPS = 30;
const avsPageListeners = new Set(); // functions called with every message from page-hook.js

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__aiVoiceSaver !== true) return;
  const d = e.data;
  if (d.kind === 'clip' && d.blob instanceof Blob) {
    avsClips.unshift({ id: Date.now() + Math.random(), blob: d.blob, source: d.source, time: Date.now() });
    if (avsClips.length > AVS_MAX_CLIPS) avsClips.length = AVS_MAX_CLIPS;
  }
  for (const fn of avsPageListeners) {
    try { fn(d); } catch {}
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'list-clips') {
    sendResponse({
      site: AVS_SITE,
      clips: avsClips.map((c) => ({ id: c.id, size: c.blob.size, type: c.blob.type, time: c.time }))
    });
  } else if (msg.type === 'download-clip') {
    const clip = avsClips.find((c) => c.id === msg.id);
    if (!clip) { sendResponse({ ok: false, error: 'That clip is no longer available.' }); return; }
    avsVoice().then((voice) => {
      avsDownloadBlob(clip.blob, avsFilename(AVS_SITE, voice, avsExtForType(clip.blob.type)));
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === 'clear-clips') {
    avsClips.length = 0;
    sendResponse({ ok: true });
  }
});
