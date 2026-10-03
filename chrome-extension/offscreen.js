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
  finish(tag) {
    const buf = this.encoder.flush();
    if (buf.length) this.chunks.push(new Uint8Array(buf));
    return new Blob(tag ? [tag, ...this.chunks] : this.chunks, { type: 'audio/mpeg' });
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
  finish(tag) {
    return wavBlob(this.chunks, this.bytes, 2, SAMPLE_RATE, tag);
  }
}

// 16-bit PCM WAV from interleaved sample chunks. An optional "id3 " chunk
// after the audio carries the cover art.
function wavBlob(chunks, bytes, channels, rate, tag) {
  const extra = tag ? 8 + tag.size + (tag.size & 1) : 0;
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  h.setUint32(4, 36 + bytes + extra, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);                       // PCM
  h.setUint16(22, channels, true);
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * channels * 2, true);     // byte rate
  h.setUint16(32, channels * 2, true);            // block align
  h.setUint16(34, 16, true);                      // bits per sample
  str(36, 'data');
  h.setUint32(40, bytes, true);
  const parts = [h.buffer, ...chunks];
  if (tag) {
    const ch = new DataView(new ArrayBuffer(8));
    [...'id3 '].forEach((c, i) => ch.setUint8(i, c.charCodeAt(0)));
    ch.setUint32(4, tag.size, true);
    parts.push(ch.buffer, tag);
    if (tag.size & 1) parts.push(new Uint8Array(1)); // chunks are word-aligned
  }
  return new Blob(parts, { type: 'audio/wav' });
}

// ---- Saving the page's original audio file instead of a recording ----------
//
// Exact: no playback timing involved, original quality. Kept as is when its
// format matches the chosen one, otherwise decoded (at its own sample rate,
// no resampling) and converted.

function sniffAudio(b, contentType) {
  const at = (o, s) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (at(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
  if (at(4, 'ftyp')) return 'm4a';
  if (at(0, 'OggS')) return 'ogg';
  if (at(0, 'fLaC')) return 'flac';
  return /^audio\//.test(contentType || '') ? 'audio' : '';
}

// Sample rate from an MP3's first frame header (after any ID3 tag).
function mp3Rate(b) {
  let o = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) o = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  for (; o + 4 < b.length && o < 200000; o++) {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[o + 1] >> 3) & 3;      // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const idx = (b[o + 2] >> 2) & 3;
    if (ver === 1 || idx === 3) continue;
    return [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]][ver][idx];
  }
  return 0;
}

function wavRate(b) {
  return new DataView(b.buffer, b.byteOffset).getUint32(24, true);
}

// Short, private-part-free description of an address, for messages.
function describeUrl(url) {
  if (url.startsWith('data:')) return 'page copy';
  const u = new URL(url);
  const ext = (u.pathname.match(/\.\w+$/) || [''])[0];
  return `${u.host}${ext ? ` …${ext}` : ''}${u.search ? ' (signed)' : ''}`;
}

async function loadOriginal(s, meta) {
  const urls = [];
  if (meta.key && s.originals.has(meta.key)) urls.push(s.originals.get(meta.key));
  if (meta.src) urls.push(meta.src);
  // meta.errors, when given, collects why each address failed (shown to the user).
  const note = (url, why) => meta.errors && meta.errors.push(`${describeUrl(url)}: ${why}`);
  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) { note(url, `HTTP ${res.status}`); continue; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const kind = bytes.length > 10000 && sniffAudio(bytes, res.headers.get('content-type'));
      if (kind) return { bytes, kind };
      note(url, `not audio (${res.headers.get('content-type') || 'unknown type'}, ${bytes.length} bytes)`);
    } catch (err) {
      note(url, err.message || 'network error');
    }
  }
  return null;
}

