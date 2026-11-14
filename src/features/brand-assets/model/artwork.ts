import type { BrandAssetSnapshot } from "./snapshot";
import { BrandAssetError } from "./snapshot";
import { brandBoardContrastRatio as contrast } from "@/domain/brand-board-design";
import { brandTextDirection, fontSupportsBrandText } from "@/domain/brand-board-fonts";

/** Generated logos are raster images with an off-white background. Artwork
 * uses two copies derived from the saved original, both still raster images:
 * "logo" with the light background made transparent, for light colors, and
 * "logoReversed", a one-color white version for dark colors. "direction" is the
 * chosen direction board, used for crops ("details from your direction"). */
type ImageSource = "logo" | "logoReversed" | "direction";
/** A part of a source image, in fractions of its width and height. */
export type BrandCrop = { x: number; y: number; width: number; height: number };
type TextShape = {
  kind: "text";
  text: string;
  x: number;
  y: number;
  size: number;
  family: string;
  weight: number;
  color: string;
  /** The text box: left edge `x`, width `maxWidth`. */
  maxWidth: number;
  align?: "left" | "center" | "right";
  textLength?: number;
  group?: string;
  /** Letter spacing in em. */
  tracking?: number;
};
type Shape =
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      /** A color, or "none" for an outline only. */
      fill: string;
      radius?: number;
      opacity?: number;
      /** An outline drawn on the rectangle's edge. */
      stroke?: string;
      strokeWidth?: number;
    }
  | { kind: "circle"; x: number; y: number; radius: number; fill: string; opacity?: number }
  | { kind: "line"; x: number; y: number; x2: number; y2: number; color: string; width: number; opacity?: number }
  | {
      kind: "image";
      source: ImageSource;
      x: number;
      y: number;
      width: number;
      height: number;
      /** Only this part of the source is drawn. */
      crop?: BrandCrop;
      /** contain keeps the whole picture (the default); cover fills the box. */
      fit?: "contain" | "cover";
      /** Where a contained picture sits in its box. */
      anchor?: "center" | "start";
    }
  | TextShape;
export type BrandArtwork = { width: number; height: number; title: string; nodes: Shape[] };
export const BRAND_APPLICATIONS = [
  { id: "profile", label: "Profile image", width: 1024, height: 1024, editable: false },
  { id: "post-square", label: "Square post template", width: 1080, height: 1080, editable: true },
  { id: "post-portrait", label: "Portrait post template", width: 1080, height: 1350, editable: true },
  { id: "banner-wide", label: "Wide banner", width: 1500, height: 500, editable: true },
  { id: "banner-cover", label: "Cover banner", width: 1584, height: 396, editable: true },
] as const;
type BrandApplication = (typeof BRAND_APPLICATIONS)[number];

/** Embel's own hairline (the design system's neutral-300), written out because
 * exported files cannot read the app's CSS variables. */
export const EXPORT_RULE = "#C9C8C2";
/** Embel's ink (neutral-900), the last-resort text color on a brand surface. */
const EXPORT_INK = "#191919";

/** Saved words used in the artwork. A missing or unrenderable line is left out,
 * never replaced with placeholder text. */
type BrandCopy = { tagline: string | null; headline: string | null; message: string | null };
const cleanText = (value: string | null | undefined) => value?.replace(/\s+/gu, " ").trim() || null;
export function brandCopy(
  snapshot: BrandAssetSnapshot,
  saved: { slogan?: string | null; positioning?: string | null } = {},
): BrandCopy {
  const slogan = cleanText(saved.slogan),
    positioning = cleanText(saved.positioning);
  const renderable = (text: string | null, style: BrandAssetSnapshot["heading"]) =>
    text && fontSupportsBrandText(style.font, text) ? text : null;
  return {
    tagline: renderable(slogan, snapshot.body),
    headline: renderable(slogan, snapshot.heading),
    message: renderable(positioning, snapshot.body),
  };
}

const isDarkColor = (hex: string) => contrast("#FFFFFF", hex) >= contrast("#000000", hex);
/** Palette colors to present the logo on: the brand's light background and a
 * dark color with strong contrast for the reversed version, when one exists. */
export function logoSurfaces(snapshot: BrandAssetSnapshot): { light: string; dark: string | null } {
  const p = snapshot.palette,
    colors = snapshot.colors.map((color) => color.hex);
  const light = [p.background, ...colors].find((hex) => !isDarkColor(hex)) ?? p.background;
  const dark = [p.primary, p.text, ...colors].find((hex) => contrast("#FFFFFF", hex) >= 4.5) ?? null;
  return { light, dark };
}
/** A palette color that reads on `background` (4.5:1), preferring `preferred`. */
function readableOn(snapshot: BrandAssetSnapshot, background: string, preferred: readonly string[] = []): string {
  const choices = [
    ...preferred,
    snapshot.palette.text,
    snapshot.palette.background,
    ...snapshot.colors.map((color) => color.hex),
  ];
  return (
    choices.find((hex) => contrast(hex, background) >= 4.5) ??
    (contrast("#FFFFFF", background) >= contrast(EXPORT_INK, background) ? "#FFFFFF" : EXPORT_INK)
  );
}

