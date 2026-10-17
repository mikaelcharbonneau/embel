import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingRoleOutputSchema, namingProviderReceiptSchema, validateNamingAssignmentPlan } from "../../src/domain/naming-brain";
import { id, snapshot, research, plan, proposal, receipt } from "../domain/naming-brain-fixtures";
import { createNamingBrainPolicy, createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { validateNamingRoleOutput } from "../../src/server/ai/naming-brain/outputs";

function input() {
  const brief = namingBriefSnapshotSchema.parse(snapshot()), assignment = validateNamingAssignmentPlan(brief, research(), plan())[0]!;
  const request = createNamingRoleRequest({ runId: id(3), stageKey: "creation", providerCallKey: "creation.real", input: { role: "creator", snapshot: brief, assignment }, dependencyArtifactIds: [assignment.planArtifactId], policy: createNamingRolePolicy(createNamingBrainPolicy("fixture-selected-model"), "creation", "creator", assignment.targetCount) });
  const observed = namingProviderReceiptSchema.parse({ ...receipt("creation", "creator"), requestKey: request.requestKey, providerCallKey: request.providerCallKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents, observedModel: request.policy.model, artifactItemIds: ["actual_final_item"] });
  const value = { role: "creator", assignmentKey: "real", candidates: [proposal("Quorv")] }, text = JSON.stringify(value);
  return { request, receipt: observed, final: { itemId: "actual_final_item", itemContentHash: namingTextHash(text), text, value }, dependencies: [namingRoleOutputSchema.parse(plan())], sources: [] };
}
describe("Completed Naming output binding", () => {
  it("preserves unusual candidates with deterministic independent-session provenance", () => {
    const options = input(), result = validateNamingRoleOutput(options);
    expect(validateNamingRoleOutput(options)).toEqual(result);
    expect(result.output).toMatchObject({ candidates: [{ value: "Quorv" }] });
    expect(result).toMatchObject({ creatorAttribution: { executionKind: "independent_session", subagentId: null, itemId: "actual_final_item", itemContentHash: options.final.itemContentHash } });
  });
  it("rejects forged item identity and output normalization instead of rewriting a candidate", () => {
    const options = input();
    expect(() => validateNamingRoleOutput({ ...options, final: { ...options.final, itemId: "invented_item" } })).toThrow();
    const value = { ...options.final.value, candidates: [{ ...proposal(), value: " Quorv " }] }, text = JSON.stringify(value);
    expect(() => validateNamingRoleOutput({ ...options, final: { ...options.final, value, text, itemContentHash: namingTextHash(text) } })).toThrow();
    expect(() => validateNamingRoleOutput({ ...options, dependencies: [] })).toThrow();
  });
});
