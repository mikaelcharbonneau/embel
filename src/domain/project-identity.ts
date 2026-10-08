import { z } from "zod";
import { assetProjectSummarySchema, assetVersionReferenceSchema } from "./asset-library";
import {
  identityReferenceBasis, identityReferenceMediaSchema, identityReferenceSnapshotSchema,
  MAX_IDENTITY_REFERENCE_SELECTION, referenceElementSchema, referenceElements,
  type IdentityReferenceSnapshot,
} from "./identity-references";
import { namingStrategyBasis, namingStrategyBasisSchema } from "./project-naming";
import { contextSnapshotSchema, missingStrategy, projectScopeSchema, type ContextSnapshot, type ProjectScope } from "./projects";

export const IDENTITY_MUTATION_MAX_BYTES = 32_768;
export const IDENTITY_HISTORY_DEFAULT_PAGE_SIZE = 20;
export const IDENTITY_HISTORY_MAX_PAGE_SIZE = 50;
export const IDENTITY_MAX_PRODUCTION_FILES = 48;
export const identityComponents = ["logo", "colors", "typography", "graphics", "imagery", "composition"] as const;
export const identityComponentSchema = z.enum(identityComponents);
export type IdentityComponent = z.infer<typeof identityComponentSchema>;
const editableComponent = z.enum(["colors", "typography"]);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true }).max(64);
const ownership = { ownerId: z.uuid(), projectId: z.uuid() };
const name = z.string().trim().min(1).max(200).transform(value => value.normalize("NFC"));
const note = z.string().trim().max(2000);
const direction = z.string().trim().min(1).max(2000);
const token = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sameScope = (a: { ownerId: string; projectId: string }, b: { ownerId: string; projectId: string }) => a.ownerId === b.ownerId && a.projectId === b.projectId;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Compare UTC whole seconds and decimal fractions independently: Date must never round away the cursor's submillisecond precision. */
function compareHistoryRows(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }): number | null {
  const parts = (value: string) => {
    const match = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return null;
    const whole = Date.parse(`${match[1]}${match[3]}`);
    return Number.isFinite(whole) ? { whole, fraction: match[2] ?? "" } : null;
  };
  const a = parts(left.createdAt), b = parts(right.createdAt);
  if (!a || !b) return null;
  if (a.whole !== b.whole) return a.whole < b.whole ? -1 : 1;
  const precision = Math.max(a.fraction.length, b.fraction.length);
  return compare(a.fraction.padEnd(precision, "0"), b.fraction.padEnd(precision, "0")) || compare(left.id, right.id);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function issue(ctx: z.RefinementCtx, message: string): void { ctx.addIssue({ code: "custom", message }); }
const uniqueComponents = z.array(identityComponentSchema).max(identityComponents.length)
  .refine(value => new Set(value).size === value.length, "Components must be unique")
  .transform(value => identityComponents.filter(component => value.includes(component)));

export const identityPreferencesSchema = z.strictObject({ version: z.literal(1), creativeLocale: z.string().trim().min(2).max(30), notes: note, avoidanceNotes: note }).transform(freeze);
export type IdentityPreferences = z.infer<typeof identityPreferencesSchema>;
/** Starting material values, not an invented saved preference revision. */
export function initialIdentityPreferences(context: ContextSnapshot): IdentityPreferences {
  const value = contextSnapshotSchema.parse(context);
  return identityPreferencesSchema.parse({ version: 1, creativeLocale: value.creativeLocale, notes: value.intake.identityNotes, avoidanceNotes: "" });
}
export const identityPreferenceRevisionSchema = z.strictObject({ ...ownership, revision, preferences: identityPreferencesSchema, createdAt: timestamp }).transform(freeze);
export type IdentityPreferenceRevision = z.infer<typeof identityPreferenceRevisionSchema>;

export const identityNameResolutionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("resolved"), value: name, source: z.enum(["selected_name", "supplied_name", "matching_saved_names"]) }),
  z.strictObject({ status: z.literal("missing") }),
  z.strictObject({ status: z.literal("inconsistent"), selectedName: name, suppliedName: name }),
]);
export type IdentityNameResolution = z.infer<typeof identityNameResolutionSchema>;
export function resolveIdentityName(context: ContextSnapshot): IdentityNameResolution {
  const value = contextSnapshotSchema.parse(context);
  const selected = value.selectedName?.trim().normalize("NFC") ?? "";
  const supplied = value.intake.suppliedName.trim().normalize("NFC");
  if (selected && supplied && selected !== supplied) return { status: "inconsistent", selectedName: selected, suppliedName: supplied };
  if (!selected && !supplied) return { status: "missing" };
  return { status: "resolved", value: selected || supplied, source: selected && supplied ? "matching_saved_names" : selected ? "selected_name" : "supplied_name" };
}

