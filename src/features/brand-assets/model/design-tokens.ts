import type { BrandAssetSnapshot } from "./snapshot";
import { brandBoardContrastRatio as contrast } from "@/domain/brand-board-design";

/** Assets · Design system: tokens derived only from the chosen direction's saved
 * colors and fonts, plus a fixed type scale, spacing and corner set. Nothing is
 * invented about the brand beyond those choices. */
export const TYPE_SCALE = [
  { key: "display", label: "Display", size: 48, lineHeight: 1.05, role: "heading" },
  { key: "heading", label: "Heading", size: 32, lineHeight: 1.15, role: "heading" },
  { key: "title", label: "Title", size: 20, lineHeight: 1.3, role: "heading" },
  { key: "body", label: "Body", size: 16, lineHeight: 1.5, role: "body" },
  { key: "small", label: "Small", size: 13, lineHeight: 1.45, role: "body" },
] as const;
export const SPACING = [4, 8, 12, 16, 24, 32, 48] as const;
export const CORNERS = [
  { key: "small", label: "Small", value: 6 },
  { key: "medium", label: "Medium", value: 12 },
  { key: "large", label: "Large", value: 16 },
  { key: "pill", label: "Pill", value: 999 },
] as const;

const ROLE_USE: Record<keyof BrandAssetSnapshot["palette"], string> = {
  primary: "Buttons and key actions",
  accent: "Highlights and links",
  background: "Page background",
  text: "Body text",
};

/** A text color on `background` with at least 4.5:1 contrast, preferring the
 * palette's own roles. When no palette color passes, dark or light text,
 * whichever has more contrast, so the preview never demonstrates a failing pair. */
export function readableBrandColor(
  snapshot: BrandAssetSnapshot,
  background: string,
  preferred: readonly string[] = [],
): string {
  const choices = [
    ...preferred,
    snapshot.palette.text,
    snapshot.palette.primary,
    snapshot.palette.background,
    ...snapshot.colors.map((color) => color.hex),
  ];
  return (
    choices.find((hex) => contrast(hex, background) >= 4.5) ??
    (contrast("#FFFFFF", background) >= contrast("#000000", background) ? "#FFFFFF" : "#000000")
  );
}

type DesignTokens = ReturnType<typeof designTokens>;
export function designTokens(snapshot: BrandAssetSnapshot) {
  const roles = Object.entries(snapshot.palette) as [keyof BrandAssetSnapshot["palette"], string][];
  // An accent too light for text on the page background is used as a fill only.
  const accentUse =
    contrast(snapshot.palette.accent, snapshot.palette.background) >= 4.5
      ? ROLE_USE.accent
      : "Highlights and fills, not text";
  const colors = snapshot.colors.map((color) => {
    const role = roles.find(([, hex]) => hex.toLowerCase() === color.hex.toLowerCase())?.[0];
    return {
      key: color.key,
      name: color.name,
      hex: color.hex,
      role: role ?? null,
      use: role === "accent" ? accentUse : role ? ROLE_USE[role] : "Supporting color",
    };
  });
  const fonts = {
    heading: { family: snapshot.heading.family, weight: snapshot.heading.weight },
    body: { family: snapshot.body.family, weight: snapshot.body.weight },
  };
  return {
    brand: snapshot.name,
    colors,
    roles: snapshot.palette,
    fonts,
    typeScale: TYPE_SCALE,
    spacing: SPACING,
    corners: CORNERS,
  };
}

const cssName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "") || "color";

export function designTokensCss(tokens: DesignTokens): string {
  // A palette color whose key is also a role name ("primary") is written once, not once as a color and again as
  // its role.
  const colorLines = [
    ...tokens.colors.map((color) => [cssName(color.key), color.hex] as const),
    ...Object.entries(tokens.roles).map(([role, hex]) => [role, hex] as const),
  ];
  const written = new Set<string>();
  const lines = [
    `/* ${tokens.brand} design tokens, from the chosen direction. */`,
    ":root {",
    ...colorLines.flatMap(([name, hex]) => {
      if (written.has(name)) return [];
      written.add(name);
      return [`  --color-${name}: ${hex};`];
    }),
    `  --font-heading: "${tokens.fonts.heading.family}", system-ui, sans-serif;`,
    `  --font-body: "${tokens.fonts.body.family}", system-ui, sans-serif;`,
    `  --font-weight-heading: ${tokens.fonts.heading.weight};`,
    `  --font-weight-body: ${tokens.fonts.body.weight};`,
    ...tokens.typeScale.flatMap((step) => [
      `  --text-${step.key}: ${step.size}px;`,
      `  --leading-${step.key}: ${step.lineHeight};`,
    ]),
    ...tokens.spacing.map((value) => `  --space-${value}: ${value}px;`),
    ...tokens.corners.map((corner) => `  --radius-${corner.key}: ${corner.value}px;`),
    "}",
    "",
  ];
  return lines.join("\n");
}

export function designTokensJson(tokens: DesignTokens): string {
  return (
    JSON.stringify(
      {
        brand: tokens.brand,
        color: Object.fromEntries(
          tokens.colors.map((color) => [
            cssName(color.key),
            { value: color.hex, name: color.name, role: color.role, use: color.use },
          ]),
        ),
        role: tokens.roles,
        font: tokens.fonts,
        typeScale: Object.fromEntries(
          tokens.typeScale.map((step) => [step.key, { size: step.size, lineHeight: step.lineHeight, font: step.role }]),
        ),
        spacing: tokens.spacing,
        radius: Object.fromEntries(tokens.corners.map((corner) => [corner.key, corner.value])),
      },
      null,
      2,
    ) + "\n"
  );
}
