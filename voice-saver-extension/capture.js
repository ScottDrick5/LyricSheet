// Keeps the audio clips page-hook.js spots on this page so the popup can list and save them.

const avsClips = [];
const AVS_MAX_CLIPS = 30;

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__aiVoiceSaver !== 'clip') return;
  const blob = e.data.blob;
  if (!(blob instanceof Blob)) return;
  avsClips.unshift({ id: Date.now() + Math.random(), blob, source: e.data.source, time: Date.now() });
  if (avsClips.length > AVS_MAX_CLIPS) avsClips.length = AVS_MAX_CLIPS;
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
