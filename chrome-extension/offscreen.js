// Hidden page that holds the captured stream. Raw samples come in from the
// AudioWorklet and are encoded to MP3 on the fly (and/or kept as 16-bit PCM
// for WAV), so nothing needs converting after you press Stop.

const SAMPLE_RATE = 48000; // LAME supports up to 48 kHz

let session = null;

function floatTo16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

class Mp3Sink {
  constructor(kbps) {
    this.encoder = new lamejs.Mp3Encoder(2, SAMPLE_RATE, kbps);
    this.chunks = [];
  }
  write(l16, r16) {
    const buf = this.encoder.encodeBuffer(l16, r16);
    if (buf.length) this.chunks.push(new Uint8Array(buf));
  }
  finish() {
    const buf = this.encoder.flush();
    if (buf.length) this.chunks.push(new Uint8Array(buf));
    return new Blob(this.chunks, { type: 'audio/mpeg' });
  }
}

class WavSink {
  constructor() {
    this.chunks = [];
    this.bytes = 0;
  }
  write(l16, r16) {
    const inter = new Int16Array(l16.length * 2);
    for (let i = 0; i < l16.length; i++) {
      inter[i * 2] = l16[i];
      inter[i * 2 + 1] = r16[i];
    }
    this.chunks.push(inter);
    this.bytes += inter.byteLength;
  }
  finish() {
    const h = new DataView(new ArrayBuffer(44));
    const str = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    h.setUint32(4, 36 + this.bytes, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    h.setUint32(16, 16, true);
    h.setUint16(20, 1, true);                   // PCM
    h.setUint16(22, 2, true);                   // stereo
    h.setUint32(24, SAMPLE_RATE, true);
    h.setUint32(28, SAMPLE_RATE * 4, true);     // byte rate
    h.setUint16(32, 4, true);                   // block align
    h.setUint16(34, 16, true);                  // bits per sample
    str(36, 'data');
    h.setUint32(40, this.bytes, true);
    return new Blob([h.buffer, ...this.chunks], { type: 'audio/wav' });
  }
}

async function start(streamId, settings) {
  if (session) throw new Error('Already recording.');

  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule('recorder-worklet.js');

  const mix = ctx.createGain();
  const tabSource = ctx.createMediaStreamSource(tabStream);
  tabSource.connect(mix);
  // Capturing a tab mutes it; route it back to the speakers unless asked not to.
  if (settings.keepPlaying) tabSource.connect(ctx.destination);

  let micStream = null;
  let warning = '';
  if (settings.includeMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      ctx.createMediaStreamSource(micStream).connect(mix);
    } catch (err) {
      warning = 'Microphone not available — recording tab audio only. Open the extension\'s "Allow microphone" page first.';
    }
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  mix.connect(analyser);

  const worklet = new AudioWorkletNode(ctx, 'recorder-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: 'explicit'
  });
  mix.connect(worklet);
  // Hook the recorder up to the output through a silent gain so Chrome keeps
  // pulling audio through it even when the tab itself isn't being played back.
  const silent = ctx.createGain();
  silent.gain.value = 0;
  worklet.connect(silent).connect(ctx.destination);

  const sinks = [];
  if (settings.format === 'mp3' || settings.format === 'both') sinks.push({ ext: 'mp3', sink: new Mp3Sink(settings.bitrate) });
  if (settings.format === 'wav' || settings.format === 'both') sinks.push({ ext: 'wav', sink: new WavSink() });

  session = {
    ctx, tabStream, micStream, analyser, worklet, sinks,
    frames: 0,
    peak: 0,
    maxFrames: settings.autoStopMinutes > 0 ? settings.autoStopMinutes * 60 * SAMPLE_RATE : Infinity,
    stopping: null
  };

  worklet.port.onmessage = (e) => {
    if (e.data.type !== 'data' || !session) return;
    const l16 = floatTo16(e.data.left);
    const r16 = floatTo16(e.data.right);
    for (const { sink } of session.sinks) sink.write(l16, r16);
    session.frames += l16.length;
    if (session.frames >= session.maxFrames) finishAndNotify();
  };

  // Tab closed or navigated somewhere uncapturable: save what we have.
  tabStream.getAudioTracks().forEach((t) => t.addEventListener('ended', finishAndNotify));

  return { ok: true, warning };
}

function stop() {
  if (!session) return Promise.resolve({ ok: true });
  if (session.stopping) return session.stopping;
  const s = session;
  s.stopping = (async () => {
    // Pull the last partial batch out of the worklet before finishing.
    await new Promise((resolve) => {
      const done = (e) => { if (e.data.type === 'flushed') resolve(); };
      s.worklet.port.addEventListener('message', done);
      s.worklet.port.postMessage({ type: 'flush' });
      setTimeout(resolve, 1000);
    });
    s.tabStream.getTracks().forEach((t) => t.stop());
    if (s.micStream) s.micStream.getTracks().forEach((t) => t.stop());
    await s.ctx.close();
    session = null;

    if (!s.frames) return { ok: false, error: 'Nothing was recorded.' };
    for (const { ext, sink } of s.sinks) {
      const url = URL.createObjectURL(sink.finish());
      await chrome.runtime.sendMessage({ target: 'background', type: 'save', url, ext });
    }
    return { ok: true };
  })();
  return s.stopping;
}

async function finishAndNotify() {
  if (!session || session.stopping) return;
  await stop();
  chrome.runtime.sendMessage({ target: 'background', type: 'ended' });
}

function status() {
  if (!session) return { recording: false };
  const buf = new Float32Array(session.analyser.fftSize);
  session.analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  return { recording: true, seconds: session.frames / SAMPLE_RATE, level: peak };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  const run = {
    start: () => start(msg.streamId, msg.settings),
    stop,
    pause: () => { session && session.worklet.port.postMessage({ type: 'pause' }); return { ok: true }; },
    resume: () => { session && session.worklet.port.postMessage({ type: 'resume' }); return { ok: true }; },
    status
  }[msg.type];
  if (!run) return false;
  Promise.resolve()
    .then(run)
    .then(sendResponse, (err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
