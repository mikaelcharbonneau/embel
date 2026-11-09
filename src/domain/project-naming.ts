import { z } from "zod";
import { nameTransformInputSchema, nameValueSchema, namingSourceSchema, transformNames } from "./naming";
import { contextSnapshotSchema, missingStrategy, personalitySchema, projectScopeSchema, type ContextSnapshot, type ProjectScope } from "./projects";
import { accountProjectSchema, accountProjectSummarySchema } from "./project-api";
import { getNamingPreferencesReadiness, namingPreferencesV2Schema } from "./naming-brain-preferences";
import { namingChatCheckpointSchema } from "./naming-chat-checkpoint";

export const NAMING_INITIAL_TARGET = 250;
/** Immutable first batches admitted before the 250-name correction remain readable. */
export const NAMING_LEGACY_INITIAL_TARGET = 100;
export const NAMING_MAX_BATCH_SIZE = NAMING_INITIAL_TARGET;
/** Reversible implementation choice for subsequent explicitly requested batches. */
export const NAMING_CONTINUATION_TARGET = 50;
export const NAMING_MAX_PAGE_SIZE = 100;
export const NAMING_MAX_TRANSFORM_HISTORY = 32;
export const NAMING_MUTATION_MAX_BYTES = 32_768;
export const NAMING_MAX_SNAPSHOT_ENTRIES = 10_000;
export const namingTargetCountSchema = z.union([z.literal(NAMING_INITIAL_TARGET), z.literal(NAMING_LEGACY_INITIAL_TARGET), z.literal(NAMING_CONTINUATION_TARGET)]);
export type NamingTargetCount = z.infer<typeof namingTargetCountSchema>;
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const counterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime({ offset: true });
const idempotencyKeySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const policyIdentitySchema = z.string().regex(/^[0-9a-f]{64}$/);
const ownershipFields = { ownerId: z.uuid(), projectId: z.uuid() };

/** Zod clones input; freezing the parsed graph prevents later in-memory snapshot edits. */
function freezeSnapshot<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeSnapshot(item);
    Object.freeze(value);
  }
  return value;
}

export function namingBatchTarget(sequence: number): NamingTargetCount {
  revisionSchema.parse(sequence);
  return sequence === 1 ? NAMING_INITIAL_TARGET : NAMING_CONTINUATION_TARGET;
}

/** Stored contracts accept the original first target; new admission uses namingBatchTarget. */
export function isNamingBatchTargetCompatible(sequence: number, targetCount: NamingTargetCount): boolean {
  return Number.isSafeInteger(sequence) && sequence > 0 && (sequence === 1
    ? targetCount === NAMING_INITIAL_TARGET || targetCount === NAMING_LEGACY_INITIAL_TARGET
    : targetCount === NAMING_CONTINUATION_TARGET);
}

export const namingPreferencesV1Schema = z.strictObject({
  version: z.literal(1), creativeLocale: z.string().trim().min(2).max(30), notes: z.string().trim().max(2000),
  minimumGraphemes: z.number().int().min(1).max(160).nullable(), maximumGraphemes: z.number().int().min(1).max(160).nullable(),
}).refine(value => value.minimumGraphemes === null || value.maximumGraphemes === null || value.minimumGraphemes <= value.maximumGraphemes,
  { message: "Minimum length must not exceed maximum length", path: ["minimumGraphemes"] }).transform(freezeSnapshot);
export const namingPreferencesSchema = z.union([namingPreferencesV1Schema, namingPreferencesV2Schema]).transform(freezeSnapshot);
export type NamingPreferencesV1 = z.infer<typeof namingPreferencesV1Schema>;
export type NamingPreferences = z.infer<typeof namingPreferencesSchema>;

/** An unsaved starting suggestion, never an invented preference revision or answer. */
export function initialNamingPreferences(context: ContextSnapshot): NamingPreferencesV1 {
  return namingPreferencesV1Schema.parse({ version: 1, creativeLocale: context.creativeLocale, notes: context.intake.namingNotes, minimumGraphemes: null, maximumGraphemes: null });
}

export const namingPreferenceRevisionSchema = z.strictObject({
  ...ownershipFields, version: revisionSchema, preferences: namingPreferencesSchema, createdAt: timestampSchema,
}).transform(freezeSnapshot);
export type NamingPreferenceRevision = z.infer<typeof namingPreferenceRevisionSchema>;

