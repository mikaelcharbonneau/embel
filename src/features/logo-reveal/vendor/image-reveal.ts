/*
 * transitions.dev / UI generation: the image variant only.
 *
 * Source: GitHub Jakubantalik/transitions.dev, skills/transitions-ui-generation/text-image-generation.js
 * (variant "image", described in 05-image.md), commit 54fbee8e9d698598b4e7ceabb2fb43ea30beacfc (2026-10-23).
 * Copied into Embel on 2026-11-13 and modified: ported to TypeScript, cut down to the image variant (no glyph
 * tracing, text lines, guides, reticle, readouts, agent log, timeline or auto-play), the dotted frame, corner
 * handles and labels left to the design system's CSS (`e-media--revealing`), the photo's own fade left to that CSS
 * (`data-stage="resolve"`), the drawing reads the picture's content box (a logo inset 12% in its tile), and each stage
 * is reported to the caller so the tile's status label can name it.
 *
 * Transitions.dev License
 * Copyright (c) 2026 Jakub Antalik / Transitions.dev
 *
 * You (and any coding agent working for you) may use this skill and the
 * transitions it contains in unlimited personal and commercial projects,
 * copy and modify them freely, and ship them to your users as part of your
 * own product or website. You may install and run this skill in any coding
 * agent to apply the transitions to your code.
 *
 * Restriction: you may not repackage, resell, or publish the collection (or a
 * substantial part of it) as a competing transitions library, motion pack,
 * or animation kit. Using the transitions inside templates and themes you
 * sell is allowed; see the full terms. Use the transitions in your products, not as a product of
 * their own.
 *
 * This skill is free for everyone, including companies, and needs no plan.
 * Paid plans cover the Pro transitions and paid Agent features: Pro is for
 * solo builders and freelancers (one individual paying personally,
 * including freelance client work); Business is for companies and teams,
 * even a single person at a company (one seat per person). If a company
 * pays for or reimburses the plan, it must be Business.
 *
 * Full terms: https://transitions.dev/terms.html
 *
 * The picture is drawn from its own pixels: a sketch of its tones in lines of equal tone, a fine halftone of its own
 * pixels, a dot matrix in its own colours, then the picture itself. The image must be decoded first and readable
 * (same origin or a blob); an unreadable image gets an even dot screen and no sketch.
 */

const NS = "http://www.w3.org/2000/svg";

export type RevealStage = "sketch" | "screen" | "colour" | "resolve";

export type RevealOptions = {
  /** The element the overlay is placed in (the tile's media frame). It must be positioned. */
  parent: HTMLElement;
  /** Class for the overlay layer; the svg, wire and head classes style the sketch. */
  classes: { layer: string; svg: string; sketch: string; wire: string; head: string };
  /** ms for the build; the whole run is about duration × 1.06. */
  duration?: number;
  /** Called when the stage changes and with a short status ("Sketch 42/108", "Screen 423 dots", "Color 64%"). */
  onStage?: (stage: RevealStage, status: string) => void;
};

export type RevealRun = { finished: Promise<void>; cancel(): void };

// an image's own timeline, from its start: contour sketch, halftone, colour, photo (fractions of duration)
const IMG = { sketch: [0.08, 0.38], screen: [0.2, 0.56], colour: [0.52, 0.68], photo: [0.64, 0.88] } as const;
const END = 1.06;
const CLEAN = [0.86, 1.04] as const;

type Point = [number, number];
type Box = { x: number; y: number; w: number; h: number; fit: string; pos: string };
type Stroke = { el: SVGPathElement; L: number; gap: number; n?: number; head: SVGCircleElement | null; t0: number };
type Dot = { x: number; y: number; r: number; at: number };

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (a: number, b: number, x: number) => {
  const q = clamp((x - a) / (b - a));
  return q * q * (3 - 2 * q);
};
const f2 = (n: number) => (+n).toFixed(2);
const hashN = (x: number) => {
  const v = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const cy = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0,
      hi = 1,
      m = 0.5;
    for (let i = 0; i < 28; i++) {
      m = (lo + hi) / 2;
      if (cx(m) < x) lo = m;
      else hi = m;
    }
    return cy(m);
  };
}
const OUT = bezier(0.16, 1, 0.3, 1); // drawing: a soft, quick-settling ease-out
const SMOOTH_OUT = bezier(0.22, 1, 0.36, 1); // ink and wipes
// a colour custom property on `el`, resolved to the rgb() the canvas accepts
function colourOf(el: HTMLElement, name: string, fallback: string) {
  if (!getComputedStyle(el).getPropertyValue(name).trim()) return fallback;
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  probe.style.display = "none";
  el.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value || fallback;
}

