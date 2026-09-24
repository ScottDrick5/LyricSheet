#!/usr/bin/env python3
"""iOS app icons must not have an alpha channel: re-save them as plain RGB."""
import os
from PIL import Image

d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ios/App/App/Assets.xcassets/AppIcon.appiconset")
for f in ("AppIcon-512@2x.png", "AppIcon-dark.png", "AppIcon-tinted.png"):
    p = os.path.join(d, f)
    Image.open(p).convert("RGB").save(p, optimize=True)
    print("flattened", f)
