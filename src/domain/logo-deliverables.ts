import { z } from "zod";
import { ASSET_MAX_FILE_BYTES, assetFileVerificationSchema } from "./asset-library";
import { logoExpectedHeadsSchema } from "./logo-workspace";
import { logoRequestStateSchema, type LogoRequestState } from "./logo-jobs";
import {
  identityDirectionApprovalSchema,
  identityDirectionSelectionSchema,
  identityPaletteVersionSchema,
  identityTypographyVersionSchema,
  identityGraphicsVersionSchema,
  fontRecordSchema,
} from "./logo-directions";
import {
  logoUuidSchema as uuid,
  logoHashSchema as hash,
  logoStringSchema as text,
  logoTimestampSchema as timestamp,
  logoIdentifierSchema as identifier,
  logoScopeShape as scope,
  logoAssetReferenceSchema,
  logoInputRevisionsSchema,
  logoVectorDocumentSchema,
  logoVectorRevisionSchema,
  logoApprovalSchema,
  boundedLogoJson as bounded,
  uniqueLogoValues as unique,
  sameLogoScope,
  logoIssue as issue,
  type LogoVectorDocument,
  type LogoVectorRevision,
} from "./logo-vector";

const verifiedFileObservationSchema = assetFileVerificationSchema.options[0];
export type VerifiedFileObservation = z.infer<typeof verifiedFileObservationSchema>;
export const identityAssetReceiptSchema = bounded(
  z
    .strictObject({
      id: uuid,
      reference: logoAssetReferenceSchema,
      verification: verifiedFileObservationSchema,
      purpose: z.enum(["reference_media", "brand_asset", "input_attachment"]),
      sourceReceiptId: uuid,
      rightsEvidenceId: uuid.nullable(),
      publicationState: z.enum(["staged", "committed"]),
    })
    .refine(
      (v) => v.reference.contentHash === v.verification.contentHash,
      "Verification must bind the exact immutable hash",
    ),
);
export type IdentityAssetReceipt = z.infer<typeof identityAssetReceiptSchema>;
export const committedIdentityAssetReceiptSchema = identityAssetReceiptSchema.refine(
  (v) => v.publicationState === "committed",
  "Only committed receipts may be selected or exported",
);
export const identityAssetPublicationSchema = bounded(
  z.strictObject({
    requestKey: uuid,
    inputRevisions: logoInputRevisionsSchema,
    mimeType: text.min(1).max(150),
    contentHash: hash,
    byteLength: z.number().int().min(1).max(ASSET_MAX_FILE_BYTES),
    source: z.strictObject({
      kind: z.enum(["concept", "vector", "direction", "variant", "export", "identity_system"]),
      sourceId: uuid,
    }),
  }),
);
export type IdentityAssetPublication = z.infer<typeof identityAssetPublicationSchema>;
export const identityUploadIntentSchema = bounded(
  z.strictObject({
    requestKey: uuid,
    usage: z.enum(["logo_reference", "project_attachment", "font"]),
    mimeType: text.min(1).max(150),
    contentHash: hash,
    rightsDeclaration: text.min(1).max(2000),
  }),
);
export type IdentityUploadIntent = z.infer<typeof identityUploadIntentSchema>;
/** A server-only byte projection. Parsing does not perform the actual-byte hash/MIME validation. */
export const verifiedAssetBytesSchema = z
  .strictObject({
    reference: logoAssetReferenceSchema,
    mimeType: text.min(1).max(150),
    bytes: z
      .instanceof(Uint8Array)
      .refine((v) => v.byteLength > 0 && v.byteLength <= ASSET_MAX_FILE_BYTES, "Invalid file size"),
    verification: verifiedFileObservationSchema,
  })
  .refine(
    (v) =>
      v.reference.contentHash === v.verification.contentHash &&
      v.mimeType === v.verification.mimeType &&
      v.bytes.byteLength === v.verification.byteLength,
    "File observation must bind exact metadata and byte length",
  );
