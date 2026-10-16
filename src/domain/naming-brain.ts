import { z } from "zod";
import { nameValueSchema } from "./naming";
import { nameIdentityKey, nameIdentityKeySchema, namingStrategyBasisSchema, namingStrategyKeyFromBasis } from "./project-naming";
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

export const namingProviderReceiptSchema = z.strictObject({
  version: z.literal(1), provider: z.literal("openai"), billingMode: z.literal("openai_api"), runId: z.uuid(), stageKey: namingStageKeySchema, role: namingRoleSchema,
  snapshotHash: hash, requestKey, dispatchState: z.enum(["not_dispatched", "dispatched", "unknown"]), sessionId: providerId.nullable(), turnId: providerId.nullable(), agentId: providerId.nullable(), requestId: providerId.nullable(),
  callIds: z.array(providerId).max(200).refine(unique), observedModel: z.string().min(1).max(150).nullable(),
  toolCalls: z.array(z.strictObject({ callId: providerId, type: z.enum(["web_search", "function", "subagent", "other"]), providerItemId: providerId.nullable(), status: z.enum(["started", "completed", "failed", "unknown"]) })).max(200),
  artifactItemIds: z.array(providerId).max(500).refine(unique),
  usage: z.strictObject({ inputTokens: counter.nullable(), outputTokens: counter.nullable(), totalTokens: counter.nullable() }).nullable(),
  actualCostMicrousd: counter.nullable(), recordedAt: timestamp,
}).superRefine((value, ctx) => {
  if (!rolesForStage[value.stageKey].includes(value.role)) issue(ctx, "Provider role must match the stage");
  if (!unique(value.toolCalls.map(call => call.callId))) issue(ctx, "Retained tool calls must be unique");
  if (value.dispatchState === "not_dispatched" && (value.sessionId !== null || value.turnId !== null || value.agentId !== null || value.callIds.length || value.toolCalls.length || value.artifactItemIds.length || value.usage !== null || value.actualCostMicrousd !== null)) issue(ctx, "A no-dispatch receipt cannot claim provider execution or settlement");
}).transform(freeze);
export type NamingProviderReceipt = z.infer<typeof namingProviderReceiptSchema>;

