#!/usr/bin/env python3
"""
Generate Lantern's app icon as a PNG. Stdlib only — no Pillow.

A near-black squircle holding a cool metal ring around a warm core: the lantern
reduced to the thing it actually is, light held inside a housing. The core lights
the ring's inner edge additively and spills onto the background, so the tile
reads as lit from within rather than as a flat glyph.

Drawn this way on purpose. The earlier lantern had a handle, two caps, tapered
posts and a foot; below about 48px those collapsed into a grey smudge and the
tile read as "dark square, warm dot". Two shapes survive any size.

Antialiased by 3x3 supersampling.

    python3 tools/make_icon.py out.png [size]
"""

import struct
import sys
import zlib

SQUIRCLE_N = 5.0      # 4-5 approximates the Big Sur icon shape
CONTENT = 0.82        # art occupies this fraction; the rest is transparent margin

RING_R = 0.262        # ring centreline, in fractions of the tile
RING_TH = 0.048       # thick enough to hold up at 32px; thinner greys out
CORE_R = 0.150        # small on purpose — the dark gap between core and ring is
                      # what makes this read as light *held* rather than a disc

BG_TOP = (0x1B, 0x1C, 0x22)     # cool charcoal, lifts the top edge off pure black
BG_BOT = (0x06, 0x06, 0x08)     # near black
METAL_HI = (0xF2, 0xF5, 0xFA)   # cool white
METAL_LO = (0x9A, 0xA4, 0xB8)   # cool steel, used lower down for a little depth
FLAME_CORE = (0xFF, 0xFE, 0xF6)   # white-hot centre
FLAME_MID  = (0xFF, 0xD1, 0x63)   # yellow body
FLAME_EDGE = (0xFF, 0x8B, 0x1C)   # deep orange rim
GLOW = (0xFF, 0xB4, 0x4A)


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def add_light(base, light, amount):
    """Additive blend, clamped — light falling on a surface."""
    return tuple(min(255.0, base[i] + light[i] * amount) for i in range(3))


def seg(x, y, x0, y0, x1, y1, thick):
    """Distance to a line segment, as a thickness test. Lets posts be angled."""
    dx, dy = x1 - x0, y1 - y0
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / L2))
    cx, cy = x0 + t * dx, y0 + t * dy
    return ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 <= thick * 0.5


def ring(x, y, cx, cy, radius, thick, upper_only=False):
    if upper_only and y > cy:
        return False
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    return abs(d - radius) <= thick * 0.5


def flame_field(x, y, cx, base_y, r, height, lean):
    """
    A flame rather than a droplet: rounded base, concave sides, a point at the
    tip, and a slight curl so it does not read as a symmetrical blob.

    Returns 0 outside, rising to 1 on the centreline, so the caller can grade
    colour from rim to core instead of filling a flat shape.
    """
    h = base_y - y                      # height above the base centre
    if h > height or h < -r:
        return 0.0
    if h <= 0.0:                        # rounded base
        d = (((x - cx) / r) ** 2 + ((y - base_y) / r) ** 2) ** 0.5
        return max(0.0, 1.0 - d)
    t = h / height
    # exponent < 1 makes the sides concave, which is what reads as "flame"
    w = r * (1.0 - t) ** 0.70
    if w <= 1e-6:
        return 0.0
    axis = cx + lean * (t ** 2)         # tip curls slightly to one side
    return max(0.0, 1.0 - abs(x - axis) / w)


def shade(px, py, size):
    """Return (alpha 0..1, (r,g,b)) for a point in pixel space."""
    half = size / 2.0
    radius = half * CONTENT
    dx = abs(px - half) / radius
    dy = abs(py - half) / radius
    if (dx ** SQUIRCLE_N + dy ** SQUIRCLE_N) ** (1.0 / SQUIRCLE_N) > 1.0:
        return 0.0, (0, 0, 0)

    u = px / float(size)
    v = py / float(size)
    mid = 0.5

    d = ((u - mid) ** 2 + (v - mid) ** 2) ** 0.5

    # ── background: vertical gradient, then the core's spill light ───────────
    col = mix(BG_TOP, BG_BOT, v)
    # Falls off fast: a gentler curve floods the gap and the housing stops
    # reading as a housing.
    spill = max(0.0, 1.0 - d / 0.42) ** 3.4
    col = add_light(col, GLOW, spill * 0.62)

    # ── the ring ────────────────────────────────────────────────────────────
    # Cool white at the top, steel toward the bottom, and lit on its inner edge
    # by the core — that inner rim is what stops it reading as a flat outline.
    if ring(u, v, mid, mid, RING_R, RING_TH):
        metal = mix(METAL_HI, METAL_LO, max(0.0, min(1.0, (v - 0.26) / 0.50)))
        inner_edge = RING_R - RING_TH * 0.5
        lit = max(0.0, 1.0 - (d - inner_edge) / RING_TH)
        return 1.0, add_light(metal, GLOW, lit * 0.55 + spill * 0.30)

    # ── the core ────────────────────────────────────────────────────────────
    # Graded rather than banded, but with enough gamma that the middle stays a
    # solid bright disc: that is what survives being drawn 32 pixels wide.
    core = max(0.0, 1.0 - d / CORE_R)
    if core > 0.0:
        c = mix(FLAME_EDGE, FLAME_MID, min(1.0, core * 2.0))
        if core > 0.52:
            c = mix(c, FLAME_CORE, min(1.0, (core - 0.52) / 0.28))
        # Fade the outermost sliver into the lit background so the core has no
        # hard circular cut where it meets the gap.
        return 1.0, mix(col, c, min(1.0, core * 3.4))

    return 1.0, col


def render(size):
    rows = []
    ss = 3                       # 3x3 supersampling — the angled posts need it
    step = 1.0 / ss
    offset = step / 2.0
    for y in range(size):
        row = bytearray([0])     # PNG filter type 0
        for x in range(size):
            acc_a = 0.0
            acc = [0.0, 0.0, 0.0]
            for sy in range(ss):
                py = y + offset + sy * step
                for sx in range(ss):
                    px = x + offset + sx * step
                    a, rgb = shade(px, py, size)
                    acc_a += a
                    if a:
                        for i in range(3):
                            acc[i] += rgb[i] * a
            n = ss * ss
            alpha = acc_a / n
            if alpha <= 0.0:
                row += b"\x00\x00\x00\x00"
            else:
                # un-premultiply so the squircle edge keeps its colour
                row += bytes(min(255, max(0, int(round(acc[i] / acc_a)))) for i in range(3))
                row += bytes((min(255, int(round(alpha * 255))),))
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def write_png(path, size):
    raw = render(size)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "icon.png"
    dim = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    written = write_png(out, dim)
    print(f"wrote {out} ({dim}x{dim}, {written} bytes)")
