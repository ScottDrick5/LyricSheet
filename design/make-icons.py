#!/usr/bin/env python3
"""Builds the app icons from design/icon-source.jpg (the notepad icon on a light background).

Cuts the notepad out of its background, then writes:
  iOS  AppIcon-512@2x.png  - the icon on a light background
       AppIcon-dark.png    - the same colored icon on black (iPhone dark mode)
       AppIcon-tinted.png  - a grayscale version on black (iPhone tinted mode)
  Mac  desktop/build/icon.png - the notepad shape itself, transparent around it, with a soft shadow
Needs Pillow:  pip install pillow && python3 design/make-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
IOS = os.path.join(ROOT, "ios/App/App/Assets.xcassets/AppIcon.appiconset")
SIZE = 1024
LIGHT_BG = (234, 238, 242)


def cut_out(src):
    """Return the notepad as an RGBA image, cropped to its edges."""
    w, h = src.size
    # background = light, grayish pixels (includes the pale blue glow around the icon)
    cand = Image.new("L", src.size, 0)
    px, cp = src.load(), cand.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            hi, lo = max(r, g, b), min(r, g, b)
            if hi > 175 and (hi - lo) / hi < 0.3:
                cp[x, y] = 255
    # only what's connected to the outside counts (the cream paper is inside the blue border)
    for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if cand.getpixel(corner) == 255:
            ImageDraw.floodfill(cand, corner, 128)
    mask = cand.point(lambda v: 0 if v == 128 else 255)
    mask = mask.filter(ImageFilter.MinFilter(3))  # drop the light fringe around the edge
    box = mask.getbbox()
    icon = src.convert("RGBA")
    icon.putalpha(mask.filter(ImageFilter.GaussianBlur(0.8)))  # soften the cut edge
    return icon.crop(box)


def fit(icon, height):
    scale = height / icon.height
    return icon.resize((round(icon.width * scale), round(icon.height * scale)), Image.LANCZOS)


def place(canvas, icon):
    canvas.alpha_composite(icon, ((SIZE - icon.width) // 2, (SIZE - icon.height) // 2))
    return canvas


def with_shadow(canvas, icon, color, blur, offset, opacity):
    pad = blur * 3
    sh = Image.new("RGBA", (icon.width + pad * 2, icon.height + pad * 2), color + (0,))
    a = Image.new("L", sh.size, 0)
    a.paste(icon.getchannel("A").point(lambda v: int(v * opacity)), (pad, pad + offset))
    sh.putalpha(a.filter(ImageFilter.GaussianBlur(blur)))
    canvas.alpha_composite(sh, ((SIZE - icon.width) // 2 - pad, (SIZE - icon.height) // 2 - pad))
    return place(canvas, icon)


src = Image.open(os.path.join(HERE, "icon-source.jpg")).convert("RGB")
icon = cut_out(src)
ios_icon = fit(icon, 800)  # iOS rounds the square's corners itself, so leave a margin

light = with_shadow(Image.new("RGBA", (SIZE, SIZE), LIGHT_BG + (255,)), ios_icon, (30, 136, 229), 28, 10, 0.35)
light.convert("RGB").save(os.path.join(IOS, "AppIcon-512@2x.png"), optimize=True)

dark = place(Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 255)), ios_icon)
dark.convert("RGB").save(os.path.join(IOS, "AppIcon-dark.png"), optimize=True)

gray = ImageOps.grayscale(ios_icon.convert("RGB")).convert("RGBA")
gray.putalpha(ios_icon.getchannel("A"))
tinted = place(Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 255)), gray)
tinted.convert("RGB").save(os.path.join(IOS, "AppIcon-tinted.png"), optimize=True)

mac = with_shadow(Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), fit(icon, 840), (0, 0, 0), 18, 12, 0.3)
mac.save(os.path.join(ROOT, "desktop/build/icon.png"), optimize=True)
print("icon cut out at", icon.size, "- wrote iOS light/dark/tinted and Mac icons")
