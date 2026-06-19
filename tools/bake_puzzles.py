"""Bake the built-in gallery: fetch CC0 photos, convert to paint-by-number
puzzles, and emit js/puzzle-data.js (palette + RLE grid per puzzle).

Only the transformed low-res numbered grids are stored in the repo, never the
source photographs.  Sources are CC0 via the Openverse API.
"""
import json, os, sys, time, urllib.request, urllib.parse
from collections import Counter
from PIL import Image, ImageOps, ImageEnhance, ImageFilter

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "..", "js", "puzzle-data.js")
UA = "PaintByNumbers/1.0 (personal project)"

# subject, display name, emoji, target max dimension, colour count
CATALOG = [
    ("sunflower",        "Sunflower",     "🌻", 72, 20),
    ("red rose flower",  "Rose",          "🌹", 70, 20),
    ("butterfly wings",  "Butterfly",     "🦋", 76, 22),
    ("kitten cat",       "Kitten",        "🐱", 72, 20),
    ("puppy dog",        "Puppy",         "🐶", 72, 20),
    ("autumn forest",    "Autumn Woods",  "🍂", 78, 24),
    ("beach sunset sea", "Sunset Beach",  "🌅", 80, 22),
    ("mountain lake",    "Mountain Lake", "🏔️", 80, 24),
    ("nebula galaxy",    "Galaxy",        "🌌", 76, 22),
    ("hot air balloon",  "Hot Air Balloon","🎈", 72, 22),
    ("lighthouse coast", "Lighthouse",    "🗼", 74, 22),
    ("cherry blossom",   "Cherry Blossom","🌸", 76, 20),
    ("koi fish pond",    "Koi Pond",      "🐟", 76, 22),
    ("colorful parrot",  "Parrot",        "🦜", 72, 22),
    ("red fox",          "Fox",           "🦊", 72, 20),
    ("hummingbird flower","Hummingbird",  "🐦", 76, 22),
    ("tropical fish reef","Coral Reef",   "🐠", 80, 24),
    ("strawberry fruit", "Strawberry",    "🍓", 68, 18),
]


def openverse(query, n=12):
    url = "https://api.openverse.org/v1/images/?" + urllib.parse.urlencode({
        "q": query, "license": "cc0", "size": "medium",
        "page_size": n, "mature": "false",
    })
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get("results", [])


def fetch_image(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        from io import BytesIO
        return Image.open(BytesIO(r.read())).convert("RGB")


def crop_to(img, max_dim):
    """Resize so the long side == max_dim, keep aspect, gently center-crop
    extreme panoramas toward a friendlier 4:3-ish frame."""
    w, h = img.size
    ar = w / h
    if ar > 1.6:        # very wide -> crop sides
        nw = int(h * 1.5); img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    elif ar < 0.62:     # very tall -> crop top/bottom
        nh = int(w / 1.5); img = img.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    w, h = img.size
    s = max_dim / max(w, h)
    return img.resize((max(8, round(w * s)), max(8, round(h * s))), Image.LANCZOS)


def convert(img, max_dim, colors):
    img = ImageOps.autocontrast(img, cutoff=1)
    img = ImageEnhance.Color(img).enhance(1.18)          # a touch more vivid
    img = ImageEnhance.Contrast(img).enhance(1.05)
    small = crop_to(img, max_dim)
    w, h = small.size
    q = small.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE)
    q = q.filter(ImageFilter.ModeFilter(3))              # flatten speckle (region merge happens in-app)
    pal = q.getpalette()
    idxs = list(q.getdata())

    # build grid
    grid = [idxs[y * w:(y + 1) * w] for y in range(h)]

    # compact + order palette by luminance
    used = sorted(set(idxs))
    cols = [(pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]) for i in used]
    order = sorted(range(len(used)), key=lambda k: 0.299 * cols[k][0] + 0.587 * cols[k][1] + 0.114 * cols[k][2])
    remap = {used[order[n]]: n for n in range(len(order))}
    new_pal = [cols[order[n]] for n in range(len(order))]
    grid = [[remap[v] + 1 for v in row] for row in grid]   # 1-based

    # RLE: flat [val,run,...]
    rle = []
    prev, run = None, 0
    for row in grid:
        for v in row:
            if v == prev:
                run += 1
            else:
                if prev is not None:
                    rle += [prev, run]
                prev, run = v, 1
    if prev is not None:
        rle += [prev, run]

    hexpal = ["#%02x%02x%02x" % c for c in new_pal]
    return w, h, hexpal, rle


def main():
    puzzles = []
    for subj, name, emoji, dim, colors in CATALOG:
        ok = False
        try:
            results = openverse(subj)
        except Exception as e:
            print("  search failed", subj, e); results = []
        for r in results:
            u = r.get("url")
            if not u:
                continue
            try:
                img = fetch_image(u)
                if min(img.size) < 200:
                    continue
                # high resolution so the finished picture reads like the photo,
                # not a coarse pixel grid (regions are detected in-app)
                w, h, pal, rle = convert(img, 150, colors)
                puzzles.append({
                    "id": subj.split()[0] + "-" + str(len(puzzles)),
                    "name": name, "emoji": emoji,
                    "w": w, "h": h, "palette": pal, "rle": rle,
                })
                print("  ok  %-16s %dx%d  %d colors  %d cells" % (name, w, h, len(pal), w * h))
                ok = True
                break
            except Exception as e:
                continue
        if not ok:
            print("  SKIP", name)
        time.sleep(0.3)

    body = "window.PUZZLE_DATA = " + json.dumps(puzzles, separators=(",", ":")) + ";\n"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(body)
    kb = len(body) / 1024
    print("wrote %s  (%d puzzles, %.1f KB)" % (OUT, len(puzzles), kb))


if __name__ == "__main__":
    main()
