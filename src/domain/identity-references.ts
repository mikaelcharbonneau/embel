import { z } from "zod";
import { assetVersionReferenceSchema } from "./asset-library";

export const referenceElements = ["logo", "typography", "colors", "graphics", "images", "composition"] as const;
export const referenceElementSchema = z.enum(referenceElements);
export type ReferenceElement = z.infer<typeof referenceElementSchema>;
export const MAX_IDENTITY_REFERENCE_SELECTION = 100;
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const selectedReferenceCount = z.number().int().min(0).max(MAX_IDENTITY_REFERENCE_SELECTION);
const timestamp = z.iso.datetime({ offset: true });
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// Match PostgreSQL COLLATE C for valid Unicode: scalar value order, not UTF-16
// code-unit order (which differs for astral characters and high-BMP tags).
const compareTags = (a: string, b: string) => {
  const left = Array.from(a, (character) => character.codePointAt(0)!),
    right = Array.from(b, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
};
const uniqueElements = z
  .array(referenceElementSchema)
  .max(referenceElements.length)
  .superRefine((elements, ctx) => {
    if (new Set(elements).size !== elements.length)
      ctx.addIssue({ code: "custom", message: "Reference elements must be unique" });
  })
  .transform((elements) => referenceElements.filter((element) => elements.includes(element)));
const tagSet = (maximum: number) =>
  z
    .array(z.string().trim().min(1).max(80))
    .max(maximum)
    .superRefine((values, ctx) => {
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: "custom", message: "Reference tags must be unique" });
    })
    .transform((values) => [...values].sort(compareTags));
const tags = tagSet(50);
// 100 page rows × 50 tags, 50 active exclusions and 50 real suggestions.
// This bounds a response, never the number of persisted project tags.
const responseTags = tagSet(5100);
/** Conservative stored URL grammar shared with SQL, not a WHATWG/IDNA parser.
 * International hosts (including ACE/punycode), IPv6 and unusual numeric hosts
 * are unsupported; international path/query text must be percent encoded. */
