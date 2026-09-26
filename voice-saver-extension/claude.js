// Claude: adds the player bar under each reply. Pressing play presses Claude's own read-aloud
// button and records the audio Claude plays (in the extension's voice if Claude's request has a
// voice setting). Claude streams it, so you hear it live the first time; after that it's in our
// bar, where it can be replayed, scrubbed and downloaded. Pressing the button mid-read finishes early.

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

// Waits for the capture to end: a clip, browser speech, or nothing happening for too long.
// While Claude streams, `onProgress` gets the seconds recorded so far.
function avsWaitForCapture(token, onProgress) {
  return new Promise((resolve) => {
    let timer = null;
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => done(null), ms); };
    const done = (value) => { clearTimeout(timer); avsPageListeners.delete(listen); resolve(value); };
    const listen = (d) => {
      if (d.token !== token) return;
      if (d.kind === 'clip' || d.kind === 'speech') done(d);
      else if (d.kind === 'progress') { onProgress(d.seconds); arm(60000); }
      else if (d.kind === 'request') arm(45000);
    };
    avsPageListeners.add(listen);
    arm(30000); // nothing at all within 30 seconds
  });
}

let avsActiveCapture = null; // token of the capture in progress
let avsActiveButton = null; // Claude's read-aloud button for it

// Ends the capture in progress early, keeping what has been recorded so far, and stops Claude reading.
function avsFinishCapture() {
  if (!avsActiveCapture) return;
  window.postMessage({ __aiVoiceSaverCmd: 'capture-finish', token: avsActiveCapture }, location.origin);
  const btn = avsActiveButton;
  if (btn && btn.isConnected && /pause|stop/i.test(avsButtonLabel(btn))) btn.click();
}

async function avsClaudeCapture(block, voice, status) {
  const btn = avsFindReadAloud(block);
  if (!btn) {
    const labels = avsReplyButtons(block).map(avsButtonLabel).filter(Boolean).slice(0, 12);
    await avsSaveDiagnostics({ result: 'read-aloud button not found', button: null, buttons: labels, requests: [] });
    throw new Error("Couldn't find Claude's read-aloud button on this reply. Open the extension popup for details.");
  }
  if (avsActiveCapture) avsFinishCapture();

  const token = String(Date.now()) + Math.random().toString(36).slice(2);
  const requests = [];
  const noteRequests = (d) => { if (d.token === token && d.kind === 'request') requests.push(d.request); };
  avsPageListeners.add(noteRequests);
  avsActiveCapture = token;
  avsActiveButton = btn;
  try {
    window.postMessage({ __aiVoiceSaverCmd: 'capture-start', token, voice }, location.origin);
    await avsWaitForPage(token, 'capture-ready', 1000);
    status('Starting…');
    // Claude is already reading (its button says Pause/Stop): stop it first, then start fresh.
    if (/pause|stop/i.test(avsButtonLabel(btn))) {
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
    }
    btn.click();
    const result = await avsWaitForCapture(token, (secs) => status(`● Recording ${avsFmtTime(secs)}`));
    if (!result || result.kind === 'speech') {
      window.postMessage({ __aiVoiceSaverCmd: 'capture-cancel', token }, location.origin);
      const speech = result && result.kind === 'speech';
      await avsSaveDiagnostics({
        result: speech ? `Claude used the browser's built-in speech (voice: ${result.voice})` : 'no audio caught',
        button: avsButtonLabel(btn),
        buttons: null,
        requests
      });
      throw new Error(speech
        ? "Claude reads this reply with your browser's built-in speech, which doesn't make an audio file that can be saved."
        : "Claude's read-aloud audio couldn't be caught. Open the extension popup, copy the Read-aloud diagnostics, and send them over.");
    }
    await avsSaveDiagnostics({
      result: `caught ${result.blob.type || 'audio'} via ${result.source}, ${Math.round(result.blob.size / 1000)} KB`,
      button: avsButtonLabel(btn),
      buttons: null,
      requests
    });
    return result;
  } finally {
    avsPageListeners.delete(noteRequests);
    if (avsActiveCapture === token) avsActiveCapture = avsActiveButton = null;
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
        fetch: async ({ voice }, { status }) => {
          const { blob, heard } = await avsClaudeCapture(block, voice, status);
          // Streamed audio was heard live while it was recorded, so don't play it again right away.
          return { blob, voice, ext: avsExtForType(blob.type), heard };
        },
        finish: avsFinishCapture,
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
