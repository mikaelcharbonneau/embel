import "server-only";
import { z } from "zod";
import { assertNamingStageWireInput, namingAssignmentOutputSchema, namingEvidenceAssignmentOutputSchema, namingUnavailableApproachSchema, namingCreatorAssignmentSchema, namingCandidateProposalSchema, namingFactualClaimSchema, namingCreatorOutputSchema, namingCurationOutputSchema, namingResearchOutputSchema, namingStageRequestSchema, namingVerificationOutputSchema, type NamingRole, type NamingStageInput, type NamingStageKey, type NamingRolePolicy, type NamingStageRequest } from "../../../domain/naming-brain";
import { createNamingDirectorAllocation, createNamingEvidenceDirectorAllocation } from "../../../domain/naming-director-allocation";
import { NAMING_PROGRESSIVE_FACTUAL_APPROACHES } from "../../../domain/naming-brain-progressive";
import { NAMING_COMMON_INSTRUCTIONS, NAMING_ROLE_INSTRUCTIONS } from "./role-instructions";
import { NAMING_PROGRESSIVE_APPROACH_INSTRUCTIONS, NAMING_PROGRESSIVE_COMMON_INSTRUCTIONS, NAMING_PROGRESSIVE_ROLE_INSTRUCTIONS, NAMING_PROGRESSIVE_FACTUAL_CREATOR_INSTRUCTIONS_V4 } from "./progressive-role-instructions";
import { namingHash } from "./identity";
import { namingProgressiveServiceTier, type ManagedCreateRequest } from "./protocol";
import { NAMING_PROGRESSIVE_DIRECTOR_INSTRUCTIONS_V2, NAMING_PROGRESSIVE_DIRECTOR_EVIDENCE_INSTRUCTIONS_V4, NAMING_PROGRESSIVE_DIRECTOR_INSTRUCTIONS_V5 } from "./progressive-director-instructions";
import { namingProgressiveReferenceInstructionsV2 } from "./progressive-research-instructions";