/** These fields are attached from retained transport evidence, never supplied by a model. */
export const namingEvidenceSourceSchema = z.strictObject({
  sourceKey: localKey, url: z.url({ protocol: /^https?$/ }).max(2000), title: z.string().trim().min(1).max(300), retrievedAt: timestamp,
  providerItemId: providerId, evidenceStatus: z.enum(["retrieved", "unretrieved"]), excerpt: z.string().trim().min(1).max(8000).nullable(), contentHash: hash.nullable(),
}).superRefine((value, ctx) => {
  if (value.evidenceStatus === "retrieved" ? value.excerpt === null || value.contentHash === null : value.excerpt !== null || value.contentHash !== null) issue(ctx, "Only actually retrieved text has an excerpt and content hash");
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
  if (receipt.dispatchState !== "dispatched" || receipt.sessionId === null || receipt.turnId === null || receipt.observedModel === null) issue(ctx, "Completed artifacts require actual completed-session evidence");
  if (!boundedBytes(value, 524_288)) issue(ctx, "Completed artifact exceeds its byte limit");
}
function checkSources(value: { sources: NamingEvidenceSource[]; providerReceipt: NamingProviderReceipt }, references: readonly string[], ctx: z.RefinementCtx): void {
  const keys = new Set(value.sources.map(source => source.sourceKey));
  if (references.some(key => !keys.has(key))) issue(ctx, "All source references must resolve to retained evidence");
  const observed = new Set([...value.providerReceipt.artifactItemIds, ...value.providerReceipt.toolCalls.map(call => call.providerItemId).filter((item): item is string => item !== null)]);
  if (value.sources.some(source => !observed.has(source.providerItemId))) issue(ctx, "Source records must bind actual retained provider items");
}
export const namingResearchPackSchema = z.strictObject({ ...envelopeFields, stageKey: z.literal("research"), output: namingResearchOutputSchema, sources: sourcesSchema }).superRefine((value, ctx) => {
  checkEnvelope(value, ctx); checkSources(value, [...value.output.territories, ...value.output.facts, ...value.output.interpretations].flatMap(row => row.sourceKeys), ctx);
}).transform(freeze);
export type NamingResearchPack = z.infer<typeof namingResearchPackSchema>;
export const namingAssignmentPlanSchema = z.strictObject({ ...envelopeFields, stageKey: z.enum(["direction", "gap"]), output: namingAssignmentOutputSchema }).superRefine((value, ctx) => {
  checkEnvelope(value, ctx);
  if ((value.stageKey === "gap") !== (value.output.round === "gap")) issue(ctx, "Assignment round must match its saved stage");
}).transform(freeze);
export type NamingAssignmentPlan = z.infer<typeof namingAssignmentPlanSchema>;
export const namingCreatorSetSchema = z.strictObject({ ...envelopeFields, stageKey: z.enum(["creation", "gap"]), output: namingCreatorOutputSchema,
  candidateIds: z.array(z.strictObject({ candidateKey: localKey, candidateId: z.uuid() })).max(150),
}).superRefine((value, ctx) => {
  checkEnvelope(value, ctx);
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

export const namingValidatedAssignmentSchema = z.strictObject({ ...namingCreatorAssignmentSchema.shape, runId: z.uuid(), snapshotHash: hash, assignmentOrder: z.number().int().min(0).max(59), round: z.enum(["initial", "gap"]), sources: sourcesSchema });
export type NamingValidatedAssignment = z.infer<typeof namingValidatedAssignmentSchema>;
export function validateNamingAssignmentPlan(snapshotInput: unknown, researchInput: unknown, planInput: unknown): NamingValidatedAssignment[] {
  const snapshot = namingBriefSnapshotSchema.parse(snapshotInput), research = namingResearchPackSchema.parse(researchInput), plan = namingAssignmentPlanSchema.parse(planInput);
  assert(getNamingPreferencesReadiness(snapshot.preferences).ready, "Generation requires explicit saved approach, directness and source choices");
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
    return namingValidatedAssignmentSchema.parse({ ...assignment, runId: plan.runId, snapshotHash: snapshot.snapshotHash, assignmentOrder: index + (plan.output.round === "gap" ? 30 : 0), round: plan.output.round, sources: assignment.sourceKeys.map(key => sources.get(key)!) });
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
export const namingAppliedVerificationSchema = z.strictObject({ runId: z.uuid(), snapshotHash: hash, verificationArtifactId: z.uuid(), candidates: z.array(namingVerifiedCandidateSchema).max(200) })
  .refine(value => unique(value.candidates.map(candidate => candidate.candidateId)), "Applied candidate IDs must be unique");
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
  return freeze(namingAppliedVerificationSchema.parse({ runId: verification.runId, snapshotHash: verification.snapshotHash, verificationArtifactId: verification.artifactId,
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
export const namingStageOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), receipt: namingProviderReceiptSchema, output: namingRoleOutputSchema }).refine(value => JSON.stringify(value.receipt) === JSON.stringify(value.output.providerReceipt), "Completed output must retain the exact provider receipt"),
  z.strictObject({ status: z.literal("rejected_before_dispatch"), code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/) }),
  z.strictObject({ status: z.literal("unresolved"), code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), receipt: namingProviderReceiptSchema.nullable(), partialArtifacts: z.array(z.strictObject({ providerItemId: providerId.nullable(), type: z.string().min(1).max(100), content: z.string().max(131_072) })).max(100) }).refine(value => boundedBytes(value, 524_288), "Retained partials exceed the bounded output limit"),
]);
export type NamingStageOutcome = z.infer<typeof namingStageOutcomeSchema>;