function validAttributionUrl(value: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes("\\") || /%(?![0-9a-f]{2})/i.test(value)) return false;
  const parts = /^(https?):\/\/([^/?#]+)([/?#].*)?$/i.exec(value);
  const authority = parts && /^([^:]+)(?::([1-9][0-9]{0,4}))?$/.exec(parts[2]!);
  if (!authority || (authority[2] && Number(authority[2]) > 65535)) return false;
  const host = authority[1]!,
    labels = host.split(".");
  if (host.length > 253) return false;
  if (/^[0-9.]+$/.test(host)) {
    if (labels.length !== 4 || labels.some((label) => !/^(0|[1-9][0-9]{0,2})$/.test(label) || Number(label) > 255))
      return false;
  } else if (
    !/^[a-z]/i.test(labels.at(-1)!) ||
    labels.some(
      (label) =>
        label.length > 63 ||
        label.toLowerCase().startsWith("xn--") ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )
  )
    return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
const attributionUrl = z
  .string()
  .trim()
  .max(2048)
  .refine(
    validAttributionUrl,
    "Attribution requires an HTTP(S) ASCII DNS/IPv4 URL with an optional valid port and encoded international text",
  );

/** Metadata binding only. A preview/download still independently verifies the real private bytes. */
export const identityReferenceMediaSchema = assetVersionReferenceSchema.extend({
  purpose: z.literal("reference_media"),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
});
export type IdentityReferenceMedia = z.infer<typeof identityReferenceMediaSchema>;
export const referenceAttributionSchema = z.strictObject({
  label: z.string().trim().min(1).max(240),
  creator: z.string().trim().min(1).max(240).nullable(),
  sourceUrl: attributionUrl.nullable(),
  rightsNote: z.string().trim().min(1).max(2000).nullable(),
});

/** Created by a trusted source constructor; changing media or metadata requires a new reference ID. */
export const identityReferenceSchema = z
  .strictObject({
    id: z.uuid(),
    ownerId: z.uuid(),
    projectId: z.uuid(),
    createdAt: timestamp,
    media: identityReferenceMediaSchema,
    source: z.enum(["user_supplied", "attributed_catalog"]),
    // A URL or rights note is attribution, never proof of fetching, licensing or catalog verification.
    attribution: referenceAttributionSchema,
    relevantElements: uniqueElements,
    tags,
  })
  .superRefine((value, ctx) => {
    if (value.media.ownerId !== value.ownerId || value.media.projectId !== value.projectId)
      ctx.addIssue({
        code: "custom",
        path: ["media"],
        message: "Reference media must belong to the same owner and project",
      });
  });
export type IdentityReference = z.infer<typeof identityReferenceSchema>;

export const setReferenceReactionSchema = z.strictObject({
  expectedRevision: revision,
  ensemble: z.boolean(),
  elements: uniqueElements,
});
export type SetReferenceReaction = z.infer<typeof setReferenceReactionSchema>;
export const referenceReactionSchema = z
  .strictObject({
    referenceId: z.uuid(),
    ownerId: z.uuid(),
    projectId: z.uuid(),
    revision,
    ensemble: z.boolean(),
    elements: uniqueElements,
    updatedAt: timestamp.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.revision === 0
        ? value.ensemble || value.elements.length > 0 || value.updatedAt !== null
        : value.updatedAt === null
    )
      ctx.addIssue({
        code: "custom",
        message: "Revision zero is an untouched reaction; later revisions require a timestamp",
      });
  });
export type ReferenceReaction = z.infer<typeof referenceReactionSchema>;
export const identityReferenceEntrySchema = z
  .strictObject({ reference: identityReferenceSchema, reaction: referenceReactionSchema })
  .superRefine((value, ctx) => {
    const { reference, reaction } = value;
    if (
      reaction.ownerId !== reference.ownerId ||
      reaction.projectId !== reference.projectId ||
      reaction.referenceId !== reference.id
    )
      ctx.addIssue({
        code: "custom",
        path: ["reaction"],
        message: "Reaction must belong to this exact owned project reference",
      });
    if (reaction.elements.some((element) => !reference.relevantElements.includes(element)))
      ctx.addIssue({
        code: "custom",
        path: ["reaction", "elements"],
        message: "Only declared relevant elements may be selected",
      });
  });
export type IdentityReferenceEntry = z.infer<typeof identityReferenceEntrySchema>;

/** Pure transition only. The later DAL must enforce this same expected revision under a DB lock. */
export function applyReferenceReaction(args: {
  actorId: string;
  projectId: string;
  reference: unknown;
  current: unknown;
  input: unknown;
  now: string;
}): ReferenceReaction {
  const reference = identityReferenceSchema.parse(args.reference),
    input = setReferenceReactionSchema.parse(args.input);
  if (reference.ownerId !== args.actorId || reference.projectId !== args.projectId)
    throw new Error("Reference not found");
  const current =
    args.current === null
      ? referenceReactionSchema.parse({
          referenceId: reference.id,
          ownerId: args.actorId,
          projectId: args.projectId,
          revision: 0,
          ensemble: false,
          elements: [],
          updatedAt: null,
        })
      : referenceReactionSchema.parse(args.current);
  identityReferenceEntrySchema.parse({ reference, reaction: current });
  if (current.revision !== input.expectedRevision) throw new Error("Reference reaction conflict");
  return identityReferenceEntrySchema.parse({
    reference,
    reaction: {
      ...current,
      revision: current.revision + 1,
      ensemble: input.ensemble,
      elements: input.elements,
      updatedAt: args.now,
    },
  }).reaction;
}

export const identityReferenceCursorSchema = z.strictObject({
  projectId: z.uuid(),
  createdAt: timestamp,
  referenceId: z.uuid(),
  excludedTags: tags,
});
export const identityReferenceQuerySchema = z
  .strictObject({
    limit: z.number().int().min(1).max(100).default(40),
    cursor: identityReferenceCursorSchema.optional(),
    excludedTags: tags.default([]),
  })
  .refine(
    (value) => !value.cursor || JSON.stringify(value.cursor.excludedTags) === JSON.stringify(value.excludedTags),
    {
      path: ["cursor"],
      message: "A reference continuation must retain its exact exclusion filters",
    },
  );
export type IdentityReferenceQuery = z.infer<typeof identityReferenceQuerySchema>;
/** Validate coverage against an authoritative response. SQL must admit exclusions
 * against all persisted tags, not merely this bounded suggestions/page union. */
export function validateIdentityReferenceQuery(
  input: unknown,
  availableTags: unknown,
  projectId: string,
): IdentityReferenceQuery {
  const query = identityReferenceQuerySchema.parse(input),
    known = new Set(responseTags.parse(availableTags));
  z.uuid().parse(projectId);
  if (query.cursor && query.cursor.projectId !== projectId)
    throw new Error("Reference cursor belongs to another project");
  if (query.excludedTags.some((tag) => !known.has(tag))) throw new Error("Unknown reference exclusion tag");
  return query;
}
export const referenceFeedAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available") }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.literal("reference_source_unconfigured") }),
]);
const pageShape = { nextCursor: identityReferenceCursorSchema.nullable() };
const referencePageSchema = z.strictObject({ items: z.array(identityReferenceSchema).max(100), ...pageShape });
const referenceEntryPageSchema = z.strictObject({
  items: z.array(identityReferenceEntrySchema).max(100),
  ...pageShape,
});
function checkPage(
  value: { ownerId: string; projectId: string; query: IdentityReferenceQuery; availableTags: string[] },
  references: IdentityReference[],
  cursor: z.infer<typeof identityReferenceCursorSchema> | null,
  ctx: z.RefinementCtx,
) {
  if (references.some((reference) => reference.ownerId !== value.ownerId || reference.projectId !== value.projectId))
    ctx.addIssue({ code: "custom", message: "Reference page must belong to the verified owner and project" });
  if (new Set(references.map((reference) => reference.id)).size !== references.length)
    ctx.addIssue({ code: "custom", message: "Reference page must contain unique reference IDs" });
  if (references.some((reference) => reference.tags.some((tag) => !value.availableTags.includes(tag))))
    ctx.addIssue({ code: "custom", message: "Reference tags must come from actual source metadata" });
  const query = value.query;
  if (
    references.length > query.limit ||
    (query.cursor && query.cursor.projectId !== value.projectId) ||
    query.excludedTags.some((tag) => !value.availableTags.includes(tag)) ||
    references.some((reference) => reference.tags.some((tag) => query.excludedTags.includes(tag)))
  )
    ctx.addIssue({
      code: "custom",
      message: "Reference rows must satisfy the validated project, exclusions and page limit",
    });
  const last = references.at(-1);
  if (
    cursor &&
    (!last ||
      cursor.projectId !== value.projectId ||
      cursor.referenceId !== last.id ||
      cursor.createdAt !== last.createdAt)
  )
    ctx.addIssue({ code: "custom", message: "Reference cursor must identify this project's last returned reference" });
  if (cursor && JSON.stringify(cursor.excludedTags) !== JSON.stringify(query.excludedTags))
    ctx.addIssue({ code: "custom", message: "Reference continuation must retain the validated query's exclusions" });
}
export const referenceSourceResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable"), reason: z.literal("reference_source_unconfigured") }),
  z
    .strictObject({
      status: z.literal("available"),
      ownerId: z.uuid(),
      projectId: z.uuid(),
      query: identityReferenceQuerySchema,
      availableTags: responseTags,
      tagsComplete: z.boolean(),
      references: referencePageSchema,
    })
    .superRefine((value, ctx) => checkPage(value, value.references.items, value.references.nextCursor, ctx)),
]);
export type ReferenceSourceResult = z.infer<typeof referenceSourceResultSchema>;
export const identityReferencesOverviewSchema = z
  .strictObject({
    ownerId: z.uuid(),
    projectId: z.uuid(),
    query: identityReferenceQuerySchema,
    referenceRevision: revision,
    selectedReferenceCount,
    feed: referenceFeedAvailabilitySchema,
    availableTags: responseTags,
    tagsComplete: z.boolean(),
    references: referenceEntryPageSchema,
  })
  .superRefine((value, ctx) => {
    checkPage(
      value,
      value.references.items.map((item) => item.reference),
      value.references.nextCursor,
      ctx,
    );
    if (value.references.items.some((item) => item.reaction.revision > value.referenceRevision))
      ctx.addIssue({ code: "custom", message: "A reaction cannot be newer than the project reference revision" });
    if (
      value.references.items.filter((item) => item.reaction.ensemble || item.reaction.elements.length).length >
      value.selectedReferenceCount
    )
      ctx.addIssue({
        code: "custom",
        message: "A page cannot contain more selections than the authoritative project count",
      });
  });
