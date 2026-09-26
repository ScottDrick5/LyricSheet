// Claude: adds the player bar under each reply. Pressing play presses Claude's own read-aloud
// button, catches the audio Claude sends back (in the extension's voice if Claude's request has a
// voice setting) and plays it in our bar, where it can be scrubbed and downloaded.

const AVS_RESPONSE_SEL = '.font-claude-response, .font-claude-message, [data-testid="assistant-message"]';
const AVS_READ_ALOUD = /read.?aloud|read out|listen|speak|text.to.speech|\btts\b|play audio|audio/i;

function avsClaudeReplies() {
  const out = [];
  const seen = new Set();
  for (const node of document.querySelectorAll(AVS_RESPONSE_SEL)) {
    if (node.parentElement && node.parentElement.closest(AVS_RESPONSE_SEL)) continue;
    const streamingEl = node.closest('[data-is-streaming]');
    const block = node.closest('[data-test-render-count]') || (streamingEl && streamingEl.parentElement) || node.parentElement;
    if (!block || seen.has(block)) continue;
    seen.add(block);
    out.push({
      block,
      anchor: streamingEl || node,
      streaming: !!streamingEl && streamingEl.getAttribute('data-is-streaming') === 'true'
    });
  }
  return out;
}

function avsButtonLabel(b) {
  return [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid'), b.textContent]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// The reply's own buttons (ours excluded). The action bar can sit just outside the reply block.
function avsReplyButtons(block) {
  const next = block.nextElementSibling;
  const scopes = [block];
  if (next && !next.querySelector(AVS_RESPONSE_SEL) && !next.matches('[data-test-render-count]')) scopes.push(next);
  const buttons = [];
  for (const scope of scopes) {
    for (const b of scope.querySelectorAll('button, [role="button"]')) {
      if (!b.closest('.avs-player')) buttons.push(b);
    }
  }
  return buttons;
}

function avsFindReadAloud(block) {
  return avsReplyButtons(block).find((b) => AVS_READ_ALOUD.test(avsButtonLabel(b))) || null;
}

async function avsSaveDiagnostics(update) {
  try {
    const { claudeDiagnostics } = await chrome.storage.local.get('claudeDiagnostics');
    await chrome.storage.local.set({ claudeDiagnostics: { ...(claudeDiagnostics || {}), ...update, time: Date.now() } });
  } catch {}
}

function avsWaitForPage(token, kind, ms) {
  return new Promise((resolve) => {
    const done = (value) => { clearTimeout(timer); avsPageListeners.delete(listen); resolve(value); };
    const listen = (d) => { if (d.token === token && d.kind === kind) done(d); };
    const timer = setTimeout(() => done(null), ms);
    avsPageListeners.add(listen);
  });
}

async function avsClaudeCapture(block, voice) {
  const btn = avsFindReadAloud(block);
  if (!btn) {
    const labels = avsReplyButtons(block).map(avsButtonLabel).filter(Boolean).slice(0, 12);
    await avsSaveDiagnostics({ result: 'read-aloud button not found', button: null, buttons: labels, requests: [] });
    throw new Error("Couldn't find Claude's read-aloud button on this reply. Open the extension popup for details.");
  }

  const token = String(Date.now()) + Math.random().toString(36).slice(2);
  const requests = [];
  const noteRequests = (d) => { if (d.token === token && d.kind === 'request') requests.push(d.request); };
  avsPageListeners.add(noteRequests);
  try {
    window.postMessage({ __aiVoiceSaverCmd: 'capture-start', token, voice }, location.origin);
    await avsWaitForPage(token, 'capture-ready', 1000);
    btn.click();
    const clip = await avsWaitForPage(token, 'clip', 90000);
    if (!clip) {
      window.postMessage({ __aiVoiceSaverCmd: 'capture-cancel', token }, location.origin);
      await avsSaveDiagnostics({ result: 'no audio caught', button: avsButtonLabel(btn), buttons: null, requests });
      throw new Error("Claude's read-aloud audio couldn't be caught. Use \"Record this tab\" for now, and see the popup for details.");
    }
    await avsSaveDiagnostics({
      result: `caught ${clip.blob.type || 'audio'} via ${clip.source}, ${Math.round(clip.blob.size / 1000)} KB`,
      button: avsButtonLabel(btn),
      buttons: null,
      requests
    });
    return clip.blob;
  } finally {
    avsPageListeners.delete(noteRequests);
  }
}

const avsClaudePlayers = new WeakMap(); // reply block -> player

function avsInjectClaudePlayers() {
  for (const { block, anchor, streaming } of avsClaudeReplies()) {
    if (streaming) continue;
    let p = avsClaudePlayers.get(block);
    if (!p) {
      p = avsCreatePlayer({
        site: 'claude',
        choice: async () => {
          const voice = await avsVoice('claude');
          return { voice, key: voice };
        },
        fetch: async ({ voice }) => {
          const blob = await avsClaudeCapture(block, voice);
          return { blob, voice, ext: avsExtForType(blob.type) };
        },
        fillVoices: (select) => avsFillVoiceOptions(select, 'claude', VOICES.claude)
      });
      avsClaudePlayers.set(block, p);
    }
    if (p.el.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', p.el);
  }
}

let avsClaudeScanTimer = null;
new MutationObserver(() => {
  clearTimeout(avsClaudeScanTimer);
  avsClaudeScanTimer = setTimeout(avsInjectClaudePlayers, 400);
}).observe(document.documentElement, { childList: true, subtree: true });
avsInjectClaudePlayers();
