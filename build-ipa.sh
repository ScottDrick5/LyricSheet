#!/bin/bash
# Builds an UNSIGNED LyricSheet.ipa for sideloading (Sideloadly / AltStore re-sign it with your Apple ID).
# Needs: a Mac with the full Xcode app installed (from the App Store) and opened once.
set -e
cd "$(dirname "$0")"

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "Xcode isn't set up. Install Xcode from the App Store, open it once, then run:"
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

# Put the latest app page into the iOS project (edit www/index.html to update the app)
cp www/index.html ios/App/App/public/index.html

rm -rf build Payload LyricSheet.ipa
echo "Building… (the first build downloads Capacitor and takes a few minutes)"
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build -quiet

mkdir Payload
cp -R build/Build/Products/Release-iphoneos/App.app Payload/
zip -qry LyricSheet.ipa Payload
rm -rf Payload

echo ""
echo "Done: $(pwd)/LyricSheet.ipa"
echo "Drag it into Sideloadly or AltStore to install."