export const namingOutputSchemas = { researcher: namingResearchOutputSchema, director: namingAssignmentOutputSchema, creator: namingCreatorOutputSchema, curator: namingCurationOutputSchema, verifier: namingVerificationOutputSchema };
export function namingOutputSchemaForRequest(request: NamingStageRequest) {
  // Existing versioned requests retain their exact schema and request hash.
  // Contract 3 prevents the provider from inventing assignment identity/credit.
  if ((request.policy.progressiveContractVersion === 3 || request.policy.progressiveContractVersion === 4 || request.policy.progressiveContractVersion === 5) && request.input.role === "creator") {
    const assignment = request.input.assignment;
    const factual = (request.policy.progressiveContractVersion === 4 || request.policy.progressiveContractVersion === 5) && NAMING_PROGRESSIVE_FACTUAL_APPROACHES.has(assignment.primaryApproach);
    const additional = assignment.additionalApproaches.length
      ? z.array(z.enum(assignment.additionalApproaches)).max(10).refine(values => new Set(values).size === values.length)
      : namingCandidateProposalSchema.shape.additionalApproaches.max(0);
    const keys = assignment.sources.filter(source => !factual || source.evidenceStatus === "retrieved").map(source => source.sourceKey);
    if (factual && !keys.length) throw new Error("factual_creator_sources_unavailable");
    const sourceKeys = keys.length
      ? z.array(z.enum(keys)).max(20).refine(values => new Set(values).size === values.length)
      : namingFactualClaimSchema.shape.sourceKeys.max(0);
    // minItems + a literal requirement are supported structured-output fields.
    // Do not use array contains/prefixItems or synthesize a missing model claim.
    const claims = factual
      ? z.array(namingFactualClaimSchema.safeExtend({ requirement: z.literal("primary_approach"), sourceKeys: sourceKeys.min(1) })).min(1).max(8)
      : z.array(namingFactualClaimSchema.safeExtend({ sourceKeys })).max(8);
    const candidate = namingCandidateProposalSchema.safeExtend({
      primaryApproach: z.literal(assignment.primaryApproach), additionalApproaches: additional,
      territoryId: z.literal(assignment.territoryId), constructionKey: z.literal(assignment.constructionKey),
      claims,
    });
    return namingCreatorOutputSchema.safeExtend({ assignmentKey: z.literal(assignment.assignmentKey), candidates: z.array(candidate).max(assignment.targetCount) });
  }
  if (request.policy.progressiveContractVersion === undefined || request.input.role !== "director") return namingOutputSchemas[request.role];
  if (request.policy.progressiveContractVersion === 5) {
    const input = request.input, selected = input.snapshot.preferences.approaches;
    const keys = input.research.sources.map(source => source.sourceKey);
    const retrieved = input.research.sources.filter(source => source.evidenceStatus === "retrieved").map(source => source.sourceKey);
    const supported = selected.filter(approach => !NAMING_PROGRESSIVE_FACTUAL_APPROACHES.has(approach) || retrieved.length > 0);
    const alternatives = supported.map(approach => namingCreatorAssignmentSchema.safeExtend({
      primaryApproach: z.literal(approach), targetCount: z.literal(10),
      additionalApproaches: z.array(z.enum(selected)).max(10),
      sourceKeys: NAMING_PROGRESSIVE_FACTUAL_APPROACHES.has(approach) ? z.array(z.enum(retrieved)).min(1).max(20)
        : keys.length ? z.array(z.enum(keys)).max(20) : namingCreatorAssignmentSchema.shape.sourceKeys.max(0),
    }));
    const item = alternatives.length === 1 ? alternatives[0]! : alternatives.length > 1 ? z.union(alternatives) : namingCreatorAssignmentSchema;
    const factual = selected.filter((approach): approach is "other_languages" | "classical_roots" | "people_places" | "stories_culture" => NAMING_PROGRESSIVE_FACTUAL_APPROACHES.has(approach));
    const unavailable = namingUnavailableApproachSchema.safeExtend({
      approach: factual.length ? z.enum(factual) : namingUnavailableApproachSchema.shape.approach,
      reason: z.literal(retrieved.length ? "retrieved_evidence_not_applicable" : "no_retrieved_evidence"),
      inspectedSourceKeys: retrieved.length ? z.array(z.enum(retrieved)).min(1).max(20) : namingUnavailableApproachSchema.shape.inspectedSourceKeys.max(0),
    });
    const assignments = !supported.length ? z.array(item).max(0)
      : factual.length < selected.length ? z.array(item).length(15)
      : z.union([z.array(item).length(15), z.array(item).max(0)]);
    return namingEvidenceAssignmentOutputSchema.safeExtend({ assignments, unavailableApproaches: z.array(unavailable).max(factual.length) });
  }
  const allocation = request.input.allocation!;
  if (allocation.version !== 1) throw new Error("director_allocation_contract_mismatch");
  const assignment = namingCreatorAssignmentSchema.safeExtend({
    primaryApproach: z.enum(request.input.snapshot.preferences.approaches), targetCount: z.literal(allocation.targetCountPerAssignment),
  });
  return namingAssignmentOutputSchema.safeExtend({ round: z.literal("initial"), assignments: z.array(assignment).length(allocation.assignmentCount) });
}
export function buildNamingManagedRequest(raw: unknown): ManagedCreateRequest {
  const request = namingStageRequestSchema.parse(raw), research = request.role === "researcher" || request.role === "verifier";
  const localUnlimited = request.policy.budgetControl === "local_unlimited_v1";
  const progressive = request.policy.localPipelineVersion === 2;
  const future = request.policy.progressiveContractVersion !== undefined;
  const roleInstructions = request.policy.progressiveContractVersion === 5 && request.role === "director" ? NAMING_PROGRESSIVE_DIRECTOR_INSTRUCTIONS_V5
    : future && request.role === "director" ? NAMING_PROGRESSIVE_DIRECTOR_INSTRUCTIONS_V2
    : future && (request.role === "researcher" || request.role === "verifier") ? namingProgressiveReferenceInstructionsV2(request.role, request.policy.referenceHosts)
    : NAMING_PROGRESSIVE_ROLE_INSTRUCTIONS[request.role];
  const evidenceInstructions = request.policy.progressiveContractVersion === 4 || request.policy.progressiveContractVersion === 5
    ? request.input.role === "creator" && NAMING_PROGRESSIVE_FACTUAL_APPROACHES.has(request.input.assignment.primaryApproach) ? `\n\n${NAMING_PROGRESSIVE_FACTUAL_CREATOR_INSTRUCTIONS_V4}`
      : request.input.role === "director" && request.policy.progressiveContractVersion === 4 ? `\n\n${NAMING_PROGRESSIVE_DIRECTOR_EVIDENCE_INSTRUCTIONS_V4}` : ""
    : "";
  const instructions = progressive ? `${NAMING_PROGRESSIVE_COMMON_INSTRUCTIONS}\n\n${roleInstructions}${request.input.role === "creator" ? `\n\n${NAMING_PROGRESSIVE_APPROACH_INSTRUCTIONS[request.input.assignment.primaryApproach]}` : ""}${evidenceInstructions}` : `${NAMING_COMMON_INSTRUCTIONS}\n\n${NAMING_ROLE_INSTRUCTIONS[request.role]}`;
  const body: ManagedCreateRequest = { environment: { type: "none" }, agent: { model: request.policy.model, instructions,
    ...(progressive ? { service_tier: namingProgressiveServiceTier(request.policy.model) } : {}),
    reasoning: { effort: "xhigh" }, multi_agent: { enabled: false }, tools: research ? [
      { type: "web_search", mode: "live", allowed_domains: request.policy.referenceHosts, context_size: "low" },
      { type: "function", name: "read_reference", description: future ? `Read and retain exact public reference text. Use only these exact HTTPS hosts and the permitted paths in the instructions: ${request.policy.referenceHosts.join(", ")}. Other hosts and redirects are unavailable.` : "Read one observed public reference and retain its exact text.", parameters: { type: "object", properties: { url: { type: "string", maxLength: 2000 } }, required: ["url"], additionalProperties: false } },
    ] : [], text: { format: { type: "json_schema", schema: z.toJSONSchema(namingOutputSchemaForRequest(request)) }, ...(progressive ? { verbosity: "low" } : {}) } },
    input: JSON.stringify({ stageKey: request.stageKey, ...request.input }), metadata: { embel_run: request.runId, embel_call: request.providerCallKey, embel_request: request.requestKey, embel_request_hash: request.requestHash, embel_snapshot: request.snapshotHash,
      ...(request.policy.providerSpendCapCents !== undefined ? { embel_provider_spend_cap_cents: String(request.policy.providerSpendCapCents) } : {}),
      ...(localUnlimited ? { embel_budget_control: "local_unlimited_v1" } : {}), ...(progressive ? { embel_pipeline_version: "2" } : {}), ...(future ? { embel_progressive_contract_version: String(request.policy.progressiveContractVersion) } : {}) },
    ...(request.policy.providerSpendCapCents !== undefined ? { spend_control: { limit: request.policy.providerSpendCapCents } } : localUnlimited ? {} : { spend_control: { limit: request.policy.sessionLimitCents } }), stream: true };
  assertNamingStageWireInput(request, body);
  return body;
}
export function namingRequestHash(request: NamingStageRequest): string {
  const normalized = { ...request, requestHash: "0".repeat(64) };
  return namingHash({ request: normalized, wire: buildNamingManagedRequest(normalized) });
}
export function createNamingRoleRequest(options: { runId: string; stageKey: NamingStageKey; providerCallKey: string; input: NamingStageInput; dependencyArtifactIds: string[]; policy: NamingRolePolicy }): NamingStageRequest {
  const role: NamingRole = options.input.role;
  const input = options.input.role === "director" && options.policy.progressiveContractVersion !== undefined ? { ...options.input, allocation: options.input.allocation ?? (options.policy.progressiveContractVersion === 5 ? createNamingEvidenceDirectorAllocation() : createNamingDirectorAllocation()) } : options.input;
  const initial = namingStageRequestSchema.parse({ ...options, input, role, snapshotHash: options.input.snapshot.snapshotHash, assignmentKey: options.input.role === "creator" ? options.input.assignment.assignmentKey : null,
    requestKey: `naming-${namingHash([options.runId, options.stageKey, options.providerCallKey]).slice(0, 48)}`, requestHash: "0".repeat(64) });
  return namingStageRequestSchema.parse({ ...initial, requestHash: namingRequestHash(initial) });
}