export type VerifiedAssetBytes = z.infer<typeof verifiedAssetBytesSchema>;
export const logoVectorDetailSchema = bounded(
  z
    .strictObject({
      revision: logoVectorRevisionSchema,
      document: logoVectorDocumentSchema,
      sourcePreview: committedIdentityAssetReceiptSchema,
    })
    .refine(
      (v) =>
        sameLogoScope(v.revision, v.sourcePreview.reference) &&
        v.revision.sourcePreview.versionId === v.sourcePreview.reference.versionId &&
        v.revision.sourcePreview.assetId === v.sourcePreview.reference.assetId &&
        v.revision.sourcePreview.contentHash === v.sourcePreview.reference.contentHash &&
        v.revision.proof.pathCount === v.document.components.reduce((n, c) => n + c.paths.length, 0) &&
        v.revision.proof.componentCount === v.document.components.length &&
        JSON.stringify(v.revision.proof.viewBox) === JSON.stringify(v.document.viewBox),
      "Vector detail must retain the exact original preview",
    ),
  8_421_376,
);
export type LogoVectorDetail = {
  revision: LogoVectorRevision;
  document: LogoVectorDocument;
  sourcePreview: IdentityAssetReceipt;
};

export const logoVariantSchema = bounded(
  z
    .strictObject({
      id: uuid,
      role: z.enum(["primary", "horizontal", "stacked", "symbol_only"]),
      colorway: z.enum(["black", "white", "color"]),
      documentAsset: logoAssetReferenceSchema.nullable(),
      renderHash: hash.nullable(),
      preview: committedIdentityAssetReceiptSchema.nullable(),
      clearSpace: z.number().min(0).max(1_000_000),
      minimumDigitalSize: z.number().positive().max(16_384).nullable(),
      applicability: z.discriminatedUnion("status", [
        z.strictObject({ status: z.literal("applicable") }),
        z.strictObject({ status: z.literal("not_applicable"), reason: z.enum(["no_symbol", "inseparable_artwork"]) }),
      ]),
      reviewStatus: z.literal("review_required"),
    })
    .superRefine((v, ctx) => {
      if (v.applicability.status === "applicable") {
        if (!v.documentAsset || !v.renderHash || !v.preview)
          issue(ctx, "Applicable variants require document, render hash and committed preview");
        else if (!sameLogoScope(v.documentAsset, v.preview.reference)) issue(ctx, "Variant files must share ownership");
      } else if (v.documentAsset !== null || v.renderHash !== null || v.preview !== null)
        issue(ctx, "Non-applicable variants have no fabricated files");
    }),
);
export type LogoVariant = z.infer<typeof logoVariantSchema>;
export const logoVariantSetSchema = bounded(
  z
    .strictObject({
      id: uuid,
      ...scope,
      approvedLogoId: uuid,
      directionApprovalId: uuid,
      items: z.array(logoVariantSchema).min(1).max(12),
      createdAt: timestamp,
    })
    .refine(
      (v) =>
        unique(v.items.map((i) => i.id)) &&
        unique(v.items.map((i) => `${i.role}:${i.colorway}`)) &&
        v.items.every(
          (i) =>
            (!i.documentAsset || sameLogoScope(v, i.documentAsset)) &&
            (!i.preview || sameLogoScope(v, i.preview.reference)),
        ),
      "Variant sets must contain unique owned role/colorway versions",
    ),
);
export type LogoVariantSet = z.infer<typeof logoVariantSetSchema>;
const resolvedLogoVariantSchema = z
  .strictObject({ variant: logoVariantSchema, document: logoVectorDocumentSchema.nullable() })
  .refine(
    (v) => (v.variant.applicability.status === "applicable") === (v.document !== null),
    "Applicable variants require resolved canonical geometry",
  );
export const resolvedLogoVariantSetSchema = z
  .strictObject({ set: logoVariantSetSchema, items: z.array(resolvedLogoVariantSchema).min(1).max(12) })
  .refine(
    (v) =>
      v.items.length === v.set.items.length &&
      unique(v.items.map((i) => i.variant.id)) &&
      v.items.every((i) => {
        const stored = v.set.items.find((s) => s.id === i.variant.id);
        return stored && JSON.stringify(stored) === JSON.stringify(i.variant);
      }),
    "Resolved variants must match the entire exact stored set",
  );
