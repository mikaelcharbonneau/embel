import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingResearchPackSchema, namingRolePolicySchema, namingStageRequestSchema, validateNamingAssignmentPlan } from "../../src/domain/naming-brain";
import { buildNamingManagedRequest, createNamingRoleRequest, namingOutputSchemaForRequest } from "../../src/server/ai/naming-brain/prompts";
import { validateNamingRoleOutput } from "../../src/server/ai/naming-brain/outputs";
import { createProgressiveNamingAssignment } from "../../src/server/ai/naming-brain/progressive-assignments";
import { evidenceDirectorFixture, evidenceDirectorOutput } from "../fixtures/naming-evidence-plan";

describe("evidence-aware Director contract5", () => {
  it("retains an exact supported/unavailable partition without editing provider JSON or selected approaches", () => {
    const f = evidenceDirectorFixture(), raw = evidenceDirectorOutput(f.request, ["classical_roots"]), before = JSON.stringify(raw);
    const artifact = validateNamingRoleOutput(f.options(raw));
    expect(artifact.output).toEqual(raw); expect(JSON.stringify(raw)).toBe(before);
    const validated = validateNamingAssignmentPlan(f.brief, f.savedResearch, artifact);
    expect(validated).toHaveLength(15); expect(validated.some(row => row.primaryApproach === "classical_roots")).toBe(false);
    expect(f.request.input.snapshot.preferences.approaches).toContain("classical_roots");
    expect(artifact.output).toHaveProperty("unavailableApproaches.0.reason", "retrieved_evidence_not_applicable");
    expect(() => createProgressiveNamingAssignment({ runId: f.request.runId, snapshot: f.brief, partIndex: 0, approach: "classical_roots", targetCount: 4, research: f.savedResearch, guidance: artifact as Parameters<typeof createProgressiveNamingAssignment>[0]["guidance"] })).toThrow("progressive_approach_unavailable");
  });

  it("uses a separate allocation and ordinary source-bound provider schema", () => {
    const f = evidenceDirectorFixture(), wire = buildNamingManagedRequest(f.request), format = wire.agent!.text!.format;
    expect(f.request.input.role === "director" && f.request.input.allocation).toMatchObject({ version: 2, maximumAssignmentCount: 15, targetCountPerAssignment: 10, unavailableApproaches: "retain_original_coverage_deficit" });
    expect(format?.type).toBe("json_schema");
    expect(wire.agent!.instructions).toContain("Put only usable directions in assignments");
    expect(wire.agent!.instructions).toContain("Do not claim a network failure");
    expect(format).toMatchObject({ schema: { properties: { planVersion: { const: 2 } } } });
    expect(JSON.stringify(format)).not.toContain("prefixItems");
    expect(wire.metadata?.embel_progressive_contract_version).toBe("5"); expect(wire).not.toHaveProperty("spend_control");
  });

  it.each(["missing-partition", "overlap", "unsupported-secondary", "duplicate-unavailable", "foreign-unavailable", "missing-source", "foreign-source", "wrong-reason", "uninspected", "foreign-inspected"] as const)("rejects %s before accepting a Director artifact", defect => {
    const f = evidenceDirectorFixture(), raw = structuredClone(evidenceDirectorOutput(f.request, ["classical_roots"]));
    if (defect === "missing-partition") raw.unavailableApproaches = [];
    if (defect === "overlap") raw.assignments[0]!.primaryApproach = "classical_roots";
    if (defect === "unsupported-secondary") raw.assignments[0]!.additionalApproaches = ["classical_roots"];
    if (defect === "duplicate-unavailable") raw.unavailableApproaches.push(raw.unavailableApproaches[0]!);
    if (defect === "missing-source") raw.assignments.find(row => row.primaryApproach === "other_languages")!.sourceKeys = [];
    if (defect === "foreign-source") raw.assignments.find(row => row.primaryApproach === "other_languages")!.sourceKeys = ["invented-source"];
    if (defect === "wrong-reason") raw.unavailableApproaches[0]!.reason = "no_retrieved_evidence";
    if (defect === "uninspected") raw.unavailableApproaches[0]!.inspectedSourceKeys = [];
    if (defect === "foreign-inspected") raw.unavailableApproaches[0]!.inspectedSourceKeys = ["invented-source"];
    let options = f.options(raw);
    if (defect === "foreign-unavailable") {
      if (f.request.input.role !== "director") throw Error("Synthetic fixture invalid");
      const snapshot = namingBriefSnapshotSchema.parse({ ...f.brief, preferences: { ...f.brief.preferences, approaches: f.brief.preferences.approaches.filter(approach => approach !== "classical_roots") } });
      const request = createNamingRoleRequest({ ...f.request, input: { ...f.request.input, snapshot } });
      options = { ...options, request, receipt: { ...options.receipt, requestHash: request.requestHash } };
    }
    const before = JSON.stringify(raw);
    expect(JSON.parse(options.final.text)).toEqual(raw);
    expect(() => validateNamingRoleOutput(options)).toThrow(); expect(JSON.stringify(raw)).toBe(before);
  });

  it("accepts zero assignments when every selected factual route has no retained evidence", () => {
    const f = evidenceDirectorFixture();
    const snapshot = namingBriefSnapshotSchema.parse({ ...f.brief, preferences: { ...f.brief.preferences, approaches: ["classical_roots", "stories_culture"] } });
    const research = namingResearchPackSchema.parse({ ...f.savedResearch, readiness: "partial", sources: [], output: { ...f.savedResearch.output,
      territories: f.savedResearch.output.territories.map(row => ({ ...row, sourceKeys: [] })), facts: [], interpretations: [] } });
    const request = createNamingRoleRequest({ ...f.request, input: { role: "director", snapshot, research } });
    const output = evidenceDirectorOutput(request, ["classical_roots", "stories_culture"]);
    expect(output.assignments).toEqual([]); expect(namingOutputSchemaForRequest(request).safeParse(output).success).toBe(true);
    const artifact = validateNamingRoleOutput({ ...f.options(output), request, receipt: { ...f.observed, requestHash: request.requestHash }, dependencies: [research] });
    expect(validateNamingAssignmentPlan(snapshot, research, artifact)).toEqual([]);
    expect(output.unavailableApproaches.every(row => row.reason === "no_retrieved_evidence" && row.inspectedSourceKeys.length === 0)).toBe(true);
  });

  it("does not treat retained URLs without retrieved passages as factual direction support", () => {
    const f = evidenceDirectorFixture(), output = evidenceDirectorOutput(f.request);
    const research = namingResearchPackSchema.parse({ ...f.savedResearch, readiness: "partial", sources: f.savedResearch.sources.map(source => ({ ...source, evidenceStatus: "unretrieved", excerpt: null, contentHash: null, retrieval: null })),
      output: { ...f.savedResearch.output, facts: [] } });
    const artifact = validateNamingRoleOutput(f.options(output));
    expect(() => validateNamingAssignmentPlan(f.brief, research, artifact)).toThrow("Supported factual directions require actual retrieved source keys");
  });

  it("rejects a version5 marker with a historical allocation or capped policy", () => {
    const f = evidenceDirectorFixture();
    expect(namingStageRequestSchema.safeParse({ ...f.request, input: { ...f.request.input, allocation: { version: 1, assignmentCount: 15, targetCountPerAssignment: 10, totalTargets: 150 } } }).success).toBe(false);
    expect(namingRolePolicySchema.safeParse({ ...f.policy, providerSpendCapCents: f.policy.sessionLimitCents }).success).toBe(false);
  });
});
