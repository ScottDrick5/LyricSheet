// Injected into the recorded tab's page. Reports what song is playing, from
// the page's media session ("now playing" info) or, on Suno, from the song
// link that matches the audio file being played.
(() => {
  if (window.__audioGrabberWatch) return;
  window.__audioGrabberWatch = true;

  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function currentAudio() {
    const els = [...document.querySelectorAll('audio, video')];
    return els.find((el) => !el.paused) || els.find((el) => el.currentSrc || el.src) || null;
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
    const id = (src.match(UUID) || [])[0] || '';
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
      const m = a.getAttribute('href').match(UUID);
      if (m) ids.add(m[0].toLowerCase());
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
    song.id = song.id.toLowerCase();
    window.postMessage({ __audioGrabber: 'song', ...song, playlistIds }, '*');
  }, 100);

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__audioGrabber === 'stop') {
      clearInterval(timer);
      window.__audioGrabberWatch = false;
    }
  });
})();