/** The four palette roles with plain words for how to use each, shared by the
 * brand board and the guidelines. */
export function brandRoleColors(snapshot: BrandAssetSnapshot) {
  const p = snapshot.palette,
    accent = contrast(p.accent, p.background);
  return [
    {
      role: "primary",
      name: "Primary",
      hex: p.primary,
      short: "Large areas",
      use: "Large areas, buttons and key actions.",
    },
    {
      role: "accent",
      name: "Accent",
      hex: p.accent,
      short: accent >= 4.5 ? "Highlights and text" : accent >= 3 ? "Highlights and large type" : "Highlights, not text",
      use:
        accent >= 4.5
          ? "Highlights, links and text."
          : accent >= 3
            ? "Highlights, fills and large type."
            : "Highlights and fills. Not for text.",
    },
    { role: "background", name: "Background", hex: p.background, short: "Pages", use: "Page background." },
    { role: "text", name: "Text", hex: p.text, short: "Body text", use: "Body text." },
  ] as const;
}

/** Two template families (canvas page 5). "lines": a deep field with a fine grid
 * and a rising line with data points, for directions built on grids, charts,
 * maps or routes. "frames": the light page inside a double rule, for every
 * other direction. Chosen from the direction's saved graphic treatment and its
 * own words about graphics and imagery. */
export type BrandTemplateFamily = "lines" | "frames";
const LINE_CUES = /\b(grids?|graphs?|charts?|data|dashboards?|plots?|maps?|routes?|flight[- ]?paths?|coordinates?)\b/iu;
export function brandTemplateFamily(snapshot: BrandAssetSnapshot): BrandTemplateFamily {
  if (snapshot.design.graphic === "fine_lines") return "lines";
  return LINE_CUES.test(`${snapshot.graphicNotes} ${snapshot.imageryNotes ?? ""}`) ? "lines" : "frames";
}
/** Field, ink and logo copy for a family, all from the saved palette. */
export function templateTheme(snapshot: BrandAssetSnapshot) {
  const p = snapshot.palette,
    family = brandTemplateFamily(snapshot);
  const field = family === "lines" ? (logoSurfaces(snapshot).dark ?? p.background) : p.background;
  const ink = readableOn(snapshot, field, family === "lines" ? [p.background] : [p.primary]);
  const accent = contrast(p.accent, field) >= 2 ? p.accent : ink;
  const logo: ImageSource = isDarkColor(field) ? "logoReversed" : "logo";
  return { family, field, ink, accent, logo };
}
type Theme = ReturnType<typeof templateTheme>;

const rect = (x: number, y: number, width: number, height: number, fill: string, radius = 0): Shape => ({
  kind: "rect",
  x,
  y,
  width,
  height,
  fill,
  radius,
});
/** An outline whose outer edge sits `inset` inside the artwork, like a CSS border. */
const frame = (w: number, h: number, inset: number, width: number, color: string): Shape => ({
  kind: "rect",
  x: inset + width / 2,
  y: inset + width / 2,
  width: w - inset * 2 - width,
  height: h - inset * 2 - width,
  fill: "none",
  stroke: color,
  strokeWidth: width,
});
function text(
  snapshot: BrandAssetSnapshot,
  value: string,
  x: number,
  y: number,
  size: number,
  maxWidth: number,
  heading = false,
  color = snapshot.palette.text,
  align: "left" | "center" | "right" = "left",
  options: { weight?: number; tracking?: number } = {},
): TextShape {
  const style = heading ? snapshot.heading : snapshot.body;
  const weight =
    options.weight === undefined
      ? style.weight
      : Math.min(style.font.maxWeight, Math.max(style.font.minWeight, options.weight));
  return {
    kind: "text",
    text: value,
    x,
    y,
    size,
    maxWidth,
    family: style.family,
    weight,
    color,
    align,
    ...(options.tracking ? { tracking: options.tracking } : {}),
  };
}

/** A fine grid in the ink color, inside one region. */
function grid(theme: Theme, x: number, y: number, width: number, height: number, cell: number, line: number): Shape[] {
  const nodes: Shape[] = [];
  for (let at = x; at <= x + width + 0.01; at += cell)
    nodes.push({ kind: "line", x: at, y, x2: at, y2: y + height, color: theme.ink, width: line, opacity: 0.12 });
  for (let at = y; at <= y + height + 0.01; at += cell)
    nodes.push({ kind: "line", x, y: at, x2: x + width, y2: at, color: theme.ink, width: line, opacity: 0.12 });
  return nodes;
}
/** A rising line across a region with three data points: two small ink dots and
 * one larger accent dot. The line runs edge to edge; the dots sit inside. */
