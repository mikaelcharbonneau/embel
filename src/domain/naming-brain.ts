import { z } from "zod";
import { nameValueSchema } from "./naming";
import { nameIdentityKey, nameIdentityKeySchema, namingStrategyBasisSchema, namingStrategyKeyFromBasis, projectNameEntrySchema } from "./project-naming";
import { getNamingPreferencesReadiness, matchesNamingTextFragment, namingApproachSchema, namingPreferencesV2Schema, type NamingApproach } from "./naming-brain-preferences";
export * from "./naming-brain-preferences";

export const NAMING_BRAIN_HANDLER_VERSION = "naming-brain-v1";
export const NAMING_BRAIN_SCHEMA_VERSION = 1;
export const NAMING_BRAIN_PROMPT_VERSION = "naming-brain-v1";
export const NAMING_BRAIN_TARGET_COUNT = 100;
export const NAMING_BRAIN_PRIMARY_FLOOR = 5;
export const NAMING_BRAIN_INITIAL_RAW_CAP = 150;
export const NAMING_BRAIN_GAP_RAW_CAP = 50;
export const NAMING_BRAIN_MAX_CANDIDATES = 200;
export const namingStageKeySchema = z.enum(["research", "direction", "creation", "curation", "verification", "gap", "prepare"]);
export type NamingStageKey = z.infer<typeof namingStageKeySchema>;
export const namingRoleSchema = z.enum(["researcher", "director", "creator", "curator", "verifier"]);
export type NamingRole = z.infer<typeof namingRoleSchema>;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const localKey = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const requestKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const providerId = z.string().min(1).max(300);
const text = z.string().trim().min(1).max(2000).refine(value => !/[\p{Cc}\p{Bidi_Control}]/u.test(value) && /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Mark}\u2800]/u.test(value), "Text must be visible and contain no controls");
const sourceKeys = z.array(localKey).max(20).refine(unique, "Source keys must be unique");
const candidateRefs = { assignmentKey: localKey, candidateKey: localKey };
const rolesForStage: Record<NamingStageKey, NamingRole[]> = { research: ["researcher"], direction: ["director"], creation: ["creator"], curation: ["curator"], verification: ["verifier"], gap: ["director", "creator", "curator", "verifier"], prepare: [] };
function unique(values: readonly unknown[]): boolean { return new Set(values).size === values.length; }
function freeze<T>(value: T): T { if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function issue(ctx: z.RefinementCtx, message: string, path: (string | number)[] = []): void { ctx.addIssue({ code: "custom", message, path }); }
function boundedBytes(value: unknown, limit: number): boolean { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= limit; }
function refKey(value: { assignmentKey: string; candidateKey: string }): string { return `${value.assignmentKey}/${value.candidateKey}`; }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

const exampleSchema = z.strictObject({ candidateId: z.uuid(), value: nameValueSchema, primaryApproach: namingApproachSchema.nullable() });
export const namingBriefSnapshotSchema = z.strictObject({
  version: z.literal(1), ownerId: z.uuid(), projectId: z.uuid(), contextRevision: revision,
  strategyBasis: namingStrategyBasisSchema, strategyKey: z.string().startsWith("naming-strategy-v1:"), preferencesVersion: revision, preferences: namingPreferencesV2Schema,
  feedbackRevision: counter, steeringRevision: counter, strongSeedIds: z.array(z.uuid()).max(5).refine(unique), steeringInstruction: text.nullable(),
  recentExamples: z.array(exampleSchema).max(50), likedExamples: z.array(exampleSchema).max(30),
  patternSummaries: z.array(z.strictObject({ pattern: text, count: counter, interpretation: text.nullable() })).max(30), snapshotHash: hash,
}).superRefine((value, ctx) => {
  if (value.strategyKey !== namingStrategyKeyFromBasis(value.strategyBasis)) issue(ctx, "Strategy key must match the frozen basis", ["strategyKey"]);
  for (const field of ["recentExamples", "likedExamples"] as const) if (!unique(value[field].map(row => row.candidateId))) issue(ctx, "Snapshot example IDs must be unique", [field]);
  if (!boundedBytes(value, 100_000)) issue(ctx, "Naming snapshot exceeds the bounded prompt material");
}).transform(freeze);
export type NamingBriefSnapshot = z.infer<typeof namingBriefSnapshotSchema>;

export const namingProtocolSchema = z.enum(["openai_agents", "openai_responses"]);
export type NamingProtocol = z.infer<typeof namingProtocolSchema>;
const observationScope = { scope: z.enum(["session", "turn", "agent", "call", "response"]), scopeId: providerId, observedAt: timestamp };
const receiptFields = {
  version: z.literal(1), provider: z.literal("openai"), billingMode: z.literal("openai_api"), runId: z.uuid(), stageKey: namingStageKeySchema, role: namingRoleSchema,
  snapshotHash: hash, requestKey, providerCallKey: localKey, assignmentKey: localKey.nullable(), requestHash: hash, sessionLimitCents: z.number().int().min(1).max(150), dispatchState: z.enum(["not_dispatched", "dispatched", "unknown"]), requestId: providerId.nullable(),
  callIds: z.array(providerId).max(200).refine(unique), observedModel: z.string().min(1).max(150).nullable(),
  toolCalls: z.array(z.strictObject({ callId: providerId, type: z.enum(["web_search", "function", "subagent", "other"]), providerItemId: providerId.nullable(), status: z.enum(["started", "completed", "failed", "unknown"]) })).max(200),
  artifactItemIds: z.array(providerId).max(500).refine(unique),
  usageObservations: z.array(z.strictObject({ ...observationScope, inputTokens: counter.nullable(), outputTokens: counter.nullable(), totalTokens: counter.nullable() })).max(200),
  estimatedCostMicrousd: counter.nullable(),
  providerCostCounters: z.array(z.strictObject({ ...observationScope, kind: z.literal("consumed_usd_cents"), value: counter })).max(200),
  accountingStatus: z.enum(["provisional", "confirmed"]), confirmedActualCostMicrousd: counter.nullable(), recordedAt: timestamp,
};
export const namingProviderReceiptSchema = z.discriminatedUnion("protocol", [
  z.strictObject({ ...receiptFields, protocol: z.literal("openai_agents"), sessionId: providerId.nullable(), turnId: providerId.nullable(), agentId: providerId.nullable(), responseId: z.null() }),
  z.strictObject({ ...receiptFields, protocol: z.literal("openai_responses"), sessionId: z.null(), turnId: z.null(), agentId: z.null(), responseId: providerId.nullable() }),
]).superRefine((value, ctx) => {
  if ((value.role === "creator") !== (value.assignmentKey !== null)) issue(ctx, "Creator call receipts require the exact assignment key");
  if (!rolesForStage[value.stageKey].includes(value.role)) issue(ctx, "Provider role must match the stage");
  if (!unique(value.toolCalls.map(call => call.callId))) issue(ctx, "Retained tool calls must be unique");
  if ((value.accountingStatus === "confirmed") !== (value.confirmedActualCostMicrousd !== null)) issue(ctx, "Confirmed expense is separate from provisional estimates and counters");
  if (value.turnId !== null && value.sessionId === null) issue(ctx, "A known turn requires its observed session");
  if (value.dispatchState === "not_dispatched" && (value.sessionId !== null || value.turnId !== null || value.agentId !== null || value.responseId !== null || value.callIds.length || value.toolCalls.length || value.artifactItemIds.length || value.usageObservations.length || value.providerCostCounters.length || value.confirmedActualCostMicrousd !== null)) issue(ctx, "A no-dispatch receipt cannot claim provider execution or settlement");
}).transform(freeze);
export type NamingProviderReceipt = z.infer<typeof namingProviderReceiptSchema>;

const evidenceProvenanceSchema = z.discriminatedUnion("protocol", [
  z.strictObject({ protocol: z.literal("openai_agents"), sessionId: providerId, turnId: providerId, responseId: z.null(), itemId: providerId, observedUrl: z.url({ protocol: /^https?$/ }).max(2000) }),
  z.strictObject({ protocol: z.literal("openai_responses"), sessionId: z.null(), turnId: z.null(), responseId: providerId, itemId: providerId, observedUrl: z.url({ protocol: /^https?$/ }).max(2000) }),
]);
/** These fields are attached from retained transport evidence, never supplied by a model. */
export const namingEvidenceSourceSchema = z.strictObject({
  sourceKey: localKey, url: z.url({ protocol: /^https?$/ }).max(2000), title: z.string().trim().min(1).max(300), retrievedAt: timestamp,
  providerItemId: providerId, provenance: evidenceProvenanceSchema.nullable(), retrieval: z.strictObject({ retrievedAt: timestamp, responseHash: hash, extractorVersion: z.string().min(1).max(100), truncated: z.boolean() }).nullable(), evidenceStatus: z.enum(["retrieved", "unretrieved"]), excerpt: z.string().min(1).max(8000).refine(value => value.trim().length > 0, "Retrieved text cannot be whitespace only").nullable(), contentHash: hash.nullable(),
}).superRefine((value, ctx) => {
  if (value.evidenceStatus === "retrieved" ? value.excerpt === null || value.contentHash === null || value.provenance === null || value.retrieval === null : value.excerpt !== null || value.contentHash !== null || value.retrieval !== null) issue(ctx, "Only actually retrieved text has an excerpt, hashes and retrieval provenance");
  if (value.provenance && (value.provenance.itemId !== value.providerItemId || value.provenance.observedUrl !== value.url)) issue(ctx, "Source provenance must bind the actually observed item and URL");
  if (value.retrieval && value.retrieval.retrievedAt !== value.retrievedAt) issue(ctx, "Source retrieval timestamps must agree");
});
export type NamingEvidenceSource = z.infer<typeof namingEvidenceSourceSchema>;
const sourcesSchema = z.array(namingEvidenceSourceSchema).max(80).refine(rows => unique(rows.map(row => row.sourceKey)), "Source keys must be unique");
const factualClaimFields = { claimKey: localKey, statement: text, sourceKeys, status: z.literal("unverified") };
export const namingFactualClaimSchema = z.strictObject({ ...factualClaimFields, requirement: z.enum(["optional", "primary_approach"]) });
export type NamingFactualClaim = z.infer<typeof namingFactualClaimSchema>;
export const namingResearchOutputSchema = z.strictObject({
  role: z.literal("researcher"),
  territories: z.array(z.strictObject({ territoryId: localKey, title: z.string().trim().min(1).max(160), direction: text, sourceKeys })).min(2).max(30),
  facts: z.array(z.strictObject(factualClaimFields)).max(100),
  interpretations: z.array(z.strictObject({ interpretationKey: localKey, statement: text, sourceKeys })).max(50), uncertainties: z.array(text).max(30),
}).superRefine((value, ctx) => {
  if (!unique(value.territories.map(row => row.territoryId)) || !unique(value.facts.map(row => row.claimKey)) || !unique(value.interpretations.map(row => row.interpretationKey))) issue(ctx, "Research local keys must be unique");
  if (value.facts.some(fact => !fact.sourceKeys.length)) issue(ctx, "A sourced fact requires a supporting source reference", ["facts"]);
});
export type NamingResearchOutput = z.infer<typeof namingResearchOutputSchema>;
const additionalApproaches = z.array(namingApproachSchema).max(10).refine(unique, "Additional approach tags must be unique");
export const namingCreatorAssignmentSchema = z.strictObject({
  assignmentKey: localKey, primaryApproach: namingApproachSchema, additionalApproaches, territoryId: localKey, constructionKey: localKey,
  direction: text, targetCount: z.number().int().min(1).max(150), sourceKeys, avoidPatterns: z.array(text).max(20), freshTerritory: z.boolean(),
}).refine(value => !value.additionalApproaches.includes(value.primaryApproach), "The primary approach cannot also be an additional tag");
export type NamingCreatorAssignment = z.infer<typeof namingCreatorAssignmentSchema>;
export const namingAssignmentOutputSchema = z.strictObject({
  role: z.literal("director"), round: z.enum(["initial", "gap"]), assignments: z.array(namingCreatorAssignmentSchema).min(1).max(30), feedbackHypotheses: z.array(text).max(20),
}).refine(value => unique(value.assignments.map(row => row.assignmentKey)), "Assignment keys must be unique");
export type NamingAssignmentOutput = z.infer<typeof namingAssignmentOutputSchema>;
export const namingCandidateProposalSchema = z.strictObject({
  candidateKey: localKey, value: nameValueSchema, primaryApproach: namingApproachSchema, additionalApproaches, territoryId: localKey, constructionKey: localKey,
  rationale: text, caution: text.nullable(), claims: z.array(namingFactualClaimSchema).max(8),
}).superRefine((value, ctx) => {
  if (value.additionalApproaches.includes(value.primaryApproach)) issue(ctx, "A name receives one primary coverage credit");
  if (!unique(value.claims.map(claim => claim.claimKey))) issue(ctx, "Candidate claim keys must be unique");
});
export type NamingCandidateProposal = z.infer<typeof namingCandidateProposalSchema>;
export const namingCreatorOutputSchema = z.strictObject({ role: z.literal("creator"), assignmentKey: localKey, candidates: z.array(namingCandidateProposalSchema).max(150) })
  .refine(value => unique(value.candidates.map(row => row.candidateKey)), "Candidate local keys must be unique");
export type NamingCreatorOutput = z.infer<typeof namingCreatorOutputSchema>;
export const namingHardRejectionReasonSchema = z.enum(["invalid_candidate", "empty_identity", "below_minimum", "above_maximum", "required_text", "excluded_text", "duplicate_response", "duplicate_history", "unsupported_primary_claim"]);
export type NamingHardRejectionReason = z.infer<typeof namingHardRejectionReasonSchema>;
export const namingCurationOutputSchema = z.strictObject({ role: z.literal("curator"),
  annotations: z.array(z.strictObject({ ...candidateRefs, concerns: z.array(text).max(8), suggestedRejection: namingHardRejectionReasonSchema.nullable() })).max(200),
  gaps: z.array(z.strictObject({ approach: namingApproachSchema.nullable(), territoryId: localKey.nullable(), explanation: text })).max(30),
}).refine(value => unique(value.annotations.map(refKey)), "Curator candidate references must be unique");
export type NamingCurationOutput = z.infer<typeof namingCurationOutputSchema>;
/** Offsets index the retained excerpt's UTF-16 code units, matching String.slice. */
export const namingEvidenceQuoteSchema = z.strictObject({ sourceKey: localKey, start: z.number().int().min(0).max(7999), end: z.number().int().min(1).max(8000), quote: z.string().min(1).max(2000) })
  .refine(value => value.end > value.start && value.end - value.start === value.quote.length, "Quote bounds must describe its exact retained text");
export type NamingEvidenceQuote = z.infer<typeof namingEvidenceQuoteSchema>;
const evidenceQuotes = z.array(namingEvidenceQuoteSchema).max(10);
export const namingVerificationFindingSchema = z.strictObject({
  ...candidateRefs, claimKey: localKey, status: z.enum(["supported", "corrected", "unresolved", "contradicted"]), supportedWording: text.nullable(), sourceKeys,
  evidence: evidenceQuotes, supportsPrimaryApproach: z.boolean(), explanation: text,
}).superRefine((value, ctx) => {
  const supported = value.status === "supported" || value.status === "corrected";
  if (supported ? value.supportedWording === null || !value.sourceKeys.length || !value.evidence.length : value.supportedWording !== null || value.supportsPrimaryApproach) issue(ctx, "Supported wording and route credit require claim-level source evidence");
  if (value.evidence.some(quote => !value.sourceKeys.includes(quote.sourceKey)) || (supported && value.sourceKeys.some(key => !value.evidence.some(quote => quote.sourceKey === key)))) issue(ctx, "Each supporting source must have an exact quoted passage");
});
export type NamingVerificationFinding = z.infer<typeof namingVerificationFindingSchema>;
export const namingVerificationOutputSchema = z.strictObject({ role: z.literal("verifier"), findings: z.array(namingVerificationFindingSchema).max(1600) })
  .refine(value => unique(value.findings.map(row => `${refKey(row)}/${row.claimKey}`)), "Claim findings must be unique");
export type NamingVerificationOutput = z.infer<typeof namingVerificationOutputSchema>;
export const namingModelOutputSchema = z.union([namingResearchOutputSchema, namingAssignmentOutputSchema, namingCreatorOutputSchema, namingCurationOutputSchema, namingVerificationOutputSchema])
  .refine(value => boundedBytes(value, 524_288), "Completed role output exceeds its byte limit");
export type NamingModelOutput = z.infer<typeof namingModelOutputSchema>;

const envelopeFields = { artifactId: z.uuid(), runId: z.uuid(), stageKey: namingStageKeySchema, snapshotHash: hash, schemaVersion: z.literal(NAMING_BRAIN_SCHEMA_VERSION), promptVersion: z.literal(NAMING_BRAIN_PROMPT_VERSION), providerReceipt: namingProviderReceiptSchema };
function checkEnvelope(value: { runId: string; stageKey: NamingStageKey; snapshotHash: string; providerReceipt: NamingProviderReceipt; output: { role: NamingRole } }, ctx: z.RefinementCtx): void {
  const receipt = value.providerReceipt;
  if (value.runId !== receipt.runId || value.stageKey !== receipt.stageKey || value.snapshotHash !== receipt.snapshotHash || value.output.role !== receipt.role) issue(ctx, "Artifact must bind its exact server-recorded provider receipt");
  if (receipt.dispatchState !== "dispatched" || (receipt.protocol === "openai_agents" ? receipt.sessionId === null || receipt.turnId === null : receipt.responseId === null) || receipt.observedModel === null) issue(ctx, "Completed artifacts require actual completed-session evidence");
  if (!boundedBytes(value, 524_288)) issue(ctx, "Completed artifact exceeds its byte limit");
}
function checkSources(value: { sources: NamingEvidenceSource[]; providerReceipt: NamingProviderReceipt }, references: readonly string[], ctx: z.RefinementCtx): void {
  const keys = new Set(value.sources.map(source => source.sourceKey));
  if (references.some(key => !keys.has(key))) issue(ctx, "All source references must resolve to retained evidence");
  const observed = new Set([...value.providerReceipt.artifactItemIds, ...value.providerReceipt.toolCalls.map(call => call.providerItemId).filter((item): item is string => item !== null)]);
  if (value.sources.some(source => !observed.has(source.providerItemId))) issue(ctx, "Source records must bind actual retained provider items");
}
export const namingResearchPackSchema = z.strictObject({ ...envelopeFields, stageKey: z.literal("research"), output: namingResearchOutputSchema, readiness: z.enum(["sourced", "partial"]), sources: sourcesSchema }).superRefine((value, ctx) => {
  checkEnvelope(value, ctx); checkSources(value, [...value.output.territories, ...value.output.facts, ...value.output.interpretations].flatMap(row => row.sourceKeys), ctx);
  const retrieved = new Set(value.sources.filter(source => source.evidenceStatus === "retrieved").map(source => source.sourceKey));
  if (value.readiness === "sourced" && (!retrieved.size || !value.output.facts.some(fact => fact.sourceKeys.length > 0 && fact.sourceKeys.every(key => retrieved.has(key))))) issue(ctx, "Generation-ready research requires retrieved supporting material; retain other results as partial");
}).transform(freeze);
export type NamingResearchPack = z.infer<typeof namingResearchPackSchema>;
export const namingAssignmentPlanSchema = z.strictObject({ ...envelopeFields, stageKey: z.enum(["direction", "gap"]), output: namingAssignmentOutputSchema }).superRefine((value, ctx) => {
  checkEnvelope(value, ctx);
  if ((value.stageKey === "gap") !== (value.output.round === "gap")) issue(ctx, "Assignment round must match its saved stage");
}).transform(freeze);
export type NamingAssignmentPlan = z.infer<typeof namingAssignmentPlanSchema>;
export const namingCreatorAttributionSchema = z.discriminatedUnion("protocol", [
  z.strictObject({ protocol: z.literal("openai_agents"), executionKind: z.enum(["independent_session", "native_subagent"]), assignmentKey: localKey, assignmentInputHash: hash, sessionId: providerId, turnId: providerId, responseId: z.null(), subagentId: providerId.nullable(), itemId: providerId, itemContentHash: hash }),
  z.strictObject({ protocol: z.literal("openai_responses"), executionKind: z.literal("independent_response"), assignmentKey: localKey, assignmentInputHash: hash, sessionId: z.null(), turnId: z.null(), responseId: providerId, subagentId: z.null(), itemId: providerId, itemContentHash: hash }),
]);
export type NamingCreatorAttribution = z.infer<typeof namingCreatorAttributionSchema>;
export const namingCreatorSetSchema = z.strictObject({ ...envelopeFields, stageKey: z.enum(["creation", "gap"]), output: namingCreatorOutputSchema, creatorAttribution: namingCreatorAttributionSchema,
  candidateIds: z.array(z.strictObject({ candidateKey: localKey, candidateId: z.uuid() })).max(150),
}).superRefine((value, ctx) => {
  checkEnvelope(value, ctx);
  const attribution = value.creatorAttribution, receipt = value.providerReceipt;
  if (attribution.protocol === "openai_agents" && ((attribution.executionKind === "native_subagent") !== (attribution.subagentId !== null))) issue(ctx, "Independent sessions and observed native children retain different attribution");
  if (attribution.assignmentKey !== value.output.assignmentKey || attribution.assignmentKey !== receipt.assignmentKey || attribution.protocol !== receipt.protocol || attribution.sessionId !== receipt.sessionId || attribution.turnId !== receipt.turnId || attribution.responseId !== receipt.responseId || !receipt.artifactItemIds.includes(attribution.itemId) || (attribution.protocol === "openai_agents" && attribution.executionKind === "native_subagent" && attribution.subagentId !== receipt.agentId)) issue(ctx, "Creator attribution must bind the actual child final item and assigned input");
  const keys = new Set(value.output.candidates.map(row => row.candidateKey));
  if (value.candidateIds.length !== keys.size || !unique(value.candidateIds.map(row => row.candidateId)) || !unique(value.candidateIds.map(row => row.candidateKey)) || value.candidateIds.some(row => !keys.has(row.candidateKey))) issue(ctx, "The application must resolve exactly one immutable ID for each candidate");
}).transform(freeze);
export type NamingCreatorSet = z.infer<typeof namingCreatorSetSchema>;
export const namingCurationSchema = z.strictObject({ ...envelopeFields, stageKey: z.enum(["curation", "gap"]), output: namingCurationOutputSchema }).superRefine(checkEnvelope).transform(freeze);
export type NamingCuration = z.infer<typeof namingCurationSchema>;
export const namingVerificationSchema = z.strictObject({ ...envelopeFields, stageKey: z.enum(["verification", "gap"]), output: namingVerificationOutputSchema, sources: sourcesSchema }).superRefine((value, ctx) => {
  checkEnvelope(value, ctx); checkSources(value, value.output.findings.flatMap(row => row.sourceKeys), ctx);
  const sources = new Map(value.sources.map(source => [source.sourceKey, source]));
  if (value.output.findings.some(finding => (finding.status === "supported" || finding.status === "corrected") && finding.sourceKeys.some(key => sources.get(key)?.evidenceStatus !== "retrieved"))) issue(ctx, "A URL or unretrieved source cannot support factual wording");
  if (value.output.findings.some(finding => finding.evidence.some(quote => {
    const source = sources.get(quote.sourceKey);
    return source?.evidenceStatus !== "retrieved" || source.excerpt === null || source.excerpt.slice(quote.start, quote.end) !== quote.quote;
  }))) issue(ctx, "Evidence quotes must match exact spans of the retained retrieved source text");
}).transform(freeze);
export type NamingVerification = z.infer<typeof namingVerificationSchema>;
export const namingRoleOutputSchema = z.union([namingResearchPackSchema, namingAssignmentPlanSchema, namingCreatorSetSchema, namingCurationSchema, namingVerificationSchema]);
export type NamingRoleOutput = z.infer<typeof namingRoleOutputSchema>;

export const namingValidatedAssignmentSchema = z.strictObject({ ...namingCreatorAssignmentSchema.shape, runId: z.uuid(), snapshotHash: hash, assignmentOrder: z.number().int().min(0).max(59), planArtifactId: z.uuid(), round: z.enum(["initial", "gap"]), sources: sourcesSchema });
export type NamingValidatedAssignment = z.infer<typeof namingValidatedAssignmentSchema>;
export function validateNamingAssignmentPlan(snapshotInput: unknown, researchInput: unknown, planInput: unknown): NamingValidatedAssignment[] {
  const snapshot = namingBriefSnapshotSchema.parse(snapshotInput), research = namingResearchPackSchema.parse(researchInput), plan = namingAssignmentPlanSchema.parse(planInput);
  assert(getNamingPreferencesReadiness(snapshot.preferences).ready, "Generation requires explicit saved approach/directness choices and possible constraints");
  assert(research.readiness === "sourced", "Director admission requires a sourced research pack; partial research remains retained");
  assert(research.snapshotHash === snapshot.snapshotHash && plan.snapshotHash === snapshot.snapshotHash && research.runId === plan.runId, "Research and plan must bind the same frozen run");
  const selected = new Set(snapshot.preferences.approaches), territories = new Set(research.output.territories.map(row => row.territoryId)), sources = new Map(research.sources.map(row => [row.sourceKey, row]));
  const total = plan.output.assignments.reduce((sum, row) => sum + row.targetCount, 0);
  assert(plan.output.round === "initial" ? total === NAMING_BRAIN_INITIAL_RAW_CAP : total <= NAMING_BRAIN_GAP_RAW_CAP, "Assignment targets must respect the admitted initial/gap total");
  if (plan.output.round === "initial") {
    for (const approach of selected) assert(plan.output.assignments.filter(row => row.primaryApproach === approach).reduce((sum, row) => sum + row.targetCount, 0) >= NAMING_BRAIN_PRIMARY_FLOOR, "Every selected approach needs five primary candidate targets");
    assert(plan.output.assignments.some(row => row.freshTerritory), "Initial and continuation exploration must leave room for fresh territory");
  }
  return freeze(plan.output.assignments.map((assignment, index) => {
    assert(selected.has(assignment.primaryApproach) && assignment.additionalApproaches.every(approach => selected.has(approach)), "Assignment cannot add or relabel selected approaches");
    assert(territories.has(assignment.territoryId), "Assignment territory must resolve to research");
    assert(assignment.sourceKeys.every(key => sources.has(key)), "Assignment source references must resolve to research evidence");
    return namingValidatedAssignmentSchema.parse({ ...assignment, runId: plan.runId, snapshotHash: snapshot.snapshotHash, assignmentOrder: index + (plan.output.round === "gap" ? 30 : 0), planArtifactId: plan.artifactId, round: plan.output.round, sources: assignment.sourceKeys.map(key => sources.get(key)!) });
  }));
}

export const namingValidatedCandidateSchema = z.strictObject({ ...namingCandidateProposalSchema.shape,
  candidateId: z.uuid(), sourceArtifactId: z.uuid(), runId: z.uuid(), snapshotHash: hash, assignmentKey: localKey, assignmentOrder: z.number().int().min(0).max(59), generatedOrder: z.number().int().min(0).max(149),
  identityKey: nameIdentityKeySchema.min(1), sources: sourcesSchema,
}).superRefine((value, ctx) => {
  if (nameIdentityKey(value.value) !== value.identityKey) issue(ctx, "Candidate identity must match its original displayed value");
  if (!unique(value.claims.map(claim => claim.claimKey)) || value.additionalApproaches.includes(value.primaryApproach)) issue(ctx, "Candidate claims and primary credit must be unique");
  const keys = new Set(value.sources.map(row => row.sourceKey));
  if (value.claims.some(claim => claim.sourceKeys.some(key => !keys.has(key)))) issue(ctx, "Candidate claim references must resolve");
});
export type NamingValidatedCandidate = z.infer<typeof namingValidatedCandidateSchema>;
export const namingCandidateRejectionSchema = z.strictObject({ ...candidateRefs, candidateId: z.uuid(), reason: namingHardRejectionReasonSchema });
export type NamingCandidateRejection = z.infer<typeof namingCandidateRejectionSchema>;
export type NamingCreatorValidation = { accepted: NamingValidatedCandidate[]; rejected: NamingCandidateRejection[] };
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const factualApproaches = new Set<NamingApproach>(["other_languages", "classical_roots", "stories_culture"]);
export function validateNamingCreatorSet(snapshotInput: unknown, assignmentInput: unknown, outputInput: unknown): NamingCreatorValidation {
  const snapshot = namingBriefSnapshotSchema.parse(snapshotInput), assignment = namingValidatedAssignmentSchema.parse(assignmentInput), output = namingCreatorSetSchema.parse(outputInput);
  assert(output.runId === assignment.runId && output.snapshotHash === snapshot.snapshotHash && assignment.snapshotHash === snapshot.snapshotHash, "Creator output must bind its validated assignment and frozen run");
  assert(output.output.assignmentKey === assignment.assignmentKey && (output.stageKey === "gap") === (assignment.round === "gap"), "Creator output must match its assignment and round");
  assert(output.output.candidates.length <= assignment.targetCount, "Creator output exceeds its assigned target");
  assert(output.providerReceipt.sessionLimitCents <= assignment.targetCount, "Creator session allowance exceeds its validated assignment allocation");
  const selected = new Set(snapshot.preferences.approaches), sourceMap = new Map(assignment.sources.map(row => [row.sourceKey, row])), ids = new Map(output.candidateIds.map(row => [row.candidateKey, row.candidateId]));
  assert(selected.has(assignment.primaryApproach) && assignment.additionalApproaches.every(approach => selected.has(approach)), "Assignment must retain the selected approaches");
  const accepted: NamingValidatedCandidate[] = [], rejected: NamingCandidateRejection[] = [], identities = new Set<string>();
  output.output.candidates.forEach((candidate, generatedOrder) => {
    assert(candidate.primaryApproach === assignment.primaryApproach && candidate.additionalApproaches.every(approach => assignment.additionalApproaches.includes(approach)) && candidate.territoryId === assignment.territoryId && candidate.constructionKey === assignment.constructionKey, "Candidate credit must come from its validated assignment");
    assert(candidate.claims.every(claim => claim.sourceKeys.every(key => sourceMap.has(key))), "Claim source reference does not resolve in its assignment");
    const identityKey = nameIdentityKey(candidate.value), length = Array.from(graphemes.segment(candidate.value)).length;
    let reason: NamingHardRejectionReason | null = null;
    if (!identityKey) reason = "empty_identity";
    else if (snapshot.preferences.minimumGraphemes !== null && length < snapshot.preferences.minimumGraphemes) reason = "below_minimum";
    else if (snapshot.preferences.maximumGraphemes !== null && length > snapshot.preferences.maximumGraphemes) reason = "above_maximum";
    else if (snapshot.preferences.requiredText.some(fragment => !matchesNamingTextFragment(candidate.value, fragment))) reason = "required_text";
    else if (snapshot.preferences.excludedText.some(fragment => matchesNamingTextFragment(candidate.value, fragment))) reason = "excluded_text";
    else if (identities.has(identityKey)) reason = "duplicate_response";
    else if (factualApproaches.has(candidate.primaryApproach) && !candidate.claims.some(claim => claim.requirement === "primary_approach")) reason = "unsupported_primary_claim";
    const candidateId = ids.get(candidate.candidateKey)!;
    if (reason) { rejected.push({ assignmentKey: assignment.assignmentKey, candidateKey: candidate.candidateKey, candidateId, reason }); return; }
    identities.add(identityKey);
    accepted.push(namingValidatedCandidateSchema.parse({ ...candidate, candidateId, sourceArtifactId: output.artifactId, runId: output.runId, snapshotHash: output.snapshotHash, assignmentKey: assignment.assignmentKey,
      assignmentOrder: assignment.assignmentOrder, generatedOrder, identityKey, sources: assignment.sources }));
  });
  return freeze({ accepted, rejected });
}

export const namingAppliedClaimSchema = z.strictObject({ claimKey: localKey, originalStatement: text, status: z.enum(["supported", "corrected", "unresolved", "contradicted"]), publishedStatement: text.nullable(), sourceKeys, evidence: evidenceQuotes, supportsPrimaryApproach: z.boolean(), explanation: text });
export const namingVerifiedCandidateSchema = z.strictObject({ candidateId: z.uuid(), value: nameValueSchema, eligible: z.boolean(), primaryCredit: namingApproachSchema.nullable(), publishedClaims: z.array(z.strictObject({ claimKey: localKey, statement: text, sourceKeys, evidence: evidenceQuotes })).max(8), claims: z.array(namingAppliedClaimSchema).max(8) });
export type NamingVerifiedCandidate = z.infer<typeof namingVerifiedCandidateSchema>;
export const namingAppliedVerificationSchema = z.strictObject({ runId: z.uuid(), snapshotHash: hash, verificationArtifactId: z.uuid(), artifact: namingVerificationSchema, candidates: z.array(namingVerifiedCandidateSchema).max(200) })
  .refine(value => unique(value.candidates.map(candidate => candidate.candidateId)) && value.runId === value.artifact.runId && value.snapshotHash === value.artifact.snapshotHash && value.verificationArtifactId === value.artifact.artifactId, "Applied verification must bind its exact retained artifact and unique candidates");
export type NamingAppliedVerification = z.infer<typeof namingAppliedVerificationSchema>;
export function applyNamingVerification(candidateInput: unknown, verificationInput: unknown): NamingAppliedVerification {
  const candidates = z.array(namingValidatedCandidateSchema).max(200).parse(candidateInput), verification = namingVerificationSchema.parse(verificationInput);
  assert(unique(candidates.map(candidate => candidate.candidateId)) && unique(candidates.map(refKey)), "Candidate references must be unique before verification");
  assert(candidates.every(candidate => candidate.runId === verification.runId && candidate.snapshotHash === verification.snapshotHash), "Verification must bind every candidate's original run and snapshot");
  const byRef = new Map(candidates.map(candidate => [refKey(candidate), candidate])), findings = new Map<string, NamingVerificationFinding>();
  for (const finding of verification.output.findings) {
    const candidate = byRef.get(refKey(finding));
    assert(candidate?.claims.some(claim => claim.claimKey === finding.claimKey), "Verifier findings cannot invent candidate or claim references");
    findings.set(`${refKey(finding)}/${finding.claimKey}`, finding);
  }
  return freeze(namingAppliedVerificationSchema.parse({ runId: verification.runId, snapshotHash: verification.snapshotHash, verificationArtifactId: verification.artifactId, artifact: verification,
    candidates: candidates.map(candidate => {
      const claims = candidate.claims.map(claim => {
        const finding = findings.get(`${refKey(candidate)}/${claim.claimKey}`);
        return { claimKey: claim.claimKey, originalStatement: claim.statement, status: finding?.status ?? "unresolved", publishedStatement: finding?.supportedWording ?? null,
          sourceKeys: finding?.sourceKeys ?? [], evidence: finding?.evidence ?? [], supportsPrimaryApproach: finding?.supportsPrimaryApproach ?? false, explanation: finding?.explanation ?? "No completed verification supports this claim." };
      });
      const eligible = candidate.claims.every(claim => claim.requirement !== "primary_approach" || claims.find(result => result.claimKey === claim.claimKey)?.supportsPrimaryApproach === true);
      return { candidateId: candidate.candidateId, value: candidate.value, eligible, primaryCredit: eligible ? candidate.primaryApproach : null, claims,
        publishedClaims: claims.flatMap(claim => claim.publishedStatement === null ? [] : [{ claimKey: claim.claimKey, statement: claim.publishedStatement, sourceKeys: claim.sourceKeys, evidence: claim.evidence }]) };
    }) }));
}

/** Failed/disconnected creation is retained without inventing a session or zero cost. */
const retainedPartialsSchema = z.array(z.strictObject({ providerItemId: providerId.nullable(), type: z.string().min(1).max(100), content: z.string().max(131_072) })).max(100);
export const namingStageOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), receipt: namingProviderReceiptSchema, output: namingRoleOutputSchema }).refine(value => JSON.stringify(value.receipt) === JSON.stringify(value.output.providerReceipt), "Completed output must retain the exact provider receipt"),
  z.strictObject({ status: z.enum(["failed", "cancelled"]), code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), receipt: namingProviderReceiptSchema, partialArtifacts: retainedPartialsSchema }).refine(value => value.receipt.dispatchState === "dispatched" && (value.receipt.protocol === "openai_agents" ? value.receipt.sessionId !== null && value.receipt.turnId !== null : value.receipt.responseId !== null) && boundedBytes(value, 524_288), "Known terminal outcomes require observed dispatch and bounded retained artifacts"),
  z.strictObject({ status: z.literal("rejected_before_dispatch"), code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/) }),
  z.strictObject({ status: z.literal("unresolved"), code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), receipt: namingProviderReceiptSchema.nullable(), partialArtifacts: retainedPartialsSchema }).refine(value => boundedBytes(value, 524_288), "Retained partials exceed the bounded output limit"),
]);
export type NamingStageOutcome = z.infer<typeof namingStageOutcomeSchema>;