const basisSourceSchema = z.strictObject({ url: z.url({ protocol: /^https?$/ }), title: z.string().trim().min(1).max(300) });
export const namingStrategyBasisSchema = z.strictObject({
  version: z.literal(1), description: z.string().max(12000), activity: z.string().max(2000), offering: z.string().max(2000), knownAudience: z.string().max(2000),
  competitors: z.array(z.strictObject({ id: z.uuid(), name: z.string().min(1).max(160), relevance: z.string().max(2000), url: z.url({ protocol: /^https?$/ }).nullable(), origin: z.enum(["user", "research"]), sources: z.array(basisSourceSchema).max(20) })).max(50),
  audience: z.array(z.strictObject({ id: z.uuid(), label: z.string().min(1).max(180), needs: z.array(z.string().min(1).max(2000)).max(12), reason: z.string().max(2000), origin: z.enum(["user", "proposal"]), sources: z.array(basisSourceSchema).max(20) })).max(30),
  personality: personalitySchema.nullable(), positioning: z.string().max(5000),
}).superRefine((basis, ctx) => {
  for (const key of ["competitors", "audience"] as const) {
    const rows = basis[key];
    if (rows.some((row, index) => index > 0 && row.id <= rows[index - 1]!.id)) {
      ctx.addIssue({ code: "custom", path: [key], message: "Retained rows must have unique IDs in ascending UUID order" });
    }
  }
}).transform(freezeSnapshot);
export type NamingStrategyBasis = z.infer<typeof namingStrategyBasisSchema>;

/**
 * Exact v1 JSON projection. SQL derives this from owned saved context and compares
 * JSONB; it need not reproduce JavaScript object-key order. Sources retain their
 * saved order and titles, omitting retrieval times. Retained rows sort by UUID.
 * Review markers govern readiness separately. This is content, not authorization.
 */
export function namingStrategyBasis(context: ContextSnapshot): NamingStrategyBasis {
  const parsed = contextSnapshotSchema.parse(context);
  const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const sources = (rows: ContextSnapshot["competitors"][number]["sources"]) => rows.map(({ url, title }) => ({ url, title }));
  return namingStrategyBasisSchema.parse({
    version: 1, description: parsed.description, activity: parsed.activity, offering: parsed.offering, knownAudience: parsed.knownAudience,
    competitors: parsed.competitors.filter(row => row.selected).map(row => ({ id: row.id, name: row.name, relevance: row.relevance, url: row.url ?? null, origin: row.origin, sources: sources(row.sources) })).sort(byId),
    audience: parsed.audienceSegments.filter(row => row.selected).map(row => ({ id: row.id, label: row.label, needs: row.needs, reason: row.reason, origin: row.origin, sources: sources(row.sources) })).sort(byId),
    personality: parsed.personality, positioning: parsed.positioning,
  });
}

export function namingStrategyKeyFromBasis(basis: NamingStrategyBasis): string {
  return `naming-strategy-v1:${JSON.stringify(namingStrategyBasisSchema.parse(basis))}`;
}
export function namingStrategyKey(context: ContextSnapshot): string { return namingStrategyKeyFromBasis(namingStrategyBasis(context)); }
const strategyKeySchema = z.string().startsWith("naming-strategy-v1:");

export const namingReadinessSchema = z.strictObject({
  ready: z.boolean(), missing: z.array(z.enum(["description", "reformulation", "competitors", "audience", "personality", "positioning"])).max(7),
}).refine(value => new Set(value.missing).size === value.missing.length, { message: "Missing steps must be unique" });
export type NamingReadiness = z.infer<typeof namingReadinessSchema>;

/** Saved account context only; local draft review bindings remain in the editor. */
export function getNamingReadiness(context: ContextSnapshot, scope: ProjectScope): NamingReadiness {
  projectScopeSchema.parse(scope);
  const missing: NamingReadiness["missing"] = [];
  if (!context.description.trim()) missing.push("description");
  const strategy = missingStrategy(context);
  for (const step of ["reformulation", "competitors", "audience", "personality", "positioning"] as const) {
    if (strategy.includes(step) || (step === "audience" && !context.intake.audienceReviewedAt)) missing.push(step);
  }
  return { ready: missing.length === 0, missing };
}

/** Proposed duplicate identity, not linguistic equivalence or legal screening. */
export function nameIdentityKey(value: string): string {
  return nameValueSchema.parse(value).toLowerCase().replace(/[\p{P}\s]/gu, "").normalize("NFC");
}
export const nameIdentityKeySchema = z.string().max(320).refine(value => value === value.toLowerCase().replace(/[\p{P}\s]/gu, "").normalize("NFC") && !/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\p{Surrogate}]/u.test(value), { message: "Use a canonical name identity" });
export const generatedNameProposalSchema = z.strictObject({ value: nameValueSchema, rationale: z.string().trim().min(1).max(2000), caution: z.string().trim().min(1).max(2000).optional() });
export type GeneratedNameProposal = z.infer<typeof generatedNameProposalSchema>;
export const acceptedGeneratedNameSchema = generatedNameProposalSchema.extend({ identityKey: nameIdentityKeySchema.refine(value => value.length > 0, "Generated names require a nonempty identity") }).superRefine((value, ctx) => {
  const name = nameValueSchema.safeParse(value.value);
  if (name.success && nameIdentityKey(name.data) !== value.identityKey) ctx.addIssue({ code: "custom", path: ["identityKey"], message: "Identity must match the name" });
}).transform(freezeSnapshot);
export type AcceptedGeneratedName = z.infer<typeof acceptedGeneratedNameSchema>;
export const namingRejectionCountsSchema = z.strictObject({
  invalid_candidate: counterSchema, empty_identity: counterSchema, below_minimum: counterSchema, above_maximum: counterSchema,
  duplicate_response: counterSchema, duplicate_history: counterSchema, over_target: counterSchema,
});
export type NamingRejectionCounts = z.infer<typeof namingRejectionCountsSchema>;
export function emptyNamingRejectionCounts(): NamingRejectionCounts {
  return { invalid_candidate: 0, empty_identity: 0, below_minimum: 0, above_maximum: 0, duplicate_response: 0, duplicate_history: 0, over_target: 0 };
}