function risingLine(
  theme: Theme,
  region: { x: number; y: number; width: number; height: number },
  options: { top: number; degrees: number; stroke: number; dot: number; mark: number },
): Shape[] {
  const slope = Math.tan((options.degrees * Math.PI) / 180),
    center = { x: region.x + region.width / 2, y: region.y + region.height * options.top };
  const yAt = (x: number) => center.y - (x - center.x) * slope;
  // The line in the design is 112% of the region wide before it is turned; the
  // dots sit along it, each placed by its left edge.
  const span = region.width * 1.12 * Math.cos((options.degrees * Math.PI) / 180);
  const along = (t: number, radius: number) => {
    const x = center.x + (t - 0.5) * span + radius;
    return { x, y: yAt(x) };
  };
  const [first, second, third] = [along(0.2, options.dot), along(0.54, options.mark), along(0.84, options.dot)];
  return [
    {
      kind: "line",
      x: region.x,
      y: yAt(region.x),
      x2: region.x + region.width,
      y2: yAt(region.x + region.width),
      color: theme.accent,
      width: options.stroke,
    },
    { kind: "circle", x: first!.x, y: first!.y, radius: options.dot, fill: theme.ink },
    { kind: "circle", x: second!.x, y: second!.y, radius: options.mark, fill: theme.accent },
    { kind: "circle", x: third!.x, y: third!.y, radius: options.dot, fill: theme.ink },
  ];
}

// Wrapping estimates a generous average glyph width; drawing still shrinks a
// line that measures wider, and lines of one block share the smallest size.
const AVERAGE_ADVANCE = 0.5;
function greedyLines(value: string, size: number, maxWidth: number): string[] {
  const perLine = Math.max(1, Math.floor(maxWidth / (size * AVERAGE_ADVANCE))),
    lines: string[] = [];
  for (const word of value.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= perLine) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}
/** Balanced wrapping: the fewest lines, then the narrowest width that keeps them. */
function wrapLines(value: string, size: number, maxWidth: number, maxLines: number): string[] | null {
  const lines = greedyLines(value, size, maxWidth);
  if (lines.length > maxLines) return null;
  let best = lines;
  for (let width = maxWidth * 0.95; lines.length > 1 && width > maxWidth * 0.4; width *= 0.95) {
    const narrower = greedyLines(value, size, width);
    if (narrower.length !== lines.length) break;
    best = narrower;
  }
  return best;
}
type Block = {
  text: string | null;
  heading: boolean;
  size: number;
  maxLines: number;
  lineHeight: number;
  /** Narrower than the column, for a measure. */
  maxWidth?: number;
  weight?: number;
};
type Column = {
  x: number;
  maxWidth: number;
  align: "left" | "center";
  top: number;
  bottom: number;
  place: "top" | "center" | "bottom";
  color: string;
  group: string;
  /** Space between blocks. */
  gap: number;
};
/** Stacks saved text inside a column, leaving out blocks that cannot fit. */
function textStack(
  snapshot: BrandAssetSnapshot,
  blocks: readonly Block[],
  column: Column,
): { nodes: TextShape[]; height: number } {
  const laid = blocks.flatMap((block, index) => {
    if (!block.text) return [];
    const width = Math.min(block.maxWidth ?? column.maxWidth, column.maxWidth);
    for (const scale of [1, 0.9, 0.8, 0.7, 0.6]) {
      const lines = wrapLines(block.text, block.size * scale, width, block.maxLines);
      if (lines) return [{ ...block, index, width, size: block.size * scale, lines }];
    }
    return [];
  });
  const leading = (row: { size: number; lineHeight: number }) => row.size * row.lineHeight;
  const natural = laid.reduce((sum, row, index) => sum + row.lines.length * leading(row) + (index ? column.gap : 0), 0);
  const available = column.bottom - column.top,
    fit = natural > available ? available / natural : 1;
  let cursor =
    column.place === "bottom"
      ? column.bottom - natural * fit
      : column.place === "top"
        ? column.top
        : column.top + (available - natural * fit) / 2;
  const nodes = laid.flatMap((row, index) => {
    const size = row.size * fit,
      lineHeight = leading(row) * fit;
    if (index) cursor += column.gap * fit;
    return row.lines.map((line) => {
      cursor += lineHeight;
      const baseline = cursor - ((lineHeight - size) / 2 + size * 0.22);
      const node = text(
        snapshot,
        line,
        column.x,
        baseline,
        size,
        row.width,
        row.heading,
        column.color,
        column.align,
        row.weight === undefined ? {} : { weight: row.weight },
      );
      return { ...node, group: `${column.group}-${row.index}` };
    });
  });
  return { nodes, height: natural * fit };
}

