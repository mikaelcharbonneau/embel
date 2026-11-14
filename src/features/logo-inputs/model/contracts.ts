import { z } from "zod";
import { fontRecordSchema, fontRightsEvidenceSchema } from "@/domain/logo-directions";
import {
  logoExpectedHeadsSchema,
  logoReferenceRegistrationSchema,
  uploadLogoReferenceInputSchema,
} from "@/domain/logo-workspace";
import { logoHashSchema, logoUuidSchema } from "@/domain/logo-vector";

export const LOGO_REFERENCE_UPLOAD_MAX_BYTES = 33_554_432;
export const LOGO_FONT_UPLOAD_MAX_BYTES = 10_485_760;
const LOGO_LICENSE_MAX_BYTES = 262_144;
export const LOGO_INPUT_METADATA_MAX_BYTES = 294_912;
const jsonbText = (value: string) =>
  [...value].every((character) => {
    const point = character.codePointAt(0)!;
    return point !== 0 && (point < 0xd800 || point > 0xdfff);
  });
const metadataBound = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= LOGO_INPUT_METADATA_MAX_BYTES;
const declaration = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (value) => value.trim().length > 0 && jsonbText(value),
    "Permission declaration is required and must be valid text.",
  );
const licenseText = z
  .string()
  .min(1)
  .max(LOGO_LICENSE_MAX_BYTES)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      jsonbText(value) &&
      new TextEncoder().encode(value).byteLength <= LOGO_LICENSE_MAX_BYTES,
    "Attach the actual license text, up to 256 KiB.",
  );
/** Deliberately matches the SQL subset: lowercase scheme, ASCII DNS labels,
 * optional port 1–65535, bounded ASCII path, no credentials/query/fragment. */
export function isLogoFontLicenseUrl(value: string): boolean {
  const match =
    /^https:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(?::([0-9]{1,5}))?(\/[A-Za-z0-9._~!$&'()*+,;=:@%/\-]*)?$/.exec(
      value,
    );
  if (
    !match ||
    match[1]!.length > 253 ||
    !/[A-Za-z]$/.test(match[1]!) ||
    (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))
  )
    return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
const sourceUrl = z
  .string()
  .max(2048)
  .refine(
    isLogoFontLicenseUrl,
    "Use lowercase https:// with an ASCII hostname, optional port and path; no query, fragment or credentials.",
  );
export const referenceUploadInputSchema = uploadLogoReferenceInputSchema.refine(
  (value) => declaration.safeParse(value.rightsDeclaration).success,
);
export const importCatalogLogoFontInputSchema = z.strictObject({
  requestKey: logoUuidSchema,
  expected: logoExpectedHeadsSchema,
  catalogFontId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9-]*$/),
});
const uploadFontShape = {
  requestKey: logoUuidSchema,
  expected: logoExpectedHeadsSchema,
  licenseSourceUrl: sourceUrl.nullable(),
  licenseText,
  rightsDeclaration: declaration,
};
export const uploadLogoFontInputSchema = z
  .strictObject(uploadFontShape)
  .refine(metadataBound, "Font metadata exceeds the supported JSON byte limit.");
const cancelFontInputSchema = z
  .strictObject({ ...uploadFontShape, licenseSourceUrl: z.string().max(2048).refine(jsonbText).nullable() })
  .refine(metadataBound);
