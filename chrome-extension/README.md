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
3. Click the icon again → **Stop & Save**. The file lands in your **Downloads** folder,
   named after the song (or the tab title) plus the date and time.

## Record a whole playlist, one file per song (great for Suno)
1. Open the playlist in a tab (e.g. a Suno playlist) and don't press play yet.
2. In the popup, turn on **Split into separate songs**.
3. Press **Record**, then press play on the playlist. You can walk away now.

Each song is saved straight into your **Downloads** folder as its own file, numbered in play order
and named after the song, with the song's cover art embedded:

```
Downloads/
    01 - Midnight Drive.mp3
    02 - Neon Rain.mp3
    03 - Last Call.mp3
```

How it knows where one song ends and the next begins:
- **Song change.** When the site switches to the next song (Suno and YouTube both announce this),
  it cuts right at the gap between the two songs, even if there's no silence between them.
- **Silence.** A silent gap (2 seconds by default) also ends a song. The silence is trimmed off,
  and the next file starts when sound comes back.
- Sounds shorter than 5 seconds (clicks, notification pings) are ignored.
- **End of your playlist.** When recording starts, it notes which songs are listed on the page
  (your playlist). As soon as Suno moves on to a song that isn't one of them (someone else's),
  it saves your last song, discards the stranger's, stops, and pauses Suno. The popup shows
  "Song 3 of 12" so you can check it counted your playlist right. Start recording from the
  playlist's own page for this to work.
- **Stop after N songs.** A backup if you want an exact count.
- When nothing has played for **2 minutes** (changeable), it assumes the playlist is over,
  stops, and saves.

**Done notification.** When the recording finishes on its own (playlist over, song limit, silence,
auto-stop, or the tab closed), a desktop notification tells you why and how many songs were saved.
Click it to open your Downloads folder. On a Mac, allow notifications for Google Chrome in
**System Settings → Notifications → Google Chrome**, and pick **Alerts** if you want it to stay on
screen until you dismiss it.

**Cover art.** Each file gets the song's cover image embedded (shown in Finder, Apple Music and
most players). It's taken from Suno's "now playing" info or the song's picture on the page.

Song names come from the site's "now playing" info (the same info shown on your media keys and
lock screen). On Suno, if that's missing, it uses the song's link on the page. Otherwise it uses the
tab title, with "| Suno", "- YouTube" and similar removed.

If songs get split in the middle of a quiet part, raise **Silent gap that splits** or lower
**Silence level**. If songs don't split on a noisy source, choose -35 dB.

Keyboard shortcut: **Alt+Shift+R** starts/stops recording the current tab
(change it at `chrome://extensions/shortcuts`).

## Options (in the popup)
| Option | What it does |
|---|---|
| Format | MP3, WAV (16-bit, 48 kHz stereo), or both at once |
| MP3 quality | 128 / 192 / 256 / 320 kbps |
| Keep playing while recording | On: you still hear the tab. Off: the tab is silenced but still recorded |
| Mix in microphone | Records your mic along with the tab. Click **allow mic** once first to give Chrome permission |
| Split into separate songs | One file per song, named after it (see above) |
| Silent gap that splits | How long a silence has to last to end a song |
| Silence level | How quiet counts as silence |
| Stop when my playlist ends | Stops as soon as a song that isn't in the playlist starts |
| Stop after N songs | Stops after that many songs (blank = no limit) |
| Stop after silence of | Stops the whole recording once the playlist has finished |
| Auto-stop after | Stops and saves automatically after 5 min to 3 hours |
| Save in Downloads/ | Optional subfolder name. Blank (the default) saves straight into Downloads |
| Ask where to save each file | Shows Chrome's Save As dialog instead of auto-saving |

**Mute** (while recording) silences the tab on your speakers without affecting the recording. Handy for
watching something else while a playlist records. **Pause** skips the paused section, so it isn't in the file. Closing the tab you're recording
stops and saves automatically. **Recent** lists your last 10 files; click one to show it in its folder, or click
**Clear history** to empty the list (your saved files aren't touched).

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
- `songwatch-*.js`: injected into the recorded tab to read the playing song's name, cover and playlist
- `id3.js`: embeds the cover art into the saved files
- `mic.*`: one-time microphone permission page
- `lib/lame.min.js`: [lamejs](https://github.com/zhuker/lamejs) MP3 encoder (LGPL)
