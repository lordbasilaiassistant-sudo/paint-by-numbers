"""Bake the built-in gallery: fetch CC0 photos, pick the most vivid / clearest
candidate per subject, convert to paint-by-number puzzles, and emit
js/puzzle-data.js (palette + RLE grid per puzzle).

Only the transformed low-res numbered grids are stored in the repo, never the
source photographs.  Sources are CC0 via the Openverse API.
"""
import json, math, os, time, urllib.request, urllib.parse
from io import BytesIO
from PIL import Image, ImageOps, ImageEnhance, ImageFilter, ImageMath, ImageStat

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "..", "js", "puzzle-data.js")
UA = "PaintByNumbers/1.0 (personal project)"
RES = 150          # long-edge resolution of the puzzle grid
TRIES = 7          # candidate images to download & score per subject

# query, display name, emoji, colours
CATALOG = [
    ("sunflower close up",        "Sunflower",      "🌻", 22),
    ("single red rose flower",    "Rose",           "🌹", 22),
    ("monarch butterfly wings",   "Butterfly",      "🦋", 22),
    ("kitten face",               "Kitten",         "🐱", 22),
    ("golden retriever puppy",    "Puppy",          "🐶", 22),
    ("autumn maple tree red",     "Autumn",         "🍂", 24),
    ("ocean sunset beach",        "Sunset",         "🌅", 22),
    ("mountain lake reflection",  "Mountain Lake",  "🏔️", 24),
    ("spiral galaxy stars",       "Galaxy",         "🌌", 22),
    ("hot air balloons sky",      "Hot Air Balloons","🎈", 22),
    ("lighthouse blue sky",       "Lighthouse",     "🗼", 22),
    ("cherry blossom pink tree",  "Cherry Blossom", "🌸", 22),
    ("koi fish pond orange",      "Koi",            "🐟", 22),
    ("scarlet macaw parrot",      "Parrot",         "🦜", 24),
    ("red fox animal",            "Fox",            "🦊", 22),
    ("hummingbird flower",        "Hummingbird",    "🐦", 22),
    ("clownfish sea anemone",     "Clownfish",      "🐠", 24),
    ("fresh strawberries",        "Strawberry",     "🍓", 20),
    ("peacock feathers",          "Peacock",        "🦚", 24),
    ("tulip field colorful",      "Tulips",         "🌷", 22),
    ("hibiscus flower",           "Hibiscus",       "🌺", 22),
    ("toucan bird",               "Toucan",         "🐦", 22),
]


def openverse(query, n=18):
    url = "https://api.openverse.org/v1/images/?" + urllib.parse.urlencode({
        "q": query, "license": "cc0", "size": "large",
        "page_size": n, "mature": "false",
    })
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get("results", [])


def fetch_image(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return Image.open(BytesIO(r.read())).convert("RGB")


def quality(img):
    """Higher = more vivid & well-exposed. Rejects dark / muddy / grey shots."""
    s = img.resize((72, 72))
    r, g, b = s.split()
    rg = ImageMath.eval("abs(a-b)", a=r, b=g).convert("L")
    yb = ImageMath.eval("abs((a+b)/2-c)", a=r, b=g, c=b).convert("L")
    srg, syb = ImageStat.Stat(rg), ImageStat.Stat(yb)
    colorful = math.sqrt(srg.stddev[0] ** 2 + syb.stddev[0] ** 2) + \
        0.3 * math.sqrt(srg.mean[0] ** 2 + syb.mean[0] ** 2)
    bright = ImageStat.Stat(s.convert("L")).mean[0]
    pen = 0.0
    if bright < 60:  pen += (60 - bright) * 1.4      # too dark (e.g. eclipse)
    if bright > 205: pen += (bright - 205) * 1.0      # blown out
    return colorful - pen


def crop_to(img, max_dim):
    w, h = img.size
    ar = w / h
    if ar > 1.6:
        nw = int(h * 1.5); img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    elif ar < 0.62:
        nh = int(w / 1.5); img = img.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    w, h = img.size
    s = max_dim / max(w, h)
    return img.resize((max(8, round(w * s)), max(8, round(h * s))), Image.LANCZOS)


def convert(img, colors):
    img = ImageOps.autocontrast(img, cutoff=1)
    img = ImageEnhance.Color(img).enhance(1.2)
    img = ImageEnhance.Contrast(img).enhance(1.05)
    small = crop_to(img, RES)
    w, h = small.size
    q = small.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE)
    q = q.filter(ImageFilter.ModeFilter(3))
    pal, idxs = q.getpalette(), list(q.getdata())
    grid = [idxs[y * w:(y + 1) * w] for y in range(h)]
    used = sorted(set(idxs))
    cols = [(pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]) for i in used]
    order = sorted(range(len(used)), key=lambda k: 0.299 * cols[k][0] + 0.587 * cols[k][1] + 0.114 * cols[k][2])
    remap = {used[order[n]]: n for n in range(len(order))}
    new_pal = [cols[order[n]] for n in range(len(order))]
    grid = [[remap[v] + 1 for v in row] for row in grid]
    rle, prev, run = [], None, 0
    for row in grid:
        for v in row:
            if v == prev: run += 1
            else:
                if prev is not None: rle += [prev, run]
                prev, run = v, 1
    if prev is not None: rle += [prev, run]
    return w, h, ["#%02x%02x%02x" % c for c in new_pal], rle


def main():
    puzzles = []
    for query, name, emoji, colors in CATALOG:
        try:
            results = openverse(query)
        except Exception as e:
            print("  search failed", name, e); results = []
        best, best_score, tried = None, -1e9, 0
        for r in results:
            if tried >= TRIES: break
            u = r.get("url")
            if not u: continue
            try:
                img = fetch_image(u)
                if min(img.size) < 240: continue
                tried += 1
                sc = quality(img)
                if sc > best_score: best_score, best = sc, img
            except Exception:
                continue
        if best is None:
            print("  SKIP", name); continue
        w, h, pal, rle = convert(best, colors)
        puzzles.append({"id": name.lower().replace(" ", "-"), "name": name, "emoji": emoji,
                        "w": w, "h": h, "palette": pal, "rle": rle})
        print("  ok  %-16s %dx%d  %2d colors  score %.0f" % (name, w, h, len(pal), best_score))
        time.sleep(0.2)

    body = "window.PUZZLE_DATA = " + json.dumps(puzzles, separators=(",", ":")) + ";\n"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(body)
    print("wrote %s  (%d puzzles, %.1f KB)" % (OUT, len(puzzles), len(body) / 1024))


if __name__ == "__main__":
    main()
