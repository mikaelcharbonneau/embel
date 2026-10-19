import "server-only";
import { z } from "zod";
import { assertNamingStageWireInput, namingAssignmentOutputSchema, namingCreatorOutputSchema, namingCurationOutputSchema, namingResearchOutputSchema, namingStageRequestSchema, namingVerificationOutputSchema, type NamingRole, type NamingStageInput, type NamingStageKey, type NamingRolePolicy, type NamingStageRequest } from "../../../domain/naming-brain";
import { NAMING_COMMON_INSTRUCTIONS, NAMING_ROLE_INSTRUCTIONS } from "./role-instructions";
import { NAMING_PROGRESSIVE_APPROACH_INSTRUCTIONS, NAMING_PROGRESSIVE_COMMON_INSTRUCTIONS, NAMING_PROGRESSIVE_ROLE_INSTRUCTIONS } from "./progressive-role-instructions";
import { namingHash } from "./identity";
import { namingProgressiveServiceTier, type ManagedCreateRequest } from "./protocol";

export const namingOutputSchemas = { researcher: namingResearchOutputSchema, director: namingAssignmentOutputSchema, creator: namingCreatorOutputSchema, curator: namingCurationOutputSchema, verifier: namingVerificationOutputSchema };
export function buildNamingManagedRequest(raw: unknown): ManagedCreateRequest {
  const request = namingStageRequestSchema.parse(raw), research = request.role === "researcher" || request.role === "verifier";
  const localUnlimited = request.policy.budgetControl === "local_unlimited_v1";
  const progressive = request.policy.localPipelineVersion === 2;
  const instructions = progressive ? `${NAMING_PROGRESSIVE_COMMON_INSTRUCTIONS}\n\n${NAMING_PROGRESSIVE_ROLE_INSTRUCTIONS[request.role]}${request.input.role === "creator" ? `\n\n${NAMING_PROGRESSIVE_APPROACH_INSTRUCTIONS[request.input.assignment.primaryApproach]}` : ""}` : `${NAMING_COMMON_INSTRUCTIONS}\n\n${NAMING_ROLE_INSTRUCTIONS[request.role]}`;
  const body: ManagedCreateRequest = { environment: { type: "none" }, agent: { model: request.policy.model, instructions,
    ...(progressive ? { service_tier: namingProgressiveServiceTier(request.policy.model) } : {}),
    reasoning: { effort: "xhigh" }, multi_agent: { enabled: false }, tools: research ? [
      { type: "web_search", mode: "live", allowed_domains: request.policy.referenceHosts, context_size: "low" },
      { type: "function", name: "read_reference", description: "Read one observed public reference and retain its exact text.", parameters: { type: "object", properties: { url: { type: "string", maxLength: 2000 } }, required: ["url"], additionalProperties: false } },
    ] : [], text: { format: { type: "json_schema", schema: z.toJSONSchema(namingOutputSchemas[request.role]) }, ...(progressive ? { verbosity: "low" } : {}) } },
    input: JSON.stringify({ stageKey: request.stageKey, ...request.input }), metadata: { embel_run: request.runId, embel_call: request.providerCallKey, embel_request: request.requestKey, embel_request_hash: request.requestHash, embel_snapshot: request.snapshotHash,
      ...(localUnlimited ? { embel_budget_control: "local_unlimited_v1" } : {}), ...(progressive ? { embel_pipeline_version: "2" } : {}) },
    ...(localUnlimited ? {} : { spend_control: { limit: request.policy.sessionLimitCents } }), stream: true };
  assertNamingStageWireInput(request, body);
  return body;
}
export function namingRequestHash(request: NamingStageRequest): string {
  const normalized = { ...request, requestHash: "0".repeat(64) };
  return namingHash({ request: normalized, wire: buildNamingManagedRequest(normalized) });
}
export function createNamingRoleRequest(options: { runId: string; stageKey: NamingStageKey; providerCallKey: string; input: NamingStageInput; dependencyArtifactIds: string[]; policy: NamingRolePolicy }): NamingStageRequest {
  const role: NamingRole = options.input.role;
  const initial = namingStageRequestSchema.parse({ ...options, role, snapshotHash: options.input.snapshot.snapshotHash, assignmentKey: options.input.role === "creator" ? options.input.assignment.assignmentKey : null,
    requestKey: `naming-${namingHash([options.runId, options.stageKey, options.providerCallKey]).slice(0, 48)}`, requestHash: "0".repeat(64) });
  return namingStageRequestSchema.parse({ ...initial, requestHash: namingRequestHash(initial) });
}
