# 🎨 Paint by Numbers

A free, relaxing **color-by-number** game you can play in any browser or install to your phone's home screen. Fill the numbered cells to reveal beautiful pictures — paint the built‑in gallery, **upload your own photos**, or browse **free public‑domain images** to color.

**▶ Play now:** https://lordbasilaiassistant-sudo.github.io/paint-by-numbers/

- 🚫 **No ads, no purchases, no sign‑up.** Ever.
- 📴 **Works offline** once loaded (installable PWA).
- 💾 **Progress saves automatically** — close it and pick up right where you left off.
- 🖼️ **Paint your own photos** — any picture becomes a paint‑by‑numbers puzzle on your device.
- 🔎 **Free image library** — search CC0 (public‑domain) photos and color them.

## How to play
1. Pick a picture from the gallery (the thumbnail shows the finished art — like the lid of a puzzle box).
2. Choose a color number from the palette at the bottom.
3. Tap each cell that shows that number to fill it. Matching cells are gently tinted so they're easy to find.
4. **Pinch / scroll to zoom** right down to a single cell, drag to pan. Use the 🖌️/✋ button to switch between painting and panning.
5. Finish every cell to reveal the picture in full color. 🎉

## Install to your phone
- **Android / Chrome / Edge:** tap the **Install app** button, or your browser's "Add to Home screen."
- **iPhone / iPad (Safari):** tap **Share → Add to Home Screen.**

It then opens full‑screen like a native app, and plays offline.

## Tech
- Pure HTML/CSS/JavaScript — no framework, no build step, no tracking.
- Photos are converted to puzzles entirely **on your device** (median‑cut color quantization + connected‑region cleanup + tile‑based numbered cells). Only the transformed, low‑resolution numbered grids are stored — never your original photos.
- Built‑in gallery images are CC0 (public domain) via [Openverse](https://openverse.org); only the derived numbered grids ship in this repo.
- Installable **PWA** with an offline service worker.

### Project layout
```
index.html            app shell + SEO
styles.css            UI
js/convert.js         image → puzzle (quantize, regions, RLE) — runs in-browser
js/puzzle-data.js     baked built-in gallery (generated)
js/puzzles.js         decodes the baked data
js/game.js            gameplay, rendering, zoom, persistence, upload, browser
service-worker.js     offline cache
tools/bake_puzzles.py rebuild the built-in gallery from CC0 photos
tools/make_icons.py   regenerate app icons
tools/make_og.py      regenerate the social-share image
```

### Rebuild the built-in gallery
```bash
pip install pillow
python tools/bake_puzzles.py     # fetch CC0 photos → js/puzzle-data.js
python tools/make_icons.py       # icons/
python tools/make_og.py          # og-image.png
```

## License
Code is released under the MIT License (see `LICENSE`). Built‑in puzzle images are derived from CC0 / public‑domain sources.