export function createBrandApplication(
  snapshot: BrandAssetSnapshot,
  spec: BrandApplication,
  copy: BrandCopy = brandCopy(snapshot),
): BrandArtwork {
  const { width: w, height: h } = spec,
    theme = templateTheme(snapshot),
    lines = theme.family === "lines",
    u = w / 100,
    hairline = Math.max(1, w / 1080);
  const nodes: Shape[] = [rect(0, 0, w, h, theme.field)];
  const logo = (x: number, y: number, width: number, height: number, anchor: "center" | "start" = "center"): Shape => ({
    kind: "image",
    source: theme.logo,
    x,
    y,
    width,
    height,
    anchor,
  });
  if (spec.id === "profile") {
    // Fits inside a common circular profile crop, including the original rectangular artwork.
    if (lines) nodes.push(...grid(theme, 0, 0, w, h, 5 * u, hairline));
    nodes.push(logo(w * 0.19, h * 0.19, w * 0.62, h * 0.62));
  } else if (spec.id === "post-square" || spec.id === "post-portrait") {
    const region = { x: w * 0.38, y: 0, width: w * 0.62, height: h * 0.52 };
    if (lines)
      nodes.push(
        ...grid(theme, region.x, region.y, region.width, region.height, 5 * u, hairline),
        ...risingLine(theme, region, { top: 0.56, degrees: 16, stroke: 0.4 * u, dot: u, mark: 1.4 * u }),
      );
    else nodes.push(frame(w, h, 3.2 * u, 0.35 * u, theme.ink), frame(w, h, 4.6 * u, 0.12 * u, theme.ink));
    nodes.push(logo(8 * u, 8 * u, 24 * u, 24 * u, "start"));
    nodes.push(
      ...textStack(
        snapshot,
        [
          { text: copy.headline, heading: true, size: 10 * u, maxLines: 3, lineHeight: 1.04 },
          { text: copy.message, heading: false, size: 3.5 * u, maxLines: 4, lineHeight: 1.4, maxWidth: 62 * u },
        ],
        {
          x: 8 * u,
          maxWidth: 84 * u,
          align: "left",
          top: lines ? region.height + 3 * u : 36 * u,
          bottom: h - 9 * u,
          place: "bottom",
          color: theme.ink,
          group: spec.id,
          gap: 2.6 * u,
        },
      ).nodes,
    );
  } else {
    const cover = spec.id === "banner-cover";
    if (lines) {
      const region = { x: 0, y: 0, width: w * 0.44, height: h };
      nodes.push(
        ...grid(theme, region.x, region.y, region.width, region.height, 2.5 * u, hairline),
        ...risingLine(theme, region, { top: 0.54, degrees: 12, stroke: 0.2 * u, dot: 0.5 * u, mark: 0.7 * u }),
      );
    } else nodes.push(frame(w, h, 1.4 * u, 0.18 * u, theme.ink), frame(w, h, 2 * u, 0.06 * u, theme.ink));
    const box = (cover ? 13 : 17) * u,
      left = w * 0.48,
      textX = left + box + 4 * u;
    nodes.push(logo(left, (h - box) / 2, box, box));
    nodes.push(
      ...textStack(
        snapshot,
        [{ text: copy.headline, heading: true, size: (cover ? 3.4 : 4.4) * u, maxLines: 3, lineHeight: 1.1 }],
        {
          x: textX,
          maxWidth: w * 0.94 - textX,
          align: "left",
          top: h * 0.14,
          bottom: h * 0.86,
          place: "center",
          color: theme.ink,
          group: spec.id,
          gap: 0,
        },
      ).nodes,
    );
  }
  return { width: w, height: h, title: `${snapshot.name} — ${spec.label}`, nodes };
}

/** Three 4:3 windows across the middle of a picture, used when no crops were measured. */
export const DEFAULT_DIRECTION_CROPS: readonly BrandCrop[] = [0, 1, 2].map((index) => ({
  x: index / 3,
  y: 0.375,
  width: 1 / 3,
  height: 0.25,
}));
/** Picks three details of the chosen direction board to show "in practice": the
 * most colourful 4:3 windows that hold no pale page (photographs and graphics
 * rather than panels of text or swatch rows), not overlapping, in reading order.
 * `pixels` is RGBA of a small copy of the board. */