export const namingFavoritesSnapshotSchema = z.array(z.strictObject({ candidateId: z.uuid(), value: nameValueSchema })).max(NAMING_MAX_SNAPSHOT_ENTRIES).refine(rows => new Set(rows.map(row => row.candidateId)).size === rows.length, { message: "Favorite candidate IDs must be unique" }).transform(freezeSnapshot);
/** Verify stored Unicode identities in JS; SQL freezes values without approximating V1 normalization. */
export const namingExclusionSnapshotSchema = z.array(z.strictObject({
  candidateId: z.uuid(), value: nameValueSchema, identityKey: nameIdentityKeySchema,
}).superRefine((entry, ctx) => {
  const value = nameValueSchema.safeParse(entry.value);
  if (value.success && nameIdentityKey(value.data) !== entry.identityKey) ctx.addIssue({ code: "custom", path: ["identityKey"], message: "Exclusion identity must match its historical name value" });
})).max(NAMING_MAX_SNAPSHOT_ENTRIES).refine(rows => new Set(rows.map(row => row.candidateId)).size === rows.length, { message: "Exclusion candidate IDs must be unique" }).transform(freezeSnapshot);
export type NamingExclusionSnapshot = z.infer<typeof namingExclusionSnapshotSchema>;
const strategyFields = { strategyBasis: namingStrategyBasisSchema, strategyKey: strategyKeySchema };
export const legacyNamingBatchSchema = z.strictObject({
  id: z.uuid(), ...ownershipFields, contextRevision: revisionSchema, ...strategyFields,
  preferencesVersion: revisionSchema, preferences: namingPreferencesV1Schema, favoritesSnapshot: namingFavoritesSnapshotSchema,
  acceptedPolicyIdentity: policyIdentitySchema, targetCount: namingTargetCountSchema, sequence: revisionSchema, jobId: z.uuid(), createdAt: timestampSchema,
}).superRefine((batch, ctx) => {
  if (!isNamingBatchTargetCompatible(batch.sequence, batch.targetCount)) ctx.addIssue({ code: "custom", path: ["targetCount"], message: "Target must match the initial or continuation sequence" });
  const basis = namingStrategyBasisSchema.safeParse(batch.strategyBasis);
  if (basis.success && batch.strategyKey !== namingStrategyKeyFromBasis(basis.data)) ctx.addIssue({ code: "custom", path: ["strategyKey"], message: "Strategy key must match its frozen basis" });
}).transform(freezeSnapshot);
export type LegacyNamingBatch = z.infer<typeof legacyNamingBatchSchema>;
export const namingBrainBatchSchema = z.strictObject({
  version: z.literal(2), handlerVersion: z.literal("naming-brain-v1"), billingMode: z.literal("openai_api"), runId: z.uuid(),
  id: z.uuid(), ...ownershipFields, contextRevision: revisionSchema, ...strategyFields,
  preferencesVersion: revisionSchema, preferences: namingPreferencesV2Schema, favoritesSnapshot: namingFavoritesSnapshotSchema,
  acceptedPolicyIdentity: policyIdentitySchema, targetCount: z.literal(100), sequence: revisionSchema, jobId: z.uuid(), createdAt: timestampSchema,
}).superRefine((batch, ctx) => {
  if (batch.strategyKey !== namingStrategyKeyFromBasis(batch.strategyBasis)) ctx.addIssue({ code: "custom", path: ["strategyKey"], message: "Strategy key must match its frozen basis" });
  if (!getNamingPreferencesReadiness(batch.preferences).ready) ctx.addIssue({ code: "custom", path: ["preferences"], message: "An admitted Naming brain batch requires ready saved choices" });
}).transform(freezeSnapshot);
export type NamingBrainBatch = z.infer<typeof namingBrainBatchSchema>;
export const namingBatchSchema = z.union([legacyNamingBatchSchema, namingBrainBatchSchema]);
export type NamingBatch = z.infer<typeof namingBatchSchema>;