/** Whether the person asked for less motion: then the caller fades the picture in instead. */
export const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag) as SVGElementTagNameMap[K];
  for (const key in attrs) element.setAttribute(key, attrs[key]!);
  if (parent) parent.appendChild(element);
  return element;
}

// ─── marching squares: closed loops of [x, y] through a grid of 0..255 at the 128 level ───
function marching(a: Uint8Array, W: number, H: number): Point[][] {
  const T = 128,
    at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : a[y * W + x]!);
  const pts = new Map<string, Point>(),
    adj = new Map<string, string[]>();
  const pt = (key: string, x0: number, y0: number, v0: number, x1: number, y1: number, v1: number) => {
    if (!pts.has(key)) {
      const t = (T - v0) / (v1 - v0);
      pts.set(key, [x0 + (x1 - x0) * t + 0.5, y0 + (y1 - y0) * t + 0.5]);
    }
    return key;
  };
  const link = (p: string, q: string) => {
    (adj.get(p) ?? adj.set(p, []).get(p)!).push(q);
    (adj.get(q) ?? adj.set(q, []).get(q)!).push(p);
  };
  for (let y = -1; y < H; y++)
    for (let x = -1; x < W; x++) {
      const A = at(x, y),
        B = at(x + 1, y),
        C = at(x + 1, y + 1),
        D = at(x, y + 1);
      const i = (A >= T ? 8 : 0) | (B >= T ? 4 : 0) | (C >= T ? 2 : 0) | (D >= T ? 1 : 0);
      if (i === 0 || i === 15) continue;
      const top = () => pt(`h${x},${y}`, x, y, A, x + 1, y, B),
        bottom = () => pt(`h${x},${y + 1}`, x, y + 1, D, x + 1, y + 1, C);
      const left = () => pt(`v${x},${y}`, x, y, A, x, y + 1, D),
        right = () => pt(`v${x + 1},${y}`, x + 1, y, B, x + 1, y + 1, C);
      switch (i) {
        case 1:
        case 14:
          link(left(), bottom());
          break;
        case 2:
        case 13:
          link(bottom(), right());
          break;
        case 3:
        case 12:
          link(left(), right());
          break;
        case 4:
        case 11:
          link(top(), right());
          break;
        case 6:
        case 9:
          link(top(), bottom());
          break;
        case 7:
        case 8:
          link(left(), top());
          break;
        case 5:
          link(top(), right());
          link(left(), bottom());
          break;
        case 10:
          link(left(), top());
          link(bottom(), right());
          break;
      }
    }
  const loops: Point[][] = [],
    seen = new Set<string>();
  for (const k of adj.keys()) {
    if (seen.has(k)) continue;
    const loop: Point[] = [];
    let prev: string | null = null,
      cur: string | null = k;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      loop.push(pts.get(cur)!);
      const nb: string[] = adj.get(cur) ?? [];
      const nx: string | null = nb.find((n) => n !== prev && !seen.has(n)) ?? null;
      prev = cur;
      cur = nx;
    }
    if (loop.length > 3) loops.push(loop);
  }
  return loops;
}
function rdp(p: Point[], eps: number): Point[] {
  if (p.length < 3) return p;
  const [ax, ay] = p[0]!,
    [bx, by] = p[p.length - 1]!,
    dx = bx - ax,
    dy = by - ay,
    L = Math.hypot(dx, dy) || 1;
  let idx = 0,
    dmax = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = Math.abs((p[i]![0] - ax) * dy - (p[i]![1] - ay) * dx) / L;
    if (d > dmax) {
      dmax = d;
      idx = i;
    }
  }
  return dmax <= eps
    ? [p[0]!, p[p.length - 1]!]
    : [...rdp(p.slice(0, idx + 1), eps).slice(0, -1), ...rdp(p.slice(idx), eps)];
}

