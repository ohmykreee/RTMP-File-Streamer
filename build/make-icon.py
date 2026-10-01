"""Generate the application icon assets (rounded gradient square with a play glyph).

Writes build/icon.png, build/icon.ico and size variants.
Run: python build/make-icon.py
"""

from PIL import Image, ImageDraw
import os

SIZE = 1024
OUT = os.path.dirname(os.path.abspath(__file__))

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

# Diagonal gradient from #2F81F7 (blue) to #7B3FF2 (violet), computed per pixel so
# there is no rotation step (rotating the layer would leave transparent corners).
c1 = (47, 129, 247)
c2 = (123, 63, 242)
grad = Image.new("RGB", (SIZE, SIZE))
pixels = grad.load()
for y in range(SIZE):
    for x in range(SIZE):
        t = (x / (SIZE - 1) + y / (SIZE - 1)) / 2
        pixels[x, y] = (
            int(c1[0] + (c2[0] - c1[0]) * t),
            int(c1[1] + (c2[1] - c1[1]) * t),
            int(c1[2] + (c2[2] - c1[2]) * t),
        )

# Rounded-square mask
radius = int(SIZE * 0.22)
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
img.paste(grad, (0, 0), mask)

# Soft inner highlight along the top
highlight = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(highlight).rounded_rectangle(
    [int(SIZE * 0.06), int(SIZE * 0.06), SIZE - int(SIZE * 0.06), int(SIZE * 0.45)],
    radius=int(SIZE * 0.18),
    fill=(255, 255, 255, 26),
)
img = Image.alpha_composite(img, highlight)

# Play triangle
d = ImageDraw.Draw(img)
cx, cy = SIZE * 0.53, SIZE * 0.5
h = SIZE * 0.30
w = h * 0.88
d.polygon(
    [(cx - w * 0.5, cy - h * 0.5), (cx - w * 0.5, cy + h * 0.5), (cx + w * 0.62, cy)],
    fill=(255, 255, 255, 255),
)

# Broadcast arcs on the right
for i, r in enumerate((0.30, 0.40)):
    bb = [cx - SIZE * r, cy - SIZE * r, cx + SIZE * r, cy + SIZE * r]
    d.arc(bb, start=-52, end=52, fill=(255, 255, 255, 150 - i * 45), width=int(SIZE * 0.035))

img.save(os.path.join(OUT, "icon.png"))
for size in (256, 128, 64, 48, 32, 16):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, "icon-%d.png" % size))
img.resize((256, 256), Image.LANCZOS).save(
    os.path.join(OUT, "icon.ico"),
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icons written to", OUT)
