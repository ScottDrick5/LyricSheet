# AI Voice Saver (Chrome extension)

Saves the spoken audio from **ChatGPT** and **Claude**, labeled with the voice you pick.

## Install
1. In Chrome, open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `voice-saver-extension` folder.
4. Pin the extension (puzzle-piece icon → pin) and **reload** any ChatGPT or Claude tabs you already had open.

Files go to your normal Downloads folder, named like `chatgpt-ember-2026-09-26_14-03-22.aac`.

## ChatGPT
- Pick a **Voice** and **File type** (AAC or MP3) in the extension popup.
- A **Voice** button appears next to Copy under every ChatGPT reply. Click it to download that reply
  spoken in the voice you picked. It doesn't matter which voice ChatGPT itself is set to.
- **Save every reply in this chat** downloads every reply at once, numbered in order. Chrome may ask
  once to allow multiple downloads.
- The voice list is loaded from ChatGPT when it can be. **Custom…** lets you type any other voice name.
- This only works in saved chats. Temporary chats can't be read aloud.

## Claude
Claude doesn't let other apps choose which voice speaks, so the voice is set in Claude itself
(**Settings → Voice**). Pick the same voice in the popup and your files will be named after it. There
are two ways to save Claude's audio:
- **Audio played in this tab:** when a reply is played aloud, the extension keeps a copy. Open the popup
  and click **Save**.
- **Record this tab:** click **Start recording**, talk to Claude or play the reply, then click
  **Stop and save**. This works for live voice conversations too. You still hear everything while it records.

## Record this tab (both sites)
This records everything the tab plays and saves it as `.webm` (Opus audio). VLC, Chrome and most
editors can play it. For an MP3 or WAV, convert it with any audio converter (for example
`ffmpeg -i file.webm file.mp3`). While it records, the icon shows a red **REC** badge.

## Notes
- ChatGPT downloads use the same read-aloud service as ChatGPT's own speaker button, and you have to be
  logged in. If OpenAI changes that service, the per-reply buttons may stop working until the
  extension is updated. Tab recording keeps working either way.
- Nothing is sent anywhere except to ChatGPT/Claude themselves.