// ─── the image's own pixels, read for a contour sketch and a halftone ───
// the image as it is shown (object-fit cover, contain or fill, and object-position) at cols × rows; null if unreadable
function readImage(src: HTMLImageElement, im: Box, cols: number, rows: number) {
  try {
    const c = document.createElement("canvas");
    c.width = cols;
    c.height = rows;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    const sw = src.naturalWidth || src.width,
      sh = src.naturalHeight || src.height;
    if (!sw || !sh) return null;
    let sx = 0,
      sy = 0,
      cw = sw,
      ch = sh,
      dx = 0,
      dy = 0,
      dw = cols,
      dh = rows;
    const [px = 0.5, py = 0.5] = String(im.pos || "50% 50%")
      .split(" ")
      .map((v) => (/%$/.test(v) ? parseFloat(v) / 100 : 0.5));
    if (im.fit === "cover") {
      const k = Math.max(im.w / sw, im.h / sh);
      cw = im.w / k;
      ch = im.h / k;
      sx = (sw - cw) * px;
      sy = (sh - ch) * py;
    } else if (im.fit === "contain") {
      const k = Math.min(im.w / sw, im.h / sh);
      dw = (sw * k * cols) / im.w;
      dh = (sh * k * rows) / im.h;
      dx = (cols - dw) * px;
      dy = (rows - dh) * py;
    }
    g.imageSmoothingQuality = "high";
    g.drawImage(src, sx, sy, cw, ch, dx, dy, dw, dh);
    return g.getImageData(0, 0, cols, rows).data;
  } catch {
    return null; // a cross-origin image without CORS can't be read
  }
}
// luminance 0..1, stretched between the image's own 1st and 99th percentile so a soft picture still has range
function luminance(d: Uint8ClampedArray | null, n: number, cols: number) {
  const lum = new Float32Array(n),
    hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const v = d
      ? d[i * 4 + 3]
        ? (0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!) / 255
        : 1
      : 0.35 + 0.3 * ((i % cols) / cols);
    lum[i] = v;
    hist[Math.min(255, Math.round(v * 255))]!++;
  }
  let lo = 0,
    hi = 255,
    acc = 0;
  for (let k = 0; k < 256; k++) {
    acc += hist[k]!;
    if (acc >= n * 0.01) {
      lo = k;
      break;
    }
  }
  acc = 0;
  for (let k = 255; k >= 0; k--) {
    acc += hist[k]!;
    if (acc >= n * 0.01) {
      hi = k;
      break;
    }
  }
  for (let i = 0; i < n; i++) lum[i] = clamp((lum[i]! * 255 - lo) / Math.max(20, hi - lo));
  return lum;
}
function boxBlur(a: Float32Array, W: number, H: number) {
  const o = new Float32Array(a.length);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0,
        n = 0;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const X = x + i,
            Y = y + j;
          if (X >= 0 && Y >= 0 && X < W && Y < H) {
            s += a[Y * W + X]!;
            n++;
          }
        }
      o[y * W + x] = s / n;
    }
  return o;
}
const chaikin = (p: Point[]): Point[] =>
  p.length < 3
    ? p
    : [
        p[0]!,
        ...p.slice(0, -1).flatMap((a, i): Point[] => {
          const b = p[i + 1]!;
          return [
            [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
            [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75],
          ];
        }),
        p[p.length - 1]!,
      ];
const polyLen = (p: Point[]) =>
  p.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - p[i - 1]![0], q[1] - p[i - 1]![1]) : 0), 0);

