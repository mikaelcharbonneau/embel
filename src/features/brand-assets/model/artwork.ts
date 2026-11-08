import type { BrandAssetSnapshot } from "./snapshot";
import { BrandAssetError } from "./snapshot";
import { brandBoardContrastRatio as contrast } from "@/domain/brand-board-design";
import { brandTextDirection, fontSupportsBrandText } from "@/domain/brand-board-fonts";

/** Generated logos are raster images with an off-white background. Artwork
 * uses two copies derived from the saved original, both still raster images:
 * "logo" with the light background made transparent, for light colors, and
 * "logoReversed", a one-color white version for dark colors. */
type ImageSource = "logo" | "logoReversed" | "direction";
type TextShape = { kind: "text"; text: string; x: number; y: number; size: number; family: string; weight: number; color: string; maxWidth: number; align?: "left" | "center"; textLength?: number; group?: string };
type Shape = { kind: "rect"; x: number; y: number; width: number; height: number; fill: string; radius?: number; opacity?: number }
  | { kind: "circle"; x: number; y: number; radius: number; fill: string; opacity?: number }
  | { kind: "line"; x: number; y: number; x2: number; y2: number; color: string; width: number }
  | { kind: "image"; source: ImageSource; x: number; y: number; width: number; height: number }
  | TextShape;
export type BrandArtwork = { width: number; height: number; title: string; nodes: Shape[] };
export const BRAND_APPLICATIONS = [
  { id: "profile", label: "Profile image", width: 1024, height: 1024, editable: false },
  { id: "post-square", label: "Square post template", width: 1080, height: 1080, editable: true },
  { id: "post-portrait", label: "Portrait post template", width: 1080, height: 1350, editable: true },
  { id: "banner-wide", label: "Wide banner", width: 1500, height: 500, editable: true },
  { id: "banner-cover", label: "Cover banner", width: 1584, height: 396, editable: true },
] as const;
export type BrandApplication = typeof BRAND_APPLICATIONS[number];

/** Saved words used in the artwork. A missing or unrenderable line is left out,
 * never replaced with placeholder text. */
export type BrandCopy = { tagline: string | null; headline: string | null; message: string | null };
const cleanText = (value: string | null | undefined) => value?.replace(/\s+/gu, " ").trim() || null;
export function brandCopy(snapshot: BrandAssetSnapshot, saved: { slogan?: string | null; positioning?: string | null } = {}): BrandCopy {
  const slogan = cleanText(saved.slogan), positioning = cleanText(saved.positioning);
  const renderable = (text: string | null, style: BrandAssetSnapshot["heading"]) => text && fontSupportsBrandText(style.font, text) ? text : null;
  return { tagline: renderable(slogan, snapshot.body), headline: renderable(slogan, snapshot.heading), message: renderable(positioning, snapshot.body) };
}

export const isDarkColor = (hex: string) => contrast("#FFFFFF", hex) >= contrast("#000000", hex);
/** Palette colors to present the logo on: the brand's light background and a
 * dark color with strong contrast for the reversed version, when one exists. */
export function logoSurfaces(snapshot: BrandAssetSnapshot): { light: string; dark: string | null } {
  const p = snapshot.palette, colors = snapshot.colors.map(color => color.hex);
  const light = [p.background, ...colors].find(hex => !isDarkColor(hex)) ?? p.background;
  const dark = [p.primary, p.text, ...colors].find(hex => contrast("#FFFFFF", hex) >= 4.5) ?? null;
  return { light, dark };
}

