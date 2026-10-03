// Isolated-world half of the song watcher: forwards song changes to the extension.
(() => {
  // Replace a relay left over from an earlier recording or an older version
  // of the extension (after an update its connection to the extension is dead).
  if (typeof window.__audioGrabberRelay === 'function') window.__audioGrabberRelay(false);

  // False once the extension has been reloaded or updated underneath this page.
  const alive = () => {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (err) {
      return false;
    }
  };

  const onMessage = (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__audioGrabber === 'original') {
      if (!alive()) return stop(false);
      const { key, blob } = e.data;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          chrome.runtime.sendMessage({ target: 'background', type: 'original', key, dataUrl: reader.result }).catch(() => {});
        } catch (err) {
          stop(false);
        }
      };
      reader.readAsDataURL(blob);
      return;
    }
    if (e.data.__audioGrabber === 'calib') {
      if (!alive()) return stop(false);
      try {
        chrome.runtime.sendMessage({ target: 'background', type: 'calib', walls: e.data.walls }).catch(() => {});
      } catch (err) {
        stop(false);
      }
      return;
    }
    if (e.data.__audioGrabber === 'timing') {
      if (!alive()) return stop(false);
      const { key, zero, source } = e.data;
      try {
        chrome.runtime.sendMessage({ target: 'background', type: 'songTiming', key, zero, source }).catch(() => {});
      } catch (err) {
        stop(false);
      }
      return;
    }
    if (e.data.__audioGrabber !== 'song') return;
    if (!alive()) return stop(false);
    const { id, src, playing, title, artist, art, key, playlistIds } = e.data;
    try {
      chrome.runtime.sendMessage({ target: 'background', type: 'song', id, src, playing, title, artist, art, key, playlistIds })
        .then((res) => { if (res && res.keep === false) stop(); })
        .catch(() => stop());
    } catch (err) {
      stop(false);
    }
  };

  const onExtensionMessage = (msg) => {
    if (msg && msg.type === 'songwatch-stop') stop();
  };

  // stopWatcher: also stop the page-side watcher (skipped for a dead relay,
  // so it doesn't shut down the watcher a newer version is using).
  function stop(stopWatcher = true) {
    window.removeEventListener('message', onMessage);
    try {
      chrome.runtime.onMessage.removeListener(onExtensionMessage);
    } catch (err) {
      // extension already gone
    }
    if (window.__audioGrabberRelay === stop) window.__audioGrabberRelay = null;
    // Stamped so a watcher started after this moment ignores it.
    if (stopWatcher) window.postMessage({ __audioGrabber: 'stop', at: performance.now() }, '*');
  }

  window.addEventListener('message', onMessage);
  chrome.runtime.onMessage.addListener(onExtensionMessage);
  window.__audioGrabberRelay = stop;
})();