// the contour sketch: lines of equal tone through the softened picture, like a topographic drawing of it; edges of
// the image are left to the frame. Longest lines kept within `budget` px.
function sketch(src: HTMLImageElement, im: Box, light: boolean, budget: number) {
  const S = 3,
    cols = Math.max(2, Math.round(im.w / S)),
    rows = Math.max(2, Math.round(im.h / S)),
    sx = im.w / cols,
    sy = im.h / rows;
  const d = readImage(src, im, cols, rows);
  if (!d) return [];
  const lum = boxBlur(luminance(d, cols * rows, cols), cols, rows),
    out: Point[][] = [];
  for (const lv of [0.14, 0.28, 0.42, 0.56, 0.7, 0.84]) {
    const a = new Uint8Array(cols * rows);
    for (let i = 0; i < a.length; i++) a[i] = Math.round(clamp(0.5 + ((light ? lum[i]! : 1 - lum[i]!) - lv) * 4) * 255);
    for (const loop of marching(a, cols, rows)) {
      let run: Point[] = [];
      const flush = () => {
        if (run.length > 3) out.push(run);
        run = [];
      };
      for (const [x, y] of loop) {
        if (x < 1.2 || y < 1.2 || x > cols - 1.2 || y > rows - 1.2) flush();
        else run.push([x * sx, y * sy]);
      }
      flush();
    }
  }
  // long contours are cut into strokes of up to 240px, so the sketch builds up in many places at once
  const pieces: Point[][] = [];
  for (const p of out.map((q) => chaikin(rdp(q, 0.8)))) {
    let cur: Point[] = [p[0]!],
      L = 0;
    for (let i = 1; i < p.length; i++) {
      L += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]);
      cur.push(p[i]!);
      if (L > 240 && p.length - i > 4) {
        pieces.push(cur);
        cur = [p[i]!];
        L = 0;
      }
    }
    pieces.push(cur);
  }
  const lines = pieces
    .map((p) => ({ p, L: polyLen(p), y: Math.min(...p.map((q) => q[1])) }))
    .filter((o) => o.L > 16)
    .sort((a, b) => b.L - a.L);
  const keep: typeof lines = [];
  let total = 0;
  for (const o of lines) {
    if (total + o.L > budget) continue;
    keep.push(o);
    total += o.L;
  }
  return keep
    .sort((a, b) => a.y + hashN(a.L) * 60 - b.y - hashN(b.L) * 60)
    .map((o) => "M" + o.p.map(([x, y]) => `${f2(im.x + x)} ${f2(im.y + y)}`).join("L"));
}

// the halftone: one dot per cell, its area following how dark the picture is there, with the local contrast lifted so
// texture survives the screen; it sweeps in from the top left. Plus the cells' own colours.
function halftone(src: HTMLImageElement, im: Box, cell: number, light: boolean) {
  const cols = Math.max(1, Math.floor(im.w / cell)),
    rows = Math.max(1, Math.floor(im.h / cell)),
    ox = (im.w - cols * cell) / 2,
    oy = (im.h - rows * cell) / 2;
  const d = readImage(src, im, cols, rows),
    lum = luminance(d, cols * rows, cols),
    dots: Dot[] = [];
  const soft = boxBlur(boxBlur(boxBlur(lum, cols, rows), cols, rows), cols, rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c,
        v = clamp(lum[i]! + 2 * (lum[i]! - soft[i]!)),
        dark = Math.pow(light ? v : 1 - v, 1.3); // shadows keep their steps
      if (dark < 0.04) continue;
      const x = (c + 0.5) / cols,
        y = (r + 0.5) / rows;
      dots.push({
        x: ox + (c + 0.5) * cell,
        y: oy + (r + 0.5) * cell,
        r: Math.max(0.3, cell * 0.46 * Math.sqrt(dark)),
        at: 0.8 * (x * 0.4 + y * 0.6) + 0.2 * hashN(r * 12.9 + c * 78.2),
      });
    }
  dots.sort((a, b) => a.at - b.at);
  return { dots, d, cols, rows, ox, oy };
}

const FLOW = 0.016;
function drawStroke(s: Stroke, q: number, t: number) {
  const on = q > 0;
  s.el.style.opacity = on ? "1" : "0";
  if (on) {
    const n = Math.floor((s.L * Math.min(1, q)) / s.gap) + 1;
    if (n !== s.n) {
      s.n = n;
      s.el.style.strokeDasharray = `${`0 ${f2(s.gap)} `.repeat(n - 1)}0 ${f2(s.L + 10)}`;
    }
    s.el.style.strokeDashoffset = f2(-(t * FLOW) % s.gap);
  }
  if (s.head) {
    const live = q > 0 && q < 1;
    s.head.setAttribute("opacity", live ? "1" : "0");
    if (live) {
      const pt = s.el.getPointAtLength(Math.floor((s.L * q) / s.gap) * s.gap);
      s.head.setAttribute("cx", f2(pt.x));
      s.head.setAttribute("cy", f2(pt.y));
    }
  }
}