export const namingBrainFulfillmentSchema = z.strictObject({ status: z.enum(["complete", "partial", "none"]), targetCount: z.literal(100), acceptedCount: z.number().int().min(0).max(100), missingCount: z.number().int().min(0).max(100), coverageSatisfied: z.boolean(), message: text.nullable() })
  .refine(value => (value.status === "complete" ? value.message === null : value.message !== null) && value.missingCount === 100 - value.acceptedCount && value.status === (value.acceptedCount === 0 ? "none" : value.acceptedCount === 100 && value.coverageSatisfied ? "complete" : "partial"), "Fulfillment reports both actual count and genuine primary coverage");
export type NamingBrainFulfillment = z.infer<typeof namingBrainFulfillmentSchema>;
export const namingPreparedSetSchema = z.strictObject({
  version: z.literal(1), runId: z.uuid(), stageKey: z.literal("prepare"), snapshotHash: hash, schemaVersion: z.literal(NAMING_BRAIN_SCHEMA_VERSION), promptVersion: z.literal(NAMING_BRAIN_PROMPT_VERSION),
  targetCount: z.literal(100), minimumPerApproach: z.literal(5), candidateIds: z.array(z.uuid()).max(100),
  primaryCounts: z.array(z.strictObject({ approach: namingApproachSchema, count: z.number().int().min(0).max(100) })).min(1).max(11),
  retainedUnusedIds: z.array(z.uuid()).max(200), fulfillment: namingBrainFulfillmentSchema,
  deficits: z.array(z.strictObject({ approach: namingApproachSchema, required: z.literal(5), actual: z.number().int().min(0).max(4), missing: z.number().int().min(1).max(5) })).max(11),
  rejected: z.array(namingCandidateRejectionSchema).max(200), annotations: z.array(z.strictObject({ candidateId: z.uuid(), concerns: z.array(text).max(8) })).max(200),
  curationArtifactId: z.uuid(), verificationArtifactId: z.uuid(), sourceArtifactIds: z.array(z.uuid()).max(60).refine(unique),
}).superRefine((value, ctx) => {
  if (!unique([...value.candidateIds, ...value.retainedUnusedIds]) || !unique(value.primaryCounts.map(row => row.approach)) || !unique(value.deficits.map(row => row.approach)) || !unique(value.rejected.map(row => row.candidateId)) || !unique(value.annotations.map(row => row.candidateId))) issue(ctx, "Prepared membership and primary coverage must be unique");
  if (value.primaryCounts.reduce((sum, row) => sum + row.count, 0) !== value.candidateIds.length || value.fulfillment.acceptedCount !== value.candidateIds.length) issue(ctx, "Prepared membership must count exactly one primary credit per name");
  const expected = value.primaryCounts.filter(row => row.count < 5);
  if (expected.length !== value.deficits.length || expected.some(row => !value.deficits.some(deficit => deficit.approach === row.approach && deficit.actual === row.count && deficit.missing === 5 - row.count)) || value.fulfillment.coverageSatisfied !== (expected.length === 0)) issue(ctx, "Coverage deficits must report actual primary representation");
  if (value.rejected.some(row => value.candidateIds.includes(row.candidateId) || value.retainedUnusedIds.includes(row.candidateId))) issue(ctx, "Rejected candidates cannot also be eligible membership");
}).transform(freeze);
export type NamingPreparedSet = z.infer<typeof namingPreparedSetSchema>;
export type NamingAssemblyInput = { snapshot: NamingBriefSnapshot; candidates: readonly NamingValidatedCandidate[]; curation: NamingCuration; verification: NamingAppliedVerification; existingIdentityKeys: ReadonlySet<string> | readonly string[] };

