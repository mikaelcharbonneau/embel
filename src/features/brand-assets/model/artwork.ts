import type { BrandAssetSnapshot } from "./snapshot";
import { BrandAssetError } from "./snapshot";
import { brandBoardContrastRatio as contrast } from "@/domain/brand-board-design";
import { brandTextDirection } from "@/domain/brand-board-fonts";

type Shape = { kind: "rect"; x: number; y: number; width: number; height: number; fill: string; radius?: number; opacity?: number }
  | { kind: "circle"; x: number; y: number; radius: number; fill: string; opacity?: number }
  | { kind: "line"; x: number; y: number; x2: number; y2: number; color: string; width: number }
  | { kind: "image"; source: "logo" | "direction"; x: number; y: number; width: number; height: number }
  | { kind: "text"; text: string; x: number; y: number; size: number; family: string; weight: number; color: string; maxWidth: number; align?: "left" | "center"; textLength?: number };
export type BrandArtwork = { width: number; height: number; title: string; nodes: Shape[] };
export const BRAND_APPLICATIONS = [
  { id: "profile", label: "Profile image", width: 1024, height: 1024, editable: false },
  { id: "post-square", label: "Square post template", width: 1080, height: 1080, editable: true },
  { id: "post-portrait", label: "Portrait post template", width: 1080, height: 1350, editable: true },
  { id: "banner-wide", label: "Wide banner", width: 1500, height: 500, editable: true },
  { id: "banner-cover", label: "Cover banner", width: 1584, height: 396, editable: true },
] as const;
export type BrandApplication = typeof BRAND_APPLICATIONS[number];
const rect = (x: number, y: number, width: number, height: number, fill: string, radius = 0): Shape => ({ kind: "rect", x, y, width, height, fill, radius });
const image = (source: "logo" | "direction", x: number, y: number, width: number, height: number): Shape => ({ kind: "image", source, x, y, width, height });
function text(snapshot: BrandAssetSnapshot, value: string, x: number, y: number, size: number, maxWidth: number, heading = false, color = snapshot.palette.text, align: "left" | "center" = "left"): Shape {
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
/** Original raster geometry is contained, never cropped, recolored or presented as vector. */
function logoFrame(snapshot: BrandAssetSnapshot, x: number, y: number, width: number, height: number): Shape[] {
  const inset = Math.min(width, height) * .08, radius = snapshot.design.graphic === "rounded_shapes" ? Math.min(width, height) * .06 : 0;
  return [rect(x, y, width, height, "#FFFFFF", radius), image("logo", x + inset, y + inset, width - inset * 2, height - inset * 2)];
}
export function createBrandApplication(snapshot: BrandAssetSnapshot, spec: BrandApplication): BrandArtwork {
  const { width: w, height: h } = spec, p = snapshot.palette, fg = foreground(snapshot, p.background), pad = w * .065;
  const nodes: Shape[] = [rect(0, 0, w, h, p.background), ...graphics(snapshot, w, h)];
  if (spec.id === "profile") {
    // Fits inside a common circular profile crop, including the original rectangular artwork.
    nodes.push(...logoFrame(snapshot, w * .18, h * .18, w * .64, h * .64));
  } else if (w / h > 2) {
    const centered = snapshot.design.layout === "centered", split = snapshot.design.layout === "split";
    if (split) nodes.push(rect(0, 0, w * .4, h, p.primary));
    if (centered) {
      nodes.push(...logoFrame(snapshot, w * .065, h * .16, w * .23, h * .68));
      nodes.push(text(snapshot, snapshot.name, w * .59, h * .43, h * .17, w * .55, true, fg, "center"), text(snapshot, "Your tagline here", w * .59, h * .66, h * .075, w * .55, false, fg, "center"));
    } else {
      nodes.push(...logoFrame(snapshot, pad, h * .17, w * .25, h * .66));
      nodes.push(text(snapshot, snapshot.name, w * .43, h * .43, h * .18, w * .49, true, fg), text(snapshot, "Your tagline here", w * .43, h * .68, h * .075, w * .49, false, fg));
    }
  } else if (snapshot.design.layout === "centered") {
    nodes.push(...logoFrame(snapshot, w * .27, h * .14, w * .46, h * .25));
    nodes.push(text(snapshot, "Your headline", w / 2, h * .56, w * .087, w * .8, true, fg, "center"), text(snapshot, "goes here.", w / 2, h * .67, w * .087, w * .8, true, fg, "center"));
    nodes.push(text(snapshot, "Add your message.", w / 2, h * .81, w * .03, w * .8, false, fg, "center"), text(snapshot, snapshot.name, w / 2, h * .93, w * .024, w * .8, false, fg, "center"));
  } else if (snapshot.design.layout === "split") {
    nodes.push(rect(0, 0, w * .46, h, p.primary));
    nodes.push(...logoFrame(snapshot, w * .055, h * .34, w * .35, h * .3));
    nodes.push(text(snapshot, "Your", w * .52, h * .36, w * .075, w * .41, true, fg), text(snapshot, "headline", w * .52, h * .47, w * .075, w * .41, true, fg), text(snapshot, "goes here.", w * .52, h * .58, w * .075, w * .41, true, fg));
    nodes.push(text(snapshot, "Add your message.", w * .52, h * .76, w * .026, w * .41, false, fg), text(snapshot, snapshot.name, w * .52, h * .92, w * .023, w * .41, false, fg));
  } else {
    nodes.push(...logoFrame(snapshot, pad, h * .08, w * .32, h * .19));
    nodes.push(text(snapshot, "Your headline", pad, h * .56, w * .09, w * .82, true, fg), text(snapshot, "goes here.", pad, h * .68, w * .09, w * .82, true, fg));
    nodes.push(text(snapshot, "Add your message.", pad, h * .81, w * .03, w * .82, false, fg), text(snapshot, snapshot.name, pad, h * .94, w * .024, w * .82, false, fg));
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
export function createFinalBrandBoard(snapshot: BrandAssetSnapshot): BrandArtwork {
  const p = snapshot.palette, fg = foreground(snapshot, p.background), w = 1600, h = 2200;
  const nodes: Shape[] = [rect(0, 0, w, h, p.background), ...graphics(snapshot, w, 340)];
  nodes.push(text(snapshot, "BRAND IDENTITY", 80, 72, 20, 1400, false, fg), text(snapshot, snapshot.name, 80, 186, 100, 1440, true, fg));
  nodes.push(...logoFrame(snapshot, 80, 250, 880, 440), image("direction", 1000, 250, 520, 440));
  nodes.push(text(snapshot, "YOUR LOGO", 80, 730, 18, 800, false, fg), text(snapshot, "SELECTED DIRECTION", 1000, 730, 18, 520, false, fg));
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
  const appsY = typeY + 260;
  nodes.push(text(snapshot, "In practice", 80, appsY, 42, 1400, true, fg));
  nodes.push(...placed(createBrandApplication(snapshot, BRAND_APPLICATIONS[1]), 80, appsY + 40, 560));
  nodes.push(...placed(createBrandApplication(snapshot, BRAND_APPLICATIONS[3]), 700, appsY + 40, 820));
  nodes.push(...placed(createBrandApplication(snapshot, BRAND_APPLICATIONS[0]), 700, appsY + 340, 220));
  nodes.push(text(snapshot, "READY TO MAKE YOUR OWN", 980, appsY + 382, 18, 540, false, fg), text(snapshot, "Your colors. Your type.", 980, appsY + 442, 36, 540, true, fg), text(snapshot, "Your next chapter.", 980, appsY + 493, 36, 540, true, fg));
  nodes.push(text(snapshot, "Logo · Color palette · Fonts · Social templates", 80, 2140, 22, 1440, false, fg));
  return { width: w, height: h, title: `${snapshot.name} — Brand identity`, nodes };
}

export type BrandImages = Record<"logo" | "direction", { image: CanvasImageSource; width: number; height: number; dataUrl: string }>;
export type BrandFontNames = ReadonlyMap<string, string>;
export function drawBrandArtwork(canvas: HTMLCanvasElement, artwork: BrandArtwork, images: BrandImages, fonts: BrandFontNames): BrandArtwork {
  canvas.width = artwork.width; canvas.height = artwork.height;
  const ctx = canvas.getContext("2d", { alpha: false }); if (!ctx) throw new BrandAssetError("canvas");
  const fitted: BrandArtwork = { ...artwork, nodes: [] };
  for (const input of artwork.nodes) {
    let node = { ...input }; ctx.save();
    if (node.kind === "rect") { ctx.globalAlpha = node.opacity ?? 1; ctx.fillStyle = node.fill; ctx.beginPath(); ctx.roundRect(node.x, node.y, node.width, node.height, node.radius ?? 0); ctx.fill(); }
    else if (node.kind === "circle") { ctx.globalAlpha = node.opacity ?? 1; ctx.fillStyle = node.fill; ctx.beginPath(); ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2); ctx.fill(); }
    else if (node.kind === "line") { ctx.strokeStyle = node.color; ctx.lineWidth = node.width; ctx.beginPath(); ctx.moveTo(node.x, node.y); ctx.lineTo(node.x2, node.y2); ctx.stroke(); }
    else if (node.kind === "image") { const source = images[node.source], scale = Math.min(node.width / source.width, node.height / source.height), width = source.width * scale, height = source.height * scale; ctx.drawImage(source.image, node.x + (node.width - width) / 2, node.y + (node.height - height) / 2, width, height); }
    else {
      const family = fonts.get(node.family); if (!family) throw new BrandAssetError("font");
      const setFont = () => { ctx.font = `${node.kind === "text" ? node.weight : 400} ${node.kind === "text" ? node.size : 12}px "${family}"`; };
      const direction = brandTextDirection(node.text);
      ctx.direction = direction;
      setFont();
      while (ctx.measureText(node.text).width > node.maxWidth && node.size > 10) { node = { ...node, size: node.size - 1 }; setFont(); }
      // Canvas still fits unusually long names at the minimum size. Record that
      // final width so the editable SVG preserves the same complete lettering.
      if (ctx.measureText(node.text).width > node.maxWidth) node = { ...node, textLength: node.maxWidth };
      const x = node.align !== "center" && direction === "rtl" ? node.x + node.maxWidth : node.x;
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
  return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${artwork.width}" height="${artwork.height}" viewBox="0 0 ${artwork.width} ${artwork.height}"><title>${xml(artwork.title)}</title><desc>Editable text and shapes. The original logo remains an embedded raster image. Install the linked fonts before editing.</desc>${nodes.join("")}</svg>`);
}