/** The picture's content box inside its frame: padding (the 12% logo inset) is paper, not picture. */
function contentBox(img: HTMLImageElement, parent: HTMLElement): Box {
  const r = img.getBoundingClientRect(),
    P = parent.getBoundingClientRect(),
    cs = getComputedStyle(img);
  const pl = parseFloat(cs.paddingLeft) || 0,
    pr = parseFloat(cs.paddingRight) || 0,
    pt = parseFloat(cs.paddingTop) || 0,
    pb = parseFloat(cs.paddingBottom) || 0;
  return {
    x: r.left - P.left + pl,
    y: r.top - P.top + pt,
    w: Math.max(1, r.width - pl - pr),
    h: Math.max(1, r.height - pt - pb),
    fit: cs.objectFit,
    pos: cs.objectPosition,
  };
}

/**
 * Draws `img` from its own pixels over it, in `parent`. Resolves when the overlay is gone. Under reduced motion it
 * draws nothing and resolves at once: the caller fades the picture in instead.
 */
export function revealImage(img: HTMLImageElement, options: RevealOptions): RevealRun {
  let resolve: () => void = () => {};
  const finished = new Promise<void>((done) => (resolve = done));
  let raf = 0,
    stopped = false,
    layer: HTMLDivElement | null = null;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    layer?.remove();
    resolve();
  };
  if (prefersReducedMotion()) {
    finish();
    return { finished, cancel: finish };
  }
  const D = Math.max(800, options.duration ?? 3000);
  const { parent, classes } = options;
  try {
    const W = parent.clientWidth,
      H = parent.clientHeight,
      im = contentBox(img, parent);
    if (im.w < 40 || im.h < 40) {
      finish();
      return { finished, cancel: finish };
    }
    layer = document.createElement("div");
    layer.className = classes.layer;
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, { left: "0", top: "0", width: f2(W) + "px", height: f2(H) + "px" });
    const dpr = Math.min(2, devicePixelRatio || 1),
      cv = document.createElement("canvas");
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = f2(W) + "px";
    cv.style.height = f2(H) + "px";
    layer.appendChild(cv);
    const root = svg(
      "svg",
      { class: classes.svg, width: f2(W), height: f2(H), viewBox: `0 0 ${f2(W)} ${f2(H)}` },
      layer,
    );
    parent.appendChild(layer); // in the page first: SVG lengths only measure once rendered
    const ctx = cv.getContext("2d");
    if (!ctx) {
      finish();
      return { finished, cancel: finish };
    }
    ctx.scale(dpr, dpr);
    // the settled dots are the ink at half strength (the original's rgba(13, 13, 13, 0.5))
    const inkColour = colourOf(parent, "--reveal-ink", "rgb(13, 13, 13)"),
      lit = colourOf(parent, "--reveal-strong", "rgb(108, 108, 108)");
    const rgb = (inkColour.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
    const light = (rgb[0] ?? 0) + (rgb[1] ?? 0) + (rgb[2] ?? 0) > 384;

    const sk = svg("g", { class: classes.sketch }, root);
    const paths = sketch(img, im, light, (im.w + im.h) * 13),
      ns = paths.length,
      sd = 0.12,
      [a0, a1] = IMG.sketch;
    const lines: Stroke[] = paths.map((d, k) => {
      const el = svg("path", { d, class: classes.wire }, sk);
      return {
        el,
        L: el.getTotalLength(),
        gap: 3.4,
        t0: a0 + (ns > 1 ? (a1 - a0 - sd) * (k / (ns - 1)) : 0),
        head: k % 3 ? null : svg("circle", { r: f2(1.6), class: classes.head, opacity: "0" }, sk),
      };
    });
    // the two finished screens are drawn once: the grey dots as they settle, and the colour dot matrix
    const screen = (fill?: string) => {
      const c = document.createElement("canvas");
      c.width = Math.ceil(im.w * dpr);
      c.height = Math.ceil(im.h * dpr);
      const g = c.getContext("2d")!;
      g.scale(dpr, dpr);
      if (fill) g.fillStyle = fill;
      return [c, g] as const;
    };
    const cell = Math.max(3, Math.min(5, Math.round(Math.sqrt(im.w * im.h) / 160)));
    const ht = halftone(img, im, cell, light),
      [settled, sg] = screen(inkColour),
      [colour, cg] = screen();
    sg.globalAlpha = 0.5;
    if (ht.d) {
      const buckets = new Map<string, Point[]>(),
        cr = cell * 0.48;
      for (let r = 0; r < ht.rows; r++)
        for (let c = 0; c < ht.cols; c++) {
          const j = (r * ht.cols + c) * 4,
            key = `rgb(${ht.d[j]! & 0xf8},${ht.d[j + 1]! & 0xf8},${ht.d[j + 2]! & 0xf8})`;
          (buckets.get(key) ?? buckets.set(key, []).get(key)!).push([
            ht.ox + (c + 0.5) * cell,
            ht.oy + (r + 0.5) * cell,
          ]);
        }
      for (const [col, pts] of buckets) {
        cg.fillStyle = col;
        cg.beginPath();
        for (const [x, y] of pts) {
          cg.moveTo(x + cr, y);
          cg.arc(x, y, cr, 0, Math.PI * 2);
        }
        cg.fill();
      }
    }
    const dots = ht.dots,
      hasColour = Boolean(ht.d);
    let k = 0,
      lastStage: RevealStage | null = null,
      lastStatus = "";

    const frame = (p: number, t: number) => {
      const clean = 1 - smooth(CLEAN[0], CLEAN[1], p);
      const hq = clamp((p - IMG.screen[0]) / (IMG.screen[1] - IMG.screen[0]));
      const cq = SMOOTH_OUT(clamp((p - IMG.colour[0]) / (IMG.colour[1] - IMG.colour[0]))),
        pq = SMOOTH_OUT(clamp((p - IMG.photo[0]) / (IMG.photo[1] - IMG.photo[0])));
      const gone = 1 - pq;
      // the sketch: tone lines traced in flowing dots, quieter as the dots arrive
      lines.forEach((s) => drawStroke(s, OUT(clamp((p - s.t0) / 0.12)), t));
      sk.setAttribute("opacity", f2((1 - 0.55 * hq) * (1 - 0.6 * cq) * gone * clean));
      // dots that have landed are drawn once into the settled screen; the ones landing now pop in large and dark
      if (hq > 0) {
        const land = (d: Dot) => clamp((hq - d.at * 0.8) / 0.2);
        let any = false;
        sg.beginPath();
        while (k < dots.length && land(dots[k]!) >= 1) {
          const d = dots[k++]!;
          sg.moveTo(d.x + d.r, d.y);
          sg.arc(d.x, d.y, d.r, 0, Math.PI * 2);
          any = true;
        }
        if (any) sg.fill();
      }
      ctx.clearRect(0, 0, W, H);
      if (hq > 0 && pq < 1) {
        ctx.globalAlpha = gone * (hasColour ? 1 - cq : 1);
        ctx.drawImage(settled, im.x, im.y, im.w, im.h);
        ctx.beginPath();
        ctx.fillStyle = lit;
        for (let j = k; j < dots.length; j++) {
          const d = dots[j]!,
            a = clamp((hq - d.at * 0.8) / 0.2);
          if (a <= 0) break;
          const r = d.r * OUT(a) * (1 + 0.25 * (1 - a));
          ctx.moveTo(im.x + d.x + r, im.y + d.y);
          ctx.arc(im.x + d.x, im.y + d.y, r, 0, Math.PI * 2);
        }
        ctx.fill();
        if (hasColour && cq > 0) {
          ctx.globalAlpha = gone * cq;
          ctx.drawImage(colour, im.x, im.y, im.w, im.h);
        }
        ctx.globalAlpha = 1;
      }
      // the stage and its status read this frame's count, so a frame is the same however the timeline got there
      const stage: RevealStage = pq > 0 ? "resolve" : cq > 0 ? "colour" : hq > 0 ? "screen" : "sketch";
      const status =
        stage === "resolve"
          ? "Resolving"
          : stage === "colour"
            ? `Color ${Math.round(cq * 100)}%`
            : stage === "screen"
              ? `Screen ${Math.min(k, dots.length)} dots`
              : `Sketch ${lines.filter((s) => p >= s.t0).length}/${lines.length}`;
      if (stage !== lastStage || status !== lastStatus) {
        lastStage = stage;
        lastStatus = status;
        options.onStage?.(stage, status);
      }
    };
    frame(0, 0);
    const t0 = performance.now();
    const tick = (now: number) => {
      if (stopped) return;
      const t = now - t0,
        p = t / D;
      frame(p, t);
      if (p >= END) return finish();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  } catch {
    finish(); // the drawing could not be built: the picture shows as it is
  }
  return { finished, cancel: finish };
}