const rootFields = { ...ownershipFields, candidateId: z.uuid(), contextRevision: revisionSchema };
export const generatedNamingOriginV1Schema = z.strictObject({
  kind: z.literal("generated"), ...rootFields, value: nameValueSchema.refine(value => value.replace(/[\p{P}\s]/gu, "").length > 0, "Generated ancestry requires a nonempty identity"), batchId: z.uuid(), jobId: z.uuid(), stepKey: z.string().min(1).max(200),
  provider: z.literal("openai"), billingMode: z.literal("chatgpt_subscription"), model: z.string().min(1).max(150),
  responseId: z.string().min(1).max(300), requestId: z.string().min(1).max(300).nullable(), generatedAt: timestampSchema,
});
const generatedV2Fields = {
  kind: z.literal("generated"), version: z.literal(2), handlerVersion: z.literal("naming-brain-v1"), ...rootFields,
  value: nameValueSchema.refine(value => value.replace(/[\p{P}\s]/gu, "").length > 0, "Generated ancestry requires a nonempty identity"),
  batchId: z.uuid(), jobId: z.uuid(), stepKey: z.literal("prepare"), runId: z.uuid(), sourceArtifactId: z.uuid(), sourceStageKey: z.enum(["creation", "gap"]),
  provider: z.literal("openai"), billingMode: z.literal("openai_api"), model: z.string().min(1).max(150), requestId: z.string().min(1).max(300).nullable(),
  providerItemId: z.string().min(1).max(300), generatedAt: timestampSchema,
};
export const generatedNamingOriginV2Schema = z.discriminatedUnion("protocol", [
  z.strictObject({ ...generatedV2Fields, protocol: z.literal("openai_agents"), sessionId: z.string().min(1).max(300), turnId: z.string().min(1).max(300), agentId: z.string().min(1).max(300).nullable(), responseId: z.null() }),
  z.strictObject({ ...generatedV2Fields, protocol: z.literal("openai_responses"), sessionId: z.null(), turnId: z.null(), agentId: z.null(), responseId: z.string().min(1).max(300) }),
]);
export type GeneratedNamingOriginV2 = z.infer<typeof generatedNamingOriginV2Schema>;
export const generatedNamingOriginSchema = z.discriminatedUnion("billingMode", [generatedNamingOriginV1Schema, generatedNamingOriginV2Schema]);
/** Future initial ideation has a distinct honest provenance contract. It is not
 * a researched/verified Naming brain artifact and cannot acquire such claims. */
export const brainstormNamingOriginSchema = z.strictObject({
  kind: z.literal("brainstorm"), version: z.literal(1), profile: z.literal("brainstorm_v1"), ...rootFields,
  value: nameValueSchema, batchId: z.uuid(), jobId: z.uuid(), runId: z.uuid(), callId: z.uuid(),
  responseId: z.string().min(1).max(300), requestId: z.string().min(1).max(300).nullable(),
  model: z.string().min(1).max(150), generatedAt: timestampSchema,
});
export const importedNamingOriginSchema = z.strictObject({ kind: z.literal("local_import"), ...rootFields, source: namingSourceSchema, capturedContext: contextSnapshotSchema });
export const namingRootOriginSchema = z.discriminatedUnion("kind", [generatedNamingOriginSchema, brainstormNamingOriginSchema, importedNamingOriginSchema]);
export type NamingRootOrigin = z.infer<typeof namingRootOriginSchema>;
export const projectNameHistoryStepSchema = z.strictObject({
  transformId: z.uuid(), projectId: z.uuid(), parentCandidateId: z.uuid(), secondaryCandidateId: z.uuid().nullable(), input: nameTransformInputSchema, output: nameValueSchema, createdAt: timestampSchema,
});
const historySchema = z.array(projectNameHistoryStepSchema).max(NAMING_MAX_TRANSFORM_HISTORY);
export const projectNameOriginSchema = z.discriminatedUnion("kind", [
  generatedNamingOriginSchema, brainstormNamingOriginSchema, importedNamingOriginSchema,
  z.strictObject({ kind: z.literal("transform"), authorship: z.literal("user_supplied"), algorithmVersion: z.literal(1), transformId: z.uuid(), parentCandidateId: z.uuid(), secondaryCandidateId: z.uuid().nullable(), root: namingRootOriginSchema, history: historySchema.min(1) }),
  z.strictObject({ kind: z.literal("account_copy"), authorship: z.enum(["generated", "user_supplied"]), sourceProjectId: z.uuid(), sourceCandidateId: z.uuid(), sourceContextRevision: revisionSchema, root: namingRootOriginSchema, history: historySchema }),
]);
export type ProjectNameOrigin = z.infer<typeof projectNameOriginSchema>;

function lineage(origin: ProjectNameOrigin): { root: NamingRootOrigin; history: z.infer<typeof historySchema> } {
  return origin.kind === "transform" || origin.kind === "account_copy" ? { root: origin.root, history: origin.history } : { root: origin, history: [] };
}