const stageLimit = (cost: number, searches: number) => z.strictObject({ maximumCostMicrousd: z.literal(cost), maxWebSearchCalls: z.literal(searches) });
/** Admission freezes the full allowance; estimates/counters never release it as actual expense. */
export const namingBrainPolicySchema = z.strictObject({
  version: z.literal(1), handlerVersion: z.literal(NAMING_BRAIN_HANDLER_VERSION), billingMode: z.literal("openai_api"), protocol: z.literal("openai_agents"), model: z.string().trim().min(1).max(150), reasoningEffort: z.literal("xhigh"),
  runAllowanceMicrousd: z.literal(5_000_000), aggregateAllowanceMicrousd: z.literal(25_000_000), maxUnsettledRuns: z.literal(5), maxConcurrentCreators: z.literal(3),
  maxInitialCandidates: z.literal(150), maxGapCandidates: z.literal(50), maxGapRounds: z.literal(1), maxInputBytes: z.literal(131_072), maxOutputBytes: z.literal(524_288), stageDeadlineMs: z.literal(240_000),
  stageLimits: z.strictObject({ research: stageLimit(750_000, 4), direction: stageLimit(250_000, 0), creation: stageLimit(1_500_000, 0), curation: stageLimit(500_000, 0), verification: stageLimit(1_250_000, 20), gap: stageLimit(750_000, 8), prepare: stageLimit(0, 0) }),
}).transform(freeze);
export type NamingBrainPolicy = z.infer<typeof namingBrainPolicySchema>;
export const namingRolePolicySchema = z.strictObject({
  version: z.literal(1), role: namingRoleSchema, protocol: z.literal("openai_agents"), model: z.string().trim().min(1).max(150), reasoningEffort: z.literal("xhigh"),
  maximumCostMicrousd: z.number().int().min(1).max(1_500_000), sessionLimitCents: z.number().int().min(1).max(150), maxWebSearchCalls: z.number().int().min(0).max(20),
  maxInputBytes: z.literal(131_072), maxOutputBytes: z.literal(524_288), deadlineMs: z.literal(240_000), nativeDelegation: z.literal(false),
  allowedTools: z.array(z.enum(["web_search", "read_reference"])).max(2).refine(unique),
  referenceHosts: z.array(z.string().min(3).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)).max(40).refine(unique),
}).superRefine((value, ctx) => {
  if (value.maximumCostMicrousd !== value.sessionLimitCents * 10_000) issue(ctx, "Native session cents must exactly match the server-allocated micro-USD bound");
  const searchRole = value.role === "researcher" || value.role === "verifier";
  if (searchRole ? value.allowedTools.length !== 2 || !value.referenceHosts.length : value.allowedTools.length !== 0 || value.maxWebSearchCalls !== 0 || value.referenceHosts.length !== 0) issue(ctx, "Only Research and Verification receive explicit read-only research tools");
  if (value.role === "researcher" && (value.maxWebSearchCalls > 4 || value.maximumCostMicrousd > 750_000)) issue(ctx, "Research must fit its admitted stage bounds");
  if (value.role === "director" && value.maximumCostMicrousd > 250_000) issue(ctx, "Direction must fit its admitted stage bound");
  if (value.role === "curator" && value.maximumCostMicrousd > 500_000) issue(ctx, "Curation must fit its admitted stage bound");
  if (value.role === "verifier" && value.maximumCostMicrousd > 1_250_000) issue(ctx, "Verification must fit its admitted stage bound");
}).transform(freeze);
export type NamingRolePolicy = z.infer<typeof namingRolePolicySchema>;
export const namingStageInputSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("researcher"), snapshot: namingBriefSnapshotSchema }),
  z.strictObject({ role: z.literal("director"), snapshot: namingBriefSnapshotSchema, research: namingResearchPackSchema }),
  z.strictObject({ role: z.literal("creator"), snapshot: namingBriefSnapshotSchema, assignment: namingValidatedAssignmentSchema }),
  z.strictObject({ role: z.literal("curator"), snapshot: namingBriefSnapshotSchema, candidates: z.array(namingValidatedCandidateSchema).max(200), validationRejections: z.array(namingCandidateRejectionSchema).max(200) }),
  z.strictObject({ role: z.literal("verifier"), snapshot: namingBriefSnapshotSchema, candidates: z.array(namingValidatedCandidateSchema).max(200), curation: namingCurationSchema }),
]);
export type NamingStageInput = z.infer<typeof namingStageInputSchema>;
export const namingStageRequestSchema = z.strictObject({
  runId: z.uuid(), stageKey: namingStageKeySchema, role: namingRoleSchema, snapshotHash: hash, input: namingStageInputSchema, dependencyArtifactIds: z.array(z.uuid()).max(100).refine(unique),
  requestKey, providerCallKey: localKey, assignmentKey: localKey.nullable(), requestHash: hash, policy: namingRolePolicySchema,
}).superRefine((value, ctx) => {
  const { input } = value;
  if (value.stageKey === "gap" && (value.policy.maximumCostMicrousd > 750_000 || value.policy.maxWebSearchCalls > 8)) issue(ctx, "Every gap call must remain within the shared gap stage limits");
  if (!rolesForStage[value.stageKey].includes(value.role) || value.role !== input.role || value.role !== value.policy.role || value.snapshotHash !== input.snapshot.snapshotHash || !getNamingPreferencesReadiness(input.snapshot.preferences).ready) issue(ctx, "Role request must bind its ready frozen input, stage and accepted policy");
  const dependencies = new Set(value.dependencyArtifactIds);
  if (input.role === "director" && (input.research.runId !== value.runId || input.research.snapshotHash !== value.snapshotHash || input.research.readiness !== "sourced" || !dependencies.has(input.research.artifactId))) issue(ctx, "Direction must depend on saved sourced research from this run");
  if (input.role === "creator") {
    if (value.assignmentKey !== input.assignment.assignmentKey || input.assignment.runId !== value.runId || input.assignment.snapshotHash !== value.snapshotHash || !dependencies.has(input.assignment.planArtifactId)) issue(ctx, "Creator requests must bind one saved validated assignment");
    if (value.policy.sessionLimitCents > input.assignment.targetCount) issue(ctx, "Creator session allowance cannot exceed its share of the creation-stage allocation");
  } else if (value.assignmentKey !== null) issue(ctx, "Only Creator calls bind a Creator assignment key");
  if (input.role === "curator" || input.role === "verifier") {
    if (input.candidates.some(candidate => candidate.runId !== value.runId || candidate.snapshotHash !== value.snapshotHash || !dependencies.has(candidate.sourceArtifactId))) issue(ctx, "Review requires saved candidate artifacts from this run");
  }
  if (input.role === "verifier" && (input.curation.runId !== value.runId || input.curation.snapshotHash !== value.snapshotHash || !dependencies.has(input.curation.artifactId))) issue(ctx, "Verification must depend on this run's saved curation");
  if (!boundedBytes(value, value.policy.maxInputBytes)) issue(ctx, "Role input exceeds its accepted byte limit; transport also bounds final instructions and wire encoding");
}).transform(freeze);
export type NamingStageRequest = z.infer<typeof namingStageRequestSchema>;
export type NamingStageHooks = { signal: AbortSignal; beforeDispatch(): Promise<void>; onReceipt(receipt: NamingProviderReceipt): Promise<void>; onArtifact(rawCompletedItem: unknown): Promise<void> };
export interface NamingAgentRuntime {
  runStage(request: NamingStageRequest, hooks: NamingStageHooks): Promise<NamingStageOutcome>;
  resumeStage(receipt: NamingProviderReceipt, hooks: NamingStageHooks): Promise<NamingStageOutcome>;
  cancelStage(receipt: NamingProviderReceipt): Promise<void>;
}
export const namingBrainJobInputSchema = z.strictObject({
  version: z.literal(2), handlerVersion: z.literal(NAMING_BRAIN_HANDLER_VERSION), billingMode: z.literal("openai_api"), runId: z.uuid(), jobId: z.uuid(), batchId: z.uuid(),
  snapshot: namingBriefSnapshotSchema, acceptedPolicyIdentity: hash, policy: namingBrainPolicySchema,
}).refine(value => getNamingPreferencesReadiness(value.snapshot.preferences).ready, "Admission requires generation-ready saved preferences").transform(freeze);
export type NamingBrainJobInput = z.infer<typeof namingBrainJobInputSchema>;

