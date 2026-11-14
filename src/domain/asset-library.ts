import { z } from "zod";
import { assetFormatSchema } from "./assets";
import { projectScopeSchema } from "./projects";

const ASSET_LIBRARY_DEFAULT_PAGE_SIZE = 40;
const ASSET_LIBRARY_MAX_PAGE_SIZE = 100;
const ASSET_LIBRARY_PREVIEW_COUNT = 4;
export const ASSET_LIBRARY_MUTATION_MAX_BYTES = 32_768;
export const ASSET_MAX_FILE_BYTES = 52_428_800;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ownerProject = { ownerId: z.uuid(), projectId: z.uuid() };
const assetScope = { ...ownerProject, assetId: z.uuid() };
const mimeType = z.string().min(1).max(150);
function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const sameScope = (a: { ownerId: string; projectId: string }, b: { ownerId: string; projectId: string }) =>
  a.ownerId === b.ownerId && a.projectId === b.projectId;
const sameAsset = (
  a: { ownerId: string; projectId: string; assetId: string },
  b: { ownerId: string; projectId: string; assetId: string },
) => sameScope(a, b) && a.assetId === b.assetId;
const mimeBase = (value: string) => value.split(";", 1)[0]!.trim().toLowerCase();

/** Authoritative purpose is never inferred from the arbitrary legacy kind label. */
const assetPurposeSchema = z.enum(["brand_asset", "reference_media", "legacy_unknown"]);
const assetLibraryTabSchema = z.enum(["my_selection", "all_generations"]);
export const assetFileTypeSchema = z.enum([...assetFormatSchema.options, "other"]);
type AssetFileType = z.infer<typeof assetFileTypeSchema>;
export function assetFormatFromMime(value: string): AssetFileType {
  const formats: Readonly<Record<string, AssetFileType>> = {
    "image/svg+xml": "svg",
    "image/png": "png",
    "image/webp": "webp",
    "image/jpeg": "jpeg",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/json": "json",
  };
  const key = mimeBase(mimeType.parse(value));
  return Object.hasOwn(formats, key) ? formats[key]! : "other";
}

/** Metadata reference only: neither file-integrity nor origin/rights evidence. Kept extendable. */
export const assetVersionReferenceSchema = z.strictObject({ ...assetScope, versionId: z.uuid(), contentHash: hash });
export type AssetVersionReference = z.infer<typeof assetVersionReferenceSchema>;
/** Existing rows have no trusted creation receipt, regardless of the shape of their raw JSON. */
const assetProvenanceSchema = z.strictObject({ status: z.literal("legacy_unverified") });
const assetFileStateSchema = z.enum(["metadata_only", "unverified", "verified", "missing_or_invalid"]);
export const assetFileVerificationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("verified"),
    checkedAt: timestamp,
    contentHash: hash,
    mimeType,
    byteLength: z.number().int().positive().max(ASSET_MAX_FILE_BYTES),
  }),
  z.strictObject({ status: z.literal("missing_or_invalid"), checkedAt: timestamp }),
]);
const assetFreshnessSchema = z
  .strictObject({
    basis: z.literal("revision_only"),
    status: z.enum(["unknown", "stale"]),
    inputRevision: revision,
    currentProjectRevision: revision,
    reasons: z
      .array(z.enum(["project_revision_changed", "material_basis_unavailable"]))
      .min(1)
      .max(2),
  })
  .superRefine((value, ctx) => {
    const changed = value.inputRevision !== value.currentProjectRevision;
    const expected = changed
      ? ["project_revision_changed", "material_basis_unavailable"]
      : ["material_basis_unavailable"];
    if (
      value.inputRevision > value.currentProjectRevision ||
      value.status !== (changed ? "stale" : "unknown") ||
      JSON.stringify(value.reasons) !== JSON.stringify(expected)
    )
      ctx.addIssue({
        code: "custom",
        message: "Legacy freshness reports only revision comparison and unknown material basis",
      });
  })
  .transform(freeze);