/** Read-only provenance; passing this schema never proves ownership of references. */
export const namingVerificationNoteSchema = z.strictObject({ claimKey: z.string().min(1).max(100), originalStatement: z.string().min(1).max(2000), status: z.enum(["supported", "corrected", "unresolved", "contradicted"]), explanation: z.string().min(1).max(2000) });
export const projectNameCandidateSchema = z.strictObject({
  id: z.uuid(), ...ownershipFields, value: nameValueSchema, identityKey: nameIdentityKeySchema,
  rationale: generatedNameProposalSchema.shape.rationale, caution: generatedNameProposalSchema.shape.caution,
  verificationNotes: z.array(namingVerificationNoteSchema).max(8).optional(),
  contextRevision: revisionSchema, ...strategyFields, origin: projectNameOriginSchema, createdAt: timestampSchema,
}).superRefine((candidate, ctx) => {
  if (candidate.verificationNotes && (candidate.origin.kind === "brainstorm" ? candidate.verificationNotes.length !== 0 : candidate.origin.kind !== "generated" || candidate.origin.billingMode !== "openai_api" || new Set(candidate.verificationNotes.map(note => note.claimKey)).size !== candidate.verificationNotes.length)) ctx.addIssue({ code: "custom", path: ["verificationNotes"], message: "Verification findings require a managed original with unique claim keys" });
  const name = nameValueSchema.safeParse(candidate.value);
  if (name.success && nameIdentityKey(name.data) !== candidate.identityKey) ctx.addIssue({ code: "custom", path: ["identityKey"], message: "Identity must match the candidate value" });
  const basis = namingStrategyBasisSchema.safeParse(candidate.strategyBasis);
  if (basis.success && candidate.strategyKey !== namingStrategyKeyFromBasis(basis.data)) ctx.addIssue({ code: "custom", path: ["strategyKey"], message: "Strategy key must match the recorded basis" });
  const { root, history } = lineage(candidate.origin);
  if (root.ownerId !== candidate.ownerId) ctx.addIssue({ code: "custom", path: ["origin"], message: "Root must belong to the candidate owner" });
  const ownRoot = candidate.origin.kind === "generated" || candidate.origin.kind === "brainstorm" || candidate.origin.kind === "local_import";
  if (ownRoot && (root.candidateId !== candidate.id || root.projectId !== candidate.projectId || root.contextRevision !== candidate.contextRevision)) ctx.addIssue({ code: "custom", path: ["origin"], message: "Direct origin must bind this candidate and saved revision" });
  if (candidate.origin.kind === "generated" && !candidate.identityKey) ctx.addIssue({ code: "custom", path: ["identityKey"], message: "Generated names need a nonempty identity" });
  const importedDepth = root.kind === "local_import" ? root.source.history.length : 0;
  if (history.length + importedDepth > NAMING_MAX_TRANSFORM_HISTORY) ctx.addIssue({ code: "custom", path: ["origin", "history"], message: "Preserve at most 32 total transformation steps" });
  let previous = root.kind !== "local_import" ? root.value : root.source.value;
  let lastExplanation: string | undefined;
  const stepIds = new Set<string>();
  // Do not replay an oversized or already-invalid nested transform input.
  if (history.length <= NAMING_MAX_TRANSFORM_HISTORY) history.forEach((step, index) => {
    if (stepIds.has(step.transformId)) ctx.addIssue({ code: "custom", path: ["origin", "history", index], message: "Transformation identifiers must be unique" });
    stepIds.add(step.transformId);
    const input = nameTransformInputSchema.safeParse(step.input);
    if (!input.success) return;
    const seed = input.data.kind === "blend" ? input.data.left : input.data.seed;
    const replayed = transformNames(input.data).candidates.find(row => row.value === step.output);
    if (seed !== previous || (input.data.kind === "blend") !== (step.secondaryCandidateId !== null) || !replayed) {
      ctx.addIssue({ code: "custom", path: ["origin", "history", index], message: "History must replay V1 from the previous value with its required parents" });
    }
    previous = step.output;
    lastExplanation = replayed?.explanation;
  });
  if (previous !== candidate.value) ctx.addIssue({ code: "custom", path: ["value"], message: "Candidate must equal the root or last replayed output" });
  if (history.length && lastExplanation !== candidate.rationale) ctx.addIssue({ code: "custom", path: ["rationale"], message: "Derived names retain the V1 transform explanation, never generated authorship" });
  if (candidate.origin.kind === "transform") {
    const last = history.at(-1);
    if (!last || last.projectId !== candidate.projectId || last.transformId !== candidate.origin.transformId || last.parentCandidateId !== candidate.origin.parentCandidateId || last.secondaryCandidateId !== candidate.origin.secondaryCandidateId || candidate.origin.parentCandidateId === candidate.id || candidate.origin.secondaryCandidateId === candidate.id) {
      ctx.addIssue({ code: "custom", path: ["origin"], message: "Current transform must match the last immutable history step" });
    }
  }
  if (candidate.origin.kind === "account_copy") {
    const authorship = (root.kind === "generated" || root.kind === "brainstorm") && history.length === 0 ? "generated" : "user_supplied";
    if (candidate.origin.authorship !== authorship || candidate.origin.sourceProjectId === candidate.projectId || candidate.origin.sourceCandidateId === candidate.id) ctx.addIssue({ code: "custom", path: ["origin"], message: "Account copies preserve source authorship and create a new candidate in a different project" });
  }
}).transform(freezeSnapshot);
export type ProjectNameCandidate = z.infer<typeof projectNameCandidateSchema>;

