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

  function read() {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const el = currentAudio();
    const src = el ? el.currentSrc || el.src || '' : '';
    const id = (src.match(UUID) || [])[0] || '';
    let title = (md && md.title) || '';
    if (!title && id) title = linkTitle(id);
    return { title: title.trim(), artist: ((md && md.artist) || '').trim(), key: `${id || src}|${title}` };
  }

  let last = '';
  const timer = setInterval(() => {
    const song = read();
    if (song.key === '|' || song.key === last) return;
    last = song.key;
    window.postMessage({ __audioGrabber: 'song', ...song }, '*');
  }, 100);

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__audioGrabber === 'stop') {
      clearInterval(timer);
      window.__audioGrabberWatch = false;
    }
  });
})();
