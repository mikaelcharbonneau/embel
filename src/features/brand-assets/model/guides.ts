import type { BrandAssetSnapshot } from "./snapshot";
export { brandGuideHtml, brandTextPairs, type BrandGuideInput } from "./guide-document";
const textBytes = (text: string) => new TextEncoder().encode(text);

type TypeStyle = BrandAssetSnapshot["typography"][number];
const STYLE_WORDS: readonly [RegExp, string][] = [
  [/head|display|title|hero|headline/iu, "headings"],
  [/label|button|action|cta|nav|ui/iu, "buttons and labels"],
  [/caption|small|meta|fine|note|legal/iu, "captions"],
  [/body|text|copy|paragraph|read/iu, "body text"],
];
/** Plain words for a saved type style, e.g. "guide_heading" → "headings". */
function plainTypeStyleName(snapshot: BrandAssetSnapshot, style: Pick<TypeStyle, "key" | "role">): string {
  if (style.key === snapshot.design.headingStyleKey) return "headings";
  if (style.key === snapshot.design.bodyStyleKey) return "body text";
  return (
    STYLE_WORDS.find(([pattern]) => pattern.test(style.key) || pattern.test(style.role))?.[1] ??
    (style.role.trim().toLowerCase() || style.key.replace(/[_-]+/gu, " "))
  );
}
const identifier = (value: string) => /[_-]|[a-z][A-Z]/u.test(value);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** Saved design notes can name internal style and color keys. Show readers plain
 * words instead; ordinary words that happen to be keys stay as written. */
export function plainBrandNotes(snapshot: BrandAssetSnapshot, notes: string): string {
  const names = [
    ...snapshot.typography.map((style) => [style.key, plainTypeStyleName(snapshot, style)] as const),
    ...snapshot.colors.map((color) => [color.key, color.name] as const),
  ]
    .filter(([key]) => identifier(key))
    .sort((a, b) => b[0].length - a[0].length);
  let result = notes;
  for (const [key, name] of names)
    result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(key)}(?![\\p{L}\\p{N}_-])`, "gu"), name);
  // Any other snake_case identifier reads as separate words.
  return result.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu, (match) => match.replace(/_/gu, " "));
}

export function brandPaletteCss(colors: BrandAssetSnapshot["colors"]): string {
  return `:root {\n${colors.map((color) => `  --brand-${color.key}: ${color.hex};`).join("\n")}\n}\n`;
}
export function brandPaletteFiles(snapshot: BrandAssetSnapshot) {
  return {
    json: textBytes(
      JSON.stringify(
        {
          brand: snapshot.name,
          colors: snapshot.colors,
          roles: snapshot.design.paletteRoles,
          usage: snapshot.colorNotes,
        },
        null,
        2,
      ) + "\n",
    ),
    css: textBytes(brandPaletteCss(snapshot.colors)),
  };
}
export function brandPackReadme(
  snapshot: BrandAssetSnapshot,
  vectorIncluded: boolean,
  slogan: string | null = null,
): Uint8Array<ArrayBuffer> {
  // A short, friendly "What's in this kit" (D-063). It says plainly that the logos are images, never vectors,
  // unless a saved vector is included.
  const lines = [
    `${snapshot.name}: your brand kit`,
    ...(slogan ? [`Slogan: ${slogan}`] : []),
    "",
    "What's in this kit",
    "- brand-board.png: your brand on one page.",
    `- logo/: your logo as you chose it, a copy with a transparent background and a one-color copy for dark backgrounds${vectorIncluded ? ", plus your saved SVG vector" : ""}.`,
    "- direction/: the creative direction you chose.",
    "- social/: a profile image, square and portrait post templates and two banners, ready to upload.",
    "- guides/: your colors, CSS variables and the brand guidelines (brand-guide.html, with links to your fonts).",
    "- design-system/: design tokens as CSS and JSON.",
    "",
    "Good to know",
    "- Headlines in the social images come from your slogan and positioning. Each has an SVG copy whose text, colors and shapes you can edit (the logo inside stays an image); install the fonts linked in the brand guidelines first. The fonts themselves are not included.",
    vectorIncluded
      ? "- The logo PNGs are images made from your saved logo; logo/ also holds your saved SVG vector."
      : "- The logos are PNG images, not vector files. They keep the size of your saved logo.",
    "",
  ];
  return textBytes(lines.join("\n"));
}