type AssetFreshness = z.infer<typeof assetFreshnessSchema>;
export function assetRevisionFreshness(inputRevision: number, currentProjectRevision: number): AssetFreshness {
  const changed = inputRevision !== currentProjectRevision;
  return assetFreshnessSchema.parse({
    basis: "revision_only",
    status: changed ? "stale" : "unknown",
    inputRevision,
    currentProjectRevision,
    reasons: changed ? ["project_revision_changed", "material_basis_unavailable"] : ["material_basis_unavailable"],
  });
}
export const assetVersionDetailSchema = z
  .strictObject({
    ...assetVersionReferenceSchema.shape,
    versionNumber: revision,
    inputRevision: revision,
    inputHash: hash,
    createdAt: timestamp,
    mimeType,
    format: assetFileTypeSchema,
    provenance: assetProvenanceSchema,
    vectorStatus: z.literal("unverified"),
    licenseStatus: z.literal("unverified"),
    fileState: assetFileStateSchema,
    fileVerification: assetFileVerificationSchema.nullable(),
    freshness: assetFreshnessSchema,
  })
  .superRefine((value, ctx) => {
    const parsedMime = mimeType.safeParse(value.mimeType);
    if (parsedMime.success && value.format !== assetFormatFromMime(parsedMime.data))
      ctx.addIssue({
        code: "custom",
        path: ["format"],
        message: "Format must describe the recorded MIME type, including unknown types",
      });
    if (value.freshness.inputRevision !== value.inputRevision)
      ctx.addIssue({
        code: "custom",
        path: ["freshness"],
        message: "Freshness must bind this immutable input revision",
      });
    const check = value.fileVerification;
    if (check ? check.status !== value.fileState : !["metadata_only", "unverified"].includes(value.fileState))
      ctx.addIssue({
        code: "custom",
        path: ["fileVerification"],
        message: "A file-integrity result requires its actual verification observation",
      });
    if (
      check?.status === "verified" &&
      (check.contentHash !== value.contentHash || mimeBase(check.mimeType) !== mimeBase(value.mimeType))
    )
      ctx.addIssue({
        code: "custom",
        path: ["fileVerification"],
        message: "Verified bytes must match the immutable hash and MIME manifest",
      });
  })
  .transform(freeze);
export type AssetVersionDetail = z.infer<typeof assetVersionDetailSchema>;
function sameVersion(a: AssetVersionDetail, b: AssetVersionDetail): boolean {
  // Zod canonicalizes property order. Every projection of one version in the
  // same response must include the same metadata and integrity observation.
  return JSON.stringify(a) === JSON.stringify(b);
}

const assetSelectionReceiptSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("legacy_unverified") }),
  z.strictObject({
    status: z.literal("recorded"),
    projectRevision: revision,
    acceptedStaleBasis: z.boolean(),
    previousSelectionId: z.uuid().nullable(),
  }),
]);
const assetSelectionSchema = z
  .strictObject({
    id: z.uuid(),
    ...assetScope,
    versionId: z.uuid(),
    reason: z.enum(["selected", "restored"]),
    createdAt: timestamp,
    receipt: assetSelectionReceiptSchema,
  })
  .refine((value) => value.receipt.status !== "recorded" || value.receipt.previousSelectionId !== value.id, {
    message: "A selection receipt cannot point to itself",
  })
  .transform(freeze);
export const assetRecordSchema = z
  .strictObject({
    id: z.uuid(),
    ...ownerProject,
    kind: z.string().min(1).max(64),
    purpose: assetPurposeSchema,
    createdAt: timestamp,
    versionCount: counter,
    retentionRevision: counter,
    liked: z.boolean(),
    saved: z.boolean(),
    usage: z.strictObject({ active: z.boolean(), legacy: z.boolean() }),
    selectionRevision: counter,
    currentSelection: assetSelectionSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const selected = value.currentSelection;
    if (
      selected
        ? value.selectionRevision === 0 ||
          value.versionCount === 0 ||
          !sameAsset({ ...value, assetId: value.id }, selected)
        : value.selectionRevision !== 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["currentSelection"],
        message: "Selection head must bind the exact owned asset and its revision",
      });
    if (
      selected?.receipt.status === "recorded" &&
      (value.selectionRevision === 1) !== (selected.receipt.previousSelectionId === null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["currentSelection"],
        message: "Recorded selection revisions must retain their actual predecessor",
      });
    if (value.usage.active && value.versionCount === 0)
      ctx.addIssue({ code: "custom", path: ["usage"], message: "Active brand use requires a real immutable version" });
  })
  .transform(freeze);