const strategySteps = ["reformulation", "competitors", "audience", "personality", "positioning"] as const;
const strategyStep = z.enum(strategySteps);
export const identityReadinessSchema = z.strictObject({
  ready: z.boolean(), blocking: z.array(z.enum(["scope", "description", ...strategySteps, "missing_name", "inconsistent_name", "references"])).max(10),
  missingStrategy: z.array(strategyStep).max(strategySteps.length), name: identityNameResolutionSchema,
}).superRefine((value, ctx) => {
  if (value.ready !== (value.blocking.length === 0) || new Set(value.blocking).size !== value.blocking.length || new Set(value.missingStrategy).size !== value.missingStrategy.length)
    issue(ctx, "Readiness must report its actual distinct blocking and missing steps");
  if ((value.name.status === "missing") !== value.blocking.includes("missing_name") || (value.name.status === "inconsistent") !== value.blocking.includes("inconsistent_name"))
    issue(ctx, "Readiness must preserve the saved-name resolution");
});
export type IdentityReadiness = z.infer<typeof identityReadinessSchema>;
/** Input readiness only. The selected-reference count must come from the owned aggregate, not a feed page. */
export function getIdentityReadiness(context: ContextSnapshot, scope: ProjectScope, referenceSummary: { selectedReferenceCount: number }): IdentityReadiness {
  const value = contextSnapshotSchema.parse(context);
  projectScopeSchema.parse(scope);
  z.number().int().min(0).max(MAX_IDENTITY_REFERENCE_SELECTION).parse(referenceSummary.selectedReferenceCount);
  const missing = missingStrategy(value);
  const missingReviewed = strategySteps.filter(step => missing.includes(step) || (step === "audience" && !value.intake.audienceReviewedAt));
  const blocking: IdentityReadiness["blocking"] = [];
  if (scope === "naming_only") blocking.push("scope");
  if (!value.description) blocking.push("description");
  if (scope === "complete_brand") blocking.push(...missingReviewed);
  const resolved = resolveIdentityName(value);
  if (resolved.status !== "resolved") blocking.push(resolved.status === "missing" ? "missing_name" : "inconsistent_name");
  if (!referenceSummary.selectedReferenceCount) blocking.push("references");
  return identityReadinessSchema.parse({ ready: blocking.length === 0, blocking, missingStrategy: missingReviewed, name: resolved });
}

const materialElements = z.array(referenceElementSchema).max(referenceElements.length)
  .refine(value => new Set(value).size === value.length, "Selected elements must be unique")
  .transform(value => referenceElements.filter(element => value.includes(element)));
const materialReferenceBasisSchema = z.strictObject({
  version: z.literal(1), ...ownership, references: z.array(z.strictObject({ referenceId: z.uuid(), media: identityReferenceMediaSchema, ensemble: z.boolean(), elements: materialElements })).max(MAX_IDENTITY_REFERENCE_SELECTION),
}).superRefine((value, ctx) => {
  if (new Set(value.references.map(row => row.referenceId)).size !== value.references.length || value.references.some(row => !sameScope(value, row.media) || (!row.ensemble && !row.elements.length)))
    issue(ctx, "Material references require unique owned media and actual selections");
}).transform(value => ({ ...value, references: [...value.references].sort((a, b) => compare(a.referenceId, b.referenceId)) }));
export const identityBasisSchema = z.strictObject({
  version: z.literal(1), ...ownership, strategy: namingStrategyBasisSchema, name, referenceBasis: materialReferenceBasisSchema, preferences: identityPreferencesSchema,
}).refine(value => sameScope(value, value.referenceBasis), "Identity basis must bind the owned reference selection").transform(freeze);
export type IdentityBasis = z.infer<typeof identityBasisSchema>;
type BasisInput = { ownerId: string; projectId: string; context: ContextSnapshot; references: IdentityReferenceSnapshot; preferences: IdentityPreferences };
/** Authoritative constructors derive this from loaded saved records; SQL compares JSONB, not the public key. */
export function identityBasis(input: BasisInput): IdentityBasis {
  const resolved = resolveIdentityName(input.context);
  if (resolved.status !== "resolved") throw new Error("A consistent saved name is required for an Identity basis");
  return identityBasisSchema.parse({ version: 1, ownerId: input.ownerId, projectId: input.projectId, strategy: namingStrategyBasis(input.context), name: resolved.value,
    referenceBasis: identityReferenceBasis(input.references), preferences: input.preferences });
}
export function identityBasisKey(basis: IdentityBasis): string { return `identity-basis-v1:${JSON.stringify(identityBasisSchema.parse(basis))}`; }
export const identityCurrentBasisSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), basis: identityBasisSchema }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.enum(["missing_name", "inconsistent_name"]) }),
]);
export type IdentityCurrentBasis = z.infer<typeof identityCurrentBasisSchema>;
export function getIdentityCurrentBasis(input: BasisInput): IdentityCurrentBasis {
  // Validate scope even when a missing name prevents a comparable material basis.
  z.strictObject(ownership).parse({ ownerId: input.ownerId, projectId: input.projectId });
  const references = identityReferenceSnapshotSchema.parse(input.references);
  if (!sameScope(input, references)) throw new Error("Reference snapshot belongs to another project");
  identityPreferencesSchema.parse(input.preferences);
  const resolved = resolveIdentityName(input.context);
  return resolved.status === "resolved" ? { status: "available", basis: identityBasis(input) }
    : { status: "unavailable", reason: resolved.status === "missing" ? "missing_name" : "inconsistent_name" };
}
export const identityInputSnapshotSchema = z.strictObject({
  version: z.literal(1), ...ownership, scope: projectScopeSchema, projectRevision: revision, context: contextSnapshotSchema,
  referenceSnapshot: identityReferenceSnapshotSchema, preferencesRevision: counter, preferences: identityPreferencesSchema, capturedAt: timestamp, basis: identityBasisSchema,
}).superRefine((value, ctx) => {
  try {
    const expected = identityBasis({ ...value, references: value.referenceSnapshot });
    if (!same(value.basis, expected)) issue(ctx, "Captured material basis must match the complete saved inputs");
    if (value.preferencesRevision === 0 && !same(value.preferences, initialIdentityPreferences(value.context))) issue(ctx, "Preference revision zero uses only the saved context's starting values");
  } catch { issue(ctx, "Captured inputs require a consistent saved name and exact owned reference selection"); }
}).transform(freeze);
export type IdentityInputSnapshot = z.infer<typeof identityInputSnapshotSchema>;
export function createIdentityInputSnapshot(input: Omit<IdentityInputSnapshot, "version" | "basis">): IdentityInputSnapshot {
  return identityInputSnapshotSchema.parse({ ...input, version: 1, basis: identityBasis({ ...input, references: input.referenceSnapshot }) });
}

