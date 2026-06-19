"""Generate a 1200x630 social-share (Open Graph) image."""
import os, json, re
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(__file__)
ICONS = os.path.join(HERE, "..", "icons")
DATA = os.path.join(HERE, "..", "js", "puzzle-data.js")
W, H = 1200, 630
A, B = (91, 108, 255), (138, 91, 255)


def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def font(sz, bold=True):
    for n in (("segoeuib.ttf" if bold else "segoeui.ttf"), "arialbd.ttf", "DejaVuSans-Bold.ttf", "arial.ttf"):
        try: return ImageFont.truetype(n, sz)
        except Exception: pass
    return ImageFont.load_default()


def load_puzzles():
    txt = open(DATA, encoding="utf-8").read()
    return json.loads(re.sub(r"^window\.PUZZLE_DATA\s*=\s*|;\s*$", "", txt.strip()))


def render_puzzle(p, box):
    w, h, pal, rle = p["w"], p["h"], p["palette"], p["rle"]
    im = Image.new("RGB", (w, h))
    px = im.load()
    i = 0
    for k in range(0, len(rle), 2):
        v, run = rle[k], rle[k + 1]
        for _ in range(run):
            x, y = i % w, i // w
            c = pal[v - 1].lstrip("#")
            px[x, y] = (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
            i += 1
    # cover-crop into a square box
    s = box
    scale = max(s / w, s / h)
    im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    left = (im.width - s) // 2; top = (im.height - s) // 2
    return im.crop((left, top, left + s, top + s))


img = Image.new("RGB", (W, H))
d = ImageDraw.Draw(img)
for y in range(H):
    d.line([(0, y), (W, y)], fill=lerp(A, B, y / H))

# showcase a few finished puzzles on the right
try:
    puz = load_puzzles()
    picks = [p for p in puz if p["name"] in ("Rose", "Tulips", "Autumn", "Hibiscus")]
    picks = (picks + puz)[:4]
    box = 250; gap = 18; x0 = W - (box * 2 + gap) - 50; y0 = (H - (box * 2 + gap)) // 2
    for n, p in enumerate(picks):
        tile = render_puzzle(p, box)
        m = Image.new("L", (box, box), 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, box, box], 28, fill=255)
        img.paste(tile, (x0 + (n % 2) * (box + gap), y0 + (n // 2) * (box + gap)), m)
except Exception as e:
    print("puzzle render skipped:", e)

d.text((60, 210), "Paint by Numbers", font=font(78), fill=(255, 255, 255))
d.text((62, 305), "Free color-by-number coloring game", font=font(36, False), fill=(235, 235, 255))
d.text((62, 360), "Paint your own photos · No ads · Installable", font=font(30, False), fill=(220, 222, 255))
d.rounded_rectangle([62, 430, 360, 500], 35, fill=(255, 255, 255))
d.text((96, 448), "▶  Play free", font=font(34), fill=(91, 108, 255))

img.save(os.path.join(HERE, "..", "og-image.png"))
print("wrote og-image.png")