const rect = (x: number, y: number, width: number, height: number, fill: string, radius = 0): Shape => ({ kind: "rect", x, y, width, height, fill, radius });
function text(snapshot: BrandAssetSnapshot, value: string, x: number, y: number, size: number, maxWidth: number, heading = false, color = snapshot.palette.text, align: "left" | "center" = "left"): TextShape {
  const style = heading ? snapshot.heading : snapshot.body;
  return { kind: "text", text: value, x, y, size, maxWidth, family: style.family, weight: style.weight, color, align };
}
function foreground(snapshot: BrandAssetSnapshot, background: string): string {
  const choices = [snapshot.palette.text, ...snapshot.colors.map(color => color.hex)];
  const preferred = choices.find(color => contrast(color, background) >= 4.5);
  return preferred ?? (contrast("#FFFFFF", background) >= contrast("#191919", background) ? "#FFFFFF" : "#191919");
}
function graphics(snapshot: BrandAssetSnapshot, width: number, height: number): Shape[] {
  const { accent, primary } = snapshot.palette;
  if (snapshot.design.graphic === "rounded_shapes") return [
    { kind: "circle", x: width * .8, y: height * .2, radius: Math.min(width, height) * .2, fill: accent, opacity: .65 },
    { kind: "circle", x: width * .88, y: height * .22, radius: Math.min(width, height) * .11, fill: primary, opacity: .35 },
  ];
  if (snapshot.design.graphic === "fine_lines") return Array.from({ length: 7 }, (_, i) => ({ kind: "line", x: width * .72 + i * width * .035, y: 0, x2: width * .72 + i * width * .035, y2: height, color: accent, width: 1.5 }));
  if (snapshot.design.graphic === "bold_blocks") return [rect(width * .78, 0, width * .22, height * .4, primary), rect(width * .88, height * .4, width * .12, height * .6, accent)];
  return [];
}
/** Original raster geometry is contained, never cropped or presented as vector.
 * No box is drawn behind it: the surface decides which logo copy sits on it. */
function logoFrame(surface: string, x: number, y: number, width: number, height: number, inset = .08): Shape[] {
  const pad = Math.min(width, height) * inset;
  return [{ kind: "image", source: isDarkColor(surface) ? "logoReversed" : "logo", x: x + pad, y: y + pad, width: width - pad * 2, height: height - pad * 2 }];
}

// Wrapping estimates a generous average glyph width; drawing still shrinks a
// line that measures wider, and lines of one block share the smallest size.
const AVERAGE_ADVANCE = .56;
function wrapLines(value: string, size: number, maxWidth: number, maxLines: number): string[] | null {
  const perLine = Math.max(1, Math.floor(maxWidth / (size * AVERAGE_ADVANCE))), lines: string[] = [];
  for (const word of value.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= perLine) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.length <= maxLines ? lines : null;
}
type Block = { text: string | null; heading: boolean; size: number; maxLines: number };
type Column = { x: number; maxWidth: number; align: "left" | "center"; top: number; bottom: number; place: "center" | "bottom"; color: string; group: string };
/** Stacks saved text inside a column, leaving out blocks that cannot fit. */
function textStack(snapshot: BrandAssetSnapshot, blocks: readonly Block[], column: Column): TextShape[] {
  const laid = blocks.flatMap((block, index) => {
    if (!block.text) return [];
    for (const scale of [1, .9, .8, .7, .6]) {
      const lines = wrapLines(block.text, block.size * scale, column.maxWidth, block.maxLines);
      if (lines) return [{ ...block, index, size: block.size * scale, lines }];
    }
    return [];
  });
  const leading = (row: { heading: boolean; size: number }) => row.size * (row.heading ? 1.12 : 1.4);
  const natural = laid.reduce((sum, row, index) => sum + row.lines.length * leading(row) + (index ? row.size * .9 : 0), 0);
  const available = column.bottom - column.top, fit = natural > available ? available / natural : 1;
  let cursor = column.place === "bottom" ? column.bottom - natural * fit : column.top + (available - natural * fit) / 2;
  return laid.flatMap((row, index) => {
    const size = row.size * fit, lineHeight = leading(row) * fit;
    if (index) cursor += size * .9;
    return row.lines.map(line => {
      cursor += lineHeight;
      const node = text(snapshot, line, column.x, cursor - lineHeight * .26, size, column.maxWidth, row.heading, column.color, column.align);
      return { ...node, group: `${column.group}-${row.index}` };
    });
  });
}