const materialKeys = ["strategy", "name", "references", "preferences"] as const;
export const identityFreshnessSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("current"), changed: z.array(z.enum(materialKeys)).length(0) }),
  z.strictObject({ status: z.literal("stale"), changed: z.array(z.enum(materialKeys)).min(1).max(materialKeys.length).refine(value => new Set(value).size === value.length, "Material changes must be unique") }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.enum(["missing_name", "inconsistent_name"]) }),
]);
export type IdentityFreshness = z.infer<typeof identityFreshnessSchema>;
export function getIdentityFreshness(recordedBasis: IdentityBasis, current: IdentityCurrentBasis): IdentityFreshness {
  const recorded = identityBasisSchema.parse(recordedBasis), actual = identityCurrentBasisSchema.parse(current);
  if (actual.status === "unavailable") return { ...actual };
  if (!sameScope(recorded, actual.basis)) throw new Error("Identity bases belong to different projects");
  const changed = materialKeys.filter(key => key === "references" ? !same(recorded.referenceBasis, actual.basis.referenceBasis) : !same(recorded[key], actual.basis[key]));
  return identityFreshnessSchema.parse({ status: changed.length ? "stale" : "current", changed });
}

export const identityDirectionSchema = z.strictObject({ direction, usageNotes: note }).transform(freeze);
export const identityColorsSchema = z.strictObject({
  swatches: z.array(z.strictObject({ key: token, name: z.string().trim().min(1).max(120), hex: z.string().regex(/^#[a-fA-F0-9]{6}$/).transform(value => value.toUpperCase()) })).min(1).max(16), usageNotes: note,
}).refine(value => new Set(value.swatches.map(row => row.key)).size === value.swatches.length, "Color keys must be unique").transform(freeze);
export type IdentityColors = z.infer<typeof identityColorsSchema>;
/** Family names are specifications only: no installed font, downloadable file or license is implied. */
export const identityTypographySchema = z.strictObject({
  styles: z.array(z.strictObject({ key: token, role: z.string().trim().min(1).max(120), family: z.string().trim().min(1).max(160), weight: z.number().int().min(1).max(1000), style: z.enum(["normal", "italic", "oblique"]) })).min(1).max(8), usageNotes: note,
}).refine(value => new Set(value.styles.map(row => row.key)).size === value.styles.length, "Typography keys must be unique").transform(freeze);
export type IdentityTypography = z.infer<typeof identityTypographySchema>;
export const identityComponentsSchema = z.strictObject({
  logo: identityDirectionSchema, colors: identityColorsSchema, typography: identityTypographySchema,
  graphics: identityDirectionSchema, imagery: identityDirectionSchema, composition: identityDirectionSchema,
}).transform(freeze);
/** Immutable metadata only. Current byte verification remains a separate AssetVersionDetail observation. */
export const identitySystemAssetSchema = assetVersionReferenceSchema.extend({ purpose: z.enum(["brand_asset", "legacy_unknown"]), mimeType: z.string().min(1).max(150) });
export type IdentitySystemAsset = z.infer<typeof identitySystemAssetSchema>;
export const identityBoardPreviewSchema = z.strictObject({
  asset: identitySystemAssetSchema.extend({ mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]) }), depictsSystemVersionId: z.uuid(), staleComponents: uniqueComponents,
}).transform(freeze);
export type IdentityBoardPreview = z.infer<typeof identityBoardPreviewSchema>;
export const identityProductionFileSchema = z.strictObject({ component: identityComponentSchema, role: z.string().trim().min(1).max(120), asset: identitySystemAssetSchema });
export type IdentityProductionFile = z.infer<typeof identityProductionFileSchema>;
/** Read-only evidence links, never provider-authorship proof from shape alone. The DAL must resolve actual leased completion or replay the owned manual base. */
export const identitySystemSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("generated"), batchId: z.uuid(), jobId: z.uuid(), stepKey: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("manual_edit"), baseSystemVersionId: z.uuid(), changeId: z.uuid(), component: editableComponent, editedAtProjectRevision: revision, editedAtReferenceRevision: counter, editedAtPreferencesRevision: counter }),
]);
export type IdentitySystemSource = z.infer<typeof identitySystemSourceSchema>;
export const identitySystemVersionSchema = z.strictObject({
  id: z.uuid(), ...ownership, createdAt: timestamp, input: identityInputSnapshotSchema, source: identitySystemSourceSchema,
  components: identityComponentsSchema, board: identityBoardPreviewSchema, productionFiles: z.array(identityProductionFileSchema).max(IDENTITY_MAX_PRODUCTION_FILES),
}).superRefine((value, ctx) => {
  if (!sameScope(value, value.input) || !sameScope(value, value.board.asset) || value.productionFiles.some(file => !sameScope(value, file.asset))) issue(ctx, "Every system input and file must belong to its exact owner and project");
  const versions = new Map<string, IdentitySystemAsset>();
  versions.set(value.board.asset.versionId, value.board.asset);
  const roles = new Set<string>();
  for (const file of value.productionFiles) {
    const previous = versions.get(file.asset.versionId), role = `${file.component}\u0000${file.role}`;
    if (file.asset.versionId === value.board.asset.versionId || file.asset.contentHash === value.board.asset.contentHash || (previous && !same(previous, file.asset)) || roles.has(role)) issue(ctx, "Production files must be distinct from the board's bytes and retain exact repeated-version metadata and unique roles");
    versions.set(file.asset.versionId, file.asset); roles.add(role);
  }
  const source = value.source;
  if (source.kind === "generated") {
    if (value.board.depictsSystemVersionId !== value.id || value.board.staleComponents.length) issue(ctx, "A generated system requires its own coordinated board");
  } else if (source.baseSystemVersionId === value.id || value.board.depictsSystemVersionId === value.id || !value.board.staleComponents.includes(source.component) || source.editedAtProjectRevision < value.input.projectRevision || source.editedAtReferenceRevision < value.input.referenceSnapshot.referenceRevision || source.editedAtPreferencesRevision < value.input.preferencesRevision || value.productionFiles.some(file => file.component === source.component)) {
    issue(ctx, "Manual edits preserve their earlier base and explicitly stale inherited board without invented replacement files");
  }
}).transform(freeze);
export type IdentitySystemVersion = z.infer<typeof identitySystemVersionSchema>;
/** A manual system keeps its original generation inputs but exists only from its actual edit revision. */
function creationRevisions(system: IdentitySystemVersion) {
  return system.source.kind === "manual_edit" ? { projectRevision: system.source.editedAtProjectRevision, referenceRevision: system.source.editedAtReferenceRevision, preferencesRevision: system.source.editedAtPreferencesRevision }
    : { projectRevision: system.input.projectRevision, referenceRevision: system.input.referenceSnapshot.referenceRevision, preferencesRevision: system.input.preferencesRevision };
}
type InputRevisions = ReturnType<typeof creationRevisions>;
function atLeast(value: InputRevisions, previous: InputRevisions): boolean { return value.projectRevision >= previous.projectRevision && value.referenceRevision >= previous.referenceRevision && value.preferencesRevision >= previous.preferencesRevision; }
function inputRevisions(input: IdentityInputSnapshot): InputRevisions { return { projectRevision: input.projectRevision, referenceRevision: input.referenceSnapshot.referenceRevision, preferencesRevision: input.preferencesRevision }; }