export function directionCrops(pixels: Uint8ClampedArray, width: number, height: number, count = 3): BrandCrop[] {
  const cw = Math.max(1, Math.round(width / 5)),
    ch = Math.max(1, Math.round((cw * 3) / 4));
  if (pixels.length < width * height * 4 || ch > height) return [...DEFAULT_DIRECTION_CROPS];
  const step = Math.max(1, Math.round(cw / 8));
  const windows: { x: number; y: number; score: number }[] = [];
  for (let y = 0; y + ch <= height; y += step)
    for (let x = 0; x + cw <= width; x += step) {
      let n = 0,
        rg = 0,
        yb = 0,
        rg2 = 0,
        yb2 = 0,
        l = 0,
        l2 = 0,
        pale = 0;
      for (let row = y; row < y + ch; row++)
        for (let col = x; col < x + cw; col++) {
          const i = (row * width + col) * 4,
            r = pixels[i]!,
            g = pixels[i + 1]!,
            b = pixels[i + 2]!;
          const a = r - g,
            c = (r + g) / 2 - b,
            lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          n++;
          rg += a;
          yb += c;
          rg2 += a * a;
          yb2 += c * c;
          l += lum;
          l2 += lum * lum;
          // Page white and light greys: the paper behind text and swatches.
          if (lum > 215 && Math.max(r, g, b) - Math.min(r, g, b) < 24) pale++;
        }
      const mrg = rg / n,
        myb = yb / n,
        srg = Math.max(0, rg2 / n - mrg * mrg),
        syb = Math.max(0, yb2 / n - myb * myb),
        sl = Math.sqrt(Math.max(0, l2 / n - (l / n) ** 2));
      const colorfulness = Math.sqrt(srg + syb) + 0.3 * Math.sqrt(mrg * mrg + myb * myb);
      windows.push({ x, y, score: (colorfulness + 0.25 * sl) * (1 - pale / n) ** 3 });
    }
  windows.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  const chosen: { x: number; y: number }[] = [];
  for (const candidate of windows) {
    if (chosen.length === count) break;
    if (chosen.every((other) => Math.abs(other.x - candidate.x) >= cw || Math.abs(other.y - candidate.y) >= ch))
      chosen.push(candidate);
  }
  const crops = chosen
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((window) => ({ x: window.x / width, y: window.y / height, width: cw / width, height: ch / height }));
  return crops.length === count ? crops : [...DEFAULT_DIRECTION_CROPS];
}

/** The brand board (1600 × 2200): the logo on light and dark, the colour roles,
 * the type pair set in saved words and three details of the chosen direction. */