export const nameSelectionSchema = z.strictObject({
  id: z.uuid(), ...ownershipFields, candidateId: z.uuid(), projectRevision: revisionSchema,
  previousSelectionId: z.uuid().nullable(), acceptedEarlierContext: z.boolean(), createdAt: timestampSchema,
}).refine(value => value.id !== value.previousSelectionId, { message: "A new selection must reference an earlier selection", path: ["previousSelectionId"] }).transform(freezeSnapshot);
export type NameSelection = z.infer<typeof nameSelectionSchema>;
export const nameRetentionSchema = z.strictObject({
  ...ownershipFields, candidateId: z.uuid(), revision: counterSchema, favorite: z.boolean(), saved: z.boolean(), updatedAt: timestampSchema.nullable(),
}).refine(value => value.revision === 0 ? !value.favorite && !value.saved && value.updatedAt === null : value.updatedAt !== null, { message: "Revision zero denotes untouched retention only" });
export type NameRetention = z.infer<typeof nameRetentionSchema>;
export const namingListFilterSchema = z.enum(["all", "retained", "favorite", "saved"]);
export const namingViewStateSchema = z.strictObject({
  pane: z.enum(["results", "screening", "workshop"]), conversationOpen: z.boolean(), filter: namingListFilterSchema, query: z.string().max(200),
  visibleBatchId: z.uuid().nullable(), scrollCandidateId: z.uuid().nullable(), workshopCandidateId: z.uuid().nullable(),
  namingChat: namingChatCheckpointSchema.optional(),
});
export type NamingViewState = z.infer<typeof namingViewStateSchema>;
export const namingSessionSchema = z.strictObject({
  ...ownershipFields, revision: revisionSchema, currentPreferencesVersion: counterSchema, latestBatchSequence: counterSchema,
  currentSelectionId: z.uuid().nullable(), viewRevision: revisionSchema, viewState: namingViewStateSchema, createdAt: timestampSchema, updatedAt: timestampSchema,
});
export type NamingSession = z.infer<typeof namingSessionSchema>;

export const updateNamingPreferencesSchema = z.strictObject({ expectedPreferencesVersion: counterSchema, preferences: namingPreferencesSchema });
export type UpdateNamingPreferences = z.infer<typeof updateNamingPreferencesSchema>;
export const updateNameRetentionSchema = z.strictObject({ candidateId: z.uuid(), expectedRevision: counterSchema, favorite: z.boolean(), saved: z.boolean() });
export type UpdateNameRetention = z.infer<typeof updateNameRetentionSchema>;
export const selectProjectNameSchema = z.strictObject({ candidateId: z.uuid(), expectedRevision: revisionSchema, acceptEarlierContext: z.boolean() });
export type SelectProjectName = z.infer<typeof selectProjectNameSchema>;
export const updateNamingViewStateSchema = z.strictObject({ expectedViewRevision: revisionSchema, viewState: namingViewStateSchema });
export type UpdateNamingViewState = z.infer<typeof updateNamingViewStateSchema>;
export const transformProjectNamesSchema = z.strictObject({ parentCandidateId: z.uuid(), secondaryCandidateId: z.uuid().optional(), input: nameTransformInputSchema, idempotencyKey: idempotencyKeySchema })
  .refine(value => (value.input.kind === "blend") === (value.secondaryCandidateId !== undefined), { message: "Exactly Blend requires a secondary owned candidate", path: ["secondaryCandidateId"] });
export type TransformProjectNames = z.infer<typeof transformProjectNamesSchema>;
export const importProjectNameSchema = z.strictObject({ expectedProjectRevision: revisionSchema, source: namingSourceSchema, capturedContext: contextSnapshotSchema, idempotencyKey: idempotencyKeySchema });
export type ImportProjectName = z.infer<typeof importProjectNameSchema>;
export const createBrandFromProjectNameSchema = z.strictObject({ sourceProjectId: z.uuid(), sourceCandidateId: z.uuid(), expectedSourceProjectRevision: revisionSchema, title: z.string().trim().min(1).max(160), idempotencyKey: idempotencyKeySchema, acceptEarlierContext: z.boolean().default(false) });
export type CreateBrandFromProjectName = z.infer<typeof createBrandFromProjectNameSchema>;