const expectedInputs = { expectedProjectRevision: revision, expectedReferenceRevision: counter, expectedPreferencesRevision: counter, expectedIdentityRevision: counter };
export const selectIdentitySystemSchema = z.strictObject({ systemVersionId: z.uuid(), ...expectedInputs, acceptEarlierBasis: z.boolean() });
export type SelectIdentitySystem = z.infer<typeof selectIdentitySystemSchema>;
export const identitySelectionSchema = z.strictObject({
  id: z.uuid(), ...ownership, systemVersionId: z.uuid(), identityRevision: revision, projectRevision: revision, referenceRevision: counter, preferencesRevision: counter, currentBasis: identityBasisSchema,
  acceptedEarlierBasis: z.boolean(), previousSelectionId: z.uuid().nullable(), reason: z.enum(["selected", "restored", "refined"]), createdAt: timestamp,
}).superRefine((value, ctx) => {
  if (!sameScope(value, value.currentBasis) || value.previousSelectionId === value.id || (value.identityRevision === 1) !== (value.previousSelectionId === null)) issue(ctx, "Selections retain their exact owned basis and immutable predecessor");
}).transform(freeze);
export type IdentitySelection = z.infer<typeof identitySelectionSchema>;
export const identitySelectionWithSystemSchema = z.strictObject({ selection: identitySelectionSchema, system: identitySystemVersionSchema, freshness: identityFreshnessSchema }).superRefine((value, ctx) => {
  const { selection, system } = value;
  if (!sameScope(selection, system) || selection.systemVersionId !== system.id || !atLeast(selection, creationRevisions(system)) || (selection.reason === "refined" && system.source.kind !== "manual_edit")) issue(ctx, "A selection must bind this exact owned system after all creation revisions without inventing an edit");
  if (sameScope(selection, system) && selection.acceptedEarlierBasis !== !same(selection.currentBasis, system.input.basis)) issue(ctx, "Earlier-basis acknowledgment must describe the basis at selection time");
}).transform(freeze);
export type IdentitySelectionWithSystem = z.infer<typeof identitySelectionWithSystemSchema>;
type SelectionArgs = {
  actorId: string; projectId: string; system: unknown; currentInput: unknown; previousSelection: unknown; identityRevision: number;
  request: unknown; selectionId: string; now: string; reason?: IdentitySelection["reason"];
};
/** Pure transition only; the database must lock and check the same authoritative revisions and evidence. */
export function selectIdentitySystem(args: SelectionArgs): IdentitySelection {
  const system = identitySystemVersionSchema.parse(args.system), current = identityInputSnapshotSchema.parse(args.currentInput), request = selectIdentitySystemSchema.parse(args.request);
  const previous = args.previousSelection === null ? null : identitySelectionSchema.parse(args.previousSelection);
  counter.parse(args.identityRevision);
  if (system.ownerId !== args.actorId || system.projectId !== args.projectId || !sameScope(system, current) || (previous && !sameScope(system, previous))) throw new Error("Identity system not found");
  const currentRevisions = inputRevisions(current);
  if (system.id !== request.systemVersionId || request.expectedProjectRevision !== current.projectRevision || request.expectedReferenceRevision !== currentRevisions.referenceRevision || request.expectedPreferencesRevision !== current.preferencesRevision || request.expectedIdentityRevision !== args.identityRevision || !atLeast(currentRevisions, creationRevisions(system)) || (previous ? previous.identityRevision !== args.identityRevision || !atLeast(currentRevisions, previous) : args.identityRevision !== 0)) throw new Error("Identity revision conflict");
  const stale = !same(system.input.basis, current.basis);
  if (stale && !request.acceptEarlierBasis) throw new Error("Explicit earlier-basis acknowledgment required");
  const selection = identitySelectionSchema.parse({ id: args.selectionId, ownerId: args.actorId, projectId: args.projectId, systemVersionId: system.id,
    identityRevision: args.identityRevision + 1, ...currentRevisions, currentBasis: current.basis, acceptedEarlierBasis: stale,
    previousSelectionId: previous?.id ?? null, reason: args.reason ?? "selected", createdAt: args.now });
  return identitySelectionWithSystemSchema.parse({ selection, system, freshness: getIdentityFreshness(system.input.basis, { status: "available", basis: current.basis }) }).selection;
}

