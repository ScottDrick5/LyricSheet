// Runs in the page itself (MAIN world). Watches for audio the site loads or plays —
// ChatGPT/Claude "read aloud" clips — and hands a copy to capture.js.
// When claude.js asks for a capture (our player pressed Claude's read-aloud button), it also:
//  - switches any voice setting in Claude's request to the voice picked in the extension,
//  - mutes Claude's own playback so the audio plays in our player instead,
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
    }
  });

  const captureLive = () => capture && Date.now() - capture.started < 120000;

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

  const emit = (blob, source) => {
    try {
      if (!blob || blob.size < MIN_BYTES) return;
      const token = captureLive() ? capture.token : null;
      const key = `${blob.type}:${blob.size}`;
      const now = Date.now();
      if (!token && now - (recent.get(key) || 0) < 30000) return;
      recent.set(key, now);
      post({ kind: 'clip', blob, source, token });
      if (token) endCapture();
    } catch {}
  };

  const isAudio = (type) => /^audio\//i.test(type || '');
  const looksLikeSpeech = (url) => /tts|speech|speak|audio|voice|read[-_]?aloud|synthes/i.test(url || '');
  const VOICE_KEYS = ['voice', 'voice_id', 'voiceId', 'voice_name', 'voiceName', 'speaker'];

  // Swap the voice in a URL's query string. Returns the new URL, or null if it has no voice setting.
  function swapVoiceInUrl(url, voice) {
    try {
      const u = new URL(url, location.href);
      const k = VOICE_KEYS.find((key) => u.searchParams.has(key));
      if (!k) return null;
      u.searchParams.set(k, voice);
      return u.toString();
    } catch { return null; }
  }

  // Swap the voice in a JSON body (top level or one level down). Returns the new body or null.
  function swapVoiceInBody(body, voice) {
    if (typeof body !== 'string' || !body.trim().startsWith('{')) return null;
    try {
      const obj = JSON.parse(body);
      let hit = false;
      const visit = (o) => {
        for (const k of VOICE_KEYS) if (typeof o[k] === 'string') { o[k] = voice; hit = true; }
      };
      visit(obj);
      for (const v of Object.values(obj)) if (v && typeof v === 'object' && !Array.isArray(v)) visit(v);
      return hit ? JSON.stringify(obj) : null;
    } catch { return null; }
  }

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
    let swapped = false;
    let info = null;
    try {
      if (captureLive()) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
        const body = init && init.body;
        if (Date.now() - capture.started < 8000 && !/\/(sentry|statsig|events|analytics|log)/i.test(url)) {
          info = describe(method, url, body);
          if (capture.voice && looksLikeSpeech(url)) {
            const newUrl = swapVoiceInUrl(url, capture.voice);
            const newBody = swapVoiceInBody(body, capture.voice);
            if (newUrl || newBody) {
              let nextInput = input;
              if (newUrl) nextInput = input instanceof Request ? new Request(newUrl, input) : newUrl;
              args = [nextInput, newBody ? { ...init, body: newBody } : init];
              swapped = true;
            }
          }
        }
      }
    } catch {
      args = arguments;
      swapped = false;
    }
    const promise = origFetch.apply(this, args);
    promise.then((res) => {
      try {
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (info) noteRequest(info, { status: res.status, type, voiceSwapped: swapped });
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
          const swappedUrl = capture.voice && swapVoiceInUrl(src, capture.voice);
          if (swappedUrl) { url = swappedUrl; this.src = swappedUrl; }
          noteRequest(describe('GET', src), { type: 'media element', voiceSwapped: !!swappedUrl });
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
        const swapped = swapVoiceInUrl(url, capture.voice);
        if (swapped) { arguments[1] = swapped; this.__avs.swapped = true; }
      }
    } catch {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const x = this.__avs;
      if (x && captureLive() && Date.now() - capture.started < 8000) {
        let swappedBody = null;
        if (capture.voice && looksLikeSpeech(x.url)) swappedBody = swapVoiceInBody(body, capture.voice);
        const info = describe(x.method, x.url, body);
        this.addEventListener('load', () => {
          try {
            const type = (this.getResponseHeader('content-type') || '').split(';')[0].trim();
            noteRequest(info, { status: this.status, type: type + ' (XHR)', voiceSwapped: !!(x.swapped || swappedBody) });
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

  // 6. WebSocket: audio pushed from the server in pieces.
  if (window.WebSocket) {
    const OrigWS = window.WebSocket;
    window.WebSocket = new Proxy(OrigWS, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        try {
          if (captureLive()) noteEvent(`WebSocket opened: ${describe('WS', String(args[0])).path}`);
          ws.addEventListener('message', (e) => {
            const live = captureLive() ? capture : null;
            if (!live) return;
            live.ws = live.ws || { parts: [], messages: 0 };
            live.ws.messages++;
            const add = (u8) => {
              live.ws.parts.push(u8);
              whenIdle(live, 'ws', 3000, () => {
                noteEvent(`WebSocket: ${live.ws.messages} messages`);
                tryAudioBytes(live.ws.parts, 'WebSocket');
              });
            };
            if (e.data instanceof ArrayBuffer) add(new Uint8Array(e.data));
            else if (e.data instanceof Blob) e.data.arrayBuffer().then((b) => add(new Uint8Array(b)));
            else if (typeof e.data === 'string') base64Chunks(e.data).forEach(add);
          });
        } catch {}
        return ws;
      }
    });
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

  // 8. Web Audio: collect every buffer the page plays, join them once they stop arriving.
  //    Also collect raw samples the page streams to an AudioWorklet.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx && window.AudioBufferSourceNode) {
    const origStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function () {
      try {
        const live = captureLive() ? capture : null;
        if (live && this.buffer) {
          if (!live.pcm) noteEvent('Web Audio buffers');
          live.pcm = live.pcm || { rate: this.buffer.sampleRate, chunks: [] };
          live.pcm.chunks.push(this.buffer.getChannelData(0).slice());
          whenIdle(live, 'pcm', 3000, () => emit(pcmToWav(live.pcm.chunks, live.pcm.rate), 'webaudio'));
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
              whenIdle(live, 'worklet', 3000, () => emit(pcmToWav(live.worklet.chunks, live.worklet.rate), 'worklet'));
            }
          }
        } catch {}
        return origPost.apply(this, arguments);
      };
    }

    // Mute Web Audio output during a capture so only our player is heard.
    const origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest) {
      try {
        if (captureLive() && dest instanceof AudioDestinationNode) {
          const gain = this.context.createGain();
          gain.gain.value = 0;
          origConnect.call(gain, dest);
          return origConnect.call(this, gain);
        }
      } catch {}
      return origConnect.apply(this, arguments);
    };
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
