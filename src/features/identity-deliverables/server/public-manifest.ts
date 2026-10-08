import "server-only";
import { z } from "zod";
import type { ApprovedDeliverableSnapshot } from "../../../domain/logo-deliverables";
import { logoHashSchema, logoUuidSchema } from "../../../domain/logo-vector";
import type { PreparedExportFile } from "./export-types";
import { LOGO_MAX_FILE_BYTES, LogoFileError } from "./render-policy";

const FONT_OMISSION_REASON = "Font binaries are not included. Consult the exact font license and source; permitted PDF specimens do not grant redistribution rights.";
const RIGHTS_NOTICE = "Export does not establish exclusive rights, copyright protection, uniqueness or trademark clearance.";
const PRINT_NOTICE = "Logo PDF colors are RGB; no print-profile or PDF/X guarantee is made.";
export const PUBLIC_LOGO_MANIFEST_MAX_BYTES = 131_072;
export const publicLogoExportManifestSchema = z.strictObject({
  version: z.literal(1),
  approvedLogoId: logoUuidSchema, directionApprovalId: logoUuidSchema,
  variantSetId: logoUuidSchema, variantReviewId: logoUuidSchema, sourceSnapshotHash: logoHashSchema,
  files: z.array(z.strictObject({
    name: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/),
    role: z.string().regex(/^(?:(?:primary|horizontal|stacked|symbol_only)\.(?:black|white|color)|guidelines|avatar|banner)$/),
    mimeType: z.enum(["image/svg+xml", "application/pdf", "image/png"]),
    contentHash: logoHashSchema, byteLength: z.number().int().min(1).max(LOGO_MAX_FILE_BYTES),
    variantId: logoUuidSchema.nullable(),
  })).min(1).max(99).refine(files => new Set(files.map(file => file.name)).size === files.length, "Duplicate public file member"),
  licenseOmissions: z.array(z.strictObject({ fontVersionId: logoUuidSchema, reason: z.literal(FONT_OMISSION_REASON) })).max(100).refine(items => new Set(items.map(item => item.fontVersionId)).size === items.length, "Duplicate font omission"),
  notices: z.tuple([z.literal(RIGHTS_NOTICE), z.literal(PRINT_NOTICE)]),
});
export type PublicLogoExportManifest = z.infer<typeof publicLogoExportManifestSchema>;
/** All fields are derived from the frozen snapshot and already validated file membership. */
export function createPublicLogoExportManifest(snapshot: ApprovedDeliverableSnapshot, files: readonly PreparedExportFile[]): PublicLogoExportManifest {
  return publicLogoExportManifestSchema.parse({
    version: 1, approvedLogoId: snapshot.logoApproval.id, directionApprovalId: snapshot.directionApproval.id,
    variantSetId: snapshot.variants.id, variantReviewId: snapshot.variantReview.id, sourceSnapshotHash: snapshot.sourceSnapshotHash,
    files: files.map(file => ({ name: file.name, role: file.role, mimeType: file.mimeType, contentHash: file.contentHash, byteLength: file.bytes.byteLength, variantId: file.sourceVariantId })),
    licenseOmissions: snapshot.fonts.map(font => ({ fontVersionId: font.id, reason: FONT_OMISSION_REASON })),
    notices: [RIGHTS_NOTICE, PRINT_NOTICE],
  });
}
export function serializePublicLogoExportManifest(manifest: PublicLogoExportManifest): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(publicLogoExportManifestSchema.parse(manifest), null, 2));
  if (bytes.byteLength > PUBLIC_LOGO_MANIFEST_MAX_BYTES) throw new LogoFileError("size_limit", "The public export manifest exceeds its byte limit.");
  return bytes;
}
/** Exact canonical bytes also reject duplicate JSON keys or discarded hidden material. */
export function assertPublicLogoExportManifest(bytes: Uint8Array, expected: PublicLogoExportManifest): void {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > PUBLIC_LOGO_MANIFEST_MAX_BYTES) throw new LogoFileError("verification_failed", "The public export manifest is invalid.");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = publicLogoExportManifestSchema.parse(JSON.parse(decoded));
  const expectedBytes = serializePublicLogoExportManifest(expected);
  if (JSON.stringify(parsed) !== JSON.stringify(expected) || !Buffer.from(bytes).equals(Buffer.from(expectedBytes))) throw new LogoFileError("verification_failed", "The public export manifest differs from the exact approved export.");
}
