#!/usr/bin/env python3
"""Writes optimized AVIF + WebP files from design-assets/source/ to design-assets/optimized/.
IMG-007/008: 360x270 (1x) and 720x540 (2x). IMG-003: 1200x630 (1x) and 2400x1260 (2x)."""
import os, io
from PIL import Image
R = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
S, O = f"{R}/design-assets/source/", f"{R}/design-assets/optimized/"
jobs = [
  ("IMG-007_kestrel-home_v1.png", "IMG-007_kestrel-home", [(360,270),(720,540)], 35),
  ("IMG-007_orchard-lane-home_v1.png", "IMG-007_orchard-lane-home", [(360,270),(720,540)], 35),
  ("IMG-007_tidewild-home_v2.png", "IMG-007_tidewild-home", [(360,270),(720,540)], 35),
  ("IMG-003_share-image_v1.png", "IMG-003_share-image", [(1200,630)], 200),
  ("IMG-003_share-image_v1@2x.png", "IMG-003_share-image", [(2400,1260)], 600),
]
def save(im, path, fmt, budget):
    # highest quality that fits the budget
    for q in range(90, 20, -3):
        b = io.BytesIO(); im.save(b, fmt, quality=q, **({"method":6} if fmt=="WEBP" else {"speed":3}))
        if len(b.getvalue()) <= budget*1024: break
    open(path,"wb").write(b.getvalue()); return q, len(b.getvalue())
for src, slug, sizes, budget in jobs:
    im0 = Image.open(S+src).convert("RGB")
    for (w,h) in sizes:
        im = im0 if im0.size==(w,h) else im0.resize((w,h), Image.LANCZOS)
        for ext, fmt in (("webp","WEBP"),("avif","AVIF")):
            q,n = save(im, f"{O}{slug}-{w}.{ext}", fmt, budget)
            print(f"{slug}-{w}.{ext}  q{q}  {n/1024:.1f} KB (budget {budget})")