export const namingFeedCursorSchema = z.strictObject({ entryId: z.uuid(), position: revision });
export type NamingFeedCursor = z.infer<typeof namingFeedCursorSchema>;
const expectedRevisions = { expectedProjectRevision: revision, expectedPreferencesVersion: revision, expectedSteeringRevision: counter };
const demandFields = { version: z.literal(1), ...expectedRevisions, expectedDemandSequence: counter, consumedThrough: namingFeedCursorSchema.nullable(), idempotencyKey: requestKey };
export const ensureNamingRunIntentSchema = z.discriminatedUnion("reason", [
  z.strictObject({ ...demandFields, reason: z.enum(["initial", "scroll"]) }).refine(value => value.reason === "scroll" ? value.consumedThrough !== null : value.consumedThrough === null, "Initial and scroll demand must bind their intended feed position"),
  z.strictObject({ ...demandFields, reason: z.literal("resume"), resumeOfRunId: z.uuid(), expectedRunRevision: revision }),
]);
export type EnsureNamingRunIntent = z.infer<typeof ensureNamingRunIntentSchema>;
export const steerNamingFeedIntentSchema = z.strictObject({ ...expectedRevisions, candidateIds: z.array(z.uuid()).min(1).max(5).refine(unique), instruction: text.nullable(), idempotencyKey: requestKey });
export type SteerNamingFeedIntent = z.infer<typeof steerNamingFeedIntentSchema>;