export function createBrandApplication(snapshot: BrandAssetSnapshot, spec: BrandApplication, copy: BrandCopy = brandCopy(snapshot)): BrandArtwork {
  const { width: w, height: h } = spec, p = snapshot.palette, fg = foreground(snapshot, p.background), pad = w * .065;
  const nodes: Shape[] = [rect(0, 0, w, h, p.background), ...graphics(snapshot, w, h)];
  // Bold blocks fill the right edge (fully above 40% height): text stays clear of them.
  const blocks = snapshot.design.graphic === "bold_blocks", clear = (x: number, maxWidth: number, upper = false) => blocks ? Math.min(maxWidth, w * (upper ? .75 : .85) - x) : maxWidth;
  const posts = (column: Omit<Column, "color" | "group">, headingSize: number, messageSize: number, headingLines: number, messageLines: number) => textStack(snapshot, [
    { text: copy.headline, heading: true, size: headingSize, maxLines: headingLines },
    { text: copy.message, heading: false, size: messageSize, maxLines: messageLines },
  ], { ...column, color: fg, group: spec.id });
  if (spec.id === "profile") {
    // Fits inside a common circular profile crop, including the original rectangular artwork.
    nodes.push(...logoFrame(p.background, w * .18, h * .18, w * .64, h * .64));
  } else if (w / h > 2) {
    const centered = snapshot.design.layout === "centered", split = snapshot.design.layout === "split";
    if (split) nodes.push(rect(0, 0, w * .4, h, p.primary));
    const nameY = copy.tagline ? h * .43 : h * .57;
    if (centered) {
      nodes.push(...logoFrame(p.background, w * .065, h * .16, w * .23, h * .68));
      nodes.push(text(snapshot, snapshot.name, w * .59, nameY, h * .17, blocks ? w * .32 : w * .55, true, fg, "center"));
      if (copy.tagline) nodes.push(text(snapshot, copy.tagline, w * .59, h * .66, h * .075, blocks ? w * .5 : w * .55, false, fg, "center"));
    } else {
      nodes.push(...logoFrame(split ? p.primary : p.background, pad, h * .17, w * .25, h * .66));
      nodes.push(text(snapshot, snapshot.name, w * .43, nameY, h * .18, clear(w * .43, w * .49, Boolean(copy.tagline)), true, fg));
      if (copy.tagline) nodes.push(text(snapshot, copy.tagline, w * .43, h * .68, h * .075, clear(w * .43, w * .49), false, fg));
    }
  } else if (snapshot.design.layout === "centered") {
    nodes.push(...logoFrame(p.background, w * .27, h * .14, w * .46, h * .25));
    nodes.push(...posts({ x: w / 2, maxWidth: blocks ? w * .7 : w * .8, align: "center", top: h * .44, bottom: h * .87, place: "center" }, w * .087, w * .03, 3, 4));
    nodes.push(text(snapshot, snapshot.name, w / 2, h * .93, w * .024, w * .8, false, fg, "center"));
  } else if (snapshot.design.layout === "split") {
    nodes.push(rect(0, 0, w * .46, h, p.primary));
    nodes.push(...logoFrame(p.primary, w * .055, h * .34, w * .35, h * .3));
    nodes.push(...posts({ x: w * .52, maxWidth: clear(w * .52, w * .41), align: "left", top: blocks ? h * .44 : h * .12, bottom: h * .85, place: "center" }, w * .075, w * .026, 4, 6));
    nodes.push(text(snapshot, snapshot.name, w * .52, h * .92, w * .023, w * .41, false, fg));
  } else {
    nodes.push(...logoFrame(p.background, pad, h * .08, w * .32, h * .19));
    nodes.push(...posts({ x: pad, maxWidth: clear(pad, w * .82), align: "left", top: h * .42, bottom: h * .87, place: "bottom" }, w * .09, w * .03, 3, 4));
    nodes.push(text(snapshot, snapshot.name, pad, h * .94, w * .024, w * .82, false, fg));
  }
  return { width: w, height: h, title: `${snapshot.name} — ${spec.label}`, nodes };
}
function placed(art: BrandArtwork, x: number, y: number, width: number): Shape[] {
  const s = width / art.width;
  return [rect(x - 1, y - 1, width + 2, art.height * s + 2, "#D5D5D5"), ...art.nodes.map(node => {
    const common = { ...node, x: x + node.x * s, y: y + node.y * s };
    if (node.kind === "rect") return { ...common, width: node.width * s, height: node.height * s, radius: (node.radius ?? 0) * s } as Shape;
    if (node.kind === "circle") return { ...common, radius: node.radius * s } as Shape;
    if (node.kind === "line") return { ...common, x2: x + node.x2 * s, y2: y + node.y2 * s, width: node.width * s } as Shape;
    if (node.kind === "image") return { ...common, width: node.width * s, height: node.height * s } as Shape;
    return { ...common, size: node.size * s, maxWidth: node.maxWidth * s } as Shape;
  })];
}
export function createFinalBrandBoard(snapshot: BrandAssetSnapshot, copy: BrandCopy = brandCopy(snapshot)): BrandArtwork {
  const p = snapshot.palette, fg = foreground(snapshot, p.background), w = 1600, h = 2200, round = snapshot.design.graphic === "rounded_shapes" ? 24 : 0;
  const nodes: Shape[] = [rect(0, 0, w, h, p.background), ...graphics(snapshot, w, 340)];
  nodes.push(text(snapshot, "BRAND IDENTITY", 80, 72, 20, 1400, false, fg), text(snapshot, snapshot.name, 80, copy.tagline ? 176 : 186, 100, 1440, true, fg));
  if (copy.tagline) nodes.push(text(snapshot, copy.tagline, 80, 232, 30, 1440, false, fg));
  // The logo on the brand background, and on a contrasting palette color.
  const top = copy.tagline ? 270 : 250, height = 690 - top, surfaces = logoSurfaces(snapshot);
  const second = isDarkColor(p.background) ? surfaces.light : surfaces.dark, half = second && second !== p.background ? 700 : 1440;
  const caption = (surface: string) => isDarkColor(surface) ? "ONE-COLOR REVERSED VERSION, FOR DARK BACKGROUNDS" : "YOUR LOGO";
  nodes.push({ kind: "rect", x: 80, y: top, width: half, height, fill: fg, radius: round, opacity: .16 }, rect(81.5, top + 1.5, half - 3, height - 3, p.background, round));
  nodes.push(...logoFrame(p.background, 80, top, half, height, .14), text(snapshot, caption(p.background), 80, 730, 18, half, false, fg));
  if (half === 700) nodes.push(rect(820, top, 700, height, second!, round), ...logoFrame(second!, 820, top, 700, height, .14), text(snapshot, caption(second!), 820, 730, 18, 700, false, fg));
  nodes.push(text(snapshot, "Color palette", 80, 820, 42, 1400, true, fg));
  const columns = Math.min(8, snapshot.colors.length), cell = 1440 / columns;
  snapshot.colors.forEach((color, index) => {
    const x = 80 + index % columns * cell, y = 860 + Math.floor(index / columns) * 140;
    nodes.push(rect(x, y, cell - 12, 74, fg), rect(x + 1, y + 1, cell - 14, 72, color.hex), text(snapshot, color.name, x, y + 100, 19, cell - 14, false, fg), text(snapshot, color.hex, x, y + 126, 17, cell - 14, false, fg));
  });
  const typeY = snapshot.colors.length > 8 ? 1190 : 1050;
  nodes.push(text(snapshot, "Typography", 80, typeY, 42, 1400, true, fg));
  nodes.push(text(snapshot, `${snapshot.heading.family} · ${snapshot.heading.weight}`, 80, typeY + 54, 20, 700, false, fg), text(snapshot, "A distinct voice.", 80, typeY + 144, 64, 700, true, fg));
  nodes.push(text(snapshot, `${snapshot.body.family} · ${snapshot.body.weight}`, 870, typeY + 54, 20, 650, false, fg), text(snapshot, "The details make the difference.", 870, typeY + 112, 30, 650, false, fg), text(snapshot, "Aa Bb Cc 0123456789", 870, typeY + 164, 30, 650, false, fg));
  // In practice: a square post beside a wide banner over a portrait post and the
  // profile image, scaled to fill the space above the footer.
  const appsY = typeY + 260, footerY = 2140, scale = Math.min(1, (footerY - 80 - (appsY + 40)) / 664), at = (value: number) => value * scale;
  const square = at(664), column = at(736), x2 = 80 + square + at(40), banner = column / 3, row = square - banner - at(24);
  nodes.push(text(snapshot, "In practice", 80, appsY, 42, 1400, true, fg));
  nodes.push(...placed(createBrandApplication(snapshot, BRAND_APPLICATIONS[1], copy), 80, appsY + 40, square));
  nodes.push(...placed(createBrandApplication(snapshot, BRAND_APPLICATIONS[3], copy), x2, appsY + 40, column));
  nodes.push(...placed(createBrandApplication(snapshot, BRAND_APPLICATIONS[2], copy), x2, appsY + 40 + banner + at(24), row * .8));
  nodes.push(...placed(createBrandApplication(snapshot, BRAND_APPLICATIONS[0], copy), x2 + row * .8 + at(24), appsY + 40 + banner + at(24), row));
  nodes.push(text(snapshot, "Logo · Color palette · Fonts · Social templates", 80, footerY, 22, 1440, false, fg));
  return { width: w, height: h, title: `${snapshot.name} — Brand identity`, nodes };
}

