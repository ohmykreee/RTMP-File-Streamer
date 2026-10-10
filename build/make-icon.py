"""Generate the application icon assets.

Flat by design: one solid blue tile, solid white shapes, no gradient, no gloss, no
shadow. The mark is the one the UI itself draws (see
`src/renderer/src/components/BrandMark.tsx`): a play glyph that emits two broadcast
arcs. Keep the two in step — the window chrome and the header logo are meant to be
the same thing at two sizes.

Run: python build/make-icon.py
Writes build/icon.png, build/icon.ico and the size variants next to it.
"""

from PIL import Image, ImageDraw
import os

SIZE = 1024
# Drawn oversized and downsampled: PIL has no antialiased arcs or polygons, and
# the whole mark is curves and diagonals.
SS = 2
OUT = os.path.dirname(os.path.abspath(__file__))

# Tile gradient, top-left to bottom-right: a gentle luminance ramp over the theme's
# primary blue — enough material to read as a surface, not a gloss.
C1 = (59, 130, 246)
C2 = (37, 99, 235)
C3 = (29, 78, 216)
MARK = (255, 255, 255)


def tile(size: int) -> Image.Image:
    """The rounded, softly graded background of the mark."""
    px = size * SS
    grad = Image.new("RGB", (px, px))
    pixels = grad.load()
    for y in range(px):
        for x in range(px):
            # Diagonal parameter, then a two-stop ramp through the middle colour.
            t = (x / (px - 1) + y / (px - 1)) / 2
            if t < 0.5:
                a, b, k = C1, C2, t / 0.5
            else:
                a, b, k = C2, C3, (t - 0.5) / 0.5
            pixels[x, y] = (
                int(a[0] + (b[0] - a[0]) * k),
                int(a[1] + (b[1] - a[1]) * k),
                int(a[2] + (b[2] - a[2]) * k),
            )

    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    mask = Image.new("L", (px, px), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, px - 1, px - 1], radius=int(px * 0.235), fill=255)
    img.paste(grad, (0, 0), mask)
    return img.resize((size, size), Image.LANCZOS)


def mark(size: int, compact: bool) -> Image.Image:
    """The play glyph plus its broadcast arcs, transparent elsewhere."""
    px = size * SS
    layer = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # Placement: balanced on the mark's VISUAL centre, not on its bounding box and not
    # on the triangle alone. The bright weight (solid triangle + the near arc) is what
    # the eye places, so the group sits one unit right of the outline's centre — that
    # leaves the left margin a little wider than the right, which is what the fading
    # outer arc needs to read as a balanced whole. Judged on a rendered sheet
    # (0/1/2 unit offsets at 256, 48 and 16 px) rather than by arithmetic.
    u = px / 32

    if compact:
        # Below ~48 px the outer arc turns into a grey smear and the glyph loses its
        # point: a smaller triangle, one arc, and a stroke thick enough to survive
        # the resample. The gap between glyph and arc is wider here on purpose — at
        # this size a tight gap closes up into a single blob.
        d.polygon([(8.8 * u, 8.6 * u), (18.4 * u, 16.0 * u), (8.8 * u, 23.4 * u)], fill=MARK)
        _arc(d, u, cx=18.65, cy=16.0, r=6.8, spread=54, width=3.0, alpha=255, color=MARK)
    else:
        d.polygon([(9.2 * u, 9.0 * u), (17.6 * u, 16.0 * u), (9.2 * u, 23.0 * u)], fill=MARK)
        _arc(d, u, cx=17.2, cy=16.0, r=5.6, spread=50, width=2.1, alpha=255, color=MARK)
        _arc(d, u, cx=17.0, cy=16.0, r=9.0, spread=46, width=2.1, alpha=140, color=MARK)

    return layer.resize((size, size), Image.LANCZOS)


def _arc(d: ImageDraw.ImageDraw, u: float, cx: float, cy: float, r: float, spread: float, width: float, alpha: int, color) -> None:
    """One broadcast arc, centred on the glyph's right vertex."""
    box = [((cx - r) * u), ((cy - r) * u), ((cx + r) * u), ((cy + r) * u)]
    d.arc(box, start=-spread, end=spread, fill=color + (alpha,), width=max(1, int(round(width * u))))


def render(size: int, compact: bool) -> Image.Image:
    img = tile(size)
    img = Image.alpha_composite(img, mark(size, compact))
    return img


# Full artwork from 64 px up; the simplified mark below that, where the outer arc
# would be thinner than a pixel.
VARIANTS = [256, 128, 64, 48, 32, 16]

icon = render(SIZE, compact=False)
icon.save(os.path.join(OUT, "icon.png"))
for size in VARIANTS:
    render(size, compact=size < 64).save(os.path.join(OUT, "icon-%d.png" % size))

# The .ico carries each size as its own drawing rather than one bitmap resampled
# down: Windows picks the 16 px frame for the taskbar, and the compact artwork is
# what stays readable there. `sizes` and `append_images` are matched positionally.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
render(256, compact=False).save(
    os.path.join(OUT, "icon.ico"),
    sizes=[(s, s) for s in ICO_SIZES],
    append_images=[render(s, compact=s < 64) for s in ICO_SIZES],
)
print("icons written to", OUT)