async function decodeOriginal(orig) {
  let mp4Error = null;
  let rate = (orig.kind === 'mp3' && mp3Rate(orig.bytes)) || (orig.kind === 'wav' && wavRate(orig.bytes)) || 0;
  if (orig.kind === 'm4a') {
    // MP4/M4A (incl. the fragmented kind streaming players use): demux + WebCodecs.
    try {
      return await MP4.decode(orig.bytes);
    } catch (err) {
      mp4Error = err;
      try { rate = MP4.parse(orig.bytes).sampleRate; } catch (e) {}
    }
  }
  rate = rate || SAMPLE_RATE;
  const ctx = new OfflineAudioContext(1, 1, rate);
  return ctx.decodeAudioData(orig.bytes.slice().buffer).catch((err) => {
    throw mp4Error || err;
  });
}

// Decoded samples back to 16-bit; the exact inverse of how 16-bit audio is
// decoded (x / 32768), so 16-bit originals come back sample-for-sample.
function channelsOf(buf) {
  const n = Math.min(2, buf.numberOfChannels);
  return Array.from({ length: n }, (_, c) => {
    const f = buf.getChannelData(c);
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32768)));
    return out;
  });
}

// A WAV original kept byte-for-byte, with the cover art added as an "id3 " chunk.
function wavWithTag(bytes, tag) {
  if (!tag) return new Blob([bytes], { type: 'audio/wav' });
  const head = bytes.slice(0, 8);
  const riff = new DataView(head.buffer).getUint32(4, true);
  const body = bytes.subarray(8, 8 + riff);
  const pad = body.length & 1 ? [new Uint8Array(1)] : [];
  const ch = new DataView(new ArrayBuffer(8));
  [...'id3 '].forEach((c, i) => ch.setUint8(i, c.charCodeAt(0)));
  ch.setUint32(4, tag.size, true);
  const total = riff + pad.length + 8 + tag.size + (tag.size & 1);
  new DataView(head.buffer).setUint32(4, total, true);
  return new Blob([head, body, ...pad, ch.buffer, tag, ...(tag.size & 1 ? [new Uint8Array(1)] : [])], { type: 'audio/wav' });
}

