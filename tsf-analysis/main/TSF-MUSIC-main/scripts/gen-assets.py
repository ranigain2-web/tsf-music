#!/usr/bin/env python3
"""TSF Music — rasterize brand assets for @capacitor/assets.

Why programmatic (SVG→PNG) instead of AI image generation:
  - Launcher icons must be geometrically exact at 48dp; AI generation
    produces artifacts at small sizes. SVG gives pixel-crisp output at every
    density and the source stays diffable in git.
"""
import cairosvg
from PIL import Image, ImageDraw, ImageFilter
import os

SRC = "/home/z/my-project/assets-src"
OUT = "/home/z/my-project/assets-src"

# ---- 1024x1024 app icon (no rounded corners — Android masks it) ----
cairosvg.svg2png(url=f"{SRC}/icon.svg", write_to=f"{OUT}/icon-only.png",
                 output_width=1024, output_height=1024)

# ---- 1024x1024 logo WITH transparent background (adaptive icon foreground layer) ----
# The adaptive-icon foreground must be the note ONLY on transparency so the
# OS-supplied background color shows through and the icon survives any mask
# (circle/squircle/rounded-square) with proper safe-zone padding (~66% area).
logo_svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="note" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2cff7e"/>
      <stop offset="55%" stop-color="#1ed760"/>
      <stop offset="100%" stop-color="#14a94a"/>
    </linearGradient>
  </defs>
  <g fill="url(#note)">
    <rect x="392" y="330" width="42" height="420"/>
    <rect x="630" y="290" width="42" height="420"/>
    <path d="M 392 330 L 672 290 L 672 372 L 392 412 Z"/>
    <ellipse cx="342" cy="738" rx="118" ry="88" transform="rotate(-16 342 738)"/>
    <ellipse cx="580" cy="698" rx="118" ry="88" transform="rotate(-16 580 698)"/>
  </g>
  <g fill="#1ed760" opacity="0.9">
    <rect x="768" y="600" width="30" height="120" rx="15"/>
    <rect x="818" y="540" width="30" height="180" rx="15"/>
    <rect x="868" y="640" width="30" height="80" rx="15"/>
  </g>
</svg>"""
with open(f"{OUT}/logo-fore.svg", "w") as f:
    f.write(logo_svg)
cairosvg.svg2png(url=f"{OUT}/logo-fore.svg", write_to=f"{OUT}/logo.png",
                 output_width=1024, output_height=1024)

# ---- Splash 2732x2732: pure black, breathing glow, centered note ----
S = 2732
splash = Image.new("RGB", (S, S), (0, 0, 0))
# soft green radial glow
glow = Image.new("L", (S, S), 0)
gd = ImageDraw.Draw(glow)
gd.ellipse([S*0.28, S*0.26, S*0.72, S*0.70], fill=70)
glow = glow.filter(ImageFilter.GaussianBlur(180))
green = Image.new("RGB", (S, S), (30, 215, 96))
splash = Image.composite(green, splash, glow.point(lambda p: p))
# center the foreground note at ~30% of splash
fore = Image.open(f"{OUT}/logo.png").convert("RGBA")
fs = int(S * 0.30)
fore = fore.resize((fs, fs), Image.LANCZOS)
splash_rgba = splash.convert("RGBA")
splash_rgba.alpha_composite(fore, ((S - fs)//2, int((S - fs)//2 * 0.98)))
splash_rgba.convert("RGB").save(f"{OUT}/splash.png")

print("generated:", os.listdir(OUT))
