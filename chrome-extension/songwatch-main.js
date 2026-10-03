// Injected into the recorded tab's page. Reports what song is playing, from
// the page's media session ("now playing" info) or, on Suno, from the song
// link that matches the audio file being played.
(() => {
  // A watcher left over from an earlier recording (or an older version of the
  // extension) is shut down so this one starts fresh.
  if (typeof window.__audioGrabberWatch === 'function') window.__audioGrabberWatch();
  const startedAt = performance.now();

  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // Audio the page loads into memory and plays from a blob: address. Kept so
  // the original file can be saved instead of a recording of it.
  window.__audioGrabberBlobs = window.__audioGrabberBlobs || new Map();
  if (!window.__audioGrabberBlobHook) {
    window.__audioGrabberBlobHook = true;
    const create = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const url = create.call(URL, obj);
      try {
        if (obj instanceof Blob && obj.size > 10000 && obj.size < 200e6 && (!obj.type || /audio|octet|mpeg|mp4|wav|ogg|flac/.test(obj.type))) {
          window.__audioGrabberBlobs.set(url, obj);
          if (window.__audioGrabberBlobs.size > 30) window.__audioGrabberBlobs.delete(window.__audioGrabberBlobs.keys().next().value);
        }
      } catch (err) {}
      return url;
    };
  }

  // Players kept out of the page (new Audio()) are found by noting every
  // element that gets play() called on it.
  window.__audioGrabberMedia = window.__audioGrabberMedia || new Set();
  if (!window.__audioGrabberPlayHook) {
    window.__audioGrabberPlayHook = true;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      try { window.__audioGrabberMedia.add(this); } catch (err) {}
      return play.apply(this, args);
    };
  }

  // The element playing the music. Muted videos (animated covers, background
  // loops) are ignored, and a real <audio> player wins over any video.
  function currentAudio() {
    const els = [...new Set([...document.querySelectorAll('audio, video'), ...window.__audioGrabberMedia])]
      .filter((el) => !el.muted && el.volume > 0);
    const playing = els.filter((el) => !el.paused);
    return playing.find((el) => el.tagName === 'AUDIO') || playing[0] ||
      els.find((el) => el.tagName === 'AUDIO' && (el.currentSrc || el.src)) || null;
  }

  // A song ID from a URL. Temporary blob: addresses carry a random UUID that
  // has nothing to do with the song, so they don't count.
  function idFrom(url) {
    if (!url || url.startsWith('blob:')) return '';
    const m = url.match(UUID);
    return m ? m[0].toLowerCase() : '';
  }

  function linkTitle(id) {
    for (const a of document.querySelectorAll(`a[href*="${id}"]`)) {
      const text = (a.getAttribute('title') || a.textContent || '').trim();
      if (text && text.length < 150) return text;
    }
    return '';
  }

  // Cover image URLs to try, best first.
  function artFor(md, id) {
    const urls = [];
    const art = md && md.artwork ? [...md.artwork] : [];
    const px = (a) => Math.max(0, ...String(a.sizes || '').split(/\s+/).map((s) => parseInt(s, 10) || 0));
    art.sort((a, b) => px(b) - px(a));
    for (const a of art) if (a.src) urls.push(new URL(a.src, location.href).href);
    if (id) {
      for (const img of document.images) {
        let src = img.currentSrc || img.src;
        if (!src.includes(id)) continue;
        try {
          // Unwrap Next.js image-optimizer URLs to get the original image.
          const u = new URL(src, location.href);
          if (u.pathname.includes('/_next/image') && u.searchParams.get('url')) src = new URL(u.searchParams.get('url'), location.href).href;
        } catch (err) {}
        urls.push(src);
        break;
      }
      // Suno's usual cover-image locations.
      urls.push(`https://cdn2.suno.ai/image_large_${id}.jpeg`, `https://cdn2.suno.ai/image_${id}.jpeg`);
    }
    return [...new Set(urls)];
  }

  function read() {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const el = currentAudio();
    const src = el ? el.currentSrc || el.src || '' : '';
    // From the audio address, or else the cover image (Suno names covers after the song).
    let id = idFrom(src);
    if (!id && md && md.artwork) for (const a of md.artwork) if ((id = idFrom(a.src))) break;
    let title = (md && md.title) || '';
    if (!title && id) title = linkTitle(id);
    return {
      id,
      src: /^https?:/.test(src) ? src : '',
      blobSrc: src.startsWith('blob:') ? src : '',
      playing: !!el && !el.paused,
      title: title.trim(),
      artist: ((md && md.artist) || '').trim(),
      art: artFor(md, id),
      key: `${id || src}|${title}`
    };
  }

  // Every song linked on the page (on a Suno playlist page: the playlist's songs).
  function pageSongIds() {
    const ids = new Set();
    for (const a of document.querySelectorAll('a[href*="/song/"]')) {
      const id = idFrom(a.getAttribute('href'));
      if (id) ids.add(id);
    }
    return [...ids];
  }

  // Stems: work out the exact clock time at which this song's position 0 was
  // played (now minus the player's position), from a few steady readings.
  let timingKey = '';
  let timingDone = false;
  let samples = [];
  function sampleTiming(key) {
    if (key !== timingKey) { timingKey = key; timingDone = false; samples = []; }
    if (timingDone) return;
    const el = currentAudio();
    if (!el || el.paused || el.seeking || el.playbackRate !== 1 || el.currentTime < 0.3) return;
    samples.push(performance.timeOrigin + performance.now() - el.currentTime * 1000);
    if (samples.length < 9) return;
    samples.sort((a, b) => a - b);
    timingDone = true;
    window.postMessage({ __audioGrabber: 'timing', key, zero: samples[4] }, '*');
  }

  // Stems: measure how long tab audio takes to reach the recorder. Three short,
  // quiet chirps at 17-19 kHz (above most people's hearing) are played at known
  // times; the recorder finds them and corrects every cut by the delay.
  async function calibrate() {
    try {
      const ctx = new AudioContext();
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      if (ctx.state !== 'running') { ctx.close(); return; }
      const start = ctx.currentTime + 0.25;
      const times = [0, 0.35, 0.7].map((k) => start + k);
      for (const t of times) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.setValueAtTime(17000, t);
        osc.frequency.linearRampToValueAtTime(19000, t + 0.04);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.05, t + 0.005);
        gain.gain.setValueAtTime(0.05, t + 0.035);
        gain.gain.linearRampToValueAtTime(0, t + 0.04);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.045);
      }
      await new Promise((r) => setTimeout(r, 150));
      // Wall-clock time each chirp is heard, from the output's own timestamps.
      const ts = ctx.getOutputTimestamp();
      const wall = ts && ts.performanceTime > 0
        ? (t) => performance.timeOrigin + ts.performanceTime + (t - ts.contextTime) * 1000
        : (t) => performance.timeOrigin + performance.now() + (t - ctx.currentTime + (ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
      window.postMessage({ __audioGrabber: 'calib', walls: times.map(wall) }, '*');
      setTimeout(() => ctx.close(), 2000);
    } catch (err) {
      // no calibration this time; the last measured delay is used
    }
  }
  if (window.__audioGrabberCalibrate) {
    window.__audioGrabberCalibrate = false;
    const el = currentAudio();
    if (!el || el.paused) calibrate(); // only while the tab is quiet
  }

  let last = '';
  let sentOriginal = '';
  let lastPlaying = false;
  let playlistIds = null;
  const timer = setInterval(() => {
    const song = read();
    if (song.key !== '|') sampleTiming(song.key);
    // Report a new song, and also the moment playback starts.
    if (song.key === '|' || (song.key === last && song.playing === lastPlaying)) return;
    last = song.key;
    lastPlaying = song.playing;
    // Snapshot the playlist when playback starts, before the page can change.
    if (!playlistIds) playlistIds = pageSongIds();
    // The song's original file, if the page holds it in memory.
    const blob = song.blobSrc && window.__audioGrabberBlobs.get(song.blobSrc);
    if (blob && song.key !== sentOriginal) {
      sentOriginal = song.key;
      window.postMessage({ __audioGrabber: 'original', key: song.key, blob }, '*');
    }
    delete song.blobSrc;
    window.postMessage({ __audioGrabber: 'song', ...song, playlistIds }, '*');
  }, 100);

  const stop = () => {
    clearInterval(timer);
    window.removeEventListener('message', onStop);
    if (window.__audioGrabberWatch === stop) window.__audioGrabberWatch = null;
  };
  const onStop = (e) => {
    // Ignore a stop meant for the previous recording that arrives late.
    if (e.source === window && e.data && e.data.__audioGrabber === 'stop' && e.data.at >= startedAt) stop();
  };
  window.addEventListener('message', onStop);
  window.__audioGrabberWatch = stop;
})();
