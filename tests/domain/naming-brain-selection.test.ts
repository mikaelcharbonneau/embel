import { describe, expect, it } from "vitest";
import { applyNamingVerification, validateNamingAssignmentPlan, validateNamingCreatorSet, type NamingValidatedCandidate } from "../../src/domain/naming-brain";
import * as selection from "../../src/domain/naming-brain-selection";
import { assignment, creatorSet, curation, id, plan, proposal, research, snapshot, sourceContext, verification } from "./naming-brain-fixtures";

function pool(languageCount = 20) {
  const brief = snapshot(), assignments = validateNamingAssignmentPlan(brief, research(), plan());
  const real = Array.from({ length: 90 }, (_, n) => proposal(`Fruit${n}`, `real-${n}`));
  const invented = Array.from({ length: 40 }, (_, n) => proposal(`Qvorr${n}`, `invented-${n}`, "invented", "rhythm"));
  const language = Array.from({ length: languageCount }, (_, n) => ({ ...proposal(`Brume${n}`, `language-${n}`, "other_languages"), claims: [{ claimKey: "meaning", statement: "Synthetic language attribution", sourceKeys: ["source-one"], requirement: "primary_approach", status: "unverified" }] }));
  const candidates = [
    ...validateNamingCreatorSet(brief, assignments[0], creatorSet(real, "real", 100)).accepted,
    ...validateNamingCreatorSet(brief, assignments[1], creatorSet(invented, "invented", 2000)).accepted,
    ...validateNamingCreatorSet(brief, assignments[2], creatorSet(language, "language", 4000)).accepted,
  ];
  const findings = language.map(candidate => ({ assignmentKey: "language", candidateKey: candidate.candidateKey, claimKey: "meaning", status: "supported", supportedWording: "Synthetic language attribution", sourceKeys: ["source-one"], supportsPrimaryApproach: true, explanation: "Synthetic fixture evidence", evidence: [{ sourceKey: "source-one", start: 0, end: 24, quote: "Synthetic reference text" }] }));
  return { snapshot: brief, candidates, curation: curation(), verification: applyNamingVerification(candidates, verification(findings), sourceContext()), existingIdentityKeys: [] as string[] };
}

describe("varied Naming assembly", () => {
  it("assembles 100 distinct candidates with primary floors, flexible counts and retained unused results", () => {
    const input = pool(), output = selection.assembleNamingSet?.(input);
    expect(output?.candidateIds).toHaveLength(100);
    expect(new Set(output?.candidateIds).size).toBe(100);
    expect(output?.primaryCounts).toEqual([{ approach: "real_words", count: 40 }, { approach: "invented", count: 40 }, { approach: "other_languages", count: 20 }]);
    expect(output?.retainedUnusedIds).toHaveLength(50);
    expect(output?.retainedUnusedIds.some(id => output.candidateIds.includes(id))).toBe(false);
    expect(output?.fulfillment).toMatchObject({ status: "complete", acceptedCount: 100, missingCount: 0, coverageSatisfied: true });
    expect(output?.deficits).toEqual([]);
  });
  it("is deterministic across input order, rotates groups, and preserves generated order inside each group", () => {
    const input = pool(), output = selection.assembleNamingSet?.(input);
    expect(output?.candidateIds.slice(0, 6)).toEqual([id(1100), id(3000), id(5000), id(1101), id(3001), id(5001)]);
    expect(selection.assembleNamingSet?.({ ...input, candidates: [...input.candidates].reverse() })).toEqual(output);
  });
  it("retains unusual names despite an unsupported Curator hard-rejection suggestion", () => {
    const input = pool();
    input.curation = curation([{ assignmentKey: "invented", candidateKey: "invented-0", concerns: ["Unfamiliar sound; consider pronunciation in later user review."], suggestedRejection: "invalid_candidate" }]);
    const output = selection.assembleNamingSet?.(input);
    expect(output?.candidateIds).toContain(id(3000));
    expect(output?.annotations).toContainEqual({ candidateId: id(3000), concerns: ["Unfamiliar sound; consider pronunciation in later user review."] });
    expect(input.candidates.find(row => row.candidateId === id(3000))?.value).toBe("Qvorr0");
  });
  it("reports a primary-coverage deficit even when 100 names remain available", () => {
    const output = selection.assembleNamingSet?.(pool(4));
    expect(output?.candidateIds).toHaveLength(100);
    expect(output?.fulfillment).toMatchObject({ status: "partial", acceptedCount: 100, coverageSatisfied: false });
    expect(output?.deficits).toEqual([{ approach: "other_languages", required: 5, actual: 4, missing: 1 }]);
  });
  it("reports a count shortfall and removes complete-index duplicate identities without accent folding", () => {
    const input = pool();
    input.existingIdentityKeys = input.candidates.slice(0, 70).map(row => row.identityKey);
    const output = selection.assembleNamingSet?.(input);
    expect(output?.candidateIds).toHaveLength(80);
    expect(output?.fulfillment).toMatchObject({ status: "partial", acceptedCount: 80, missingCount: 20 });
    expect(output?.rejected.filter(row => row.reason === "duplicate_history")).toHaveLength(70);
    expect(output?.retainedUnusedIds).toHaveLength(0);
  });
  it("rejects forged applied verification, mismatched runs, and unknown Curator references", () => {
    const input = pool();
    expect(selection.assembleNamingSet?.(input)?.fulfillment.status).toBe("complete");
    expect(() => selection.assembleNamingSet({ ...input, verification: { ...input.verification, candidates: input.verification.candidates.map((row, n) => n === 0 ? { ...row, primaryCredit: "other_languages" } : row) } })).toThrow();
    expect(() => selection.assembleNamingSet({ ...input, curation: curation([{ assignmentKey: "real", candidateKey: "unknown", concerns: [], suggestedRejection: null }]) })).toThrow();
    expect(() => selection.assembleNamingSet({ ...input, candidates: input.candidates.map((candidate, n) => n === 0 ? { ...candidate, runId: id(91) } : candidate) })).toThrow();
  });
  it("gives additional tags no extra primary credit and rejects an unselected primary route", () => {
    const input = pool();
    input.candidates = input.candidates.map(row => ({ ...row, additionalApproaches: row.primaryApproach === "invented" ? ["real_words"] : [] })) as NamingValidatedCandidate[];
    const output = selection.assembleNamingSet?.(input);
    expect(output?.primaryCounts.reduce((total, item) => total + item.count, 0)).toBe(100);
    expect(() => selection.assembleNamingSet({ ...input, candidates: input.candidates.map((row, n) => n === 0 ? { ...row, primaryApproach: "compounds" } : row) })).toThrow();
  });
});

