import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createNamingDirectorAllocation } from "../../src/domain/naming-director-allocation";
import { namingAssignmentOutputSchema, namingRolePolicySchema, namingStageRequestSchema } from "../../src/domain/naming-brain";
import { buildNamingManagedRequest, namingOutputSchemaForRequest, namingRequestHash } from "../../src/server/ai/naming-brain/prompts";
import { validateNamingRoleOutput } from "../../src/server/ai/naming-brain/outputs";
import { createProgressiveNamingAssignment } from "../../src/server/ai/naming-brain/progressive-assignments";
import { directorApproaches, directorFixture, syntheticFutureDirectorOutput, syntheticLegacyDirectorOutput } from "../fixtures/naming-director-allocation";

describe("versioned application-specified Director allocation", () => {
  it("keeps the historical sixteen-direction149 semantic rejection and valid150 unchanged", () => {
    const fixture = directorFixture(), invalid = syntheticLegacyDirectorOutput(149), valid = syntheticLegacyDirectorOutput(150);
    expect(invalid.assignments.filter(row => row.targetCount === 10)).toHaveLength(5);
    expect(invalid.assignments.filter(row => row.targetCount === 9)).toHaveLength(11);
    expect(namingAssignmentOutputSchema.parse(invalid)).toEqual(invalid);
    expect(() => validateNamingRoleOutput(fixture.options(invalid))).toThrow("Assignment targets must respect the admitted initial/gap total");
    expect(validateNamingRoleOutput(fixture.options(valid)).output).toEqual(valid);
    expect(fixture.request.policy.progressiveContractVersion).toBeUndefined();
    expect(fixture.request.input.role === "director" && fixture.request.input.allocation).toBeUndefined();
    // Recorded from the pre-change renderer using this entirely synthetic input.
    expect(fixture.request.requestHash).toBe("cdfd6c507576c2c086ffef18b215809044854b050936db2b07c05cde6e0655f2");
  });

  it("freezes exactly fifteen targets of ten in the new request and supported wire schema", () => {
    const { request } = directorFixture(true), wire = buildNamingManagedRequest(request);
    expect(request.policy.localPipelineVersion).toBe(2); expect(request.policy.progressiveContractVersion).toBe(2);
    expect(request.input.role === "director" && request.input.allocation).toEqual(createNamingDirectorAllocation());
    const agent = wire.agent!;
    const format = agent.text!.format;
    if (format?.type !== "json_schema") throw new Error("Expected synthetic JSON schema format");
    const schema = format.schema;
    expect(schema).toMatchObject({ properties: { assignments: { minItems: 15, maxItems: 15, items: { properties: { targetCount: { const: 10 }, primaryApproach: { enum: [...directorApproaches] } } } } } });
    expect(JSON.stringify(schema)).not.toContain("prefixItems");
    expect(wire.metadata?.embel_progressive_contract_version).toBe("2");
    expect(agent.instructions).toContain("application has already specified the allocation");
    expect(agent.instructions).not.toContain("Allocate exactly 150 possible raw targets as required by this output contract");
  });

  it("accepts exact150 without rewriting provider JSON or hashes and permits flexible direction weights", () => {
    const fixture = directorFixture(true), raw = syntheticFutureDirectorOutput(), before = JSON.stringify(raw), requestHash = fixture.request.requestHash;
    const result = validateNamingRoleOutput(fixture.options(raw));
    expect(result.output).toEqual(raw); expect(JSON.stringify(raw)).toBe(before);
    expect(result.providerReceipt.requestHash).toBe(requestHash); expect(namingRequestHash(fixture.request)).toBe(requestHash);
    expect(raw.assignments.reduce((sum, row) => sum + row.targetCount, 0)).toBe(150);
    expect(raw.assignments.filter(row => row.primaryApproach === directorApproaches[0])).toHaveLength(2);
    expect(raw.assignments.filter(row => row.primaryApproach === directorApproaches.at(-1))).toHaveLength(1);
  });

  it.each([149, 150] as const)("does not silently rebalance a legacy sixteen-direction%s payload for a future request", total => {
    const fixture = directorFixture(true), raw = syntheticLegacyDirectorOutput(total), before = JSON.stringify(raw);
    expect(() => validateNamingRoleOutput(fixture.options(raw))).toThrow(); expect(JSON.stringify(raw)).toBe(before);
  });

  it.each(["count", "length", "coverage", "source", "territory", "unselected", "duplicate"] as const)("keeps %s validation with exact application allocation", defect => {
    const fixture = directorFixture(true), raw = syntheticFutureDirectorOutput();
    if (defect === "count") raw.assignments[0]!.targetCount = 9;
    if (defect === "length") raw.assignments.pop();
    if (defect === "coverage") raw.assignments = raw.assignments.map(row => ({ ...row, primaryApproach: "real_words" }));
    if (defect === "source") raw.assignments[0]!.sourceKeys = ["missing-source"];
    if (defect === "territory") raw.assignments[0]!.territoryId = "missing-territory";
    if (defect === "unselected") raw.assignments[0]!.primaryApproach = "phrases";
    if (defect === "duplicate") raw.assignments[1]!.assignmentKey = raw.assignments[0]!.assignmentKey;
    expect(() => validateNamingRoleOutput(fixture.options(raw))).toThrow();
  });

  it("does not turn a direction without retrieved factual sources into usable factual-route evidence", () => {
    const fixture = directorFixture(true), raw = syntheticFutureDirectorOutput(); raw.assignments.forEach(row => { row.sourceKeys = []; });
    const output = validateNamingRoleOutput(fixture.options(raw));
    expect(output.output.role).toBe("director");
    if (output.output.role !== "director") throw Error("Unexpected synthetic output");
    expect(() => createProgressiveNamingAssignment({ runId: fixture.request.runId, snapshot: fixture.brief, partIndex: 0, approach: "other_languages", targetCount: 5, research: fixture.savedResearch, guidance: output as Parameters<typeof createProgressiveNamingAssignment>[0]["guidance"] })).toThrow("progressive_factual_context_required");
  });

  it("requires the explicit progressive marker and allocation together without schema defaults", () => {
    const legacy = directorFixture().request, future = directorFixture(true).request;
    expect(namingStageRequestSchema.parse(legacy)).toEqual(legacy);
    expect(() => namingRolePolicySchema.parse({ ...future.policy, localPipelineVersion: undefined })).toThrow();
    expect(() => namingStageRequestSchema.parse({ ...future, policy: legacy.policy })).toThrow();
    expect(() => namingStageRequestSchema.parse({ ...legacy, policy: future.policy })).toThrow();
    expect(namingOutputSchemaForRequest(legacy)).toBe(namingAssignmentOutputSchema);
    expect(buildNamingManagedRequest(legacy).metadata).not.toHaveProperty("embel_progressive_contract_version");
    expect(future.requestHash).not.toBe(legacy.requestHash);
  });
});