// The original converted to the chosen format ('mp3' or 'wav'), with cover art.
async function originalAs(ext, orig, tag, kbps = 320) {
  if (ext === 'mp3' && orig.kind === 'mp3') {
    // Keep its own tag (it may already carry the cover); otherwise add ours.
    const hasTag = orig.bytes[0] === 0x49 && orig.bytes[1] === 0x44 && orig.bytes[2] === 0x33;
    return new Blob(hasTag || !tag ? [orig.bytes] : [tag, orig.bytes], { type: 'audio/mpeg' });
  }
  if (ext === 'wav' && orig.kind === 'wav') return wavWithTag(orig.bytes, tag);
  const buf = await decodeOriginal(orig);
  const ch = channelsOf(buf);
  if (ext === 'wav') {
    const frames = ch[0].length;
    const inter = new Int16Array(frames * ch.length);
    for (let i = 0; i < frames; i++) for (let c = 0; c < ch.length; c++) inter[i * ch.length + c] = ch[c][i];
    return wavBlob([inter], inter.byteLength, ch.length, buf.sampleRate, tag);
  }
  const enc = new lamejs.Mp3Encoder(ch.length, buf.sampleRate, session ? session.settings.bitrate : kbps);
  const parts = tag ? [tag] : [];
  for (let i = 0; i < ch[0].length; i += 1152 * 64) {
    const out = ch.length === 2
      ? enc.encodeBuffer(ch[0].subarray(i, i + 1152 * 64), ch[1].subarray(i, i + 1152 * 64))
      : enc.encodeBuffer(ch[0].subarray(i, i + 1152 * 64));
    if (out.length) parts.push(new Uint8Array(out));
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

// "Save exact copies": download each song's original file straight from Suno.
// Addresses learned from Suno's own player (see background.js) come first.
const SUNO_AUDIO = (id, learned = []) => [...new Set([
  ...learned.map((p) => p.split('{id}').join(id)),
  `https://cdn1.suno.ai/${id}.mp3`,
  `https://cdn1.suno.ai/${id}.m4a`,
  `https://audiopipe.suno.ai/?item_id=${id}`
])];
const SUNO_COVER = (id) => [`https://cdn2.suno.ai/image_large_${id}.jpeg`, `https://cdn2.suno.ai/image_${id}.jpeg`];

async function grab(songs, settings) {
  const exts = settings.format === 'both' ? ['mp3', 'wav'] : [settings.format];
  const failed = [];
  let detail = '';
  let notes = '';
  let saved = 0;
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    let ok = false;
    const errors = [];
    for (const src of [...new Set([...(song.urls || []), ...SUNO_AUDIO(song.id, settings.learnedAudio)])]) {
      const orig = await loadOriginal({ originals: new Map() }, { src, errors });
      if (!orig) continue;
      const art = await fetchArt([song.img, ...SUNO_COVER(song.id)].filter(Boolean));
      const tag = art ? coverArtTag(art) : null;
      let convertError = '';
      for (const ext of exts) {
        let blob = null;
        try {
          blob = await originalAs(ext, orig, tag, settings.bitrate);
        } catch (err) {
          convertError = err.message || String(err);
          continue;
        }
        await chrome.runtime.sendMessage({ target: 'background', type: 'save', url: URL.createObjectURL(blob), ext, name: song.title }).catch(() => {});
        ok = true;
      }
      if (!ok) {
        // Couldn't convert it: save Suno's file exactly as it is instead.
        const ext = { m4a: 'm4a', ogg: 'ogg', flac: 'flac', mp3: 'mp3', wav: 'wav' }[orig.kind] || 'm4a';
        await chrome.runtime.sendMessage({ target: 'background', type: 'save', url: URL.createObjectURL(new Blob([orig.bytes])), ext, name: song.title }).catch(() => {});
        ok = true;
        if (!notes) notes = `${song.title} saved as the original .${ext}, because it couldn't be converted (${convertError})`;
      }
      break;
    }
    if (ok) saved++;
    else {
      failed.push(song.title);
      if (!detail) detail = `${song.title}: ${errors.join('; ')}`;
    }
    chrome.runtime.sendMessage({ target: 'background', type: 'grabProgress', done: i + 1, total: songs.length, failed: failed.length }).catch(() => {});
  }
  chrome.runtime.sendMessage({ target: 'background', type: 'grabDone', saved, failed, total: songs.length,
    detail: [notes, detail && `${detail} | Suno's player loaded: ${(settings.audioLog || []).slice(0, 3).join(', ') || 'no audio seen yet (play a song on the page first)'}`].filter(Boolean).join(' | ') }).catch(() => {});
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
    maxSongs: settings.maxSongs > 0 ? settings.maxSongs : 0,
    playlistSize: 0,
    // Stems: never split on silence or trim it; files run from song start to song change.
    keepSilence: !!settings.keepSilence,
    hold: [],             // stems: the last few seconds, not yet written, so cuts can land exactly
    cuts: [],             // stems: exact cut points (audio-clock frames) waiting to be applied
    tentative: null,      // stems: a rough cut, used only if the exact timing never arrives
    started: false,
    lastFrame: 0,
    clock: [],            // recent readings of (wall clock - audio clock), for converting times
    useOriginal: settings.useOriginal !== false,
    originals: new Map(), // song key -> the page's in-memory copy of its audio (data: URL)
    exact: 0,             // songs saved from the original file
    latency: settings.captureLatency || 0, // frames between the page playing audio and it arriving here
    calibs: null,         // expected frames of the calibration chirps, while measuring      // how many songs the page's playlist has (from the song watcher)
    done: false,          // playlist finished: ignore any audio that follows
    pending: [],          // quiet chunks held back until we know if it's a gap or just a quiet moment
    quietFrames: 0,
    preroll: [],          // last few quiet chunks before a song starts, so the first note isn't clipped
    idleFrames: 0         // silence since the last song ended
  };
  if (!session.split) session.track = newTrack(session);

  worklet.port.onmessage = (e) => {
    if (e.data.type === 'data' && session && !session.stopping) onChunk(session, e.data.left, e.data.right, e.data.frame);
  };

  // Tab closed or navigated somewhere uncapturable: save what we have.
  tabStream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => finishAndNotify('tabClosed')));

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
    // The song's cover art, embedded in the file.
    const meta = await chrome.runtime.sendMessage({ target: 'background', type: 'trackMeta', track: number }).catch(() => null);
    const art = meta && (await fetchArt(meta.art));
    const tag = art ? coverArtTag(art) : null;
    // The page's original file beats any recording of it.
    const orig = s.split && s.useOriginal && meta && (meta.key || meta.src) ? await loadOriginal(s, meta) : null;
    if (orig) s.exact++;
    for (const { ext, sink } of track.sinks) {
      let blob = null;
      if (orig) blob = await originalAs(ext, orig, tag).catch(() => null);
      const url = URL.createObjectURL(blob || sink.finish(tag));
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
  if (s.maxSongs && s.saved >= s.maxSongs) finishPlaylist(s, 'songLimit');
}

