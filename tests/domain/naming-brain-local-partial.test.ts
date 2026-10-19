import { describe, expect, it } from "vitest";
import { namingStageRequestSchema, validateNamingAssignmentPlan, validateNamingCreatorSet } from "../../src/domain/naming-brain";
import { creatorSet, hash, id, plan, proposal, research, snapshot } from "./naming-brain-fixtures";

const mode = "local_unlimited_v1" as const;
function fixture() {
 const partial = { ...research(), readiness: "partial" as const, sources: [], providerReceipt: { ...research().providerReceipt, budgetControl: mode }, output: { ...research().output, facts: [], territories: research().output.territories.map(row => ({ ...row, sourceKeys: [] })) } };
 const direction = { ...plan(), providerReceipt: { ...plan().providerReceipt, budgetControl: mode }, output: { ...plan().output, assignments: plan().output.assignments.map(row => ({ ...row, sourceKeys: [] })) } };
 const request = { runId: id(3), stageKey: "direction", role: "director", snapshotHash: hash, input: { role: "director", snapshot: snapshot(), research: partial }, dependencyArtifactIds: [partial.artifactId], requestKey: "synthetic-local-direction-request", providerCallKey: "direction-director", assignmentKey: null, requestHash: hash,
  policy: { version: 1, role: "director", protocol: "openai_agents", model: "fixture-model", reasoningEffort: "xhigh", budgetControl: mode, maximumCostMicrousd: 250000, sessionLimitCents: 25, maxWebSearchCalls: 0, maxInputBytes: 131072, maxOutputBytes: 524288, deadlineMs: 240000, nativeDelegation: false, allowedTools: [], referenceHosts: [] } };
 return { partial, direction, request };
}

describe("honest partial Research in explicitly local Naming", () => {
 it("requires the immutable local mode on both Research and Director while retaining the partial artifact", () => {
  const { partial, direction, request } = fixture();
  expect(validateNamingAssignmentPlan(snapshot(), partial, direction)).toHaveLength(3);
  expect(namingStageRequestSchema.safeParse(request).success).toBe(true);
  expect(partial).toMatchObject({ readiness: "partial", sources: [], output: { facts: [] } });
  const { budgetControl: _researchMode, ...nativeResearchReceipt } = partial.providerReceipt; void _researchMode;
  const { budgetControl: _planMode, ...nativeDirectorReceipt } = direction.providerReceipt; void _planMode;
  const { budgetControl: _requestMode, ...nativePolicy } = request.policy; void _requestMode;
  expect(() => validateNamingAssignmentPlan(snapshot(), { ...partial, providerReceipt: nativeResearchReceipt }, direction)).toThrow();
  expect(() => validateNamingAssignmentPlan(snapshot(), partial, { ...direction, providerReceipt: nativeDirectorReceipt })).toThrow();
  expect(namingStageRequestSchema.safeParse({ ...request, policy: nativePolicy }).success).toBe(false);
  expect(namingStageRequestSchema.safeParse({ ...request, input: { ...request.input, research: { ...partial, providerReceipt: nativeResearchReceipt } } }).success).toBe(false);
  expect(namingStageRequestSchema.safeParse({ ...request, dependencyArtifactIds: [] }).success).toBe(false);
 });

 it("still rejects invented source references and requires proof for factual primary routes", () => {
  const { partial, direction } = fixture();
  expect(() => validateNamingAssignmentPlan(snapshot(), partial, { ...direction, output: { ...direction.output, assignments: direction.output.assignments.map(row => ({ ...row, sourceKeys: ["invented-evidence"] })) } })).toThrow();
  const assignment = validateNamingAssignmentPlan(snapshot(), partial, direction).find(row => row.primaryApproach === "other_languages")!;
  const output = creatorSet([proposal("Fleur", "one", "other_languages")], assignment.assignmentKey);
  const validated = validateNamingCreatorSet(snapshot(), assignment, { ...output, providerReceipt: { ...output.providerReceipt, budgetControl: mode } });
  expect(validated.accepted).toEqual([]); expect(validated.rejected).toHaveLength(1);
 });
});
