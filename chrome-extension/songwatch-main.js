// Injected into the recorded tab's page. Reports what song is playing, from
// the page's media session ("now playing" info) or, on Suno, from the song
// link that matches the audio file being played.
(() => {
  // A watcher left over from an earlier recording (or an older version of the
  // extension) is shut down so this one starts fresh.
  if (typeof window.__audioGrabberWatch === 'function') window.__audioGrabberWatch();
  const startedAt = performance.now();

  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // The element playing the music. Muted videos (animated covers, background
  // loops) are ignored, and a real <audio> player wins over any video.
  function currentAudio() {
    const els = [...document.querySelectorAll('audio, video')].filter((el) => !el.muted && el.volume > 0);
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

  let last = '';
  let playlistIds = null;
  const timer = setInterval(() => {
    const song = read();
    if (song.key === '|' || song.key === last) return;
    last = song.key;
    // Snapshot the playlist when playback starts, before the page can change.
    if (!playlistIds) playlistIds = pageSongIds();
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