export type AssetRecord = z.infer<typeof assetRecordSchema>;
export function isAssetRetained(value: Pick<AssetRecord, "liked" | "saved" | "usage">): boolean {
  return value.liked || value.saved || value.usage.active || value.usage.legacy;
}
/** Preserve all valid foundation titles; the narrower new-project write limit is separate. */
export const assetProjectSummarySchema = z.strictObject({
  id: z.uuid(),
  owner_id: z.uuid(),
  title: z.string().min(1).max(200),
  scope: projectScopeSchema,
  current_revision: revision,
  created_at: timestamp,
});
export type AssetProjectSummary = z.infer<typeof assetProjectSummarySchema>;

const assetLibraryCursorSchema = z.strictObject({
  createdAt: timestamp,
  assetId: z.uuid(),
  tab: assetLibraryTabSchema,
  projectId: z.uuid().nullable(),
  format: assetFileTypeSchema.nullable(),
});
export type AssetLibraryCursor = z.infer<typeof assetLibraryCursorSchema>;
const assetVersionCursorSchema = z.strictObject({
  createdAt: timestamp,
  versionId: z.uuid(),
  assetId: z.uuid(),
  projectId: z.uuid(),
  format: assetFileTypeSchema.nullable(),
});
export const assetLibraryQuerySchema = z
  .strictObject({
    tab: assetLibraryTabSchema.default("my_selection"),
    projectId: z.uuid().optional(),
    format: assetFileTypeSchema.optional(),
    cursor: assetLibraryCursorSchema.optional(),
    limit: z.number().int().min(1).max(ASSET_LIBRARY_MAX_PAGE_SIZE).default(ASSET_LIBRARY_DEFAULT_PAGE_SIZE),
  })
  .refine(
    (value) =>
      !value.cursor ||
      (value.cursor.tab === value.tab &&
        value.cursor.projectId === (value.projectId ?? null) &&
        value.cursor.format === (value.format ?? null)),
    { message: "Continuation cursor must retain its exact library filters", path: ["cursor"] },
  );
export type AssetLibraryQuery = z.infer<typeof assetLibraryQuerySchema>;
export const assetDetailQuerySchema = z
  .strictObject({
    format: assetFileTypeSchema.optional(),
    cursor: assetVersionCursorSchema.optional(),
    limit: z.number().int().min(1).max(ASSET_LIBRARY_MAX_PAGE_SIZE).default(ASSET_LIBRARY_DEFAULT_PAGE_SIZE),
  })
  .refine((value) => !value.cursor || value.cursor.format === (value.format ?? null), {
    message: "Version cursor must retain its exact format filter",
    path: ["cursor"],
  });
export type AssetDetailQuery = z.infer<typeof assetDetailQuerySchema>;
export const assetVersionPageSchema = z
  .strictObject({
    ...assetScope,
    format: assetFileTypeSchema.nullable(),
    items: z.array(assetVersionDetailSchema).max(ASSET_LIBRARY_MAX_PAGE_SIZE),
    totalCount: counter,
    nextCursor: assetVersionCursorSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.items.length > value.totalCount ||
      new Set(value.items.map((row) => row.versionId)).size !== value.items.length ||
      value.items.some((row) => !sameAsset(value, row) || (value.format !== null && value.format !== row.format))
    )
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Version page must contain unique matching versions of this owned asset",
      });
    const cursor = value.nextCursor,
      last = value.items.at(-1);
    if (
      cursor &&
      (!last ||
        value.items.length === value.totalCount ||
        cursor.assetId !== value.assetId ||
        cursor.projectId !== value.projectId ||
        cursor.format !== value.format ||
        cursor.versionId !== last.versionId ||
        cursor.createdAt !== last.createdAt)
    )
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "Version continuation requires remaining history and must bind its last row, owned asset and format",
      });
  });
