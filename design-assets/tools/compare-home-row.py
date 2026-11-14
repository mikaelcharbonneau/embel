#!/usr/bin/env python3
"""Pastes the three IMG-007 crops into the approved signed-out Home screens (390, 768, 1440) at the
slot positions and writes a side-by-side check: approved row on the left, candidate row on the right.
Usage: python3 design-assets/tools/compare-home-row.py"""
from PIL import Image, ImageDraw
import os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
A = os.path.join(ROOT, "design-audit/approved")
S = os.path.join(ROOT, "design-assets/source")
OUT = os.path.join(ROOT, "design-assets/candidates")
crops = [Image.open(os.path.join(S, f)).convert("RGB") for f in (
    "IMG-007_kestrel-home_v1.png", "IMG-007_orchard-lane-home_v1.png", "IMG-007_tidewild-home_v2.png")]
PLACEHOLDER = (241, 240, 238)

def slot_of_placeholder(im):
    """Bounding box of the placeholder card: rows that hold a long unbroken run of its colour."""
    px = im.load(); w, h = im.size; rows = []; x0s = []; x1s = []
    for y in range(500, h):
        best = (0, 0, 0); run = 0
        for x in range(w):
            if px[x, y] == PLACEHOLDER:
                run += 1
                if run > best[0]: best = (run, x - run + 1, x + 1)
            else: run = 0
        if best[0] >= 120: rows.append(y); x0s.append(best[1]); x1s.append(best[2])
    return min(x0s), min(rows), max(x1s), max(rows) + 1

def rounded(img, r):
    m = Image.new("L", img.size, 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, img.size[0] - 1, img.size[1] - 1), r, fill=255); return m

for width in (390, 768, 1440):
    approved = Image.open(os.path.join(A, f"home__home-signed-out__{width}.png")).convert("RGB")
    x3, y3, x4, y4 = slot_of_placeholder(approved)
    w, h = x4 - x3, y4 - y3
    if width == 390:   # one across, stacked: stride is slot height + caption
        stride = 313; pos = [(x3, y3 - 2 * stride), (x3, y3 - stride), (x3, y3)]
    else:              # three across: stride is slot width + gap
        gap = (x3 - 24 - 2 * w) // 2 if width == 768 else 24
        left = x3 - 2 * (w + gap); pos = [(left + i * (w + gap), y3) for i in range(3)]
    cand = approved.copy()
    for (x, y), c in zip(pos, crops):
        # clear the slot area (approved art or placeholder) with the page canvas colour, then paste
        ImageDraw.Draw(cand).rectangle((x - 1, y - 1, x + w, y + h), fill=(247, 247, 245))
        t = c.resize((w, h), Image.LANCZOS); cand.paste(t, (x, y), rounded(t, 16))
    top = max(0, y3 - 90 if width != 390 else y3 - 2 * 313 - 120)
    bottom = min(approved.size[1], y4 + 60)
    left_part = approved.crop((0, top, approved.size[0], bottom)); right_part = cand.crop((0, top, approved.size[0], bottom))
    sheet = Image.new("RGB", (left_part.size[0] * 2 + 24, left_part.size[1]), (255, 255, 255))
    sheet.paste(left_part, (0, 0)); sheet.paste(right_part, (left_part.size[0] + 24, 0))
    sheet.save(os.path.join(OUT, f"IMG-007_check-{width}.png"))
    print(width, "slot", (w, h), "positions", pos, "sheet", sheet.size)
