"""Generate PWA icons for Paint by Numbers (paint-palette + numbered tiles)."""
import math, os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

ACCENT = (91, 108, 255)
ACCENT2 = (138, 91, 255)
TILES = [("1", (255, 107, 107)), ("2", (255, 212, 59)),
         ("3", (105, 219, 124)), ("4", (77, 171, 247))]


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def font(size):
    for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def make(size, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # diagonal gradient background
    grad = Image.new("RGB", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        for_t = y / size
        gd.line([(0, y), (size, y)], fill=lerp(ACCENT, ACCENT2, for_t))
    # rounded mask (maskable icons keep extra safe padding -> bigger radius bg)
    radius = int(size * (0.18 if not maskable else 0.5))
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    if maskable:
        md.rectangle([0, 0, size, size], fill=255)  # full bleed, content inset
    else:
        md.rounded_rectangle([0, 0, size, size], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # 2x2 numbered tiles
    inset = size * (0.30 if maskable else 0.18)
    gap = size * 0.045
    area = size - inset * 2
    tile = (area - gap) / 2
    f = font(int(tile * 0.62))
    for i, (num, col) in enumerate(TILES):
        cx = inset + (i % 2) * (tile + gap)
        cy = inset + (i // 2) * (tile + gap)
        box = [cx, cy, cx + tile, cy + tile]
        rounded(d, box, int(tile * 0.22), col)
        # number, auto-contrast
        lum = (col[0] * 299 + col[1] * 587 + col[2] * 114) / 1000
        tcol = (40, 40, 40) if lum > 140 else (255, 255, 255)
        tb = d.textbbox((0, 0), num, font=f)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        d.text((cx + tile / 2 - tw / 2 - tb[0], cy + tile / 2 - th / 2 - tb[1]),
               num, font=f, fill=tcol)
    return img


for sz in (192, 512, 180):
    make(sz).save(os.path.join(OUT, f"icon-{sz}.png"))
make(512, maskable=True).save(os.path.join(OUT, "icon-maskable-512.png"))
# favicon
make(64).resize((32, 32)).save(os.path.join(OUT, "favicon-32.png"))
print("icons written to", os.path.abspath(OUT))
