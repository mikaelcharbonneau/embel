import { describe, expect, it } from "vitest";
import { applyNamingVerification, namingBriefSnapshotSchema, validateNamingAssignmentPlan, validateNamingCreatorSet } from "../../src/domain/naming-brain";
import { assembleNamingSet } from "../../src/domain/naming-brain-selection";
import { nameIdentityKey } from "../../src/domain/project-naming";
import { at, context, creatorSet, curation, id, plan, proposal, research, snapshot, verification } from "./naming-brain-fixtures";

function firstPlan() {
  const retainedResearch = { ...research(), providerReceipt: { ...research().providerReceipt, budgetControl: "local_unlimited_v1" as const } };
  const retainedPlan = { ...plan(), providerReceipt: { ...plan().providerReceipt, budgetControl: "local_unlimited_v1" as const },
    output: { ...plan().output, assignments: plan().output.assignments.map(row => ({ ...row, freshTerritory: false })) } };
  return { retainedResearch, retainedPlan };
}

describe("local plan freshness is advisory while actual history defenses remain mandatory", () => {
  it("accepts an unchanged genuine plan when no earlier exploration material exists", () => {
    const { retainedResearch, retainedPlan } = firstPlan();
    const before = JSON.stringify(retainedPlan);
    const assignments = validateNamingAssignmentPlan(snapshot(), retainedResearch, retainedPlan);
    expect(assignments).toHaveLength(3);
    expect(assignments.every(row => row.freshTerritory === false)).toBe(true);
    expect(assignments.reduce((sum, row) => sum + row.targetCount, 0)).toBe(150);
    expect(JSON.stringify(retainedPlan)).toBe(before);
  });

  it("requires both retained local modes before treating the editorial flag as advisory", () => {
    const { retainedResearch, retainedPlan } = firstPlan();
    expect(() => validateNamingAssignmentPlan(snapshot(), research(), retainedPlan)).toThrow("fresh territory");
    expect(() => validateNamingAssignmentPlan(snapshot(), retainedResearch, { ...retainedPlan, providerReceipt: plan().providerReceipt })).toThrow("fresh territory");
  });

  const example = { candidateId: id(90), value: "Cedar", primaryApproach: null };
  const seed = { ...example, rationale: "An owned manual seed.", caution: null, contextRevision: 1,
    origin: { kind: "local_import", ownerId: id(1), projectId: id(2), candidateId: example.candidateId, contextRevision: 1,
      source: { id: example.candidateId, value: example.value, createdAt: at, origin: "manual", history: [] }, capturedContext: context } };
  it.each([
    ["recentExamples", { recentExamples: [example] }],
    ["likedExamples", { likedExamples: [example] }],
    ["strongSeedIds", { strongSeedIds: [seed.candidateId], strongSeeds: [seed] }],
    ["patternSummaries", { patternSummaries: [{ pattern: "Earlier nature names", count: 1, interpretation: null }] }],
    ["steeringInstruction", { steeringInstruction: "Explore another direction." }],
    ["feedbackRevision", { feedbackRevision: 1 }],
    ["steeringRevision", { steeringRevision: 1 }],
  ] as const)("preserves the real local flags with %s and retains the native gate", (_field, history) => {
    const { retainedResearch, retainedPlan } = firstPlan();
    const brief = namingBriefSnapshotSchema.parse({ ...snapshot(), ...history });
    const before = JSON.stringify(retainedPlan);
    expect(validateNamingAssignmentPlan(brief, retainedResearch, retainedPlan).every(row => row.freshTerritory === false)).toBe(true);
    expect(JSON.stringify(retainedPlan)).toBe(before);
    expect(() => validateNamingAssignmentPlan(brief, research(), retainedPlan)).toThrow("fresh territory");
  });

  it("continues to enforce real targets and research references", () => {
    const { retainedResearch, retainedPlan } = firstPlan();
    const assignments = retainedPlan.output.assignments;
    expect(() => validateNamingAssignmentPlan(snapshot(), retainedResearch, { ...retainedPlan, output: { ...retainedPlan.output, assignments: assignments.map((row, index) => index ? row : { ...row, targetCount: row.targetCount - 1 }) } })).toThrow("initial/gap total");
    expect(() => validateNamingAssignmentPlan(snapshot(), retainedResearch, { ...retainedPlan, output: { ...retainedPlan.output, assignments: assignments.map(row => ({ ...row, sourceKeys: ["unavailable-source"] })) } })).toThrow("research evidence");
    expect(() => validateNamingAssignmentPlan(snapshot(), retainedResearch, { ...retainedPlan, output: { ...retainedPlan.output, assignments: assignments.map((row, index) => ({ ...row, targetCount: [145, 4, 1][index] })) } })).toThrow("five primary candidate targets");
  });

  it("excludes a real history-index duplicate and reports the remaining count and primary-floor deficit", () => {
    const { retainedResearch, retainedPlan } = firstPlan();
    const brief = namingBriefSnapshotSchema.parse({ ...snapshot(), preferences: { ...snapshot().preferences, approaches: ["real_words"] }, feedbackRevision: 1, recentExamples: [example] });
    const direction = { ...retainedPlan, output: { ...retainedPlan.output, assignments: [{ ...retainedPlan.output.assignments[0]!, targetCount: 150 }] } };
    const assignment = validateNamingAssignmentPlan(brief, retainedResearch, direction)[0]!;
    const generated = creatorSet([proposal(example.value, "seen"), proposal("New Horizon", "new")]);
    const candidates = validateNamingCreatorSet(brief, assignment, { ...generated, providerReceipt: { ...generated.providerReceipt, budgetControl: "local_unlimited_v1" } }).accepted;
    const checked = applyNamingVerification(candidates, { ...verification(), sources: [], sourceDependencies: [] });
    const prepared = assembleNamingSet({ snapshot: brief, candidates, curation: curation(), verification: checked, existingIdentityKeys: [nameIdentityKey(example.value)] });
    expect(prepared.rejected).toContainEqual({ assignmentKey: "real", candidateKey: "seen", candidateId: candidates[0]!.candidateId, reason: "duplicate_history" });
    expect(prepared.candidateIds).toEqual([candidates[1]!.candidateId]);
    expect(prepared.fulfillment).toMatchObject({ status: "partial", acceptedCount: 1, missingCount: 99, coverageSatisfied: false });
    expect(prepared.deficits).toEqual([{ approach: "real_words", required: 5, actual: 1, missing: 4 }]);
  });
});