export type BrandImages = Record<ImageSource, { image: CanvasImageSource; width: number; height: number; dataUrl: string }>;
export type BrandFontNames = ReadonlyMap<string, string>;
const luminance = (pixels: Uint8ClampedArray, index: number) => .2126 * pixels[index]! + .7152 * pixels[index + 1]! + .0722 * pixels[index + 2]!;
const ramp = (value: number, from: number, to: number) => Math.min(1, Math.max(0, (value - from) / (to - from)));
function derivedLogo(canvas: HTMLCanvasElement, logo: Pick<BrandImages["logo"], "image" | "width" | "height">, pixel: (data: Uint8ClampedArray, index: number) => void) {
  canvas.width = logo.width; canvas.height = logo.height;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new BrandAssetError("canvas");
  ctx.clearRect(0, 0, logo.width, logo.height); ctx.drawImage(logo.image, 0, 0, logo.width, logo.height);
  const pixels = ctx.getImageData(0, 0, logo.width, logo.height);
  for (let index = 0; index < pixels.data.length; index += 4) pixel(pixels.data, index);
  ctx.putImageData(pixels, 0, 0);
}
// Pixels within CLEAR of white are background; from SOLID on, colors stay exact.
const CLEAR = 15, SOLID = 200;
/** The logo with its light background made transparent, for light surfaces.
 * Each pixel keeps the color it shows over white; near-white becomes clear. */
