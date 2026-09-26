// Isolated-world half of the song watcher: forwards song changes to the extension.
(() => {
  if (window.__audioGrabberRelay) return;
  window.__audioGrabberRelay = true;
  const stop = () => {
    window.postMessage({ __audioGrabber: 'stop' }, '*');
    window.removeEventListener('message', onMessage);
    window.__audioGrabberRelay = false;
  };
  const onMessage = (e) => {
    if (e.source !== window || !e.data || e.data.__audioGrabber !== 'song') return;
    const { id, title, artist, art, key, playlistIds } = e.data;
    chrome.runtime.sendMessage({ target: 'background', type: 'song', id, title, artist, art, key, playlistIds })
      .then((res) => { if (res && res.keep === false) stop(); })
      .catch(stop);
  };
  window.addEventListener('message', onMessage);
  chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'songwatch-stop') stop(); });
})();