const refinementFields = { baseSystemVersionId: z.uuid(), ...expectedInputs, acceptEarlierBasis: z.boolean(), idempotencyKey };
export const refineIdentityComponentSchema = z.discriminatedUnion("component", [
  z.strictObject({ ...refinementFields, component: z.literal("colors"), input: identityColorsSchema }),
  z.strictObject({ ...refinementFields, component: z.literal("typography"), input: identityTypographySchema }),
]);
export type RefineIdentityComponent = z.infer<typeof refineIdentityComponentSchema>;
const changeFields = {
  id: z.uuid(), ...ownership, baseSystemVersionId: z.uuid(), resultSystemVersionId: z.uuid(), projectRevision: revision, referenceRevision: counter, preferencesRevision: counter, currentBasis: identityBasisSchema,
  acceptedEarlierBasis: z.boolean(), provenance: z.strictObject({ kind: z.literal("user_edit"), actorId: z.uuid() }), createdAt: timestamp,
};
export const identityComponentChangeSchema = z.discriminatedUnion("component", [
  z.strictObject({ ...changeFields, component: z.literal("colors"), before: identityColorsSchema, after: identityColorsSchema }),
  z.strictObject({ ...changeFields, component: z.literal("typography"), before: identityTypographySchema, after: identityTypographySchema }),
]).superRefine((value, ctx) => {
  if (value.provenance.actorId !== value.ownerId || !sameScope(value, value.currentBasis) || value.baseSystemVersionId === value.resultSystemVersionId || same(value.before, value.after)) issue(ctx, "A user edit must record a real owned change to a new system version");
}).transform(freeze);
export type IdentityComponentChange = z.infer<typeof identityComponentChangeSchema>;
export const identityRefinementResponseSchema = z.strictObject({ system: identitySystemVersionSchema, change: identityComponentChangeSchema, selection: identitySelectionSchema }).superRefine((value, ctx) => {
  const { system, change, selection } = value, source = system.source;
  if (!sameScope(system, change) || !sameScope(system, selection) || source.kind !== "manual_edit" || source.changeId !== change.id || source.baseSystemVersionId !== change.baseSystemVersionId || source.component !== change.component || source.editedAtProjectRevision !== change.projectRevision || source.editedAtReferenceRevision !== change.referenceRevision || source.editedAtPreferencesRevision !== change.preferencesRevision || change.resultSystemVersionId !== system.id || !same(system.components[change.component], change.after)
    || selection.systemVersionId !== system.id || selection.reason !== "refined" || selection.projectRevision !== change.projectRevision || selection.referenceRevision !== change.referenceRevision || selection.preferencesRevision !== change.preferencesRevision || !same(selection.currentBasis, change.currentBasis) || selection.acceptedEarlierBasis !== change.acceptedEarlierBasis)
    issue(ctx, "Refinement response must bind the exact user-edit system, change and new selection");
  if (sameScope(system, selection) && selection.acceptedEarlierBasis !== !same(selection.currentBasis, system.input.basis)) issue(ctx, "A refinement preserves the actual earlier-basis acknowledgment");
}).transform(freeze);
export type IdentityRefinementResponse = z.infer<typeof identityRefinementResponseSchema>;
/** Persistence must resolve a trusted immutable source and the exact owned base; this guard replays one complete recorded edit without accepting provenance by shape. */
export function validateIdentityRefinement(input: { base: unknown; system: unknown; change: unknown; selection: unknown }): void {
  const base = identitySystemVersionSchema.parse(input.base), result = identityRefinementResponseSchema.parse({ system: input.system, change: input.change, selection: input.selection });
  const { system, change } = result;
  if (!sameScope(base, system) || base.id !== change.baseSystemVersionId || system.source.kind !== "manual_edit") throw new Error("Refinement base mismatch");
  const expectedComponents = { ...base.components, [change.component]: change.after };
  const staleComponents = identityComponents.filter(component => base.board.staleComponents.includes(component) || component === change.component);
  if (!same(base.components[change.component], change.before) || !same(system.components, expectedComponents) || !same(system.input, base.input)
    || !same(system.board, { ...base.board, staleComponents }) || !same(system.productionFiles, base.productionFiles.filter(file => file.component !== change.component))
    || !atLeast(change, creationRevisions(base)) || change.acceptedEarlierBasis !== !same(change.currentBasis, base.input.basis)) throw new Error("Refinement must replay the exact base without unrecorded changes or a silent rebase");
}
type RefinementArgs = Omit<SelectionArgs, "system" | "reason"> & { base: unknown; systemVersionId: string; changeId: string };
export function refineIdentityComponent(args: RefinementArgs): IdentityRefinementResponse {
  const base = identitySystemVersionSchema.parse(args.base), current = identityInputSnapshotSchema.parse(args.currentInput), request = refineIdentityComponentSchema.parse(args.request);
  if (base.ownerId !== args.actorId || base.projectId !== args.projectId || !sameScope(base, current) || request.baseSystemVersionId !== base.id) throw new Error("Identity base not found");
  if (!atLeast(inputRevisions(current), creationRevisions(base))) throw new Error("Identity base is newer than the saved edit context");
  if (same(base.components[request.component], request.input)) throw new Error("A refinement must change its component");
  const stale = !same(base.input.basis, current.basis);
  if (stale && !request.acceptEarlierBasis) throw new Error("Explicit earlier-basis acknowledgment required");
  const change = identityComponentChangeSchema.parse({ id: args.changeId, ownerId: args.actorId, projectId: args.projectId, baseSystemVersionId: base.id, resultSystemVersionId: args.systemVersionId,
    ...inputRevisions(current), currentBasis: current.basis, acceptedEarlierBasis: stale, component: request.component, before: base.components[request.component], after: request.input,
    provenance: { kind: "user_edit", actorId: args.actorId }, createdAt: args.now });
  const system = identitySystemVersionSchema.parse({ ...base, id: args.systemVersionId, createdAt: args.now,
    source: { kind: "manual_edit", baseSystemVersionId: base.id, changeId: change.id, component: request.component, editedAtProjectRevision: current.projectRevision, editedAtReferenceRevision: current.referenceSnapshot.referenceRevision, editedAtPreferencesRevision: current.preferencesRevision },
    components: { ...base.components, [request.component]: request.input },
    board: { ...base.board, staleComponents: identityComponents.filter(component => base.board.staleComponents.includes(component) || component === request.component) },
    productionFiles: base.productionFiles.filter(file => file.component !== request.component) });
  const selection = selectIdentitySystem({ ...args, system, reason: "refined", request: { systemVersionId: system.id, expectedProjectRevision: request.expectedProjectRevision,
    expectedReferenceRevision: request.expectedReferenceRevision, expectedPreferencesRevision: request.expectedPreferencesRevision, expectedIdentityRevision: request.expectedIdentityRevision, acceptEarlierBasis: request.acceptEarlierBasis } });
  const result = identityRefinementResponseSchema.parse({ system, change, selection });
  validateIdentityRefinement({ base, ...result });
  return result;
}

