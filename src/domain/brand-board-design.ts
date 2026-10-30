import { z } from "zod";

const componentKey = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);

/** Explicit presentation decisions shared by the generated direction and its
 * downloadable applications. Free-form design prose is never executed. */
export const brandBoardApplicationDesignSchema = z.strictObject({
  version: z.literal(1),
  graphic: z.enum(["none", "rounded_shapes", "fine_lines", "bold_blocks"]),
  layout: z.enum(["editorial", "centered", "split"]),
  paletteRoles: z.strictObject({ primary: componentKey, accent: componentKey, background: componentKey, text: componentKey }),
  headingStyleKey: componentKey,
  bodyStyleKey: componentKey,
});
export type BrandBoardApplicationDesign = z.infer<typeof brandBoardApplicationDesignSchema>;
