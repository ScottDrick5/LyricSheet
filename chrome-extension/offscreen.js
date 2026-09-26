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
  // Capturing a tab mutes it; route it back to the speakers through a gain we
  // can turn down to mute the tab mid-recording (the recording isn't affected).
  const monitor = ctx.createGain();
  monitor.gain.value = settings.keepPlaying ? 1 : 0;
  tabSource.connect(monitor).connect(ctx.destination);

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

  const sec = (n) => Math.round(n * SAMPLE_RATE);
  session = {
    ctx, tabStream, micStream, analyser, worklet, monitor, settings,
    frames: 0,            // everything captured this session (excludes paused time)
    maxFrames: settings.autoStopMinutes > 0 ? sec(settings.autoStopMinutes * 60) : Infinity,
    track: null,          // the file currently being written
    trackCount: 0,
    saved: 0,
    saves: Promise.resolve(),
    stopping: null,
    cut: null,            // song change announced; collecting audio to find the exact cut point
    // Split-on-silence
    split: !!settings.splitOnSilence,
    threshold: Math.pow(10, settings.silenceDb / 20),
    gapFrames: sec(settings.silenceSeconds),
    endFrames: settings.endAfterSilenceMinutes > 0 ? sec(settings.endAfterSilenceMinutes * 60) : 0,
    minTrackFrames: sec(5), // shorter blips (clicks, notification sounds) are thrown away
    pending: [],          // quiet chunks held back until we know if it's a gap or just a quiet moment
    quietFrames: 0,
    preroll: [],          // last few quiet chunks before a song starts, so the first note isn't clipped
    idleFrames: 0         // silence since the last song ended
  };
  if (!session.split) session.track = newTrack(session);

  worklet.port.onmessage = (e) => {
    if (e.data.type === 'data' && session && !session.stopping) onChunk(session, e.data.left, e.data.right);
  };

  // Tab closed or navigated somewhere uncapturable: save what we have.
  tabStream.getAudioTracks().forEach((t) => t.addEventListener('ended', finishAndNotify));

  return { ok: true, warning };
}

function newTrack(s) {
  const { format, bitrate } = s.settings;
  const sinks = [];
  if (format === 'mp3' || format === 'both') sinks.push({ ext: 'mp3', sink: new Mp3Sink(bitrate) });
  if (format === 'wav' || format === 'both') sinks.push({ ext: 'wav', sink: new WavSink() });
  return { sinks, frames: 0, number: ++s.trackCount };
}

function writeTrack(track, l16, r16) {
  for (const { sink } of track.sinks) sink.write(l16, r16);
  track.frames += l16.length;
}

function queueSave(s, track) {
  const number = s.split ? track.number : undefined;
  s.saved++;
  // Chain saves so files are handed over in order, even mid-recording.
  s.saves = s.saves.then(async () => {
    for (const { ext, sink } of track.sinks) {
      const url = URL.createObjectURL(sink.finish());
      await chrome.runtime.sendMessage({ target: 'background', type: 'save', url, ext, track: number }).catch(() => {});
    }
  });
}

// A song just went quiet for long enough: close its file and save it.
function endTrack(s) {
  const track = s.track;
  // Keep a short tail so the natural decay of the last note isn't chopped off.
  for (const [l, r] of s.pending.slice(0, 3)) writeTrack(track, l, r);
  s.idleFrames = s.quietFrames;
  s.track = null;
  s.pending = [];
  s.quietFrames = 0;
  s.preroll = [];
  if (track.frames >= s.minTrackFrames) queueSave(s, track);
  else s.trackCount--; // too short to be a song, reuse its number
}

// The page switched songs (reported by the song watcher). Cut there even if
// there was no silent gap, as happens when a playlist runs straight on.
// The page announces the change a little before that audio reaches us, so
// collect the next moment of sound and cut at its quietest point: the gap
// between the old song ending and the new one starting.
const CUT_WINDOW = Math.round(0.6 * SAMPLE_RATE);

function songChange() {
  const s = session;
  if (!s || !s.split || s.stopping || !s.track || s.cut) return { ok: true };
  // A track this young already belongs to the new song (its audio beat the
  // page's announcement), so keep it going.
  if (s.track.frames < s.minTrackFrames) return { ok: true };
  for (const [l, r] of s.pending) writeTrack(s.track, l, r);
  s.pending = [];
  s.quietFrames = 0;
  s.cut = { chunks: [], frames: 0 };
  return { ok: true };
}

function joinChunks(chunks, ch) {
  const out = new Int16Array(chunks.reduce((n, c) => n + c[ch].length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c[ch], o); o += c[ch].length; }
  return out;
}

