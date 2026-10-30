import { z } from "zod";
import { logoBriefRevisionSchema, logoRasterSourceSchema } from "./logo-workspace";
import { logoTypeSchema } from "./logo-vector";
import { committedIdentityAssetReceiptSchema } from "./logo-deliverables";

/** Captured by admission from the saved selection, never from a browser URL. */
export const identityLogoSourceSchema = z.strictObject({
  version: z.literal(1),
  source: logoRasterSourceSchema,
  selectionRevision: z.number().int().positive(),
  logoType: logoTypeSchema,
  brief: logoBriefRevisionSchema,
  preview: committedIdentityAssetReceiptSchema,
}).superRefine((value, ctx) => {
  const { brief, preview } = value;
  if (brief.ownerId !== preview.reference.ownerId || brief.projectId !== preview.reference.projectId
    || preview.purpose !== "brand_asset" || !["image/png", "image/jpeg", "image/webp"].includes(preview.verification.mimeType)
    || preview.verification.contentHash !== preview.reference.contentHash) {
    ctx.addIssue({ code: "custom", message: "A selected logo must retain its owned saved brief and verified raster" });
  }
});
export type IdentityLogoSource = z.infer<typeof identityLogoSourceSchema>;
