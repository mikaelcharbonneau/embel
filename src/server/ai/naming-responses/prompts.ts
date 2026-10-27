import "server-only";
import { z } from "zod";
import { NAMING_RESPONSES_HANDLER, namingResponsesRequestSchema, namingResponsesWireSchema, type NamingResponsesRequest, type NamingResponsesWire } from "../../../domain/naming-responses";
import { namingStageInputSchema, namingAssignmentOutputSchema, namingCreatorAssignmentSchema, namingCandidateProposalSchema, namingFactualClaimSchema, namingCreatorOutputSchema, type NamingStageInput } from "../../../domain/naming-brain";
import { createNamingDirectorAllocation } from "../../../domain/naming-director-allocation";
import { namingOutputSchemas } from "../naming-brain/prompts";
import { namingHash } from "../naming-brain/identity";
import { NAMING_REFERENCE_HOSTS } from "../naming-brain/source-reader";
import { NAMING_PROGRESSIVE_COMMON_INSTRUCTIONS, NAMING_PROGRESSIVE_ROLE_INSTRUCTIONS, NAMING_PROGRESSIVE_APPROACH_INSTRUCTIONS } from "../naming-brain/progressive-role-instructions";
import { NAMING_PROGRESSIVE_DIRECTOR_INSTRUCTIONS_V2 } from "../naming-brain/progressive-director-instructions";
import { namingProgressiveReferenceInstructionsV2 } from "../naming-brain/progressive-research-instructions";
import { quoteNamingResponses, type ResponsesInputQualification } from "./budget";

function outputSchema(input: NamingStageInput) {
  if (input.role === "director") {
    const allocation = input.allocation ?? createNamingDirectorAllocation();
    if (allocation.version !== 1) throw new Error("responses_evidence_planning_unavailable");
    return namingAssignmentOutputSchema.safeExtend({ round: z.literal("initial"), assignments: z.array(namingCreatorAssignmentSchema.safeExtend({
      primaryApproach: z.enum(input.snapshot.preferences.approaches), targetCount: z.literal(allocation.targetCountPerAssignment),
    })).length(allocation.assignmentCount) });
  }
  if (input.role === "creator") {
    const assignment = input.assignment;
    const sourceKeys = assignment.sources.map(source => source.sourceKey);
    return namingCreatorOutputSchema.safeExtend({ assignmentKey: z.literal(assignment.assignmentKey), candidates: z.array(namingCandidateProposalSchema.safeExtend({
      primaryApproach: z.literal(assignment.primaryApproach), territoryId: z.literal(assignment.territoryId), constructionKey: z.literal(assignment.constructionKey),
      additionalApproaches: assignment.additionalApproaches.length ? z.array(z.enum(assignment.additionalApproaches)).max(10) : namingCandidateProposalSchema.shape.additionalApproaches.max(0),
      claims: z.array(namingFactualClaimSchema.safeExtend({ sourceKeys: sourceKeys.length ? z.array(z.enum(sourceKeys)).max(20) : namingFactualClaimSchema.shape.sourceKeys.max(0) })).max(8),
    })).max(assignment.targetCount) });
  }
  return namingOutputSchemas[input.role];
}

/** New bodies keep the approved model/effort, role instructions and semantic
 * output contracts. This does not rewrite a historical Agents request or turn a
 * Responses result into an Agents publication. Publication activation is pending
 * the independently qualified required-research envelope and provenance path. */
export function buildNamingResponsesRoleBody(options: { runId: string; dispatchKey: string; input: NamingStageInput; maximumOutputTokens?: number; maximumToolCalls?: number }): NamingResponsesWire {
  let input = namingStageInputSchema.parse(options.input);
  if (input.role === "director") input = { ...input, allocation: input.allocation ?? createNamingDirectorAllocation() };
  if (input.role === "creator" && (input.assignment.runId !== options.runId || input.assignment.snapshotHash !== input.snapshot.snapshotHash)) throw Error("responses_assignment_scope_mismatch");
  const research = input.role === "researcher" || input.role === "verifier";
  const roleInstructions = input.role === "director" ? NAMING_PROGRESSIVE_DIRECTOR_INSTRUCTIONS_V2 : research
    ? namingProgressiveReferenceInstructionsV2(input.role as "researcher" | "verifier", NAMING_REFERENCE_HOSTS) : NAMING_PROGRESSIVE_ROLE_INSTRUCTIONS[input.role];
  const stage = { researcher: "research", director: "direction", creator: "creation", curator: "curation", verifier: "verification" }[input.role];
  return namingResponsesWireSchema.parse({ model: "gpt-6-luna", reasoning: { effort: "xhigh", mode: "standard" }, service_tier: "default",
    prompt_cache_options: { mode: "explicit", ttl: "30m" }, input: JSON.stringify({ stageKey: stage, ...input }),
    instructions: `${NAMING_PROGRESSIVE_COMMON_INSTRUCTIONS}\n\n${roleInstructions}${input.role === "creator" ? `\n\n${NAMING_PROGRESSIVE_APPROACH_INSTRUCTIONS[input.assignment.primaryApproach]}` : ""}`,
    max_output_tokens: options.maximumOutputTokens ?? 32_768, ...(research ? { max_tool_calls: options.maximumToolCalls ?? 4 } : {}),
    tools: research ? [{ type: "web_search", search_context_size: "low", filters: { allowed_domains: [...NAMING_REFERENCE_HOSTS] } },
      { type: "function", name: "read_reference", description: "Read and retain exact approved public reference text. Each model continuation needs a separately frozen and reserved request.",
        parameters: { type: "object", properties: { url: { type: "string", maxLength: 2000 } }, required: ["url"], additionalProperties: false }, strict: true }] : [],
    tool_choice: "auto", parallel_tool_calls: false, background: true, store: true, stream: true, truncation: "disabled",
    include: research ? ["reasoning.encrypted_content", "web_search_call.action.sources"] : ["reasoning.encrypted_content"],
    text: { verbosity: "low", format: { type: "json_schema", name: `naming_responses_${input.role}_v1`, strict: true, schema: z.toJSONSchema(outputSchema(input)) } },
    metadata: { embel_run: options.runId, embel_dispatch: options.dispatchKey, embel_contract: NAMING_RESPONSES_HANDLER, embel_owner: input.snapshot.ownerId,
      embel_project: input.snapshot.projectId, embel_role: input.role, embel_snapshot: input.snapshot.snapshotHash },
  });
}

export function namingResponsesRequestHash(request: NamingResponsesRequest): string { return namingHash({ ...request, requestHash: "0".repeat(64) }); }
export function validateNamingResponsesRequest(value: unknown): NamingResponsesRequest {
  const request = namingResponsesRequestSchema.parse(value);
  if (namingResponsesRequestHash(request) !== request.requestHash) throw Error("responses_request_hash_mismatch");
  return request;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function createNamingResponsesRequest(options: { runId: string; dispatchKey: string; body: NamingResponsesWire; now: number; qualification?: ResponsesInputQualification }): NamingResponsesRequest {
  const request = namingResponsesRequestSchema.parse({ version: 1, protocol: "openai_responses", runId: options.runId, dispatchKey: options.dispatchKey,
    requestHash: "0".repeat(64), body: options.body, quote: quoteNamingResponses(options.body, options.now, options.qualification) });
  return freeze(validateNamingResponsesRequest({ ...request, requestHash: namingResponsesRequestHash(request) }));
}