// The playlist is done (song limit reached, or the page moved on to a song
// that isn't in the playlist). Drop whatever came after and stop.
function finishPlaylist(s, reason) {
  if (s.done) return;
  s.done = true;
  if (s.track && s.track.frames < s.minTrackFrames) {
    // The first moments of the unwanted next song: throw them away.
    s.track = null;
    s.trackCount--;
  }
  s.pending = [];
  finishAndNotify(reason);
}

// The page switched songs (reported by the song watcher). Cut there even if
// there was no silent gap, as happens when a playlist runs straight on.
// The page announces the change a little before that audio reaches us, so
// collect the next moment of sound and cut at its quietest point: the gap
// between the old song ending and the new one starting.
const CUT_WINDOW = Math.round(0.6 * SAMPLE_RATE);

// final: the new song isn't part of the playlist, so end the recording at the cut.
function songChange(final) {
  const s = session;
  if (!s || !s.split || s.stopping || s.done) return { ok: true };
  if (s.cut) { s.cut.final = s.cut.final || final; return { ok: true }; }
  // No song in progress, or one so young it already belongs to the new song
  // (its audio beat the page's announcement).
  if (!s.track || s.track.frames < SAMPLE_RATE * 1.5) {
    if (final) finishPlaylist(s, 'playlistEnd');
    return { ok: true };
  }
  for (const [l, r] of s.pending) writeTrack(s.track, l, r);
  s.pending = [];
  s.quietFrames = 0;
  s.cut = { chunks: [], frames: 0, final };
  return { ok: true };
}

// Stems: the page started playing. Start the file now, not at the first
// sound, so leading silence is kept and stems of the same song line up.
function songStart() {
  const s = session;
  if (!s || !s.split || !s.keepSilence || s.track || s.cut || s.done || s.stopping) return { ok: true };
  // No lead-in: the page reports playback a moment before the audio reaches us.
  s.track = newTrack(s);
  s.preroll = [];
  s.idleFrames = 0;
  chrome.runtime.sendMessage({ target: 'background', type: 'trackStart', track: s.track.number }).catch(() => {});
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
  const final = s.cut.final;
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
  // A few seconds caught from the end of a song that was already playing when
  // recording started isn't worth a file.
  if (s.track.frames >= s.minTrackFrames) queueSave(s, s.track);
  else s.trackCount--;
  s.track = null;
  if (final || (s.maxSongs && s.saved >= s.maxSongs)) {
    finishPlaylist(s, final ? 'playlistEnd' : 'songLimit');
    return;
  }
  s.track = newTrack(s);
  writeTrack(s.track, L.subarray(at), R.subarray(at));
  chrome.runtime.sendMessage({ target: 'background', type: 'trackStart', track: s.track.number }).catch(() => {});
}

