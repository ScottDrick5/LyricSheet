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
   named after the song (or the tab title).

## Save exact copies of Suno songs (best for stems)
Open a Suno page that lists the songs you want (a playlist, your library, or a song's stems) and
click the Audio Grabber icon. The popup lists every song on the page; untick any you don't want and
press **Save exact copies**. Each song's original file is downloaded straight from Suno, named after
the song, with its cover art: exact, original quality, done in seconds, nothing to play or record.
Stems saved this way line up perfectly. **MP3** keeps Suno's file untouched; **WAV** converts it at its
own sample rate. Songs Suno won't serve (e.g. deleted ones) are listed as "couldn't be fetched", with the reason.

Suno often refuses plain download addresses (HTTP 403) and only lets its own player's signed
addresses through. So if songs fail, **play each of them on that page for a few seconds** (just
click play, then move to the next), then press **Save exact copies** again: the extension picks up
the exact address Suno's player used for each song and downloads that. If something still fails, the
status line explains why and shows what Suno's player loaded (private parts of addresses are hidden).

## Record a whole playlist, one file per song (great for Suno)
1. Open the playlist in a tab (e.g. a Suno playlist) and don't press play yet.
2. In the popup, turn on **Split into separate songs**.
3. Press **Record**, then press play on the playlist. You can walk away now.

Each song is saved straight into your **Downloads** folder as its own file, named after the song,
with the song's cover art embedded (if a file with that name already exists, Chrome adds " (1)"):

```
Downloads/
    Midnight Drive.mp3
    Neon Rain.mp3
    Last Call.mp3
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
  playlist's own page for this to work. If it can't reliably read the playlist from the page
  ("Song 3" with no "of 12"), this check switches itself off for that recording rather than risk
  stopping early; use **Stop after N songs** instead.
- **Stop after N songs.** A backup if you want an exact count.
- When nothing has played for **2 minutes** (changeable), it assumes the playlist is over,
  stops, and saves.

**Stems.** Stems (vocals only, drums only…) have long silent stretches, which normally count as
the end of a song. Turn on **Keep silences (for stems)**: each file then runs from the moment the
track starts playing until the next track starts. Silences, including a silent intro, stay in, so every
stem file is the full length of the song. **Stop after silence of** still
ends the recording, so set it longer than the longest silence in your stems (or to **Never**), and rely
on **Stop when my playlist ends** or **Stop after N songs** instead.

**Save original files (exact)** (on by default). While the playlist plays, the extension saves the
audio file the page itself is playing, instead of a recording of it, whenever it can reach that file
(from the player's address, or the copy the page loaded into memory). That's an exact copy at original
quality, so stems line up perfectly with no adjusting. If you chose the same format as the original
(e.g. MP3 and Suno serves MP3), the file is saved untouched apart from the cover art; otherwise it's
converted at its own sample rate. When the original can't be reached, that song falls back to the
recording described below. The popup and the done notification say how many songs were exact copies.
Press **Record** before pressing play, so the extension sees each song being loaded.

How recorded stems stay in sync (when an original isn't available): the extension reads the player's exact playback position to find the moment
each stem's first sample played, and cuts the file at exactly that sample (the last few seconds are
held back so the cut can land precisely). At the start of a stems recording it also plays three very
short, quiet chirps at 17-19 kHz (above most people's hearing) in the tab to measure how long Chrome
takes to hand tab audio to the recorder, and corrects every cut by that delay. In testing, stems
recorded one after another lined up to within a fraction of a millisecond. Tips:
- Press **Record** before pressing play, so the chirps can be measured while the tab is quiet.
- Use **WAV** for stems. MP3 encoding adds a short silent padding at the start of every file
  (the same for each stem, but some editors don't remove it).
- The popup's song counter runs a few seconds behind in stems mode, because of the held-back audio.

**Done notification.** When the recording finishes on its own (playlist over, song limit, silence,
auto-stop, or the tab closed), a desktop notification tells you why and how many songs were saved.
Click it to open your Downloads folder. The popup also shows the last result when you open it, so
you never miss it. Click **Test alert** (next to Recent) to check notifications work. If nothing
appears on a Mac, allow notifications in **System Settings → Notifications → Google Chrome**, and
check that Focus / Do Not Disturb isn't on.

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
| Save original files (exact) | Save the page's own audio file instead of a recording, when possible |
| Keep silences (for stems) | Never split on silence or trim it; one full-length file per track |
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