type AssetVersionPage = z.infer<typeof assetVersionPageSchema>;

const metadataFields = { asset: assetRecordSchema, project: assetProjectSummarySchema };
const detailFields = {
  ...metadataFields,
  selectedVersion: assetVersionDetailSchema.nullable(),
  versions: assetVersionPageSchema,
};
function checkMetadata(value: { asset: AssetRecord; project: AssetProjectSummary }, ctx: z.RefinementCtx): void {
  if (
    value.asset.ownerId !== value.project.owner_id ||
    value.asset.projectId !== value.project.id ||
    value.asset.purpose === "reference_media"
  )
    ctx.addIssue({
      code: "custom",
      message: "Assets library metadata must bind one owned brand asset or explicit legacy record",
    });
  if (
    value.asset.currentSelection?.receipt.status === "recorded" &&
    value.asset.currentSelection.receipt.projectRevision > value.project.current_revision
  )
    ctx.addIssue({ code: "custom", message: "A recorded selection must refer to a saved project revision" });
}
function checkVersions(
  value: { asset: AssetRecord; project: AssetProjectSummary; selectedVersion: AssetVersionDetail | null },
  versions: AssetVersionPage,
  ctx: z.RefinementCtx,
): void {
  checkMetadata(value, ctx);
  const scope = { ownerId: value.asset.ownerId, projectId: value.asset.projectId, assetId: value.asset.id };
  if (
    !sameAsset(scope, versions) ||
    versions.totalCount > value.asset.versionCount ||
    (versions.format === null && versions.totalCount !== value.asset.versionCount)
  )
    ctx.addIssue({ code: "custom", message: "Version history must match the owned asset and its actual total" });
  const selected = value.selectedVersion,
    head = value.asset.currentSelection;
  if (selected ? !head || head.versionId !== selected.versionId || !sameAsset(scope, selected) : head !== null)
    ctx.addIssue({
      code: "custom",
      path: ["selectedVersion"],
      message: "Selected version is independent from previews and must match its head",
    });
  const selectedMatches = selected !== null && (versions.format === null || versions.format === selected.format);
  const knownMatchingIds = new Set(versions.items.map((row) => row.versionId));
  if (selectedMatches) knownMatchingIds.add(selected!.versionId);
  if (
    knownMatchingIds.size > versions.totalCount ||
    (selected && !selectedMatches && versions.totalCount >= value.asset.versionCount)
  )
    ctx.addIssue({
      code: "custom",
      path: ["selectedVersion"],
      message: "A separate selected version must fit the actual matching and complete history counts",
    });
  if (selected && versions.items.some((row) => row.versionId === selected.versionId && !sameVersion(row, selected)))
    ctx.addIssue({
      code: "custom",
      path: ["selectedVersion"],
      message: "The selected version must agree with its repeated immutable metadata",
    });
  if (
    [...versions.items, ...(selected ? [selected] : [])].some(
      (row) => row.freshness.currentProjectRevision !== value.project.current_revision,
    )
  )
    ctx.addIssue({ code: "custom", message: "Freshness must describe the returned current project revision" });
  if (selected && head?.receipt.status === "recorded" && selected.inputRevision > head.receipt.projectRevision)
    ctx.addIssue({
      code: "custom",
      message: "Selected output cannot originate after its selection's recorded input context",
    });
  if (
    selected &&
    head?.receipt.status === "recorded" &&
    selected.inputRevision < head.receipt.projectRevision &&
    !head.receipt.acceptedStaleBasis
  )
    ctx.addIssue({
      code: "custom",
      message: "A selection that used an older input revision must preserve its explicit acknowledgment",
    });
}
export const assetDetailSchema = z
  .strictObject(detailFields)
  .superRefine((value, ctx) => checkVersions(value, value.versions, ctx));