function onChunk(s, left, right, frame) {
  if (s.done) return;
  const l16 = floatTo16(left);
  const r16 = floatTo16(right);
  s.frames += l16.length;

  if (s.split && s.keepSilence) {
    noteClock(s);
    stemChunk(s, frame, l16, r16, peakOf(left, right) >= s.threshold);
  } else if (!s.split) {
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
        if (s.saved && s.endFrames && s.idleFrames >= s.endFrames) finishAndNotify('silence');
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
      if (!s.keepSilence) {
        if (s.quietFrames >= s.gapFrames) endTrack(s);
      } else if (s.endFrames && s.quietFrames >= s.endFrames) {
        // Silent for so long the playlist must be over: save without that silence.
        endTrack(s);
        if (!s.done) finishAndNotify('silence');
      } else if (!s.endFrames) {
        // Silence inside a stem is part of it. (With "Stop after silence" on, it
        // is held back until sound returns, in case it turns out to be the end.)
        for (const [l, r] of s.pending) writeTrack(s.track, l, r);
        s.pending = [];
      }
    }
  }

  if (s.frames >= s.maxFrames) finishAndNotify('autoStop');
}

// ---- Stems: sample-accurate cuts -------------------------------------------
//
// The page reports the wall-clock time at which each song's position 0 played.
// That is converted to a frame on this recorder's audio clock and the file is
// cut exactly there. Chrome's capture delay is the same for every song, so it
// shifts all files equally and stems still line up with each other. Audio is
// held back a few seconds before being written, because the timing report
// arrives about a second after the song starts.

const HOLD_FRAMES = 5 * SAMPLE_RATE;
const TENTATIVE_WAIT = 3 * SAMPLE_RATE;

function peakOf(left, right) {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const v = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (v > peak) peak = v;
  }
  return peak;
}

// Wall-clock milliseconds at audio-clock time 0, from the audio output's own timestamps.
function noteClock(s) {
  const ts = s.ctx.getOutputTimestamp ? s.ctx.getOutputTimestamp() : null;
  const offset = ts && ts.performanceTime > 0
    ? performance.timeOrigin + ts.performanceTime - ts.contextTime * 1000
    : performance.timeOrigin + performance.now() - s.ctx.currentTime * 1000;
  s.clock.push(offset);
  if (s.clock.length > 64) s.clock.shift();
}

function frameOf(s, wallMs) {
  if (!s.clock.length) noteClock(s);
  const sorted = [...s.clock].sort((a, b) => a - b);
  const offset = sorted[sorted.length >> 1];
  return Math.round(((wallMs - offset) / 1000) * SAMPLE_RATE);
}

function stemChunk(s, frame, l16, r16, loud) {
  s.hold.push({ frame, l: l16, r: r16, loud });
  s.lastFrame = frame + l16.length;
  if (s.calibs && s.lastFrame > Math.max(...s.calibs) + 0.4 * SAMPLE_RATE) measureLatency(s);
  // A rough cut whose exact timing never came: use it as is.
  if (s.tentative && s.lastFrame - s.tentative.frame >= TENTATIVE_WAIT) {
    addCut(s, s.tentative);
    s.tentative = null;
  }
  drainHold(s, false);
}

function addCut(s, cut) {
  s.cuts.push(cut);
  s.cuts.sort((a, b) => cutFrame(s, a) - cutFrame(s, b));
}

// Exact cuts come from the page's clock, so add the capture delay; rough
// cuts are already in recorded frames.
function cutFrame(s, cut) {
  return cut.exact ? cut.frame + s.latency : cut.frame;
}

// Write out held audio that is old enough, applying any cuts on the way.
function drainHold(s, all) {
  while (s.hold.length && !s.done) {
    const c = s.hold[0];
    const end = c.frame + c.l.length;
    const cut = s.cuts[0];
    const cutAt = cut && cutFrame(s, cut);
    if (cut && cutAt < end) {
      const at = Math.max(0, cutAt - c.frame);
      if (at > 0) {
        stemRelease(s, c.l.subarray(0, at), c.r.subarray(0, at), c.loud);
        c.l = c.l.subarray(at);
        c.r = c.r.subarray(at);
        c.frame += at;
      }
      s.cuts.shift();
      stemCut(s, cut.final);
      continue;
    }
    if (!all && (s.lastFrame - c.frame <= HOLD_FRAMES || (s.tentative && end > s.tentative.frame))) break;
    s.hold.shift();
    stemRelease(s, c.l, c.r, c.loud);
  }
}

