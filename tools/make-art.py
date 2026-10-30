#!/usr/bin/env python3
"""Draws the 4-TME web tools' pixel art: a ringed planet (header + icons).

1-bit, like the OLED: the planet is filled with the same 4x4 Bayer dither the
firmware uses for its planets (drawArt()), lit from the top left, with a
tilted ring passing in front of it. Writes assets/planet.svg and the PNG icons.
Run from the repo root:  python3 tools/make-art.py   (needs Pillow for the PNGs)
"""
import math, os

BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
W, H = 40, 28
CX, CY, R = 19.5, 13.5, 10.4
TILT = math.radians(-14)
RA, RB = 19.0, 4.4

def ring_pts():
    pts = {}
    for k in range(2000):
        a = 2 * math.pi * k / 2000
        for dr in (0.0, 0.55):
            x0, y0 = (RA - dr) * math.cos(a), (RB - dr * 0.3) * math.sin(a)
            x = CX + x0 * math.cos(TILT) - y0 * math.sin(TILT)
            y = CY + x0 * math.sin(TILT) + y0 * math.cos(TILT)
            front = math.sin(a) > 0
            pts[(int(round(x)), int(round(y)))] = front
    return pts

def draw():
    on = set()
    ring = ring_pts()
    for y in range(H):
        for x in range(W):
            dx, dy = x - CX, y - CY
            d = math.hypot(dx, dy)
            if d <= R:
                if d > R - 1.0:
                    on.add((x, y)); continue
                # light from the top left: brighter -> denser
                lit = 0.52 + 0.48 * (-(dx * 0.62 + dy * 0.78) / R)
                lit = max(0.0, min(1.0, lit))
                # a darker band (the planet's stripes)
                band = 0.3 if abs((dy + dx * 0.25) + 3.0) < 1.2 else 0.0
                thresh = int((lit * 0.95 - band) * 16 + 0.5)
                if BAYER4[(y & 3) * 4 + (x & 3)] < thresh:
                    on.add((x, y))
    for (x, y), front in ring.items():
        if not (0 <= x < W and 0 <= y < H):
            continue
        inside = math.hypot(x - CX, y - CY) <= R
        if front or not inside:
            on.add((x, y))
            if front and inside:          # a black gap either side of the ring in front
                for gy in (y - 1, y + 1):
                    if (x, gy) not in ring and math.hypot(x - CX, gy - CY) <= R - 1.0:
                        on.discard((x, gy))
    # two small moons and a few stars
    for (mx, my) in [(2, 4), (37, 23)]:
        for dx, dy in [(0, 0), (1, 0), (0, 1), (1, 1)]:
            on.add((mx + dx, my + dy))
    for (sx, sy) in [(34, 2), (5, 24), (31, 7)]:
        on.add((sx, sy))
    return on

def svg(on, scale=2):
    rows = []
    for y in range(H):
        x = 0
        while x < W:
            if (x, y) in on:
                x0 = x
                while x < W and (x, y) in on:
                    x += 1
                rows.append(f"M{x0} {y}h{x - x0}v1h-{x - x0}z")
            else:
                x += 1
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W * scale}" height="{H * scale}" '
            f'shape-rendering="crispEdges"><path fill="#fff" d="{"".join(rows)}"/></svg>\n')

def png(on, size, path):
    from PIL import Image
    img = Image.new("RGBA", (W, W), (0, 0, 0, 255))
    off = (W - H) // 2
    for (x, y) in on:
        img.putpixel((x, y + off), (255, 255, 255, 255))
    img.resize((size, size), Image.NEAREST).save(path)

if __name__ == "__main__":
    os.makedirs("assets", exist_ok=True)
    on = draw()
    open("assets/planet.svg", "w").write(svg(on))
    for size, name in [(32, "favicon-32.png"), (180, "favicon-180.png"), (512, "icon-512.png")]:
        png(on, size, "assets/" + name)
    print("\n".join("".join("#" if (x, y) in on else "." for x in range(W)) for y in range(H)))