export type ResolvedLogoVariantSet = z.infer<typeof resolvedLogoVariantSetSchema>;
export const logoVariantReviewSchema = bounded(
  z
    .strictObject({
      id: uuid,
      ...scope,
      variantSetId: uuid,
      approvedLogoId: uuid,
      directionApprovalId: uuid,
      acceptedVariants: z
        .array(z.strictObject({ variantId: uuid, renderHash: hash }))
        .min(1)
        .max(12),
      reviewedAt: timestamp,
    })
    .refine((v) => unique(v.acceptedVariants.map((a) => a.variantId)), "Duplicate reviewed variant"),
);
export type LogoVariantReview = z.infer<typeof logoVariantReviewSchema>;
const socialSelections = z
  .array(z.strictObject({ kind: z.enum(["avatar", "banner"]), presetId: identifier }))
  .max(20)
  .refine((v) => unique(v.map((s) => `${s.kind}:${s.presetId}`)), "Duplicate social selection");
const pngLongEdge = z.union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)]);
export const logoExportIntentSchema = bounded(
  z.strictObject({
    requestKey: uuid,
    expected: logoExpectedHeadsSchema,
    approvedLogoId: uuid,
    directionApprovalId: uuid,
    variantSetId: uuid,
    pngLongEdge,
    socialSelections,
  }),
);
export type LogoExportIntent = z.infer<typeof logoExportIntentSchema>;
/** A durable exact-body tombstone, never a generic HTTP conflict or absence read. */
export const logoExportRejectionSchema = bounded(
  z
    .strictObject({
      status: z.literal("rejected"),
      operation: z.literal("identity.logo_export"),
      ...scope,
      requestKey: uuid,
      input: logoExportIntentSchema,
    })
    .refine((v) => v.requestKey === v.input.requestKey, "Rejection must retain its exact request key"),
  65_536,
);
export type LogoExportRejection = z.infer<typeof logoExportRejectionSchema>;
function equalExportInput(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && equalExportInput(a[key], b[key]))
  );
}
export function matchesLogoExportRejection(
  proof: LogoExportRejection,
  ownerId: string,
  projectId: string,
  input: LogoExportIntent,
): boolean {
  return (
    proof.status === "rejected" &&
    proof.operation === "identity.logo_export" &&
    proof.ownerId === ownerId &&
    proof.projectId === projectId &&
    proof.requestKey === input.requestKey &&
    equalExportInput(proof.input, input)
  );
}