// One song ends and the next begins at exactly this point.
function stemCut(s, final) {
  const old = s.track;
  if (old) {
    for (const [l, r] of s.pending) writeTrack(old, l, r);
    s.pending = [];
    s.quietFrames = 0;
    if (old.frames >= SAMPLE_RATE) queueSave(s, old);
    else s.trackCount--;
    s.track = null;
  }
  if (final || (old && s.maxSongs && s.saved >= s.maxSongs)) {
    s.hold = [];
    s.cuts = [];
    s.tentative = null;
    finishPlaylist(s, final ? 'playlistEnd' : 'songLimit');
    return;
  }
  s.started = true;
  s.track = newTrack(s);
  s.idleFrames = 0;
  chrome.runtime.sendMessage({ target: 'background', type: 'trackStart', track: s.track.number }).catch(() => {});
}

// Audio leaving the hold: into the current file, keeping silences (but
// holding a long final silence back in case the playlist is over).
function stemRelease(s, l16, r16, loud) {
  if (!l16.length) return;
  if (!s.track) {
    s.idleFrames += l16.length;
    if (s.saved && s.endFrames && s.idleFrames >= s.endFrames) finishAndNotify('silence');
    return;
  }
  if (loud) {
    for (const [l, r] of s.pending) writeTrack(s.track, l, r);
    s.pending = [];
    s.quietFrames = 0;
    writeTrack(s.track, l16, r16);
    return;
  }
  s.pending.push([l16, r16]);
  s.quietFrames += l16.length;
  if (s.endFrames && s.quietFrames >= s.endFrames) {
    endTrack(s);
    if (!s.done) finishAndNotify('silence');
  } else if (!s.endFrames) {
    for (const [l, r] of s.pending) writeTrack(s.track, l, r);
    s.pending = [];
  }
}

// ---- Stems: measuring the capture delay -------------------------------------

const CHIRP = (() => {
  // The same 40 ms 17-19 kHz chirp the page plays, as in-phase and quadrature
  // templates so the match doesn't depend on its phase.
  const n = Math.round(0.04 * SAMPLE_RATE);
  const i = new Float32Array(n);
  const q = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = k / SAMPLE_RATE;
    const env = Math.min(1, t / 0.005, (0.04 - t) / 0.005);
    const ph = 2 * Math.PI * (17000 * t + 25000 * t * t);
    i[k] = env * Math.cos(ph);
    q[k] = env * Math.sin(ph);
  }
  return { i, q, n };
})();

// Mono samples for a span of recorded frames, from the hold buffer.
function holdSlice(s, from, to) {
  const out = new Float32Array(Math.max(0, to - from));
  for (const c of s.hold) {
    for (let k = Math.max(from, c.frame); k < Math.min(to, c.frame + c.l.length); k++) {
      out[k - from] = (c.l[k - c.frame] + c.r[k - c.frame]) / 65536;
    }
  }
  return out;
}

function measureLatency(s) {
  const found = [];
  for (const expected of s.calibs) {
    const from = expected - Math.round(0.03 * SAMPLE_RATE);
    const x = holdSlice(s, from, expected + Math.round(0.3 * SAMPLE_RATE) + CHIRP.n);
    let best = 0;
    let bestAt = -1;
    let energy = 0;
    for (let k = 0; k < CHIRP.n && k < x.length; k++) energy += x[k] * x[k];
    for (let off = 0; off + CHIRP.n <= x.length; off++) {
      let a = 0;
      let b = 0;
      for (let k = 0; k < CHIRP.n; k += 1) {
        a += x[off + k] * CHIRP.i[k];
        b += x[off + k] * CHIRP.q[k];
      }
      const m = a * a + b * b;
      // Normalized match, so loud music elsewhere can't fake a chirp.
      const score = m / Math.max(1e-12, energy * (CHIRP.n / 2));
      if (score > best) { best = score; bestAt = off; }
      if (off + CHIRP.n < x.length) energy += x[off + CHIRP.n] ** 2 - x[off] ** 2;
    }
    if (best > 0.5) found.push(from + bestAt - expected);
  }
  s.calibs = null;
  if (found.length < 2) return;
  found.sort((a, b) => a - b);
  // Use it only if the chirps agree with each other (within 3 ms).
  if (found[found.length - 1] - found[0] > 0.003 * SAMPLE_RATE) return;
  s.latency = found[found.length >> 1];
  chrome.runtime.sendMessage({ target: 'background', type: 'saveLatency', frames: s.latency }).catch(() => {});
}

