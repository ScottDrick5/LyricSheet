# AI Voice Saver (Chrome extension)

Saves the spoken audio from **ChatGPT** and **Claude**, labeled with the voice you pick.

## Install
1. In Chrome, open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `voice-saver-extension` folder.
4. Pin the extension (puzzle-piece icon → pin) and **reload** any ChatGPT or Claude tabs you already had open.

Files go to your normal Downloads folder, named like `chatgpt-ember-2026-09-26_14-03-22.aac`.

## ChatGPT
- Every finished reply gets a **player bar** at the end with:
  - **Play/Pause**
  - a **scrub bar** you can drag to jump anywhere in the reply, plus the time
  - a **voice picker**
  - a **Download** button
- The player's voice picker and the popup's voice picker are one setting. Change either and all players
  and the popup switch to that voice. Play and Download always use it, whatever voice ChatGPT itself is
  set to.
- Only one reply plays at a time. Audio is fetched the first time you press play or download, then reused
  until you change the voice or file type.
- Pick the **File type** (AAC or MP3) for downloads in the popup.
- **Save every reply in this chat** in the popup downloads every reply at once, numbered in order. Chrome
  may ask once to allow multiple downloads.
- The voice list is loaded from ChatGPT when it can be. **Custom…** in the popup lets you type any other
  voice name, and it then shows up in the players too.
- This only works in saved chats. Temporary chats can't be read aloud.

## Claude
- Every finished Claude reply gets the same **player bar** as ChatGPT: play/pause, scrub bar, voice
  picker and download.
- Pressing play presses Claude's own **read aloud** button for that reply behind the scenes. The
  extension catches the audio Claude sends back, mutes Claude's own playback, and plays it in the bar
  instead, so you can scrub and download it.
- **Voice:** if Claude's read-aloud request includes a voice setting, the extension switches it to the
  voice picked in the extension. If it doesn't, Claude reads in the voice from its own settings. In that
  case pick the same voice in the extension so your files are named after it.
- **If a Claude player doesn't work:** open the popup and look at **Read-aloud diagnostics**. It shows
  whether the read-aloud button was found and what Claude's request looked like, with no personal
  content. **Copy** it and send it along so the extension can be adjusted.
- **Audio played in this tab** in the popup also keeps a copy of anything Claude reads aloud.

## Settings
At the bottom of the popup, **Show player bar on ChatGPT** and **Show player bar on Claude** turn the
bars off and on for each site without disabling the extension.

## Record this tab (both sites)
This records everything the tab plays and saves it as `.webm` (Opus audio). VLC, Chrome and most
editors can play it. For an MP3 or WAV, convert it with any audio converter (for example
`ffmpeg -i file.webm file.mp3`). While it records, the icon shows a red **REC** badge.

## Notes
- **After updating the extension, reload your ChatGPT and Claude tabs.** Tabs that were already open keep
  running the old version until they're reloaded, and the player will ask you to reload.
- A message like "Couldn't reach ChatGPT" means the request never got through. It's usually a dropped
  connection or an ad or privacy blocker blocking chatgpt.com or claude.ai.
- ChatGPT downloads use the same read-aloud service as ChatGPT's own speaker button, and you have to be
  logged in. If OpenAI changes that service, the per-reply buttons may stop working until the
  extension is updated. Tab recording keeps working either way.
- Nothing is sent anywhere except to ChatGPT/Claude themselves.