export const namingRunAccountingSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("held_unsettled"), heldAllowanceMicrousd: z.literal(5_000_000), confirmedActualCostMicrousd: z.null() }),
  z.strictObject({ status: z.literal("settled"), heldAllowanceMicrousd: z.literal(0), confirmedActualCostMicrousd: counter }),
]);
export type NamingRunAccounting = z.infer<typeof namingRunAccountingSchema>;
const runSummaryFields = {
  version: z.literal(1), ownerId: z.uuid(), projectId: z.uuid(), runId: z.uuid(), jobId: z.uuid(), batchId: z.uuid(), revision, resumedFromRunId: z.uuid().nullable(),
  state: z.enum(["queued", "running", "partial", "cancel_requested", "cancelled", "succeeded", "failed", "needs_reconciliation", "prepared", "superseded"]),
  projectRevision: revision, preferencesVersion: revision, feedbackRevision: counter, steeringRevision: counter, demandSequence: counter, snapshotHash: hash, acceptedPolicyIdentity: hash,
  progress: z.number().int().min(0).max(100), preparedSetId: z.uuid().nullable(), fulfillment: namingBrainFulfillmentSchema.nullable(), accounting: namingRunAccountingSchema, createdAt: timestamp, updatedAt: timestamp,
};
export const namingBrainRunSummarySchema = z.strictObject(runSummaryFields).refine(value => value.runId !== value.resumedFromRunId, "Resume creates a new run linked to its terminal predecessor");
export type NamingBrainRunSummary = z.infer<typeof namingBrainRunSummarySchema>;
export const namingBrainRunSchema = z.strictObject({ ...runSummaryFields, snapshot: namingBriefSnapshotSchema,
  stages: z.array(z.strictObject({ stageKey: namingStageKeySchema, state: z.enum(["pending", "running", "succeeded", "skipped", "failed", "cancelled", "unresolved"]), artifactIds: z.array(z.uuid()).max(60).refine(unique), startedAt: timestamp.nullable(), finishedAt: timestamp.nullable(), errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).nullable() })).length(7),
}).superRefine((value, ctx) => {
  const snapshot = value.snapshot;
  if (value.runId === value.resumedFromRunId || value.ownerId !== snapshot.ownerId || value.projectId !== snapshot.projectId || value.projectRevision !== snapshot.contextRevision || value.preferencesVersion !== snapshot.preferencesVersion || value.feedbackRevision !== snapshot.feedbackRevision || value.steeringRevision !== snapshot.steeringRevision || value.snapshotHash !== snapshot.snapshotHash) issue(ctx, "Run and snapshot must bind one owned revision basis");
  if (!unique(value.stages.map(stage => stage.stageKey)) || value.stages.some((stage, index) => stage.stageKey !== namingStageKeySchema.options[index])) issue(ctx, "The complete fixed stage manifest must precede execution");
}).transform(freeze);
export type NamingBrainRun = z.infer<typeof namingBrainRunSchema>;
export const namingFeedEntrySchema = z.strictObject({
  entryId: z.uuid(), position: revision, runId: z.uuid().nullable(), steeringRevision: counter, entry: projectNameEntrySchema,
  primaryApproach: namingApproachSchema.nullable(), additionalApproaches, publishedClaims: z.array(z.strictObject({ claimKey: localKey, statement: text, sourceKeys, evidence: evidenceQuotes })).max(8),
}).superRefine((value, ctx) => {
  if (value.primaryApproach === null ? value.additionalApproaches.length !== 0 : value.additionalApproaches.includes(value.primaryApproach)) issue(ctx, "Feed membership preserves one primary approach without inferring legacy tags");
  const origin = value.entry.candidate.origin;
  if (origin.kind === "generated" && origin.billingMode === "openai_api") {
    if (value.runId !== origin.runId || value.primaryApproach === null) issue(ctx, "Managed feed membership must retain its actual source run and primary credit");
  } else if (value.runId !== null || value.primaryApproach !== null || value.publishedClaims.length) issue(ctx, "Legacy and user-authored names cannot acquire managed run or claim attribution");
});
export type NamingFeedEntry = z.infer<typeof namingFeedEntrySchema>;
export const namingBrainAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), handlerVersion: z.literal(NAMING_BRAIN_HANDLER_VERSION), protocol: z.literal("openai_agents"), acceptedPolicyIdentity: hash }),
  z.strictObject({ status: z.literal("unavailable"), code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/) }),
]);
export type NamingBrainAvailability = z.infer<typeof namingBrainAvailabilitySchema>;
export const namingFeedSchema = z.strictObject({
  version: z.literal(1), ownerId: z.uuid(), projectId: z.uuid(), projectRevision: revision, preferencesVersion: counter, feedbackRevision: counter, steeringRevision: counter, demandSequence: counter,
  entries: z.array(namingFeedEntrySchema).max(100), nextCursor: namingFeedCursorSchema.nullable(), consumedThrough: namingFeedCursorSchema.nullable(), activeRun: namingBrainRunSummarySchema.nullable(), preparedSetId: z.uuid().nullable(), state: z.enum(["active", "paused", "blocked"]), availability: namingBrainAvailabilitySchema,
}).superRefine((value, ctx) => {
  if (!unique(value.entries.map(row => row.entryId)) || !unique(value.entries.map(row => row.entry.candidate.id)) || value.entries.some((row, index) => row.entry.candidate.ownerId !== value.ownerId || row.entry.candidate.projectId !== value.projectId || row.steeringRevision > value.steeringRevision || (index > 0 && row.position <= value.entries[index - 1]!.position))) issue(ctx, "Feed rows require unique stable owned membership in increasing position order");
  if (value.activeRun && (value.activeRun.ownerId !== value.ownerId || value.activeRun.projectId !== value.projectId || value.activeRun.demandSequence > value.demandSequence)) issue(ctx, "The active run must belong to this feed");
  const last = value.entries.at(-1);
  if (value.nextCursor && (!last || last.entryId !== value.nextCursor.entryId || last.position !== value.nextCursor.position)) issue(ctx, "A feed continuation cursor anchors its final returned membership");
});
export type NamingFeed = z.infer<typeof namingFeedSchema>;
const resultAction = z.enum(["resume", "retry", "resolve", "configure", "review_preferences", "none"]);
export const namingFeedEnsureResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("appended"), feed: namingFeedSchema, runId: z.uuid(), appendedEntryIds: z.array(z.uuid()).min(1).max(100).refine(unique) }).refine(value => value.appendedEntryIds.every(id => value.feed.entries.some(entry => entry.entryId === id && entry.runId === value.runId)), "Appended IDs must resolve to the exact saved feed membership"),
  z.strictObject({ status: z.literal("pending"), feed: namingFeedSchema, run: namingBrainRunSummarySchema, reused: z.boolean() }).refine(value => value.run.ownerId === value.feed.ownerId && value.run.projectId === value.feed.projectId && value.feed.activeRun?.runId === value.run.runId && ["queued", "running", "cancel_requested"].includes(value.run.state), "Pending result must identify this feed's active owned run"),
  z.strictObject({ status: z.enum(["paused", "blocked"]), feed: namingFeedSchema, code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), message: text, action: resultAction }),
  z.strictObject({ status: z.literal("incomplete"), feed: namingFeedSchema, run: namingBrainRunSummarySchema, fulfillment: namingBrainFulfillmentSchema, message: text, canResume: z.boolean() }).refine(value => value.run.ownerId === value.feed.ownerId && value.run.projectId === value.feed.projectId && value.fulfillment.status !== "complete" && (!value.canResume || ["partial", "cancelled", "failed"].includes(value.run.state)), "Incomplete work remains owned and unresolved provider work cannot authorize Resume"),
]);
export type NamingFeedEnsureResult = z.infer<typeof namingFeedEnsureResultSchema>;
export const steerNamingFeedResponseSchema = z.strictObject({ feed: namingFeedSchema, supersededRunIds: z.array(z.uuid()).max(2).refine(unique), cancellationRequestedRunIds: z.array(z.uuid()).max(1) });
export type SteerNamingFeedResponse = z.infer<typeof steerNamingFeedResponseSchema>;
export const namingBrainRunResponseSchema = z.strictObject({ run: namingBrainRunSchema });
export const namingFeedResponseSchema = z.strictObject({ feed: namingFeedSchema });