it("requires bounded candidate-scoped duplicate lookup results and explains actual shortfalls", () => {
  const input = pool();
  expect(() => selection.assembleNamingSet({ ...input, existingIdentityKeys: ["notacandidate"] })).toThrow();
  const output = selection.assembleNamingSet({ ...input, existingIdentityKeys: input.candidates.slice(0, 70).map(row => row.identityKey) });
  expect(output.fulfillment.message).toMatch(/80.*100/);
});


function overlappingPool(competitors: { approach: string; key: string; target: number; indices: number[] }[]) {
  const all = [{ approach: "real_words", key: "real", target: 100, indices: Array.from({ length: 100 }, (_, n) => n) }, ...competitors];
  const brief = { ...snapshot(), preferences: { ...snapshot().preferences, approaches: all.map(row => row.approach) } };
  const direction = { ...plan(), output: { ...plan().output, assignments: all.map(row => assignment(row.approach, row.key, row.target)) } };
  const assignments = validateNamingAssignmentPlan(brief, research(), direction);
  const candidates = all.flatMap((row, index) => validateNamingCreatorSet(brief, assignments[index], creatorSet(row.indices.map(n => proposal(`Sunflower${n}`, `${row.key}-${n}`, row.approach)), row.key, 100 + index * 2000)).accepted);
  return { snapshot: brief, candidates, curation: curation(), verification: applyNamingVerification(candidates, verification(), sourceContext()), existingIdentityKeys: [] };
}

describe("identity representatives and primary floors", () => {
  it("selects the feasible 95/5 representatives instead of manufacturing a duplicate coverage deficit", () => {
    const input = overlappingPool([{ approach: "compounds", key: "compound", target: 50, indices: [0, 1, 2, 3, 4] }]);
    const output = selection.assembleNamingSet(input);
    expect(output.fulfillment.status).toBe("complete");
    expect(output.primaryCounts).toEqual([{ approach: "real_words", count: 95 }, { approach: "compounds", count: 5 }]);
    expect(output.candidateIds.filter(candidateId => input.candidates.find(row => row.candidateId === candidateId)!.primaryApproach === "compounds")).toEqual([id(3100), id(3101), id(3102), id(3103), id(3104)]);
    expect(output.rejected.map(row => row.candidateId)).toEqual([id(1100), id(1101), id(1102), id(1103), id(1104)]);
    expect(output.retainedUnusedIds).toEqual([]);
    expect(new Set(output.candidateIds.map(candidateId => input.candidates.find(row => row.candidateId === candidateId)!.identityKey)).size).toBe(100);
  });
  it("finds feasible representatives when three scarce approaches compete for the same identities", () => {
    const first = Array.from({ length: 10 }, (_, n) => n), second = [0, 1, 2, 3, 4, 10, 11, 12, 13, 14], third = Array.from({ length: 10 }, (_, n) => n + 5);
    const input = overlappingPool([{ approach: "compounds", key: "compound", target: 17, indices: first }, { approach: "invented", key: "invented", target: 17, indices: second }, { approach: "modified", key: "modified", target: 16, indices: third }]);
    const output = selection.assembleNamingSet(input);
    expect(output.fulfillment.status).toBe("complete");
    expect(output.primaryCounts).toEqual([{ approach: "real_words", count: 85 }, { approach: "compounds", count: 5 }, { approach: "invented", count: 5 }, { approach: "modified", count: 5 }]);
    expect(output.rejected).toHaveLength(30);
    expect(new Set([...output.candidateIds, ...output.retainedUnusedIds, ...output.rejected.map(row => row.candidateId)]).size).toBe(130);
    expect(selection.assembleNamingSet({ ...input, candidates: [...input.candidates].reverse() })).toEqual(output);
    for (const row of output.primaryCounts) expect(output.candidateIds.filter(candidateId => input.candidates.find(candidate => candidate.candidateId === candidateId)!.primaryApproach === row.approach)).toHaveLength(row.count);
  });
  it("keeps genuinely impossible shared-identity coverage partial", () => {
    const input = overlappingPool([{ approach: "compounds", key: "compound", target: 25, indices: [0, 1, 2, 3, 4] }, { approach: "invented", key: "invented", target: 25, indices: [0, 1, 2, 3, 4] }]);
    const output = selection.assembleNamingSet(input);
    expect(output.candidateIds).toHaveLength(100);
    expect(output.fulfillment).toMatchObject({ status: "partial", coverageSatisfied: false });
    expect(output.deficits.reduce((sum, row) => sum + row.missing, 0)).toBe(5);
  });
});