export function createFinalBrandBoard(
  snapshot: BrandAssetSnapshot,
  copy: BrandCopy = brandCopy(snapshot),
  extras: { direction?: string | null; crops?: readonly BrandCrop[] } = {},
): BrandArtwork {
  const p = snapshot.palette,
    w = 1600,
    h = 2200,
    u = w / 100,
    pad = 6 * u,
    inner = w - pad * 2,
    gap = 2 * u,
    section = 4.4 * u,
    small = 1.5 * u,
    title = 2.6 * u;
  const paper = p.background,
    ink = readableOn(snapshot, paper),
    surfaces = logoSurfaces(snapshot);
  const nodes: Shape[] = [rect(0, 0, w, h, paper)];
  const heading = (value: string, y: number) => text(snapshot, value, pad, y + title * 0.8, title, inner, true, ink);
  let y = pad;
  nodes.push(
    text(snapshot, "BRAND BOARD", pad, y + small * 0.8, small, inner / 2, false, ink, "left", { tracking: 0.12 }),
  );
  const direction = cleanText(extras.direction);
  if (direction)
    nodes.push(
      text(snapshot, direction.toUpperCase(), pad + inner / 2, y + small * 0.8, small, inner / 2, false, ink, "right", {
        tracking: 0.12,
      }),
    );
  y += small * 1.2 + section;

  // The logo on the page color, and the reversed copy on a dark palette color.
  const tileW = (inner - gap) / 2,
    tileH = (tileW * 3) / 4;
  const second = isDarkColor(paper)
    ? surfaces.light !== paper
      ? surfaces.light
      : null
    : surfaces.dark && surfaces.dark !== paper
      ? surfaces.dark
      : null;
  const tiles: [string, string][] = [[paper, "Logo"]];
  if (second) tiles.push([second, isDarkColor(second) ? "Reversed, for dark backgrounds" : "On light backgrounds"]);
  tiles.forEach(([surface, caption], index) => {
    const x = pad + index * (tileW + gap);
    nodes.push(
      surface === paper
        ? { kind: "rect", x, y, width: tileW, height: tileH, fill: surface, stroke: EXPORT_RULE, strokeWidth: 2 }
        : rect(x, y, tileW, tileH, surface),
      {
        kind: "image",
        source: isDarkColor(surface) ? "logoReversed" : "logo",
        x: x + tileW * 0.15,
        y: y + tileH * 0.07,
        width: tileW * 0.7,
        height: tileH * 0.86,
      },
      text(snapshot, caption, x, y + tileH + u + small * 0.8, small, tileW, false, ink),
    );
  });
  y += tileH + u + small * 1.2 + section;

  // Colour palette: the four roles with their values and use.
  nodes.push(heading("Color palette", y));
  y += title * 1.2 + 1.6 * u;
  const colW = (inner - gap * 3) / 4,
    swatchH = (colW * 2) / 3,
    name = 1.6 * u,
    meta = 1.4 * u;
  brandRoleColors(snapshot).forEach((color, index) => {
    const x = pad + index * (colW + gap);
    let line = y + swatchH + 0.8 * u;
    nodes.push({
      kind: "rect",
      x,
      y,
      width: colW,
      height: swatchH,
      fill: color.hex,
      stroke: EXPORT_RULE,
      strokeWidth: 2,
    });
    nodes.push(text(snapshot, color.name, x, line + name * 0.85, name, colW, false, ink, "left", { weight: 600 }));
    line += name * 1.2 + 0.8 * u;
    nodes.push(text(snapshot, color.hex, x, line + meta * 0.85, meta, colW, false, ink));
    line += meta * 1.2 + 0.8 * u;
    nodes.push(text(snapshot, color.short, x, line + meta * 0.85, meta, colW, false, ink));
  });
  y += swatchH + 0.8 * u + name * 1.2 + (0.8 * u + meta * 1.2) * 2 + section;

  // Typography: the heading face set in the saved slogan, the body face in the positioning.
  nodes.push(heading("Typography", y));
  y += title * 1.2 + 1.6 * u;
  const stack = (place: Column["place"], top: number, bottom: number) =>
    [
      textStack(
        snapshot,
        [
          {
            text: `Headings · ${snapshot.heading.family} ${snapshot.heading.weight}`,
            heading: false,
            size: meta,
            maxLines: 1,
            lineHeight: 1.3,
          },
          { text: copy.headline ?? snapshot.name, heading: true, size: 5.2 * u, maxLines: 2, lineHeight: 1.05 },
        ],
        {
          x: pad,
          maxWidth: tileW,
          align: "left",
          top,
          bottom,
          place,
          color: ink,
          group: "board-heading",
          gap: 0.8 * u,
        },
      ),
      textStack(
        snapshot,
        [
          {
            text: `Body · ${snapshot.body.family} ${snapshot.body.weight}`,
            heading: false,
            size: meta,
            maxLines: 1,
            lineHeight: 1.3,
          },
          {
            text: copy.message ?? copy.tagline ?? snapshot.name,
            heading: false,
            size: 2.1 * u,
            maxLines: 3,
            lineHeight: 1.45,
          },
        ],
        {
          x: pad + tileW + gap,
          maxWidth: tileW,
          align: "left",
          top,
          bottom,
          place,
          color: ink,
          group: "board-body",
          gap: 0.8 * u,
        },
      ),
    ] as const;
  const measured = stack("top", y, y + 600),
    typeBottom = y + Math.max(measured[0].height, measured[1].height);
  for (const column of stack("bottom", y, typeBottom)) nodes.push(...column.nodes);
  y = typeBottom + section;

  // In practice: three details of the chosen direction board.
  nodes.push(heading("In practice", y));
  y += title * 1.2 + 1.6 * u;
  const cropW = (inner - gap * 2) / 3,
    cropH = (cropW * 3) / 4;
  const crops = extras.crops?.length === 3 ? extras.crops : DEFAULT_DIRECTION_CROPS;
  crops.forEach((crop, index) =>
    nodes.push({
      kind: "image",
      source: "direction",
      x: pad + index * (cropW + gap),
      y,
      width: cropW,
      height: cropH,
      crop,
      fit: "cover",
    }),
  );
  y += cropH + 0.8 * u;
  nodes.push(
    text(
      snapshot,
      direction ? `Details from your direction board, ${direction}.` : "Details from your direction board.",
      pad,
      y + meta * 0.85,
      meta,
      inner,
      false,
      ink,
    ),
  );
  return { width: w, height: h, title: `${snapshot.name} — Brand board`, nodes };
}

export type BrandImages = Record<
  ImageSource,
  { image: CanvasImageSource; width: number; height: number; dataUrl: string }
>;
export type BrandFontNames = ReadonlyMap<string, string>;
const luminance = (pixels: Uint8ClampedArray, index: number) =>
  0.2126 * pixels[index]! + 0.7152 * pixels[index + 1]! + 0.0722 * pixels[index + 2]!;
