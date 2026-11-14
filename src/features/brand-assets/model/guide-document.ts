import { brandBoardContrastRatio as contrast } from "@/domain/brand-board-design";
import { brandBoardFont } from "@/domain/brand-board-fonts";
import { brandRoleColors, EXPORT_RULE, logoSurfaces, templateTheme } from "./artwork";
import { plainBrandNotes } from "./guides";
import type { BrandAssetSnapshot } from "./snapshot";

const html = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const isDark = (hex: string) => contrast("#FFFFFF", hex) >= contrast("#000000", hex);

/** What the guidelines say beyond the saved direction: the saved words, the
 * chosen direction's name and the pictures prepared for the file. */
export type BrandGuideInput = {
  slogan?: string | null;
  positioning?: string | null;
  /** Selected audience segments, in the saved wording. */
  audience?: readonly string[];
  /** The leading personality traits, strongest first. */
  traits?: readonly string[];
  direction?: string | null;
  date?: Date;
  /** Data URLs of the transparent and reversed logo copies and of the direction crops. */
  images?: { logo?: string | null; logoReversed?: string | null; crops?: readonly string[] };
};

const SERIF = new Set(["Fraunces", "Lora"]);
const fontStack = (family: string) =>
  `"${family.replace(/["\\]/gu, "")}", ${SERIF.has(family) ? "Georgia, serif" : "system-ui, Arial, sans-serif"}`;
const dataImage = (value: string | null | undefined) =>
  value && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(value) ? value : null;
const ratioText = (ratio: number) => `${(Math.floor(ratio * 10) / 10).toFixed(1)} : 1`;

/** Text pairs from the palette, most readable first, with what each is for. */
export function brandTextPairs(snapshot: BrandAssetSnapshot) {
  const p = snapshot.palette;
  const pairs = [
    { name: "Text on Background", fg: p.text, bg: p.background, use: "Body text and headings." },
    { name: "Background on Primary", fg: p.background, bg: p.primary, use: "Text on dark areas." },
    { name: "Primary on Accent", fg: p.primary, bg: p.accent, use: "Labels on a highlight." },
    { name: "Accent on Background", fg: p.accent, bg: p.background, use: "Links and short text." },
  ];
  return pairs
    .map((pair) => {
      const ratio = contrast(pair.fg, pair.bg);
      const use =
        ratio >= 4.5
          ? pair.use
          : ratio >= 3
            ? "Large type only, 24 px and up."
            : pair.fg === p.accent
              ? "Too faint to read. Use the accent for fills only."
              : "Too close to read. Don’t set one on the other.";
      return { ...pair, ratio, ratioText: ratioText(ratio), use };
    })
    .sort((a, b) => b.ratio - a.ratio);
}

/** The brand guidelines as one designed, self-contained page (canvas page 5): a
 * cover, logo use, colors with text pairs, type, voice and imagery, set in the
 * brand's own type and colors. Only saved content is used; a part with nothing
 * saved is left out. Embel's own hairlines use written-out primitive values. */
