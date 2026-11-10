import { z } from "zod";

const componentKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);

/** Explicit presentation decisions shared by the generated direction and its
 * downloadable applications. Free-form design prose is never executed. */
export const brandBoardApplicationDesignSchema = z.strictObject({
  version: z.literal(1),
  graphic: z.enum(["none", "rounded_shapes", "fine_lines", "bold_blocks"]),
  layout: z.enum(["editorial", "centered", "split"]),
  paletteRoles: z.strictObject({
    primary: componentKey,
    accent: componentKey,
    background: componentKey,
    text: componentKey,
  }),
  headingStyleKey: componentKey,
  bodyStyleKey: componentKey,
});
export type BrandBoardApplicationDesign = z.infer<typeof brandBoardApplicationDesignSchema>;

/** WCAG relative-luminance contrast for the saved six-digit sRGB palette. */
export function brandBoardContrastRatio(a: string, b: string): number {
  if (![a, b].every((hex) => /^#[a-f0-9]{6}$/i.test(hex))) return 0;
  const luminance = (hex: string) => {
    const [r, g, blue] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return r! * 0.2126 + g! * 0.7152 + blue! * 0.0722;
  };
  const first = luminance(a),
    second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