export type ImportCatalogLogoFontInput = z.infer<typeof importCatalogLogoFontInputSchema>;
export type UploadLogoFontInput = z.infer<typeof uploadLogoFontInputSchema>;
export type UploadLogoReferenceInput = z.infer<typeof referenceUploadInputSchema>;
const rasterFileSchema = z.strictObject({
  contentHash: logoHashSchema,
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  byteLength: z.number().int().min(1).max(LOGO_REFERENCE_UPLOAD_MAX_BYTES),
});
const fontFileSchema = z.strictObject({
  contentHash: logoHashSchema,
  mimeType: z.enum(["font/ttf", "font/otf"]),
  byteLength: z.number().int().min(12).max(LOGO_FONT_UPLOAD_MAX_BYTES),
});
/** Includes exact byte identity. Filenames, storage paths and caller owner IDs are never trusted inputs. */
export const logoInputRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reference_upload"), input: referenceUploadInputSchema, file: rasterFileSchema }),
  z.strictObject({ kind: z.literal("font_upload"), input: uploadLogoFontInputSchema, file: fontFileSchema }),
  z.strictObject({ kind: z.literal("font_catalog"), input: importCatalogLogoFontInputSchema, file: fontFileSchema }),
]);
export type LogoInputRequest = z.infer<typeof logoInputRequestSchema>;
/** Rejection-only codec preserves earlier raw URL spellings. It cannot authorize
 * source reads, uploads, font permissions, or a successful registration. */
export const logoInputCancellationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reference_upload"), input: referenceUploadInputSchema, file: rasterFileSchema }),
  z.strictObject({ kind: z.literal("font_upload"), input: cancelFontInputSchema, file: fontFileSchema }),
  z.strictObject({ kind: z.literal("font_catalog"), input: importCatalogLogoFontInputSchema, file: fontFileSchema }),
]);
const scope = {
  ownerId: logoUuidSchema,
  projectId: logoUuidSchema,
  requestKey: logoUuidSchema,
  request: logoInputRequestSchema,
};
export const logoInputRequestStateSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("not_found") }),
    z.strictObject({ status: z.literal("pending"), ...scope }),
    z.strictObject({
      status: z.literal("rejected"),
      ...scope,
      request: logoInputCancellationSchema,
      reason: z.enum(["inputs_changed", "cancelled_by_user"]),
    }),
    z.strictObject({
      status: z.literal("succeeded"),
      ...scope,
      result: z.union([logoReferenceRegistrationSchema, fontRecordSchema]),
    }),
  ])
  .superRefine((value, context) => {
    if (value.status === "not_found") return;
    if (value.requestKey !== value.request.input.requestKey)
      context.addIssue({ code: "custom", message: "Request identity mismatch." });
    if (value.status === "succeeded") {
      const reference = "referenceId" in value.result;
      if (
        reference !== (value.request.kind === "reference_upload") ||
        value.result.asset.ownerId !== value.ownerId ||
        value.result.asset.projectId !== value.projectId ||
        value.result.asset.contentHash !== value.request.file.contentHash
      )
        context.addIssue({ code: "custom", message: "Result must bind the exact owned input." });
    }
  });
export type LogoInputRequestState = z.infer<typeof logoInputRequestStateSchema>;
export const catalogLogoFontSchema = z.strictObject({
  id: z.string().min(1).max(100),
  family: z.string().min(1).max(200),
  mimeType: z.literal("font/ttf"),
  byteLength: z.number().int().min(12).max(LOGO_FONT_UPLOAD_MAX_BYTES),
  rights: fontRightsEvidenceSchema,
  conditions: z.array(z.string().min(1).max(1000)).max(20),
  reservedFontNames: z.array(z.string().min(1).max(200)).max(20),
});
export type CatalogLogoFont = z.infer<typeof catalogLogoFontSchema>;

export const logoInputRequestQuerySchema = z.strictObject({
  cursor: logoUuidSchema.optional(),
  limit: z.number().int().min(1).max(10).default(10),
});
export const logoInputRequestPageSchema = z
  .strictObject({
    ownerId: logoUuidSchema,
    projectId: logoUuidSchema,
    items: z.array(logoInputRequestStateSchema).max(10),
    nextCursor: logoUuidSchema.nullable(),
  })
  .refine(
    (page) =>
      page.items.every(
        (item) => item.status === "pending" && item.ownerId === page.ownerId && item.projectId === page.projectId,
      ) &&
      new Set(page.items.filter((item) => item.status !== "not_found").map((item) => item.requestKey)).size ===
        page.items.length,
    "Request discovery must contain unique pending owned requests.",
  );
export type LogoInputRequestPage = z.infer<typeof logoInputRequestPageSchema>;