const ramp = (value: number, from: number, to: number) => Math.min(1, Math.max(0, (value - from) / (to - from)));
function derivedLogo(
  canvas: HTMLCanvasElement,
  logo: Pick<BrandImages["logo"], "image" | "width" | "height">,
  pixel: (data: Uint8ClampedArray, index: number) => void,
) {
  canvas.width = logo.width;
  canvas.height = logo.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new BrandAssetError("canvas");
  ctx.clearRect(0, 0, logo.width, logo.height);
  ctx.drawImage(logo.image, 0, 0, logo.width, logo.height);
  const pixels = ctx.getImageData(0, 0, logo.width, logo.height);
  for (let index = 0; index < pixels.data.length; index += 4) pixel(pixels.data, index);
  ctx.putImageData(pixels, 0, 0);
}
// Pixels within CLEAR of white are background; from SOLID on, colors stay exact.
const CLEAR = 15,
  SOLID = 200;
/** The logo with its light background made transparent, for light surfaces.
 * Each pixel keeps the color it shows over white; near-white becomes clear. */
export function drawTransparentLogo(
  canvas: HTMLCanvasElement,
  logo: Pick<BrandImages["logo"], "image" | "width" | "height">,
): void {
  derivedLogo(canvas, logo, (data, index) => {
    const distance = 255 - Math.min(data[index]!, data[index + 1]!, data[index + 2]!),
      alpha = ramp(distance, CLEAR, SOLID);
    for (let channel = index; channel < index + 3; channel++)
      data[channel] = alpha ? 255 - (255 - data[channel]!) / alpha : 255;
    data[index + 3] = alpha * data[index + 3]!;
  });
}
// Near-black ink becomes solid white and an off-white background disappears.
const INK = 64,
  PAPER = 240;
/** A one-color reversed copy for dark surfaces: white ink whose opacity follows
 * the original's darkness. */
export function drawReversedLogo(
  canvas: HTMLCanvasElement,
  logo: Pick<BrandImages["logo"], "image" | "width" | "height">,
): void {
  derivedLogo(canvas, logo, (data, index) => {
    data[index + 3] = (1 - ramp(luminance(data, index), INK, PAPER)) * data[index + 3]!;
    data[index] = data[index + 1] = data[index + 2] = 255;
  });
}
function setTracking(ctx: CanvasRenderingContext2D, node: TextShape) {
  if (node.tracking && "letterSpacing" in ctx) ctx.letterSpacing = `${node.tracking * node.size}px`;
}
function fitText(ctx: CanvasRenderingContext2D, input: TextShape, family: string): TextShape {
  let node = input;
  const setFont = () => {
    ctx.font = `${node.weight} ${node.size}px "${family}"`;
    setTracking(ctx, node);
  };
  ctx.direction = brandTextDirection(node.text);
  setFont();
  while (ctx.measureText(node.text).width > node.maxWidth && node.size > 10) {
    node = { ...node, size: node.size - 1 };
    setFont();
  }
  // Canvas still fits unusually long names at the minimum size. Record that
  // final width so the editable SVG preserves the same complete lettering.
  if (ctx.measureText(node.text).width > node.maxWidth) node = { ...node, textLength: node.maxWidth };
  return node;
}
/** Where a picture is drawn: the source rectangle and the box it fills. */
function placement(node: Extract<Shape, { kind: "image" }>, source: { width: number; height: number }) {
  const crop = node.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  let sx = crop.x * source.width,
    sy = crop.y * source.height,
    sw = crop.width * source.width,
    sh = crop.height * source.height;
  if (node.fit === "cover") {
    const target = node.width / node.height;
    if (sw / sh > target) {
      sx += (sw - sh * target) / 2;
      sw = sh * target;
    } else {
      sy += (sh - sw / target) / 2;
      sh = sw / target;
    }
    return { sx, sy, sw, sh, dx: node.x, dy: node.y, dw: node.width, dh: node.height };
  }
  const scale = Math.min(node.width / sw, node.height / sh),
    dw = sw * scale,
    dh = sh * scale,
    start = node.anchor === "start";
  return {
    sx,
    sy,
    sw,
    sh,
    dx: start ? node.x : node.x + (node.width - dw) / 2,
    dy: start ? node.y : node.y + (node.height - dh) / 2,
    dw,
    dh,
  };
}
export function drawBrandArtwork(
  canvas: HTMLCanvasElement,
  artwork: BrandArtwork,
  images: BrandImages,
  fonts: BrandFontNames,
): BrandArtwork {
  canvas.width = artwork.width;
  canvas.height = artwork.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new BrandAssetError("canvas");
  const family = (node: TextShape) => {
    const name = fonts.get(node.family);
    if (!name) throw new BrandAssetError("font");
    return name;
  };
  // Lines of one wrapped block share the size of their widest line.
  const groups = new Map<string, number>();
  for (const node of artwork.nodes)
    if (node.kind === "text" && node.group) {
      ctx.save();
      const size = fitText(ctx, node, family(node)).size;
      ctx.restore();
      groups.set(node.group, Math.min(groups.get(node.group) ?? size, size));
    }
  const fitted: BrandArtwork = { ...artwork, nodes: [] };
  for (const input of artwork.nodes) {
    let node = { ...input };
    ctx.save();
    if (node.kind === "rect") {
      ctx.globalAlpha = node.opacity ?? 1;
      ctx.beginPath();
      ctx.roundRect(node.x, node.y, node.width, node.height, node.radius ?? 0);
      if (node.fill !== "none") {
        ctx.fillStyle = node.fill;
        ctx.fill();
      }
      if (node.stroke && node.strokeWidth) {
        ctx.strokeStyle = node.stroke;
        ctx.lineWidth = node.strokeWidth;
        ctx.stroke();
      }
    } else if (node.kind === "circle") {
      ctx.globalAlpha = node.opacity ?? 1;
      ctx.fillStyle = node.fill;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fill();
    } else if (node.kind === "line") {
      ctx.globalAlpha = node.opacity ?? 1;
      ctx.strokeStyle = node.color;
      ctx.lineWidth = node.width;
      ctx.beginPath();
      ctx.moveTo(node.x, node.y);
      ctx.lineTo(node.x2, node.y2);
      ctx.stroke();
    } else if (node.kind === "image") {
      const source = images[node.source],
        at = placement(node, source);
      ctx.drawImage(source.image, at.sx, at.sy, at.sw, at.sh, at.dx, at.dy, at.dw, at.dh);
    } else {
      node = fitText(
        ctx,
        node.group ? { ...node, size: Math.min(node.size, groups.get(node.group) ?? node.size) } : node,
        family(node),
      );
      const rtl = brandTextDirection(node.text) === "rtl";
      const x = node.align === "center" ? node.x : node.align === "right" || rtl ? node.x + node.maxWidth : node.x;
      ctx.fillStyle = node.color;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = node.align === "center" ? "center" : node.align === "right" ? "right" : "start";
      ctx.fillText(node.text, x, node.y, node.maxWidth);
    }
    ctx.restore();
    fitted.nodes.push(node);
  }
  return fitted;
}
const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!,
  );