export type AssetDetail = z.infer<typeof assetDetailSchema>;
export const assetLibraryItemSchema = z
  .strictObject({
    ...metadataFields,
    selectedVersion: assetVersionDetailSchema.nullable(),
    displayedVersion: assetVersionDetailSchema.nullable(),
    matchingVersions: assetVersionPageSchema,
  })
  .superRefine((value, ctx) => {
    const page = value.matchingVersions;
    checkVersions(value, page, ctx);
    if (page.items.length > ASSET_LIBRARY_PREVIEW_COUNT || (page.totalCount > 0 && page.items.length === 0))
      ctx.addIssue({
        code: "custom",
        path: ["matchingVersions"],
        message: "A library card carries the bounded first matching-version page",
      });
    if ((page.nextCursor !== null) !== page.totalCount > page.items.length)
      ctx.addIssue({
        code: "custom",
        path: ["matchingVersions", "nextCursor"],
        message: "First-page continuation must describe every remaining matching version",
      });
    const preferred =
      value.selectedVersion && (page.format === null || value.selectedVersion.format === page.format)
        ? value.selectedVersion
        : (page.items[0] ?? null);
    const displayed = value.displayedVersion;
    if (
      displayed
        ? !preferred ||
          !sameVersion(displayed, preferred) ||
          displayed.freshness.currentProjectRevision !== value.project.current_revision
        : preferred !== null
    )
      ctx.addIssue({
        code: "custom",
        path: ["displayedVersion"],
        message: "Preview is the matching current selection or newest matching version; it never changes selection",
      });
  });
export type AssetLibraryItem = z.infer<typeof assetLibraryItemSchema>;
export const assetLibraryPageSchema = z
  .strictObject({
    ownerId: z.uuid(),
    query: assetLibraryQuerySchema,
    items: z.array(assetLibraryItemSchema).max(ASSET_LIBRARY_MAX_PAGE_SIZE),
    nextCursor: assetLibraryCursorSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const query = value.query;
    if (
      value.items.length > query.limit ||
      new Set(value.items.map((row) => row.asset.id)).size !== value.items.length ||
      value.items.some(
        (row) =>
          row.asset.ownerId !== value.ownerId ||
          (query.projectId !== undefined && row.asset.projectId !== query.projectId) ||
          row.matchingVersions.format !== (query.format ?? null) ||
          (query.format !== undefined && row.matchingVersions.totalCount === 0) ||
          (query.tab === "my_selection" && !isAssetRetained(row.asset)),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Library rows must satisfy the owned, deduplicated logical-asset query",
      });
    const cursor = value.nextCursor,
      last = value.items.at(-1)?.asset;
    if (
      cursor &&
      (!last ||
        cursor.assetId !== last.id ||
        cursor.createdAt !== last.createdAt ||
        cursor.tab !== query.tab ||
        cursor.projectId !== (query.projectId ?? null) ||
        cursor.format !== (query.format ?? null))
    )
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "Library continuation must bind the last asset and exact filters",
      });
  });
export type AssetLibraryPage = z.infer<typeof assetLibraryPageSchema>;

export const setAssetRetentionSchema = z.strictObject({
  expectedRetentionRevision: counter,
  liked: z.boolean(),
  saved: z.boolean(),
});
export type SetAssetRetention = z.infer<typeof setAssetRetentionSchema>;
export const selectAssetVersionSchema = z.strictObject({
  versionId: z.uuid(),
  expectedProjectRevision: revision,
  expectedSelectionRevision: counter,
  acceptStaleBasis: z.boolean(),
});
export type SelectAssetVersion = z.infer<typeof selectAssetVersionSchema>;
/** Neutral response: clients refresh their active filtered card/page rather than reusing invented query metadata. */
export const assetRetentionResponseSchema = z.strictObject(metadataFields).superRefine(checkMetadata);
/** Mutation returns the unfiltered detail page; previous immutable selections remain unchanged. */
export const assetSelectionResponseSchema = assetDetailSchema.superRefine((value, ctx) => {
  const receipt = value.asset.currentSelection?.receipt;
  if (
    value.versions.format !== null ||
    !value.selectedVersion ||
    !receipt ||
    receipt.status !== "recorded" ||
    receipt.projectRevision !== value.project.current_revision ||
    (value.selectedVersion.freshness.status === "stale" && !receipt.acceptedStaleBasis)
  )
    ctx.addIssue({
      code: "custom",
      message: "New selection must record its current revision, exact choice and required stale acknowledgment",
    });
});