function performCut(s) {
  const L = joinChunks(s.cut.chunks, 0);
  const R = joinChunks(s.cut.chunks, 1);
  s.cut = null;
  const block = 480; // 10 ms
  let best = 0;
  let bestEnergy = Infinity;
  for (let b = 0; b + block <= L.length; b += block) {
    let e = 0;
    for (let i = b; i < b + block; i++) e += L[i] * L[i] + R[i] * R[i];
    if (e < bestEnergy) { bestEnergy = e; best = b; }
  }
  const at = best + block / 2;
  writeTrack(s.track, L.subarray(0, at), R.subarray(0, at));
  queueSave(s, s.track);
  s.track = newTrack(s);
  writeTrack(s.track, L.subarray(at), R.subarray(at));
  chrome.runtime.sendMessage({ target: 'background', type: 'trackStart', track: s.track.number }).catch(() => {});
}

function onChunk(s, left, right) {
  const l16 = floatTo16(left);
  const r16 = floatTo16(right);
  s.frames += l16.length;

  if (!s.split) {
    writeTrack(s.track, l16, r16);
  } else if (s.cut) {
    s.cut.chunks.push([l16, r16]);
    s.cut.frames += l16.length;
    if (s.cut.frames >= CUT_WINDOW) performCut(s);
  } else {
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      const v = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (v > peak) peak = v;
    }
    const loud = peak >= s.threshold;

    if (!s.track) {
      if (loud) {
        // Next song starts.
        s.track = newTrack(s);
        for (const [l, r] of s.preroll) writeTrack(s.track, l, r);
        s.preroll = [];
        writeTrack(s.track, l16, r16);
        s.idleFrames = 0;
        chrome.runtime.sendMessage({ target: 'background', type: 'trackStart', track: s.track.number }).catch(() => {});
      } else {
        s.preroll.push([l16, r16]);
        if (s.preroll.length > 3) s.preroll.shift();
        s.idleFrames += l16.length;
        // Playlist is over: nothing has played for a long while after at least one song.
        if (s.saved && s.endFrames && s.idleFrames >= s.endFrames) finishAndNotify();
      }
    } else if (loud) {
      // Only a quiet moment inside the song: keep it.
      for (const [l, r] of s.pending) writeTrack(s.track, l, r);
      s.pending = [];
      s.quietFrames = 0;
      writeTrack(s.track, l16, r16);
    } else {
      s.pending.push([l16, r16]);
      s.quietFrames += l16.length;
      if (s.quietFrames >= s.gapFrames) endTrack(s);
    }
  }

  if (s.frames >= s.maxFrames) finishAndNotify();
}

function stop() {
  if (!session) return Promise.resolve({ ok: true });
  if (session.stopping) return session.stopping;
  const s = session;
  s.stopping = (async () => {
    // Pull the last partial batch out of the worklet before finishing.
    await new Promise((resolve) => {
      s.worklet.port.onmessage = (e) => {
        if (e.data.type === 'data') onChunk(s, e.data.left, e.data.right);
        if (e.data.type === 'flushed') resolve();
      };
      s.worklet.port.postMessage({ type: 'flush' });
      setTimeout(resolve, 1000);
    });
    s.worklet.port.onmessage = null;
    s.tabStream.getTracks().forEach((t) => t.stop());
    if (s.micStream) s.micStream.getTracks().forEach((t) => t.stop());
    await s.ctx.close();
    session = null;

    if (s.cut) {
      for (const [l, r] of s.cut.chunks) writeTrack(s.track, l, r);
      s.cut = null;
    }
    if (s.track) {
      if (s.split) endTrack(s);
      else if (s.track.frames) queueSave(s, s.track);
    }
    await s.saves;
    if (!s.saved) return { ok: false, error: s.split ? 'No songs were detected, so nothing was saved.' : 'Nothing was recorded.' };
    return { ok: true, saved: s.saved };
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
  const t = session.track;
  return {
    recording: true,
    seconds: session.frames / SAMPLE_RATE,
    level: peak,
    split: session.split,
    saved: session.saved,
    trackNumber: t ? t.number : 0,
    trackSeconds: t ? t.frames / SAMPLE_RATE : 0
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  const run = {
    start: () => start(msg.streamId, msg.settings),
    stop,
    setMuted: () => { session && (session.monitor.gain.value = msg.muted ? 0 : 1); return { ok: true }; },
    pause: () => { session && session.worklet.port.postMessage({ type: 'pause' }); return { ok: true }; },
    resume: () => { session && session.worklet.port.postMessage({ type: 'resume' }); return { ok: true }; },
    status,
    songChange
  }[msg.type];
  if (!run) return false;
  Promise.resolve()
    .then(run)
    .then(sendResponse, (err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