/** Ownership still requires DB lookups; this rejects mismatched loaded parents. */
export function validateProjectNameTransformParents(request: TransformProjectNames, parent: ProjectNameCandidate, secondary?: ProjectNameCandidate): void {
  const input = transformProjectNamesSchema.parse(request), primary = projectNameCandidateSchema.parse(parent);
  if (primary.id !== input.parentCandidateId) throw new Error("Parent candidate mismatch");
  const root = lineage(primary.origin);
  if (root.history.length + (root.root.kind === "local_import" ? root.root.source.history.length : 0) >= NAMING_MAX_TRANSFORM_HISTORY) throw new Error("Transformation history limit reached");
  if (input.input.kind === "blend") {
    const other = projectNameCandidateSchema.parse(secondary);
    if (other.id !== input.secondaryCandidateId || other.ownerId !== primary.ownerId || other.projectId !== primary.projectId || input.input.left !== primary.value || input.input.right !== other.value) throw new Error("Blend parents must match the owned input values");
  } else if (secondary || input.input.seed !== primary.value) throw new Error("Transform seed must match its owned parent");
}

export const nameTransformSchema = z.strictObject({
  id: z.uuid(), ...ownershipFields, parentCandidateId: z.uuid(), secondaryCandidateId: z.uuid().nullable(), algorithmVersion: z.literal(1), input: nameTransformInputSchema,
  outputs: z.array(z.strictObject({ candidateId: z.uuid(), value: nameValueSchema, explanation: z.string().min(1).max(2000) })).max(64),
  truncated: z.boolean(), notes: z.array(z.string().min(1).max(2000)).max(20), createdAt: timestampSchema,
}).superRefine((record, ctx) => {
  const input = nameTransformInputSchema.safeParse(record.input);
  if (!input.success) return;
  const replay = transformNames(input.data);
  if ((input.data.kind === "blend") !== (record.secondaryCandidateId !== null) || new Set(record.outputs.map(row => row.candidateId)).size !== record.outputs.length || JSON.stringify(record.outputs.map(({ value, explanation }) => ({ value, explanation }))) !== JSON.stringify(replay.candidates) || record.truncated !== replay.truncated || JSON.stringify(record.notes) !== JSON.stringify(replay.notes)) {
    ctx.addIssue({ code: "custom", message: "Transform outputs and explanations must replay exactly under V1" });
  }
}).transform(freezeSnapshot);
export type NameTransform = z.infer<typeof nameTransformSchema>;

function sameScope(left: { ownerId: string; projectId: string }, right: { ownerId: string; projectId: string }): boolean { return left.ownerId === right.ownerId && left.projectId === right.projectId; }
export const projectNameEntrySchema = z.strictObject({ candidate: projectNameCandidateSchema, retention: nameRetentionSchema }).refine(value => sameScope(value.candidate, value.retention) && value.candidate.id === value.retention.candidateId, { message: "Retention must belong to this owned candidate" });
export type ProjectNameEntry = z.infer<typeof projectNameEntrySchema>;
export const namingCursorSchema = z.strictObject({ createdAt: timestampSchema, id: z.uuid() });
export type NamingCursor = z.infer<typeof namingCursorSchema>;
export const listProjectNamesSchema = z.strictObject({ cursor: namingCursorSchema.optional(), limit: z.number().int().min(1).max(NAMING_MAX_PAGE_SIZE).default(50), filter: namingListFilterSchema.default("all"), batchId: z.uuid().optional(), query: z.string().max(200).default("") });
export type ListProjectNames = z.infer<typeof listProjectNamesSchema>;
export const listNamingBatchesSchema = z.strictObject({ cursor: namingCursorSchema.optional(), limit: z.number().int().min(1).max(NAMING_MAX_PAGE_SIZE).default(50) });
export type ListNamingBatches = z.infer<typeof listNamingBatchesSchema>;
export const projectNamePageSchema = z.strictObject({ ...ownershipFields, items: z.array(projectNameEntrySchema).max(NAMING_MAX_PAGE_SIZE), nextCursor: namingCursorSchema.nullable() }).superRefine((page, ctx) => {
  if (page.items.some(row => !sameScope(page, row.candidate)) || new Set(page.items.map(row => row.candidate.id)).size !== page.items.length) ctx.addIssue({ code: "custom", path: ["items"], message: "Page rows must be unique and belong to this owner and project" });
  const last = page.items.at(-1)?.candidate;
  if (page.nextCursor && (!last || last.id !== page.nextCursor.id || last.createdAt !== page.nextCursor.createdAt)) ctx.addIssue({ code: "custom", path: ["nextCursor"], message: "Continuation cursor must anchor the final returned row" });
});
export type ProjectNamePage = z.infer<typeof projectNamePageSchema>;
export const listAccountNamesSchema = z.strictObject({ cursor: namingCursorSchema.optional(), limit: z.number().int().min(1).max(NAMING_MAX_PAGE_SIZE).default(50), filter: namingListFilterSchema.default("all"), query: z.string().max(200).default("") });
export type ListAccountNames = z.infer<typeof listAccountNamesSchema>;
export const accountNameEntrySchema = z.strictObject({ candidate: projectNameCandidateSchema, retention: nameRetentionSchema, project: accountProjectSummarySchema.strict(), currentSelection: z.boolean(), earlierContext: z.boolean() }).refine(value => sameScope(value.candidate, value.retention) && value.retention.candidateId === value.candidate.id && value.project.owner_id === value.candidate.ownerId && value.project.id === value.candidate.projectId && value.project.current_revision >= value.candidate.contextRevision, { message: "Library candidate and retention must belong to the owned project summary" });
export type AccountNameEntry = z.infer<typeof accountNameEntrySchema>;
export const accountNamesPageSchema = z.strictObject({ ownerId: z.uuid(), items: z.array(accountNameEntrySchema).max(NAMING_MAX_PAGE_SIZE), nextCursor: namingCursorSchema.nullable() }).superRefine((page, ctx) => {
  if (page.items.some(row => row.candidate.ownerId !== page.ownerId) || new Set(page.items.map(row => row.candidate.id)).size !== page.items.length) ctx.addIssue({ code: "custom", path: ["items"], message: "Library rows must have unique candidate IDs belonging to the verified owner" });
  const last = page.items.at(-1)?.candidate;
  if (page.nextCursor && (!last || last.id !== page.nextCursor.id || last.createdAt !== page.nextCursor.createdAt)) ctx.addIssue({ code: "custom", path: ["nextCursor"], message: "Continuation cursor must anchor the final returned candidate" });
});
export type AccountNamesPage = z.infer<typeof accountNamesPageSchema>;
export const currentNameSelectionSchema = z.strictObject({ selection: nameSelectionSchema, candidate: projectNameCandidateSchema }).refine(value => sameScope(value.selection, value.candidate) && value.selection.candidateId === value.candidate.id, { message: "Selection must reference this owned candidate" });
export type CurrentNameSelection = z.infer<typeof currentNameSelectionSchema>;