export function brandGuideHtml(snapshot: BrandAssetSnapshot, input: BrandGuideInput = {}): Uint8Array<ArrayBuffer> {
  const theme = templateTheme(snapshot),
    p = snapshot.palette,
    surfaces = logoSurfaces(snapshot);
  const name = html(snapshot.name),
    direction = input.direction?.trim() || null,
    head = fontStack(snapshot.heading.family),
    body = fontStack(snapshot.body.family);
  const logo = dataImage(input.images?.logo),
    reversed = dataImage(input.images?.logoReversed),
    crops = (input.images?.crops ?? []).map(dataImage).filter((value): value is string => Boolean(value));
  const slogan = input.slogan?.replace(/\s+/gu, " ").trim() || null,
    positioning = input.positioning?.replace(/\s+/gu, " ").trim() || null,
    audience = input.audience?.find((item) => item.trim())?.trim() ?? null;
  const date = (input.date ?? new Date()).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const notes = (value: string) => html(plainBrandNotes(snapshot, value));
  const fonts = [snapshot.heading, snapshot.body]
    .map((style) => brandBoardFont(style.family))
    .filter(
      (font, index, all): font is NonNullable<typeof font> =>
        Boolean(font) && all.findIndex((other) => other?.id === font!.id) === index,
    );
  const fontLinks = fonts
    .map((font) => `<a href="${html(font.url)}" target="_blank" rel="noopener noreferrer">${html(font.family)}</a>`)
    .join(" and ");
  const logoOn = (surface: string) => (isDark(surface) ? reversed : logo);
  const mark = (surface: string, alt: string, extra = "") => {
    const url = logoOn(surface);
    if (!url) return "";
    const label = alt ? ` role="img" aria-label="${html(alt)}"` : ' aria-hidden="true"';
    return `<div class="mark${extra}"${label} style="background-image:url(${url})"></div>`;
  };
  const figure = (inner: string, caption: string, style: string) =>
    `<figure><div class="tile" style="${style}">${inner}</div><figcaption>${caption}</figcaption></figure>`;
  const on = (surface: string) => `background:${surface}${surface === p.background ? "" : `;border-color:${surface}`}`;

  const cover = logoOn(theme.field)
    ? `<div class="cover-mark" role="img" aria-label="${name} logo" style="background-image:url(${logoOn(theme.field)})"></div>`
    : `<p class="cover-name" translate="no">${name}</p>`;

  const logoSection = logo
    ? `<section aria-labelledby="g-logo"><h2 id="g-logo">Logo</h2><div class="tiles">${figure(
        mark(surfaces.light, `${snapshot.name} logo`),
        "On light backgrounds: the full-color logo.",
        on(surfaces.light),
      )}${
        surfaces.dark && reversed
          ? figure(
              mark(surfaces.dark, `${snapshot.name} logo, reversed`),
              "On dark backgrounds: the one-color reversed logo.",
              on(surfaces.dark),
            )
          : ""
      }${figure(
        `<div class="clear"><div class="clear-inner">${mark(surfaces.light, "", " fill")}</div></div>`,
        "Clear space: keep a quarter of the logo’s height free on every side (the dashed line). Smallest size: 96 px wide on screen, 20 mm in print.",
        on(surfaces.light),
      )}</div><h3>Please don’t</h3><div class="tiles">${figure(
        mark(surfaces.light, "", " stretched"),
        "Don’t stretch or squeeze it.",
        on(surfaces.light),
      )}${figure(mark(surfaces.light, "", " faded"), "Don’t fade it or change its colors.", on(surfaces.light))}${figure(
        mark(p.accent, ""),
        "Don’t place it on the accent color or on a busy picture.",
        on(p.accent),
      )}</div></section>`
    : "";

  const colorSection = `<section aria-labelledby="g-colors"><h2 id="g-colors">Colors</h2><div class="swatches">${brandRoleColors(
    snapshot,
  )
    .map(
      (color) =>
        `<div class="swatch"><div class="chip" style="background:${color.hex}"></div><strong>${color.name}</strong><code>${color.hex}</code><span class="small">${html(color.use)}</span></div>`,
    )
    .join(
      "",
    )}</div>${snapshot.colorNotes ? `<p class="small">${notes(snapshot.colorNotes)}</p>` : ""}<h3>Pairs for text</h3><ul class="pairs">${brandTextPairs(
    snapshot,
  )
    .map(
      (pair) =>
        `<li><span class="aa" aria-hidden="true" style="background:${pair.bg};color:${pair.fg}">Aa</span><span class="pair"><strong>${pair.name}</strong><span class="small">${html(pair.use)}</span></span><span class="ratio">${pair.ratioText}</span></li>`,
    )
    .join("")}</ul></section>`;

  const typeRows: [string, BrandAssetSnapshot["heading"], number, number, string | null, string][] = [
    ["Display", snapshot.heading, 48, 1.05, slogan ?? snapshot.name, "display"],
    ["Heading", snapshot.heading, 32, 1.15, slogan ? snapshot.name : null, "heading"],
    ["Title", snapshot.heading, 20, 1.3, audience, "title"],
    ["Body", snapshot.body, 16, 1.5, positioning, "body"],
    [
      "Small",
      snapshot.body,
      13,
      1.5,
      snapshot.heading.family === snapshot.body.family
        ? `Everything in ${snapshot.heading.family}.`
        : `Headings in ${snapshot.heading.family}, everything else in ${snapshot.body.family}.`,
      "fine",
    ],
  ];
  const typeSection = `<section aria-labelledby="g-type"><h2 id="g-type">Typography</h2><div class="type">${typeRows
    .filter((row) => row[4])
    .map(
      ([label, style, size, leading, sample, kind]) =>
        `<div><span class="small">${label} · ${html(style.family)} ${style.weight} · ${size} / ${leading}</span><span class="${kind}" style="font-family:${html(fontStack(style.family))};font-weight:${style.weight}">${html(sample!)}</span></div>`,
    )
    .join(
      "",
    )}</div>${snapshot.typeNotes ? `<p class="small">${notes(snapshot.typeNotes)}</p>` : ""}<p class="small">Font files are linked, not included: ${fontLinks}. Install them before editing the SVG templates.</p></section>`;

  const traits = (input.traits ?? []).filter(Boolean).slice(0, 2);
  const voiceSection =
    traits.length || slogan
      ? `<section aria-labelledby="g-voice"><h2 id="g-voice">Voice</h2>${
          traits.length ? `<p><strong>Leads with ${html(traits.join(" and "))}.</strong></p>` : ""
        }${slogan ? `<div class="say"><h3>Say this</h3><p>${html(slogan)}</p></div>` : ""}</section>`
      : "";

  const imageryText = [snapshot.imageryNotes, snapshot.graphicNotes, snapshot.compositionNotes]
    .filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index)
    .map((value) => `<p>${notes(value)}</p>`)
    .join("");
  const imagerySection =
    imageryText || crops.length
      ? `<section aria-labelledby="g-imagery"><h2 id="g-imagery">Imagery</h2>${imageryText}${
          crops.length
            ? `<div class="crops">${crops
                .map(
                  (url) => `<img src="${url}" alt="A detail of the chosen direction board" width="688" height="516">`,
                )
                .join(
                  "",
                )}</div><p class="small">Details cropped from the chosen direction board${direction ? `, ${html(direction)}` : ""}.</p>`
            : ""
        }</section>`
      : "";

  const css = [
    "*{box-sizing:border-box}",
    "html{-webkit-print-color-adjust:exact;print-color-adjust:exact}",
    `body{margin:0;background:${p.background};color:${p.text};font:${snapshot.body.weight} 16px/1.5 ${body}}`,
    `h1,h2,h3{margin:0;font-family:${head};font-weight:${snapshot.heading.weight}}`,
    "h2{font-size:32px;line-height:1.15}h3{font-size:20px;line-height:1.3}",
    "p{margin:0;max-width:68ch}a{color:inherit}",
    "figure{margin:0;display:grid;gap:8px;align-content:start}figcaption,.small{font-size:13px;line-height:1.45}",
    'code{font:13px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace}',
    `.cover{display:grid;justify-items:center;gap:24px;padding:clamp(40px,9vw,96px) 24px;background:${theme.field};color:${theme.ink};text-align:center}`,
    ".cover-mark{width:min(60%,320px);aspect-ratio:3/2;background:center/contain no-repeat}",
    `.cover-name{max-width:none;font:${snapshot.heading.weight} 40px/1.1 ${head}}`,
    ".cover h1{font-size:20px;line-height:1.3}.cover p{margin:4px auto 0;font-size:13px}",
    "main{display:grid;gap:64px;padding:clamp(24px,6vw,64px)}section{display:grid;gap:24px}",
    ".tiles,.swatches,.crops{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))}",
    `.tile{aspect-ratio:4/3;display:grid;place-items:center;overflow:hidden;border:1px solid ${EXPORT_RULE}}`,
    ".mark{width:62%;height:80%;background:center/contain no-repeat}.mark.fill{width:100%;height:100%}",
    ".mark.stretched{transform:scaleX(1.5)}.mark.faded{opacity:.35}",
    `.clear{width:78%;height:84%;display:grid;place-items:center;border:1px dashed ${p.text}}`,
    `.clear-inner{width:68%;height:68%;display:grid;place-items:center;border:1px solid ${EXPORT_RULE}}`,
    `.swatch{display:grid;gap:2px;align-content:start}.chip{aspect-ratio:3/2;margin-bottom:6px;border:1px solid ${EXPORT_RULE}}`,
    "strong{font-weight:600}",
    ".pairs{margin:0;padding:0;list-style:none;display:grid;gap:12px}",
    `.pairs li{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding-bottom:12px;border-bottom:1px solid ${EXPORT_RULE}}`,
    `.aa{flex:none;display:grid;place-items:center;width:96px;height:56px;border:1px solid ${EXPORT_RULE};font:${snapshot.heading.weight} 24px/1 ${head}}`,
    ".pair{flex:1 1 200px;display:grid}.ratio{font-variant-numeric:tabular-nums}",
    ".type{display:grid;gap:20px}.type>div{display:grid;gap:4px}",
    ".display{font-size:clamp(32px,5vw,48px);line-height:1.05;letter-spacing:-.02em}",
    ".heading{font-size:clamp(24px,4vw,32px);line-height:1.15}.title{font-size:20px;line-height:1.3}",
    ".body{max-width:68ch}.fine{font-size:13px}",
    `.say{display:grid;gap:12px}.say p{max-width:none;padding:12px 16px;border:1px solid ${EXPORT_RULE}}`,
    ".crops img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover}",
  ].join("");

  return new TextEncoder().encode(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} — Brand guidelines</title><style>${css}</style></head><body><article><header class="cover">${cover}<div><h1>Brand guidelines</h1><p>${direction ? `${html(direction)} · ` : ""}${html(date)}</p></div></header><main>${logoSection}${colorSection}${typeSection}${voiceSection}${imagerySection}</main></article></body></html>`,
  );
}