export function editableBrandSvg(artwork: BrandArtwork, images: BrandImages): Uint8Array {
  const nodes = artwork.nodes.map((node) => {
    if (node.kind === "rect")
      return `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.radius ?? 0}" fill="${node.fill}" opacity="${node.opacity ?? 1}"${node.stroke && node.strokeWidth ? ` stroke="${node.stroke}" stroke-width="${node.strokeWidth}"` : ""}/>`;
    if (node.kind === "circle")
      return `<circle cx="${node.x}" cy="${node.y}" r="${node.radius}" fill="${node.fill}" opacity="${node.opacity ?? 1}"/>`;
    if (node.kind === "line")
      return `<line x1="${node.x}" y1="${node.y}" x2="${node.x2}" y2="${node.y2}" stroke="${node.color}" stroke-width="${node.width}" opacity="${node.opacity ?? 1}"/>`;
    if (node.kind === "image") {
      const source = images[node.source],
        url = source.dataUrl;
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) throw new BrandAssetError("source");
      const at = placement(node, source);
      // A nested viewport shows exactly the drawn part of the source.
      return `<svg x="${at.dx}" y="${at.dy}" width="${at.dw}" height="${at.dh}" viewBox="${at.sx} ${at.sy} ${at.sw} ${at.sh}" preserveAspectRatio="none"><image width="${source.width}" height="${source.height}" href="${url}"/></svg>`;
    }
    const direction = brandTextDirection(node.text),
      rtl = direction === "rtl",
      x = node.align === "center" ? node.x : node.align === "right" || rtl ? node.x + node.maxWidth : node.x;
    const anchor = node.align === "center" ? "middle" : node.align === "right" ? (rtl ? "start" : "end") : "start";
    return `<text x="${x}" y="${node.y}" font-family="${xml(node.family)}" font-weight="${node.weight}" font-size="${node.size}" fill="${node.color}" direction="${direction}" unicode-bidi="isolate" text-anchor="${anchor}"${node.tracking ? ` letter-spacing="${node.tracking * node.size}"` : ""}${node.textLength === undefined ? "" : ` textLength="${node.textLength}" lengthAdjust="spacingAndGlyphs"`}>${xml(node.text)}</text>`;
  });
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${artwork.width}" height="${artwork.height}" viewBox="0 0 ${artwork.width} ${artwork.height}"><title>${xml(artwork.title)}</title><desc>Editable text and shapes. The logo remains an embedded raster image made from your original logo: with its light background removed on light colors, and as a one-color reversed version on dark colors. Install the linked fonts before editing.</desc>${nodes.join("")}</svg>`,
  );
}