export const logoExportManifestSchema = bounded(
  z
    .strictObject({
      id: uuid,
      ...scope,
      requestKey: uuid,
      approvedLogoId: uuid,
      directionApprovalId: uuid,
      variantSetId: uuid,
      variantReviewId: uuid,
      sourceSnapshotHash: hash,
      files: z
        .array(
          z.strictObject({
            role: text.min(1).max(200),
            format: z.enum(["svg", "pdf", "png", "zip"]),
            variantId: uuid.nullable(),
            asset: committedIdentityAssetReceiptSchema,
          }),
        )
        .min(1)
        .max(100),
      licenseOmissions: z.array(z.strictObject({ fontVersionId: uuid, reason: text.min(1) })).max(100),
      inputRevisions: logoInputRevisionsSchema,
      createdAt: timestamp,
    })
    .superRefine((v, ctx) => {
      const mime = { svg: "image/svg+xml", pdf: "application/pdf", png: "image/png", zip: "application/zip" };
      if (
        v.files.some(
          (f) =>
            !sameLogoScope(v, f.asset.reference) ||
            f.asset.purpose !== "brand_asset" ||
            f.asset.verification.mimeType !== mime[f.format],
        )
      )
        issue(ctx, "Export files must be committed owned brand assets with matching format/MIME");
      if (
        !unique(v.files.map((f) => `${f.role}:${f.format}:${f.variantId}`)) ||
        !unique(v.licenseOmissions.map((f) => f.fontVersionId))
      )
        issue(ctx, "Duplicate export membership");
    }),
  131_072,
);
export type LogoExportManifest = z.infer<typeof logoExportManifestSchema>;
type LogoExportRequestSummary = {
  requestKey: string;
  input: LogoExportIntent;
  state: Exclude<LogoRequestState, { status: "not_found" }>;
  exportManifestId: string | null;
  createdAt: string;
};
export const logoExportRequestSummarySchema: z.ZodType<LogoExportRequestSummary> = bounded(
  z
    .strictObject({
      requestKey: uuid,
      input: logoExportIntentSchema,
      state: z
        .lazy(() => logoRequestStateSchema)
        .refine((v): v is Exclude<LogoRequestState, { status: "not_found" }> => v.status !== "not_found"),
      exportManifestId: uuid.nullable(),
      createdAt: timestamp,
    })
    .refine(
      (v) =>
        v.requestKey === v.input.requestKey &&
        v.state.requestKey === v.requestKey &&
        (!v.state.rejection || equalExportInput(v.state.rejection.input, v.input)),
      "Export recovery must retain the original exact request",
    ),
  262_144,
) as z.ZodType<LogoExportRequestSummary>;
export const logoDeliverablesOverviewSchema = bounded(
  z
    .strictObject({
      ...scope,
      logoApproval: logoApprovalSchema.nullable(),
      directionApproval: identityDirectionApprovalSchema.nullable(),
      variantSets: z.array(logoVariantSetSchema).max(50),
      variantReviews: z.array(logoVariantReviewSchema).max(50),
      exports: z.array(z.strictObject({ manifest: logoExportManifestSchema, stale: z.boolean() })).max(50),
      exportRequests: z.array(logoExportRequestSummarySchema).max(50),
      nextCursor: z.string().min(1).max(2048).nullable(),
      nextRequestCursor: z.string().min(1).max(2048).nullable(),
    })
    .refine(
      (v) =>
        [
          ...v.variantSets,
          ...v.variantReviews,
          ...v.exports.map((e) => e.manifest),
          ...(v.logoApproval ? [v.logoApproval] : []),
          ...(v.directionApproval ? [v.directionApproval] : []),
        ].every((row) => sameLogoScope(v, row)) &&
        v.exportRequests.every(
          (r) =>
            r.state.outputs.every((o) => sameLogoScope(v, o.reference)) &&
            (!r.state.receipt || sameLogoScope(v, r.state.receipt)) &&
            (!r.state.rejection || sameLogoScope(v, r.state.rejection)),
        ),
      "Deliverable reads must retain exact ownership",
    ),
  26_214_400,
);
const snapshotShape = {
  ...scope,
  brandName: text.min(1).max(200),
  heads: logoExpectedHeadsSchema,
  logo: logoVectorRevisionSchema,
  logoDocument: logoVectorDocumentSchema,
  logoApproval: logoApprovalSchema,
  directionSelection: identityDirectionSelectionSchema,
  directionApproval: identityDirectionApprovalSchema,
  palette: identityPaletteVersionSchema,
  typography: identityTypographyVersionSchema,
  graphics: identityGraphicsVersionSchema,
  fonts: z.array(fontRecordSchema).max(100),
};
export const approvedLogoIdentitySnapshotSchema = z.strictObject(snapshotShape).superRefine((v, ctx) => {
  if (
    [v.logo, v.logoApproval, v.directionSelection, v.directionApproval, v.palette, v.typography, v.graphics].some(
      (r) => !sameLogoScope(v, r),
    ) ||
    v.fonts.some((f) => !sameLogoScope(v, f.asset))
  )
    issue(ctx, "Approved snapshot must contain only owned immutable sources");
  if (
    v.logoApproval.vectorRevisionId !== v.logo.id ||
    v.directionSelection.approvedLogoId !== v.logoApproval.id ||
    v.directionApproval.approvedLogoId !== v.logoApproval.id ||
    v.directionApproval.directionSelectionId !== v.directionSelection.id ||
    v.directionApproval.consistencyHash !== v.directionSelection.consistency.hash ||
    v.palette.id !== v.directionSelection.paletteVersionId ||
    v.typography.id !== v.directionSelection.typographyVersionId ||
    v.graphics.id !== v.directionSelection.graphicsVersionId ||
    [v.palette, v.typography, v.graphics].some((r) => r.approvedLogoId !== v.logoApproval.id)
  )
    issue(ctx, "Approvals must bind exact logo, selection, components and consistency");
});
export type ApprovedLogoIdentitySnapshot = z.infer<typeof approvedLogoIdentitySnapshotSchema>;
