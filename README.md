# Lyric Sheet (placeholder name) — iOS prototype

The whole app is `www/index.html`. The `ios/` folder is the native wrapper that turns it into an iPhone app.

## Option A — build on your Mac
1. Install **Xcode** from the Mac App Store and open it once (accept the license / extra components).
2. In Terminal: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
3. In Terminal, drag in this folder after `cd `, press Enter, then run: `./build-ipa.sh`
4. `LyricSheet.ipa` appears in this folder. Drag it into Sideloadly or AltStore.

## Option B — no Mac: build on GitHub
1. Create a new GitHub repo and upload everything in this folder (including the hidden `.github` folder).
2. Go to the repo's **Actions** tab → **Build unsigned IPA** → **Run workflow**.
3. When it finishes (~5–10 min), open the run and download **LyricSheet-ipa** under Artifacts. Unzip it to get the `.ipa`.

## Updating the app later
Replace `www/index.html` with the new version and build again (or push to GitHub). If you install with the
same bundle ID (`com.lyricsheet.prototype`), your songs carry over.
