#!/usr/bin/env python3
"""Writes the app icon SVGs (design/*.svg). Render them to PNG with design/render-icons.js."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))

def artwork(dark=False):
    """The notepad and pencil, drawn on a 1024x1024 canvas."""
    paper = "#EEE5D0" if dark else "#FAF3E1"
    header = "#2A64AB"
    ring, ring_hole = "#2DD0BE", "#1D4C8A"
    line = "#2F6DB5"
    rings = "".join(
        f'<circle cx="{cx}" cy="262" r="36" fill="{ring_hole}"/>'
        f'<rect x="{cx-24}" y="150" width="48" height="126" rx="24" fill="{ring}"/>'
        for cx in (342, 504, 663))
    lines = "".join(
        f'<line x1="302" y1="{y}" x2="{x2}" y2="{y}" stroke="{line}" stroke-width="13" stroke-linecap="round"/>'
        for y, x2 in ((457, 703), (550, 700), (638, 640)))
    # pencil drawn pointing left along the x axis, then turned to point down-left
    pencil = f'''<g transform="translate(537 804) rotate(-47.4)">
      <polygon points="0,0 120,-64 120,64" fill="#F4D6A0"/>
      <polygon points="0,0 40,-21.3 40,21.3" fill="#2B5BA6"/>
      <rect x="118" y="-64" width="372" height="64" fill="#FBCB4A"/>
      <rect x="118" y="0" width="372" height="64" fill="#F2AE35"/>
      <rect x="488" y="-64" width="36" height="128" fill="#E3E6EC"/>
      <rect x="500" y="-64" width="6" height="128" fill="#C9CED8"/>
      <path d="M522 -64 H566 a26 26 0 0 1 26 26 V38 a26 26 0 0 1 -26 26 H522 Z" fill="#F2698A"/>
    </g>'''
    notepad = f'''
      <path d="M220 230 a26 26 0 0 1 26 -26 H761 a26 26 0 0 1 26 26 V351 H220 Z" fill="{header}"/>
      <path d="M220 351 H787 V841 a26 26 0 0 1 -26 26 H246 a26 26 0 0 1 -26 -26 Z" fill="{paper}"/>'''
    return notepad + rings + lines + pencil

def background(kind):
    if kind == "dark":
        return ('<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
                '<stop offset="0" stop-color="#14304C"/><stop offset="1" stop-color="#08121F"/></linearGradient>')
    return ('<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
            '<stop offset="0" stop-color="#17C6C4"/><stop offset="1" stop-color="#0A84F2"/></linearGradient>')

def ios(kind):
    """Full-bleed square: iOS rounds the corners itself."""
    if kind == "tinted":
        # grayscale artwork on black; iOS colors it with the user's tint
        return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><filter id="g"><feColorMatrix type="saturate" values="0"/></filter></defs>
  <rect width="1024" height="1024" fill="#000"/>
  <g filter="url(#g)">{artwork()}</g>
</svg>'''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>{background(kind)}</defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  {artwork(dark=kind == "dark")}
</svg>'''

def mac():
    """macOS doesn't round icons, so draw the rounded square (with margin and shadow) ourselves."""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>{background("light")}
    <clipPath id="sq"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/></filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#0A84F2" filter="url(#sh)"/>
  <g clip-path="url(#sq)">
    <rect x="100" y="100" width="824" height="824" fill="url(#bg)"/>
    <g transform="translate(100 100) scale({824/1024})">{artwork()}</g>
  </g>
</svg>'''

for name, svg in (("icon-ios.svg", ios("light")), ("icon-ios-dark.svg", ios("dark")),
                  ("icon-ios-tinted.svg", ios("tinted")), ("icon-mac.svg", mac())):
    with open(os.path.join(HERE, name), "w") as f:
        f.write(svg)
    print("wrote", name)
