# Audio Grabber — a free Audio Hijack–style Chrome extension

Records whatever is playing in a Chrome tab (optionally mixed with your microphone) and
saves it straight to **MP3**, **WAV**, or both. The MP3 is encoded while the audio plays,
so the file is ready the moment you press Stop. No converting afterwards, no accounts, and nothing is uploaded.

## Install (takes about a minute)
1. Download this `chrome-extension` folder to your computer.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and pick the `chrome-extension` folder.
5. Pin **Audio Grabber** from the puzzle-piece menu so the icon is always in the toolbar.

## Use it
1. Go to the tab that's playing audio (YouTube, SoundCloud, a web DAW, a Zoom web call…).
2. Click the Audio Grabber icon → **Record**. The toolbar badge shows **REC**.
3. Click the icon again → **Stop & Save**. The file lands in `Downloads/Audio Grabber/`,
   named after the tab title plus the date and time.

Keyboard shortcut: **Alt+Shift+R** starts/stops recording the current tab
(change it at `chrome://extensions/shortcuts`).

## Options (in the popup)
| Option | What it does |
|---|---|
| Format | MP3, WAV (16-bit, 48 kHz stereo), or both at once |
| MP3 quality | 128 / 192 / 256 / 320 kbps |
| Keep playing while recording | On: you still hear the tab. Off: the tab is silenced but still recorded |
| Mix in microphone | Records your mic along with the tab. Click **allow mic** once first to give Chrome permission |
| Auto-stop after | Stops and saves automatically after 5 min to 3 hours |
| Save in Downloads/ | Subfolder name. Leave it blank to save straight into Downloads |
| Ask where to save each file | Shows Chrome's Save As dialog instead of auto-saving |

**Pause** skips the paused section, so it isn't in the file. Closing the tab you're recording
stops and saves automatically. **Recent** lists your last 10 files; click one to show it in its folder.

## Good to know
- It records one tab at a time.
- Chrome won't let extensions capture `chrome://` pages or the Chrome Web Store.
- Some streaming services protect their audio (DRM, e.g. Netflix or Spotify's web player). Chrome
  hands those to extensions as silence, so you get an empty recording.
- Long recordings are held in memory until you stop. MP3 is small (~1.4 MB/min at 192 kbps).
  WAV uses ~11 MB/min, so for very long sessions (hours) choose MP3 only.

## Files
- `background.js`: service worker (start/stop, badge, saving files)
- `offscreen.js` + `recorder-worklet.js`: capture the audio and encode MP3/WAV live
- `popup.*`: the toolbar popup
- `mic.*`: one-time microphone permission page
- `lib/lame.min.js`: [lamejs](https://github.com/zhuker/lamejs) MP3 encoder (LGPL)
