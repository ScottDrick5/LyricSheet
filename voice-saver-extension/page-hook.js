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

  // Active capture requested by claude.js: { token, voice, started, media: Set, decoded: [] }
  let capture = null;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__aiVoiceSaverCmd) return;
    const d = e.data;
    if (d.__aiVoiceSaverCmd === 'capture-start') {
      capture = { token: d.token, voice: d.voice, started: Date.now(), media: new Set(), decoded: [], requests: [] };
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

  // 5. Audio played in pieces through the Web Audio API: join the decoded pieces
  //    once they stop arriving.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx && Ctx.prototype.decodeAudioData) {
    const origDecode = Ctx.prototype.decodeAudioData;
    let idleTimer = null;
    Ctx.prototype.decodeAudioData = function (data, ok, fail) {
      const live = captureLive() ? capture : null;
      const promise = origDecode.call(this, data, ok, fail);
      if (live && promise && promise.then) {
        promise.then((buf) => {
          if (capture !== live || !buf) return;
          live.decoded.push(buf);
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (capture === live && live.decoded.length) emit(buffersToWav(live.decoded), 'webaudio');
          }, 2500);
        }, () => {});
      }
      return promise;
    };
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

  function buffersToWav(buffers) {
    const rate = buffers[0].sampleRate;
    const total = buffers.reduce((n, b) => n + b.length, 0);
    const view = new DataView(new ArrayBuffer(44 + total * 2));
    const str = (o, t) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, total * 2, true);
    let o = 44;
    for (const b of buffers) {
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++, o += 2) {
        const v = Math.max(-1, Math.min(1, d[i]));
        view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }
})();