export type IdentityReferencesOverview = z.infer<typeof identityReferencesOverviewSchema>;

/** A neutral CAS receipt; the caller refreshes its own current filtered page. */
export const setReferenceReactionResponseSchema = z
  .strictObject({
    ownerId: z.uuid(),
    projectId: z.uuid(),
    referenceRevision: revision,
    selectedReferenceCount,
    entry: identityReferenceEntrySchema,
  })
  .superRefine((value, ctx) => {
    if (value.entry.reference.ownerId !== value.ownerId || value.entry.reference.projectId !== value.projectId)
      ctx.addIssue({ code: "custom", message: "Reaction receipt must belong to this exact owner and project" });
    if (value.entry.reaction.revision > value.referenceRevision || value.entry.reaction.revision === 0)
      ctx.addIssue({
        code: "custom",
        message: "An accepted reaction requires a recorded revision within the aggregate",
      });
    if (
      (value.entry.reaction.ensemble || value.entry.reaction.elements.length > 0) &&
      value.selectedReferenceCount === 0
    )
      ctx.addIssue({ code: "custom", message: "A selected entry requires a nonzero authoritative selection count" });
  });
export type SetReferenceReactionResponse = z.infer<typeof setReferenceReactionResponseSchema>;

/** The complete selected set, read atomically at admission, not one page of a discovery feed. */
export const identityReferenceSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    ownerId: z.uuid(),
    projectId: z.uuid(),
    referenceRevision: revision,
    selectedReferenceCount,
    capturedAt: timestamp,
    selected: z.array(identityReferenceEntrySchema).max(MAX_IDENTITY_REFERENCE_SELECTION),
  })
  .superRefine((value, ctx) => {
    if (value.selectedReferenceCount !== value.selected.length)
      ctx.addIssue({ code: "custom", message: "A snapshot requires the full authoritative selected-reference set" });
    if (new Set(value.selected.map((item) => item.reference.id)).size !== value.selected.length)
      ctx.addIssue({ code: "custom", message: "A reference snapshot cannot repeat a reference" });
    for (const item of value.selected) {
      if (item.reference.ownerId !== value.ownerId || item.reference.projectId !== value.projectId)
        ctx.addIssue({ code: "custom", message: "Snapshot entries must belong to this owner and project" });
      if (!item.reaction.ensemble && !item.reaction.elements.length)
        ctx.addIssue({
          code: "custom",
          message: "Snapshot entries must have an explicit Ensemble or element selection",
        });
      if (item.reaction.revision > value.referenceRevision)
        ctx.addIssue({ code: "custom", message: "A captured reaction cannot be newer than the snapshot revision" });
    }
  })
  .transform((value) => ({
    ...value,
    selected: [...value.selected].sort((a, b) => compare(a.reference.id, b.reference.id)),
  }));
export type IdentityReferenceSnapshot = z.infer<typeof identityReferenceSnapshotSchema>;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
/** The caller supplies the whole authoritative selection. No filtering, truncation or page inference occurs. */
export function createIdentityReferenceSnapshot(
  input: Omit<IdentityReferenceSnapshot, "version">,
): IdentityReferenceSnapshot {
  return deepFreeze(identityReferenceSnapshotSchema.parse({ ...input, version: 1 }));
}
/** Material preferences only: revision/time/source metadata and generic asset retention are not visual inputs. */
export function identityReferenceBasis(snapshot: unknown) {
  const value = identityReferenceSnapshotSchema.parse(snapshot);
  return deepFreeze({
    version: 1 as const,
    ownerId: value.ownerId,
    projectId: value.projectId,
    references: value.selected.map(({ reference, reaction }) => ({
      referenceId: reference.id,
      media: { ...reference.media },
      ensemble: reaction.ensemble,
      elements: [...reaction.elements],
    })),
  });
}
export type IdentityReferenceBasis = ReturnType<typeof identityReferenceBasis>;
