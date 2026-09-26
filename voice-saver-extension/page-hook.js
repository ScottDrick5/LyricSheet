// Runs in the page itself (MAIN world). Watches for audio the site loads or plays —
// ChatGPT/Claude "read aloud" clips — and hands a copy to capture.js.
// When claude.js asks for a capture (our player pressed Claude's read-aloud button), it also:
//  - switches any voice setting in Claude's request to the voice picked in the extension,
//  - mutes Claude's own playback when it arrives as a whole file (it then plays in our player),
//    or records it while it plays when Claude streams it,
//  - notes what the request looked like, for the popup's diagnostics line.
(() => {
  if (window.__aiVoiceSaverHooked) return;
  window.__aiVoiceSaverHooked = true;

  const MIN_BYTES = 4000; // skip UI blips and empty responses
  const recent = new Map(); // "type:size" -> time, so one clip seen two ways is only kept once
  const post = (data) => window.postMessage({ __aiVoiceSaver: true, ...data }, location.origin);

  // Active capture requested by claude.js: { token, voice, started, media: Set, ... }
  let capture = null;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__aiVoiceSaverCmd) return;
    const d = e.data;
    if (d.__aiVoiceSaverCmd === 'capture-start') {
      capture = { token: d.token, voice: d.voice, started: Date.now(), media: new Set(), requests: [] };
      post({ kind: 'capture-ready', token: d.token });
    } else if (d.__aiVoiceSaverCmd === 'capture-cancel' && capture && capture.token === d.token) {
      endCapture();
    } else if (d.__aiVoiceSaverCmd === 'capture-finish' && capture && capture.token === d.token) {
      finishStream(capture) || endCapture();
    }
  });

  // Streamed read-aloud plays in real time, so a capture can last as long as the reply.
  const captureLive = () => capture && Date.now() - capture.started < 30 * 60 * 1000;

  // Claude may start its own playback just after we've caught the audio; keep it quiet briefly.
  let quietUntil = 0;

  function endCapture() {
    if (!capture) return;
    for (const m of capture.media) {
      // A play() still starting pauses itself once it has started (pausing now makes it throw).
      if (!m.__avsStarting) try { m.pause(); m.muted = false; } catch {}
    }
    capture = null;
    quietUntil = Date.now() + 4000;
  }

  // `heard`: the audio was audible while it was caught (streamed), so the player shouldn't replay it.
  const emit = (blob, source, heard = false) => {
    try {
      if (!blob || blob.size < MIN_BYTES) return;
      const token = captureLive() ? capture.token : null;
      const key = `${blob.type}:${blob.size}`;
      const now = Date.now();
      if (!token && now - (recent.get(key) || 0) < 30000) return;
      recent.set(key, now);
      post({ kind: 'clip', blob, source, token, heard });
      if (token) endCapture();
    } catch {}
  };

  const isAudio = (type) => /^audio\//i.test(type || '');
  const looksLikeSpeech = (url) => /tts|speech|speak|audio|voice|read[-_]?aloud|synthes/i.test(url || '');
  const VOICE_KEYS = ['voice', 'voice_id', 'voiceId', 'voice_name', 'voiceName', 'speaker'];

  // Only swap values that look like a voice name ("buttery"), never ids or settings we don't understand.
  const nameLike = (v) => typeof v === 'string' && /^[a-z][a-z _-]{1,24}$/i.test(v);

  // Swap the voice in a URL's query string.
  // Returns { url, from } when swapped, { skipped: value } when left alone, or null if there's none.
  function swapVoiceInUrl(url, voice) {
    try {
      const u = new URL(url, location.href);
      const k = VOICE_KEYS.find((key) => u.searchParams.has(key));
      if (!k) return null;
      const from = u.searchParams.get(k);
      if (!nameLike(from)) return { skipped: from };
      u.searchParams.set(k, voice);
      return { url: u.toString(), from };
    } catch { return null; }
  }

  // Swap the voice in a JSON body (up to three levels down). Same return shape, with `body`.
  function swapVoiceInBody(body, voice) {
    if (typeof body !== 'string' || !body.trim().startsWith('{')) return null;
    try {
      const obj = JSON.parse(body);
      let from = null;
      let skipped = null;
      const visit = (o, depth) => {
        for (const [k, v] of Object.entries(o)) {
          if (VOICE_KEYS.includes(k) && typeof v === 'string') {
            if (nameLike(v)) { from = v; o[k] = voice; } else skipped = v;
          } else if (v && typeof v === 'object' && depth < 3) visit(v, depth + 1);
        }
      };
      visit(obj, 0);
      if (from !== null) return { body: JSON.stringify(obj), from };
      return skipped !== null ? { skipped } : null;
    } catch { return null; }
  }

  // For the diagnostics line: what happened to the voice setting.
  const voiceNote = (r) => (!r ? {} : r.skipped !== undefined ? { voiceLeft: String(r.skipped).slice(0, 40) } : { voiceSwapped: true, voiceFrom: r.from });

  // What a request looked like (ids blanked out, values dropped), for the diagnostics line.
  function describe(method, url, body) {
    let path = url;
    let params = [];
    try {
      const u = new URL(url, location.href);
      path = u.pathname;
      params = [...u.searchParams.keys()];
    } catch {}
    path = path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}');
    let bodyKeys = [];
    if (typeof body === 'string' && body.trim().startsWith('{')) {
      try { bodyKeys = Object.keys(JSON.parse(body)); } catch {}
    }
    return { method, path, params, bodyKeys };
  }

  function noteRequest(info, extra) {
    if (!captureLive()) return;
    const entry = { ...info, ...extra };
    capture.requests.push(entry);
    post({ kind: 'request', token: capture.token, request: entry });
  }

  // 1. Audio downloaded with fetch()
  const origFetch = window.fetch;
  // The site's own requests go straight through untouched: the page gets fetch's own promise
  // back, so a request that fails (an ad blocker, a dropped connection) fails exactly as it would
  // without the extension. We only look at the response on the side.
  window.fetch = function (input, init) {
    let args = arguments;
    let swapped = {};
    let info = null;
    try {
      if (captureLive()) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
        const body = init && init.body;
        if (Date.now() - capture.started < 8000 && !/\/(sentry|statsig|events|analytics|log)/i.test(url)) {
          info = describe(method, url, body);
          if (capture.voice && looksLikeSpeech(url)) {
            const u = swapVoiceInUrl(url, capture.voice);
            const b = swapVoiceInBody(body, capture.voice);
            const newUrl = u && u.url;
            const newBody = b && b.body;
            swapped = voiceNote((u && u.url ? u : null) || (b && b.body ? b : null) || u || b);
            if (newUrl || newBody) {
              let nextInput = input;
              if (newUrl) nextInput = input instanceof Request ? new Request(newUrl, input) : newUrl;
              args = [nextInput, newBody ? { ...init, body: newBody } : init];
            }
          }
        }
      }
    } catch {
      args = arguments;
      swapped = {};
    }
    const promise = origFetch.apply(this, args);
    promise.then((res) => {
      try {
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (info) noteRequest(info, { status: res.status, type, ...swapped });
        if (isAudio(type)) {
          res.clone().blob()
            .then((b) => emit(b.type ? b : new Blob([b], { type }), 'fetch'))
            .catch(() => {});
        } else if (info) {
          inspectResponse(res, res.url, type);
        }
      } catch {}
    }, () => {});
    return promise;
  };

  // 2. Audio turned into a blob: URL for an <audio> element
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreate.apply(this, arguments);
    try {
      if (obj instanceof Blob && isAudio(obj.type)) emit(obj, 'blob');
    } catch {}
    return url;
  };

  // 3. Audio streamed in pieces through MediaSource
  if (window.MediaSource && window.SourceBuffer) {
    const origAdd = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      const sb = origAdd.apply(this, arguments);
      try {
        if (isAudio(mime)) {
          const entry = { type: String(mime).split(';')[0].trim(), parts: [] };
          sb.__avsEntry = entry;
          (this.__avsEntries || (this.__avsEntries = [])).push(entry);
        }
      } catch {}
      return sb;
    };

    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        if (this.__avsEntry) {
          const copy = data instanceof ArrayBuffer
            ? data.slice(0)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
          this.__avsEntry.parts.push(copy);
        }
      } catch {}
      return origAppend.apply(this, arguments);
    };

    const origEnd = MediaSource.prototype.endOfStream;
    MediaSource.prototype.endOfStream = function () {
      try {
        for (const e of this.__avsEntries || []) {
          if (e.parts.length) emit(new Blob(e.parts, { type: e.type }), 'stream');
          e.parts = [];
        }
      } catch {}
      return origEnd.apply(this, arguments);
    };
  }

  // 4. <audio src="https://…"> played straight from a URL. During a capture: switch its voice,
  //    mute it, and download the same URL for our player.
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try {
      if (!captureLive() && Date.now() < quietUntil) {
        const el = this;
        el.muted = true;
        const r = origPlay.apply(el, arguments);
        const stop = () => { try { el.pause(); el.muted = false; } catch {} };
        if (r && r.then) r.then(stop, stop); else stop();
        return r;
      }
      if (captureLive()) {
        capture.media.add(this);
        this.muted = true;
        const src = this.currentSrc || this.src;
        if (!/^https?:/i.test(src)) noteEvent(`<audio> played from ${src ? src.split(':')[0] + ':' : this.srcObject ? 'a live stream' : 'nothing'}`);
        if (/^https?:/i.test(src)) {
          let url = src;
          const sw = capture.voice ? swapVoiceInUrl(src, capture.voice) : null;
          if (sw && sw.url) { url = sw.url; this.src = sw.url; }
          noteRequest(describe('GET', src), { type: 'media element', ...voiceNote(sw) });
          origFetch(url, { credentials: 'include' })
            .then((r) => r.blob())
            .then((b) => emit(b, 'media'))
            .catch(() => {});
        }
        const el = this;
        const live = capture;
        el.__avsStarting = true;
        const r = origPlay.apply(el, arguments);
        const settle = () => {
          el.__avsStarting = false;
          if (capture !== live) try { el.pause(); el.muted = false; } catch {}
        };
        if (r && r.then) r.then(settle, settle); else settle();
        return r;
      }
    } catch {}
    return origPlay.apply(this, arguments);
  };

  // A note for the diagnostics line about how the page produced sound during a capture.
  const noteEvent = (text) => noteRequest({ method: 'EVENT', path: text, params: [], bodyKeys: [] }, {});

  // Runs fn once no more pieces have arrived for `ms` (streamed audio has no clear end).
  function whenIdle(live, name, ms, fn) {
    live.timers = live.timers || {};
    clearTimeout(live.timers[name]);
    live.timers[name] = setTimeout(() => { if (capture === live) fn(); }, ms);
  }

  const concatBytes = (parts) => {
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p instanceof Uint8Array ? p : new Uint8Array(p), o); o += p.byteLength; }
    return out;
  };

  const sniffType = (u8) => {
    const h = (i) => u8[i];
    if (h(0) === 0x49 && h(1) === 0x44 && h(2) === 0x33) return 'audio/mpeg';
    if (h(0) === 0xff && (h(1) & 0xf6) === 0xf0) return 'audio/aac';
    if (h(0) === 0xff && (h(1) & 0xe0) === 0xe0) return 'audio/mpeg';
    if (h(0) === 0x4f && h(1) === 0x67 && h(2) === 0x67 && h(3) === 0x53) return 'audio/ogg';
    if (h(0) === 0x52 && h(1) === 0x49 && h(2) === 0x46 && h(3) === 0x46) return 'audio/wav';
    if (h(0) === 0x66 && h(1) === 0x4c && h(2) === 0x61 && h(3) === 0x43) return 'audio/flac';
    if (h(0) === 0x1a && h(1) === 0x45 && h(2) === 0xdf && h(3) === 0xa3) return 'audio/webm';
    if (h(4) === 0x66 && h(5) === 0x74 && h(6) === 0x79 && h(7) === 0x70) return 'audio/mp4';
    return '';
  };

  // Bytes that might be audio: keep them if the browser can play them.
  async function tryAudioBytes(parts, source) {
    const bytes = concatBytes(parts);
    if (bytes.byteLength < MIN_BYTES) return false;
    try {
      await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.buffer.slice(0));
    } catch {
      noteEvent(`${source}: ${Math.round(bytes.byteLength / 1000)} KB that isn't a playable audio file (starts ${[...bytes.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join(' ')})`);
      return false;
    }
    emit(new Blob([bytes], { type: sniffType(bytes) || 'audio/mpeg' }), source);
    return true;
  }

  // Audio sent as base64 text inside JSON or server-sent events: pull out the long base64 values.
  function base64Chunks(text) {
    const chunks = [];
    const visit = (v, key) => {
      if (typeof v === 'string') {
        if (v.length > 200 && /audio|chunk|data|bytes|content|delta|b64|base64/i.test(key || '') && /^[A-Za-z0-9+/=_-]+$/.test(v)) {
          try {
            const bin = atob(v.replace(/-/g, '+').replace(/_/g, '/'));
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            chunks.push(u8);
          } catch {}
        }
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) visit(x, k);
      }
    };
    for (const line of String(text).split(/\n/)) {
      const t = line.replace(/^data:\s*/, '').trim();
      if (!t.startsWith('{') && !t.startsWith('[')) continue;
      try { visit(JSON.parse(t), ''); } catch {}
    }
    return chunks;
  }

  // Responses during a capture that aren't labelled as audio but may carry it.
  function inspectResponse(res, url, type) {
    if (!captureLive()) return;
    if (!(looksLikeSpeech(url) || /octet-stream|event-stream|ndjson/i.test(type))) return;
    const textual = /json|event-stream|text/i.test(type);
    const read = textual ? res.clone().text().then(base64Chunks) : res.clone().arrayBuffer().then((b) => [new Uint8Array(b)]);
    read.then((parts) => { if (parts.length) tryAudioBytes(parts, textual ? 'base64 in response' : 'response bytes'); }).catch(() => {});
  }

  // 5. XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__avs = { method, url: String(url) };
      if (captureLive() && capture.voice && looksLikeSpeech(url)) {
        const sw = swapVoiceInUrl(url, capture.voice);
        if (sw && sw.url) arguments[1] = sw.url;
        this.__avs.voice = sw;
      }
    } catch {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const x = this.__avs;
      if (x && captureLive() && Date.now() - capture.started < 8000) {
        let bodySwap = null;
        if (capture.voice && looksLikeSpeech(x.url)) bodySwap = swapVoiceInBody(body, capture.voice);
        const swappedBody = bodySwap && bodySwap.body;
        const info = describe(x.method, x.url, body);
        this.addEventListener('load', () => {
          try {
            const type = (this.getResponseHeader('content-type') || '').split(';')[0].trim();
            const vs = (x.voice && x.voice.url ? x.voice : null) || (swappedBody ? bodySwap : null) || x.voice || bodySwap;
            noteRequest(info, { status: this.status, type: type + ' (XHR)', ...voiceNote(vs) });
            const r = this.response;
            if (isAudio(type) || looksLikeSpeech(x.url)) {
              if (r instanceof Blob) r.arrayBuffer().then((b) => tryAudioBytes([new Uint8Array(b)], 'XHR'));
              else if (r instanceof ArrayBuffer) tryAudioBytes([new Uint8Array(r)], 'XHR');
              else if (typeof r === 'string' && r) { const parts = base64Chunks(r); if (parts.length) tryAudioBytes(parts, 'XHR base64'); }
            }
          } catch {}
        });
        if (swappedBody) return origSend.call(this, swappedBody);
      }
    } catch {}
    return origSend.apply(this, arguments);
  };

  // 6. WebSocket: Claude streams read-aloud over one (/api/ws/text_to_speech/…). Switch the voice
  //    in its address or in the settings message the page sends, and keep what the server pushes.
  if (window.WebSocket) {
    const OrigWS = window.WebSocket;
    window.WebSocket = new Proxy(OrigWS, {
      construct(target, args, newTarget) {
        let voice = null;
        try {
          if (captureLive() && looksLikeSpeech(String(args[0]))) {
            if (capture.voice) {
              voice = swapVoiceInUrl(String(args[0]), capture.voice);
              if (voice && voice.url) args = [voice.url.replace(/^http/, 'ws'), ...args.slice(1)];
            }
          }
        } catch {}
        const ws = Reflect.construct(target, args, newTarget);
        try {
          ws.__avsSpeech = looksLikeSpeech(String(args[0]));
          ws.__avsSent = 0;
          if (captureLive()) {
            const d = describe('WS', String(args[0]));
            noteEvent(`WebSocket opened: ${d.path}${d.params.length ? ' (params: ' + d.params.join(', ') + ')' : ''}${voice ? ' ' + JSON.stringify(voiceNote(voice)) : ''}`);
          }
          ws.addEventListener('message', (e) => {
            const live = captureLive() ? capture : null;
            if (!live || !ws.__avsSpeech) return;
            live.ws = live.ws || { parts: [], messages: 0, text: 0 };
            live.ws.messages++;
            const add = (u8) => {
              live.ws.parts.push(u8);
              // Only needed when the page doesn't play it through Web Audio (that's caught below).
              whenIdle(live, 'ws', 4000, () => { if (!live.pcm) tryAudioBytes(live.ws.parts, 'WebSocket'); });
            };
            if (e.data instanceof ArrayBuffer) add(new Uint8Array(e.data));
            else if (e.data instanceof Blob) e.data.arrayBuffer().then((b) => add(new Uint8Array(b)));
            else if (typeof e.data === 'string') {
              live.ws.text++;
              if (live.ws.text <= 2) noteEvent(`WebSocket received: ${summarize(e.data)}`);
              base64Chunks(e.data).forEach(add);
            }
          });
        } catch {}
        return ws;
      }
    });

    const origWsSend = OrigWS.prototype.send;
    OrigWS.prototype.send = function (data) {
      try {
        if (this.__avsSpeech && captureLive()) {
          this.__avsSent++;
          if (typeof data === 'string') {
            const sw = capture.voice ? swapVoiceInBody(data, capture.voice) : null;
            if (this.__avsSent <= 3) noteEvent(`WebSocket sent: ${summarize(data)}${sw ? ' ' + JSON.stringify(voiceNote(sw)) : ''}`);
            if (sw && sw.body) return origWsSend.call(this, sw.body);
          } else if (this.__avsSent <= 3) {
            const n = data && (data.byteLength || data.size || 0);
            noteEvent(`WebSocket sent: ${n} bytes of binary data`);
          }
        }
      } catch {}
      return origWsSend.apply(this, arguments);
    };
  }

  // A JSON message's shape for the diagnostics: its keys, plus the value of any voice setting.
  // No text content is included.
  function summarize(text) {
    try {
      const obj = JSON.parse(text);
      const keys = [];
      const voices = [];
      const visit = (o, prefix, depth) => {
        for (const [k, v] of Object.entries(o)) {
          keys.push(prefix + k);
          if (VOICE_KEYS.includes(k) && typeof v === 'string') voices.push(`${k}=${v.slice(0, 40)}`);
          if (/voice|speaker/i.test(k) && v && typeof v === 'object') voices.push(`${k}=${JSON.stringify(v).slice(0, 80)}`);
          if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) visit(v, prefix + k + '.', depth + 1);
        }
      };
      if (obj && typeof obj === 'object') visit(obj, '', 0);
      return `{${keys.slice(0, 15).join(', ')}}${voices.length ? ' voice: ' + voices.join(', ') : ''}`;
    } catch {
      return `${text.length} characters of non-JSON text`;
    }
  }

  // 7. Browser text-to-speech: sound made by the operating system, not by the page.
  if (window.speechSynthesis && window.SpeechSynthesis) {
    const origSpeak = SpeechSynthesis.prototype.speak;
    SpeechSynthesis.prototype.speak = function (utterance) {
      try {
        if (captureLive()) {
          const voice = utterance && utterance.voice ? utterance.voice.name : 'default';
          noteEvent(`Browser speech (speechSynthesis), voice: ${voice}`);
          post({ kind: 'speech', token: capture.token, voice });
        }
      } catch {}
      return origSpeak.apply(this, arguments);
    };
  }

  // 8. Web Audio: collect every buffer the page plays while it plays (audible, in real time).
  //    Finished once every started piece has ended and nothing new has started for a moment.
  //    Also collect raw samples the page streams to an AudioWorklet.
  function finishStream(live) {
    if (!live || capture !== live) return false;
    const src = live.pcm && live.pcm.chunks.length ? live.pcm : live.worklet && live.worklet.chunks.length ? live.worklet : null;
    if (!src) return false;
    emit(pcmToWav(src.chunks, src.rate), src === live.pcm ? 'webaudio' : 'worklet', true);
    return true;
  }

  function streamProgress(live, src) {
    const secs = Math.floor(src.chunks.reduce((n, c) => n + c.length, 0) / src.rate);
    if (secs !== src.lastSecs) {
      src.lastSecs = secs;
      post({ kind: 'progress', token: live.token, seconds: secs });
    }
  }

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx && window.AudioBufferSourceNode) {
    const origStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function () {
      try {
        const live = captureLive() ? capture : null;
        if (live && this.buffer) {
          if (!live.pcm) {
            noteEvent(`Web Audio buffers (${this.buffer.sampleRate} Hz, ${this.buffer.numberOfChannels} channel)`);
            live.pcm = { rate: this.buffer.sampleRate, chunks: [], playing: new Set(), lastStart: 0 };
            const timer = setInterval(() => {
              if (capture !== live) return clearInterval(timer);
              const pcm = live.pcm;
              const closed = this.context && this.context.state === 'closed';
              if ((pcm.playing.size === 0 && Date.now() - pcm.lastStart > 2500) || closed) {
                clearInterval(timer);
                finishStream(live);
              }
            }, 500);
          }
          const pcm = live.pcm;
          pcm.chunks.push(this.buffer.getChannelData(0).slice());
          pcm.lastStart = Date.now();
          pcm.playing.add(this);
          this.addEventListener('ended', () => pcm.playing.delete(this));
          streamProgress(live, pcm);
        }
      } catch {}
      return origStart.apply(this, arguments);
    };

    if (window.AudioWorkletNode) {
      const OrigNode = window.AudioWorkletNode;
      window.AudioWorkletNode = new Proxy(OrigNode, {
        construct(target, args, newTarget) {
          const node = Reflect.construct(target, args, newTarget);
          try { node.port.__avsRate = args[0].sampleRate; } catch {}
          return node;
        }
      });
      const origPost = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function (msg) {
        try {
          const live = this.__avsRate && captureLive() ? capture : null;
          if (live) {
            const found = [];
            const visit = (v, depth) => {
              if (v instanceof Float32Array) found.push(v.slice());
              else if (v instanceof Int16Array) found.push(Float32Array.from(v, (x) => x / 32768));
              else if (v && typeof v === 'object' && depth < 2 && !(v instanceof ArrayBuffer)) Object.values(v).forEach((x) => visit(x, depth + 1));
            };
            visit(msg, 0);
            if (found.length) {
              if (!live.worklet) noteEvent('AudioWorklet samples');
              live.worklet = live.worklet || { rate: this.__avsRate, chunks: [] };
              live.worklet.chunks.push(...found);
              streamProgress(live, live.worklet);
              // Samples usually arrive faster than they play; the worklet may still be playing.
              const secs = live.worklet.chunks.reduce((n, c) => n + c.length, 0) / live.worklet.rate;
              const playedFor = (Date.now() - live.started) / 1000;
              whenIdle(live, 'worklet', 3000 + Math.max(0, secs - playedFor) * 1000, () => finishStream(live));
            }
          }
        } catch {}
        return origPost.apply(this, arguments);
      };
    }
  }

  function pcmToWav(chunks, rate) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const view = new DataView(new ArrayBuffer(44 + total * 2));
    const str = (o, t) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, total * 2, true);
    let o = 44;
    for (const d of chunks) {
      for (let i = 0; i < d.length; i++, o += 2) {
        const v = Math.max(-1, Math.min(1, d[i]));
        view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }
})();
