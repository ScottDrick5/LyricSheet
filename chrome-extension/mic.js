document.getElementById('allow').onclick = async () => {
  const status = document.getElementById('status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, includeMic: true } });
    status.textContent = 'Done. The microphone is allowed and "Mix in microphone" is on. You can close this tab.';
  } catch (err) {
    status.textContent = 'Microphone was blocked (' + err.name + '). Click the icon in the address bar to allow it, then try again.';
  }
};