function stemCalib(walls) {
  const s = session;
  if (!s || !s.keepSilence || s.done || !walls || !walls.length) return { ok: true };
  s.calibs = walls.map((w) => frameOf(s, w));
  return { ok: true };
}

// The exact moment this song's position 0 played, measured by the page.
function stemTiming(zero, final) {
  const s = session;
  if (!s || !s.split || !s.keepSilence || s.done || s.stopping) return { ok: true };
  s.tentative = null;
  const frame = frameOf(s, zero);
  // Replace a rough cut already made for this song change.
  const near = s.cuts.find((c) => !c.exact && Math.abs(c.frame - (frame + s.latency)) < SAMPLE_RATE);
  if (near) {
    s.cuts.splice(s.cuts.indexOf(near), 1);
    final = final || near.final;
  }
  addCut(s, { frame, final, exact: true });
  drainHold(s, false);
  return { ok: true };
}

// Rough fallbacks from the page's song reports, used only if no exact timing follows.
function stemSongStart() {
  const s = session;
  if (!s || s.done || s.stopping || s.started || s.tentative || s.cuts.length) return { ok: true };
  s.tentative = { frame: s.lastFrame, final: false };
  return { ok: true };
}

function stemSongChange(final) {
  const s = session;
  if (!s || s.done || s.stopping) return { ok: true };
  if (!s.started && !s.cuts.length && !s.tentative) {
    if (final) finishPlaylist(s, 'playlistEnd');
    return { ok: true };
  }
  if (s.tentative) s.tentative.final = s.tentative.final || final;
  else s.tentative = { frame: s.lastFrame, final };
  return { ok: true };
}

function stop() {
  if (!session) return Promise.resolve({ ok: true });
  if (session.stopping) return session.stopping;
  const s = session;
  s.stopping = (async () => {
    // Pull the last partial batch out of the worklet before finishing.
    await new Promise((resolve) => {
      s.worklet.port.onmessage = (e) => {
        if (e.data.type === 'data') onChunk(s, e.data.left, e.data.right, e.data.frame);
        if (e.data.type === 'flushed') resolve();
      };
      s.worklet.port.postMessage({ type: 'flush' });
      setTimeout(resolve, 1000);
    });
    s.worklet.port.onmessage = null;
    if (s.split && s.keepSilence && !s.done) {
      if (s.tentative) { addCut(s, s.tentative); s.tentative = null; }
      drainHold(s, true);
    }
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
    return { ok: true, saved: s.saved, exact: s.exact };
  })();
  return s.stopping;
}

async function finishAndNotify(reason) {
  if (!session || session.stopping) return;
  const res = await stop();
  chrome.runtime.sendMessage({ target: 'background', type: 'ended', reason, saved: (res && res.saved) || 0, exact: (res && res.exact) || 0 });
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
    exact: session.exact,
    playlistSize: session.playlistSize,
    maxSongs: session.maxSongs,
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
    songChange: () => (session && session.keepSilence ? stemSongChange(!!msg.final) : songChange(!!msg.final)),
    songStart: () => (session && session.keepSilence ? stemSongStart() : songStart()),
    songTiming: () => stemTiming(msg.zero, !!msg.final),
    calib: () => stemCalib(msg.walls),
    grab: () => { grab(msg.songs, msg.settings); return { ok: true }; },
    original: () => {
      if (session) {
        session.originals.set(msg.key, msg.dataUrl);
        if (session.originals.size > 8) session.originals.delete(session.originals.keys().next().value);
      }
      return { ok: true };
    },
    playlistInfo: () => { if (session) session.playlistSize = msg.size; return { ok: true }; }
  }[msg.type];
  if (!run) return false;
  Promise.resolve()
    .then(run)
    .then(sendResponse, (err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