export const updateNamingPreferencesResponseSchema = z.strictObject({ session: namingSessionSchema, preferences: namingPreferenceRevisionSchema }).refine(value => sameScope(value.session, value.preferences) && value.session.currentPreferencesVersion === value.preferences.version, { message: "Preference response must match the current session version" });
export const updateNameRetentionResponseSchema = z.strictObject({ entry: projectNameEntrySchema });
export const updateNamingViewStateResponseSchema = z.strictObject({ session: namingSessionSchema });
export const selectProjectNameResponseSchema = z.strictObject({ project: accountProjectSchema.strict(), session: namingSessionSchema, currentSelection: currentNameSelectionSchema }).superRefine((value, ctx) => {
  const { project, session, currentSelection: { selection, candidate } } = value;
  if (project.id !== session.projectId || project.owner_id !== session.ownerId || !sameScope(session, selection) || session.currentSelectionId !== selection.id || project.current_revision !== selection.projectRevision || project.context.selectedName !== candidate.value || project.context.intake.suppliedName !== candidate.value) ctx.addIssue({ code: "custom", message: "Selection, session and project name must match the new revision" });
});
export const importProjectNameResponseSchema = z.strictObject({ entry: projectNameEntrySchema }).refine(value => value.entry.candidate.origin.kind === "local_import", { message: "Local import responses preserve user-supplied origin" });
export const transformProjectNamesResponseSchema = z.strictObject({ transform: nameTransformSchema, entries: z.array(projectNameEntrySchema).max(64) }).superRefine((value, ctx) => {
  if (value.entries.length !== value.transform.outputs.length || value.entries.some((entry, index) => {
    const output = value.transform.outputs[index], origin = entry.candidate.origin;
    return !sameScope(value.transform, entry.candidate) || entry.candidate.id !== output?.candidateId || entry.candidate.value !== output.value || origin.kind !== "transform" || origin.transformId !== value.transform.id;
  })) ctx.addIssue({ code: "custom", message: "Returned candidates must match every output of this owned transform" });
});
export const createBrandFromProjectNameResponseSchema = selectProjectNameResponseSchema.refine(value => value.project.scope === "complete_brand" && value.currentSelection.candidate.origin.kind === "account_copy", { message: "Account promotion creates a complete brand with explicit copied provenance" });
export const projectNameResponseSchema = z.strictObject({ entry: projectNameEntrySchema });
export type UpdateNamingPreferencesResponse = z.infer<typeof updateNamingPreferencesResponseSchema>;
export type UpdateNameRetentionResponse = z.infer<typeof updateNameRetentionResponseSchema>;
export type UpdateNamingViewStateResponse = z.infer<typeof updateNamingViewStateResponseSchema>;
export type SelectProjectNameResponse = z.infer<typeof selectProjectNameResponseSchema>;
export type ImportProjectNameResponse = z.infer<typeof importProjectNameResponseSchema>;
export type TransformProjectNamesResponse = z.infer<typeof transformProjectNamesResponseSchema>;
export type CreateBrandFromProjectNameResponse = z.infer<typeof createBrandFromProjectNameResponseSchema>;
