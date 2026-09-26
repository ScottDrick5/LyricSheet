// Runs in the page itself (MAIN world). Watches for audio the site loads or plays —
// ChatGPT/Claude "read aloud" clips — and hands a copy to capture.js.
(() => {
  if (window.__aiVoiceSaverHooked) return;
  window.__aiVoiceSaverHooked = true;

  const MIN_BYTES = 4000; // skip UI blips and empty responses
  const recent = new Map(); // "type:size" -> time, so one clip seen two ways is only kept once

  const emit = (blob, source) => {
    try {
      if (!blob || blob.size < MIN_BYTES) return;
      const key = `${blob.type}:${blob.size}`;
      const now = Date.now();
      if (now - (recent.get(key) || 0) < 30000) return;
      recent.set(key, now);
      window.postMessage({ __aiVoiceSaver: 'clip', blob, source }, location.origin);
    } catch {}
  };

  const isAudio = (type) => /^audio\//i.test(type || '');

  // 1. Audio downloaded with fetch()
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (isAudio(type)) {
        res.clone().blob()
          .then((b) => emit(b.type ? b : new Blob([b], { type }), 'fetch'))
          .catch(() => {});
      }
    } catch {}
    return res;
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
})();