export function drawTransparentLogo(canvas: HTMLCanvasElement, logo: Pick<BrandImages["logo"], "image" | "width" | "height">): void {
  derivedLogo(canvas, logo, (data, index) => {
    const distance = 255 - Math.min(data[index]!, data[index + 1]!, data[index + 2]!), alpha = ramp(distance, CLEAR, SOLID);
    for (let channel = index; channel < index + 3; channel++) data[channel] = alpha ? 255 - (255 - data[channel]!) / alpha : 255;
    data[index + 3] = alpha * data[index + 3]!;
  });
}
// Near-black ink becomes solid white and an off-white background disappears.
const INK = 64, PAPER = 240;
/** A one-color reversed copy for dark surfaces: white ink whose opacity follows
 * the original's darkness. */
export function drawReversedLogo(canvas: HTMLCanvasElement, logo: Pick<BrandImages["logo"], "image" | "width" | "height">): void {
  derivedLogo(canvas, logo, (data, index) => {
    data[index + 3] = (1 - ramp(luminance(data, index), INK, PAPER)) * data[index + 3]!;
    data[index] = data[index + 1] = data[index + 2] = 255;
  });
}
function fitText(ctx: CanvasRenderingContext2D, input: TextShape, family: string): TextShape {
  let node = input;
  const setFont = () => { ctx.font = `${node.weight} ${node.size}px "${family}"`; };
  ctx.direction = brandTextDirection(node.text);
  setFont();
  while (ctx.measureText(node.text).width > node.maxWidth && node.size > 10) { node = { ...node, size: node.size - 1 }; setFont(); }
  // Canvas still fits unusually long names at the minimum size. Record that
  // final width so the editable SVG preserves the same complete lettering.
  if (ctx.measureText(node.text).width > node.maxWidth) node = { ...node, textLength: node.maxWidth };
  return node;
}
export function drawBrandArtwork(canvas: HTMLCanvasElement, artwork: BrandArtwork, images: BrandImages, fonts: BrandFontNames): BrandArtwork {
  canvas.width = artwork.width; canvas.height = artwork.height;
  const ctx = canvas.getContext("2d", { alpha: false }); if (!ctx) throw new BrandAssetError("canvas");
  const family = (node: TextShape) => { const name = fonts.get(node.family); if (!name) throw new BrandAssetError("font"); return name; };
  // Lines of one wrapped block share the size of their widest line.
  const groups = new Map<string, number>();
  for (const node of artwork.nodes) if (node.kind === "text" && node.group) {
    ctx.save(); const size = fitText(ctx, node, family(node)).size; ctx.restore();
    groups.set(node.group, Math.min(groups.get(node.group) ?? size, size));
  }
  const fitted: BrandArtwork = { ...artwork, nodes: [] };
  for (const input of artwork.nodes) {
    let node = { ...input }; ctx.save();
    if (node.kind === "rect") { ctx.globalAlpha = node.opacity ?? 1; ctx.fillStyle = node.fill; ctx.beginPath(); ctx.roundRect(node.x, node.y, node.width, node.height, node.radius ?? 0); ctx.fill(); }
    else if (node.kind === "circle") { ctx.globalAlpha = node.opacity ?? 1; ctx.fillStyle = node.fill; ctx.beginPath(); ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2); ctx.fill(); }
    else if (node.kind === "line") { ctx.strokeStyle = node.color; ctx.lineWidth = node.width; ctx.beginPath(); ctx.moveTo(node.x, node.y); ctx.lineTo(node.x2, node.y2); ctx.stroke(); }
    else if (node.kind === "image") { const source = images[node.source], scale = Math.min(node.width / source.width, node.height / source.height), width = source.width * scale, height = source.height * scale; ctx.drawImage(source.image, node.x + (node.width - width) / 2, node.y + (node.height - height) / 2, width, height); }
    else {
      node = fitText(ctx, node.group ? { ...node, size: Math.min(node.size, groups.get(node.group) ?? node.size) } : node, family(node));
      const x = node.align !== "center" && brandTextDirection(node.text) === "rtl" ? node.x + node.maxWidth : node.x;
      ctx.fillStyle = node.color; ctx.textBaseline = "alphabetic"; ctx.textAlign = node.align === "center" ? "center" : "start"; ctx.fillText(node.text, x, node.y, node.maxWidth);
    }
    ctx.restore(); fitted.nodes.push(node);
  }
  return fitted;
}
const xml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
export function editableBrandSvg(artwork: BrandArtwork, images: BrandImages): Uint8Array {
  const nodes = artwork.nodes.map(node => {
    if (node.kind === "rect") return `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.radius ?? 0}" fill="${node.fill}" opacity="${node.opacity ?? 1}"/>`;
    if (node.kind === "circle") return `<circle cx="${node.x}" cy="${node.y}" r="${node.radius}" fill="${node.fill}" opacity="${node.opacity ?? 1}"/>`;
    if (node.kind === "line") return `<line x1="${node.x}" y1="${node.y}" x2="${node.x2}" y2="${node.y2}" stroke="${node.color}" stroke-width="${node.width}"/>`;
    if (node.kind === "image") { const url = images[node.source].dataUrl; if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) throw new BrandAssetError("source"); return `<image x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" preserveAspectRatio="xMidYMid meet" href="${url}"/>`; }
    const direction = brandTextDirection(node.text), x = node.align !== "center" && direction === "rtl" ? node.x + node.maxWidth : node.x;
    return `<text x="${x}" y="${node.y}" font-family="${xml(node.family)}" font-weight="${node.weight}" font-size="${node.size}" fill="${node.color}" direction="${direction}" unicode-bidi="isolate" text-anchor="${node.align === "center" ? "middle" : "start"}"${node.textLength === undefined ? "" : ` textLength="${node.textLength}" lengthAdjust="spacingAndGlyphs"`}>${xml(node.text)}</text>`;
  });
  return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${artwork.width}" height="${artwork.height}" viewBox="0 0 ${artwork.width} ${artwork.height}"><title>${xml(artwork.title)}</title><desc>Editable text and shapes. The logo remains an embedded raster image made from your original logo: with its light background removed on light colors, and as a one-color reversed version on dark colors. Install the linked fonts before editing.</desc>${nodes.join("")}</svg>`);
}
