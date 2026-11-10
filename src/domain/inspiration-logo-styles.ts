import { z } from "zod";
import { LOGO_STYLE_NOTE_VERSION, logoStyleNoteSchema } from "./logo-style-notes";
import styleData from "./inspiration-logo-styles.json" with { type: "json" };

/** Logo style notes for the Inspiration brands, written once from each brand's
 * logo image by scripts/build-inspiration-logo-styles.mts. Each records the
 * fingerprint of the logo image it describes. */
export const inspirationLogoStylesSchema = z.strictObject({
  version: z.literal(1),
  noteVersion: z.literal(LOGO_STYLE_NOTE_VERSION),
  model: z.string().min(1).max(100),
  notes: z.record(
    z.uuid(),
    logoStyleNoteSchema
      .extend({
        slug: z.string().min(1).max(100),
        logoContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .refine((note) => note.symbol !== null || note.lettering !== null, "Empty note"),
  ),
});
export type InspirationLogoStyles = z.infer<typeof inspirationLogoStylesSchema>;
export const inspirationLogoStyles: InspirationLogoStyles = inspirationLogoStylesSchema.parse(styleData);
