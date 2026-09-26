let recorder = null;
let stream = null;
let audioCtx = null;
let chunks = [];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'start') {
    start(msg.streamId).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err.message || err) })
    );
    return true;
  }
  if (msg.type === 'stop') {
    stop();
    sendResponse({ ok: true });
  }
});

async function start(streamId) {
  if (recorder && recorder.state !== 'inactive') throw new Error('Already recording.');
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });

  // Capturing a tab mutes it, so play the audio back so you can still hear it.
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 192000 });
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    chunks = [];
    stream.getTracks().forEach((t) => t.stop());
    audioCtx.close();
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ target: 'background', type: 'recording-ready', url, size: blob.size });
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  };
  stream.getAudioTracks().forEach((t) => t.addEventListener('ended', stop));
  recorder.start(1000);
}

function stop() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}