export const identitySessionSchema = z.strictObject({
  ...ownership, identityRevision: counter, currentSelectionId: z.uuid().nullable(), currentPreferencesRevision: counter, createdAt: timestamp, updatedAt: timestamp,
}).refine(value => (value.identityRevision === 0) === (value.currentSelectionId === null), "The Identity selection head must match its revision");
export type IdentitySession = z.infer<typeof identitySessionSchema>;
export const updateIdentityPreferencesSchema = z.strictObject({ expectedPreferencesRevision: counter, preferences: identityPreferencesSchema });
export type UpdateIdentityPreferences = z.infer<typeof updateIdentityPreferencesSchema>;
/** Independent preference CAS. The DAL additionally requires returned revision=expected+1. */
export const updateIdentityPreferencesResponseSchema = z.strictObject({ session: identitySessionSchema, preferences: identityPreferenceRevisionSchema })
  .refine(value => sameScope(value.session, value.preferences) && value.session.currentPreferencesRevision === value.preferences.revision, "Preference response must bind the exact owned session head");
export type UpdateIdentityPreferencesResponse = z.infer<typeof updateIdentityPreferencesResponseSchema>;
/** Mutation-time freshness uses the new selection receipt, not an arbitrary later observation. */
export const selectIdentitySystemResponseSchema = z.strictObject({ session: identitySessionSchema, currentSelection: identitySelectionWithSystemSchema }).superRefine((value, ctx) => {
  const { session, currentSelection: { selection, system, freshness } } = value;
  if (!sameScope(session, selection) || session.currentSelectionId !== selection.id || session.identityRevision !== selection.identityRevision || session.currentPreferencesRevision !== selection.preferencesRevision) issue(ctx, "Selection response must bind the exact owned session head");
  try {
    if (!same(freshness, getIdentityFreshness(system.input.basis, { status: "available", basis: selection.currentBasis }))) issue(ctx, "Selection response must report its actual mutation-time material freshness");
  } catch { issue(ctx, "Selection response must bind one owned material basis"); }
});
export type SelectIdentitySystemResponse = z.infer<typeof selectIdentitySystemResponseSchema>;
export const identitySystemSummarySchema = z.strictObject({
  id: z.uuid(), ...ownership, createdAt: timestamp, inputScope: projectScopeSchema, inputProjectRevision: revision, inputReferenceRevision: counter, inputPreferencesRevision: counter, name, source: identitySystemSourceSchema,
  board: identityBoardPreviewSchema, productionFileCount: z.number().int().min(0).max(IDENTITY_MAX_PRODUCTION_FILES), freshness: identityFreshnessSchema,
}).superRefine((value, ctx) => {
  if (!sameScope(value, value.board.asset)) issue(ctx, "A system summary must retain its owned board");
  if (value.source.kind === "generated" ? value.board.depictsSystemVersionId !== value.id || value.board.staleComponents.length > 0
    : value.source.baseSystemVersionId === value.id || value.board.depictsSystemVersionId === value.id || !value.board.staleComponents.includes(value.source.component) || value.source.editedAtProjectRevision < value.inputProjectRevision || value.source.editedAtReferenceRevision < value.inputReferenceRevision || value.source.editedAtPreferencesRevision < value.inputPreferencesRevision)
    issue(ctx, "A summary preserves the system's actual board and source state");
}).transform(freeze);
export type IdentitySystemSummary = z.infer<typeof identitySystemSummarySchema>;
/** Summaries never contain full captured contexts, reference snapshots or component manifests. */
export function summarizeIdentitySystem(input: IdentitySystemVersion, currentBasis: IdentityCurrentBasis): IdentitySystemSummary {
  const system = identitySystemVersionSchema.parse(input);
  return identitySystemSummarySchema.parse({ id: system.id, ownerId: system.ownerId, projectId: system.projectId, createdAt: system.createdAt,
    inputScope: system.input.scope, inputProjectRevision: system.input.projectRevision, inputReferenceRevision: system.input.referenceSnapshot.referenceRevision, inputPreferencesRevision: system.input.preferencesRevision, name: system.input.basis.name, source: system.source, board: system.board,
    productionFileCount: system.productionFiles.length, freshness: getIdentityFreshness(system.input.basis, currentBasis) });
}
export const identitySystemCursorSchema = z.strictObject({ projectId: z.uuid(), createdAt: timestamp, id: z.uuid() });
export type IdentitySystemCursor = z.infer<typeof identitySystemCursorSchema>;
export const listIdentitySystemsSchema = z.strictObject({ cursor: identitySystemCursorSchema.optional(), limit: z.number().int().min(1).max(IDENTITY_HISTORY_MAX_PAGE_SIZE).default(IDENTITY_HISTORY_DEFAULT_PAGE_SIZE) });
export type ListIdentitySystems = z.infer<typeof listIdentitySystemsSchema>;
export const identitySystemPageSchema = z.strictObject({ ...ownership, query: listIdentitySystemsSchema, items: z.array(identitySystemSummarySchema).max(IDENTITY_HISTORY_MAX_PAGE_SIZE), nextCursor: identitySystemCursorSchema.nullable() }).superRefine((value, ctx) => {
  if (value.items.length > value.query.limit || new Set(value.items.map(row => row.id)).size !== value.items.length || value.items.some(row => !sameScope(value, row)) || (value.query.cursor && value.query.cursor.projectId !== value.projectId)) issue(ctx, "History must contain unique summaries of this owned project within its page limit");
  for (let index = 0; index < value.items.length; index++) {
    const row = value.items[index]!, prior = index === 0 ? value.query.cursor : value.items[index - 1];
    if (prior) {
      const order = compareHistoryRows(prior, row);
      if (order === null || order <= 0 || row.id === value.query.cursor?.id) issue(ctx, "History must advance strictly after its cursor in descending timestamp and UUID order");
    }
  }
  const last = value.items.at(-1), cursor = value.nextCursor;
  if (cursor && (!last || cursor.projectId !== value.projectId || cursor.createdAt !== last.createdAt || cursor.id !== last.id)) issue(ctx, "History continuation must bind its exact last row and project");
});
export type IdentitySystemPage = z.infer<typeof identitySystemPageSchema>;
export const identitySystemDetailSchema = z.strictObject({ ...ownership, system: identitySystemVersionSchema, currentBasis: identityCurrentBasisSchema, freshness: identityFreshnessSchema }).superRefine((value, ctx) => {
  try {
    if (!sameScope(value, value.system) || !same(value.freshness, getIdentityFreshness(value.system.input.basis, value.currentBasis))) issue(ctx, "System detail must bind owned metadata and actual current material freshness");
  } catch { issue(ctx, "System detail requires a comparable owned basis or explicit unavailability"); }
});
export type IdentitySystemDetail = z.infer<typeof identitySystemDetailSchema>;
export const identityProjectSchema = assetProjectSummarySchema.extend({ context: contextSnapshotSchema });
/** Server capability for selection/refinement, independent of image generation or preference CAS. */
export const identitySaveAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available") }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.literal("trusted_transaction_unavailable") }),
]);
export const projectIdentityOverviewSchema = z.strictObject({
  ...ownership, project: identityProjectSchema, session: identitySessionSchema.nullable(), preferences: identityPreferenceRevisionSchema.nullable(),
  referenceSnapshot: identityReferenceSnapshotSchema, readiness: identityReadinessSchema, currentBasis: identityCurrentBasisSchema,
  currentSelection: identitySelectionWithSystemSchema.nullable(), systems: identitySystemPageSchema,
  // Older responses cannot implicitly enable saves while the trusted boundary is absent.
  saveAvailability: identitySaveAvailabilitySchema.default(() => ({ status: "unavailable", reason: "trusted_transaction_unavailable" } as const)),
}).superRefine((value, ctx) => {
  const { project, session, preferences, currentSelection } = value;
  if (project.id !== value.projectId || project.owner_id !== value.ownerId || !sameScope(value, value.referenceSnapshot) || !sameScope(value, value.systems) || (session && !sameScope(value, session)) || (preferences && !sameScope(value, preferences))) issue(ctx, "Overview records must belong to this verified owner and project");
  if (!session ? preferences !== null || currentSelection !== null : (session.currentPreferencesRevision !== (preferences?.revision ?? 0) || session.currentSelectionId !== (currentSelection?.selection.id ?? null) || session.identityRevision !== (currentSelection?.selection.identityRevision ?? 0))) issue(ctx, "Overview must preserve actual preference and selection heads without inventing initialization");
  try {
    const actual = getIdentityCurrentBasis({ ownerId: value.ownerId, projectId: value.projectId, context: project.context, references: value.referenceSnapshot, preferences: preferences?.preferences ?? initialIdentityPreferences(project.context) });
    if (!same(value.currentBasis, actual) || !same(value.readiness, getIdentityReadiness(project.context, project.scope, value.referenceSnapshot))) issue(ctx, "Overview readiness and material basis must derive from its current saved inputs");
    const currentRevisions = { projectRevision: project.current_revision, referenceRevision: value.referenceSnapshot.referenceRevision, preferencesRevision: preferences?.revision ?? 0 };
    if (value.systems.items.some(row => !atLeast(currentRevisions, { projectRevision: row.inputProjectRevision, referenceRevision: row.inputReferenceRevision, preferencesRevision: row.inputPreferencesRevision })
      || (row.source.kind === "manual_edit" && !atLeast(currentRevisions, { projectRevision: row.source.editedAtProjectRevision, referenceRevision: row.source.editedAtReferenceRevision, preferencesRevision: row.source.editedAtPreferencesRevision }))
      || (actual.status === "unavailable" && !same(row.freshness, actual)))) issue(ctx, "History summaries retain saved revisions and honest unavailable comparisons");
    if (actual.status === "available" && value.systems.items.some(row => row.freshness.status === "unavailable" || (row.name !== actual.basis.name) !== (row.freshness.status === "stale" && row.freshness.changed.includes("name")))) issue(ctx, "Comparable history summaries must describe known name changes and cannot report unavailable comparison");
    if (currentSelection) {
      const { selection, system, freshness } = currentSelection;
      if (!sameScope(value, system) || !atLeast(currentRevisions, selection) || !same(freshness, getIdentityFreshness(system.input.basis, actual))) issue(ctx, "The current selection must retain its exact owned system and current freshness");
      const repeated = value.systems.items.find(row => row.id === system.id);
      if (repeated && !same(repeated, summarizeIdentitySystem(system, actual))) issue(ctx, "Repeated selected-system summaries must match the complete immutable system");
    }
  } catch { issue(ctx, "Overview must preserve validated current inputs while retaining historical systems"); }
});
export type ProjectIdentityOverview = z.infer<typeof projectIdentityOverviewSchema>;
