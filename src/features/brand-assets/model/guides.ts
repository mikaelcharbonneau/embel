import { brandBoardFont } from "@/domain/brand-board-fonts";
import type { BrandAssetSnapshot } from "./snapshot";
const html = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const textBytes = (text: string) => new TextEncoder().encode(text);

type TypeStyle = BrandAssetSnapshot["typography"][number];
const STYLE_WORDS: readonly [RegExp, string][] = [
  [/head|display|title|hero|headline/iu, "headings"], [/label|button|action|cta|nav|ui/iu, "buttons and labels"],
  [/caption|small|meta|fine|note|legal/iu, "captions"], [/body|text|copy|paragraph|read/iu, "body text"],
];
/** Plain words for a saved type style, e.g. "guide_heading" → "headings". */
export function plainTypeStyleName(snapshot: BrandAssetSnapshot, style: Pick<TypeStyle, "key" | "role">): string {
  if (style.key === snapshot.design.headingStyleKey) return "headings";
  if (style.key === snapshot.design.bodyStyleKey) return "body text";
  return STYLE_WORDS.find(([pattern]) => pattern.test(style.key) || pattern.test(style.role))?.[1] ?? (style.role.trim().toLowerCase() || style.key.replace(/[_-]+/gu, " "));
}
const identifier = (value: string) => /[_-]|[a-z][A-Z]/u.test(value);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** Saved design notes can name internal style and color keys. Show readers plain
 * words instead; ordinary words that happen to be keys stay as written. */
export function plainBrandNotes(snapshot: BrandAssetSnapshot, notes: string): string {
  const names = [
    ...snapshot.typography.map(style => [style.key, plainTypeStyleName(snapshot, style)] as const),
    ...snapshot.colors.map(color => [color.key, color.name] as const),
  ].filter(([key]) => identifier(key)).sort((a, b) => b[0].length - a[0].length);
  let result = notes;
  for (const [key, name] of names) result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(key)}(?![\\p{L}\\p{N}_-])`, "gu"), name);
  // Any other snake_case identifier reads as separate words.
  return result.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu, match => match.replace(/_/gu, " "));
}

export function brandPaletteCss(colors: BrandAssetSnapshot["colors"]): string {
  return `:root {\n${colors.map(color => `  --brand-${color.key}: ${color.hex};`).join("\n")}\n}\n`;
}
export function brandPaletteFiles(snapshot: BrandAssetSnapshot) {
  return {
    json: textBytes(JSON.stringify({ brand: snapshot.name, colors: snapshot.colors, roles: snapshot.design.paletteRoles, usage: snapshot.colorNotes }, null, 2) + "\n"),
    css: textBytes(brandPaletteCss(snapshot.colors)),
  };
}
export function brandGuideHtml(snapshot: BrandAssetSnapshot, slogan: string | null = null): Uint8Array<ArrayBuffer> {
  const fonts = snapshot.typography.map(style => ({ ...style, font: brandBoardFont(style.family)! }));
  const notes = (value: string) => html(plainBrandNotes(snapshot, value));
  return textBytes(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(snapshot.name)} — Brand guide</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 24px;color:#202020;background:#fff}h1{font-size:40px;line-height:1.2}h2{margin-top:36px}.palette{display:flex;flex-wrap:wrap;gap:16px}.swatch{width:150px;height:80px;border:1px solid #ddd}p{white-space:pre-line}table{width:100%;border-collapse:collapse}td,th{padding:12px;text-align:left;border-bottom:1px solid #ddd}a{color:#1649ab}code{background:#f3f3f3;padding:2px 6px}</style><h1>${html(snapshot.name)}</h1>${slogan ? `<p class="slogan">${html(slogan)}</p>` : ""}<p>Brand guide</p><h2>Colors</h2><div class="palette">${snapshot.colors.map(color => `<div><div class="swatch" style="background:${color.hex}"></div><strong>${html(color.name)}</strong><br><code>${color.hex}</code></div>`).join("")}</div><p>${notes(snapshot.colorNotes)}</p><h2>Typography and font links</h2><table><thead><tr><th>Role</th><th>Font</th><th>Weight</th></tr></thead><tbody>${fonts.map(style => `<tr><td>${html(style.role)}</td><td><a href="${style.font.url}" rel="noopener noreferrer">${html(style.family)}</a></td><td>${style.weight} · normal</td></tr>`).join("")}</tbody></table><p>${notes(snapshot.typeNotes)}</p><p>Install these fonts before editing the SVG templates. Font files are linked rather than included in this download.</p><h2>Logo</h2><p>Give the logo clear space and keep it away from other text and images. On light backgrounds, use the copy with a transparent background (logo/logo-transparent.png). On dark backgrounds, use the one-color reversed version (logo/logo-reversed.png). Don't stretch the logo or change its colors otherwise.</p><h2>Graphics</h2><p>${notes(snapshot.graphicNotes)}</p><h2>Composition</h2><p>${notes(snapshot.compositionNotes)}</p><h2>Using your files</h2><p>PNG files are ready to upload. SVG social templates keep text, colors and shapes editable; their embedded logo is the original raster image. Any headline or message in them comes from your saved slogan and positioning; edit it for each post. The original logo file keeps its saved artwork and background. The transparent and reversed logos are raster copies made from it. The selected direction image is included separately as a visual reference.</p><p>Social crops vary by platform and device. Check placement in the destination platform before publishing.</p></html>`);
}
export function brandPackReadme(snapshot: BrandAssetSnapshot, vectorIncluded: boolean, slogan: string | null = null): Uint8Array<ArrayBuffer> {
  return textBytes(`${snapshot.name} — Brand assets\n${slogan ? `Slogan: ${slogan}\n` : ""}\nbrand-board.png: final overview of your selected identity.\nlogo/: original saved logo, a copy with its light background made transparent, a one-color reversed copy for dark backgrounds${vectorIncluded ? " and the matching saved SVG vector" : ""}.\ndirection/: unchanged selected direction image.\nsocial/: profile image, square and portrait post templates, and two banners.\nguides/: color values, CSS variables, font links and usage guide.\ndesign-system/: design tokens as CSS and JSON.\n\nThe social PNGs are ready to upload. Any headline or message in them comes from your saved slogan and positioning. Their SVG companions have editable text, colors and shapes; the embedded logo remains raster. Install the fonts linked in guides/brand-guide.html before editing. Font software is not included.\n\nThe original logo file retains its saved background and resolution. The transparent and reversed logos are raster images made from it. ${vectorIncluded ? "The separate logo SVG is verified saved vector geometry." : "There is no vector logo in this pack. Social SVG templates are not vector logo masters."}\n`);
}
