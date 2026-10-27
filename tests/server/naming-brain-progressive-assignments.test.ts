import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { bindNamingVerificationSources, namingAssignmentPlanSchema, namingBriefSnapshotSchema, namingCreatorSetSchema, namingCurationSchema, namingResearchPackSchema, validateNamingAssignmentPlan, validateNamingCreatorSet } from "../../src/domain/naming-brain";
import { createNamingMicrobatch } from "../../src/domain/naming-brain-progressive";
import { chooseProgressiveNamingApproach, createProgressiveNamingAssignment, PROGRESSIVE_CREATIVE_APPROACHES } from "../../src/server/ai/naming-brain/progressive-assignments";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { id, snapshot, research, plan, creatorSet, proposal, curation, envelope, source } from "../domain/naming-brain-fixtures";

const localReceipt = (value: ReturnType<typeof envelope>["providerReceipt"]) => ({ ...value, stageKey: "creation" as const, budgetControl: "local_unlimited_v1" as const, localPipelineVersion: 2 as const });
function context() {
  const original = research();
  const pack = namingResearchPackSchema.parse({ ...original, stageKey: "creation", providerReceipt: localReceipt(original.providerReceipt), sources: original.sources.map(row => ({ ...row, contentHash: namingTextHash(row.excerpt!) })) });
  const originalPlan = plan(), first = originalPlan.output.assignments[0]!;
  const guidance = namingAssignmentPlanSchema.parse({ ...originalPlan, stageKey: "creation", providerReceipt: localReceipt(originalPlan.providerReceipt), output: { ...originalPlan.output, assignments: [
    { ...first, targetCount: 45 }, { ...first, assignmentKey: "real-contrast", targetCount: 45, territoryId: "rhythm", constructionKey: "contrasting", direction: "Explore a contrasting sound and image." }, ...originalPlan.output.assignments.slice(1),
  ] } });
  return { pack, guidance };
}

describe("Honest compact progressive assignments", () => {
  it("rotates actual seed territory and construction across repeated route rounds", () => {
    const brief = namingBriefSnapshotSchema.parse(snapshot());
    const rows = Array.from({ length: 6 }, (_, index) => createProgressiveNamingAssignment({ runId: id(3), snapshot: brief, partIndex: index * brief.preferences.approaches.length, approach: "real_words", targetCount: 4 }));
    expect(new Set(rows.map(row => row.territoryId)).size).toBe(6);
    expect(new Set(rows.map(row => row.constructionKey)).size).toBe(3);
    expect(rows.every(row => row.assignmentBasis.kind === "brief_seed" && !row.sources.length && !row.sourceKeys.length)).toBe(true);
    expect(rows.every(row => !("planArtifactId" in row))).toBe(true);
  });

  it("rotates real Director templates and retains literal current-run exclusions without banning roots", () => {
    const brief = namingBriefSnapshotSchema.parse(snapshot()), { pack, guidance } = context();
    const rows = [0, 3].map(partIndex => createProgressiveNamingAssignment({ runId: id(3), snapshot: brief, partIndex, approach: "real_words", targetCount: 4, research: pack, guidance, generatedValues: ["Quince", "Cloud & Orchard"] }));
    expect(rows.map(row => row.territoryId)).toEqual(["nature", "rhythm"]);
    expect(rows.map(row => row.constructionKey)).toEqual(["original", "contrasting"]);
    expect(rows.every(row => row.avoidPatterns.some(pattern => pattern.includes('"Quince", "Cloud & Orchard"') && pattern.includes("exact") && pattern.includes("related imagery remains welcome")))).toBe(true);
    expect(rows.every(row => row.assignmentBasis.kind === "director_guidance" && row.assignmentBasis.artifactId === guidance.artifactId)).toBe(true);
  });

  it("keeps the compact literal exclusion tail within existing fields even for maximum-length names", () => {
    const brief = namingBriefSnapshotSchema.parse(snapshot());
    const values = Array.from({ length: 200 }, (_, index) => `${String(index).padStart(3, "0")}${"\\\"".repeat(78)}`);
    const value = createProgressiveNamingAssignment({ runId: id(3), snapshot: brief, partIndex: 0, approach: "real_words", targetCount: 4, generatedValues: values });
    expect(value.avoidPatterns.length).toBeLessThanOrEqual(20); expect(value.avoidPatterns.every(row => row.length <= 2000)).toBe(true);
    expect(value.avoidPatterns.join(" ")).not.toContain(JSON.stringify(values[0]));
    expect(value.avoidPatterns.join(" ")).toContain(JSON.stringify(values.at(-1)));
  });

  it("uses a genuinely retrieved factual direction even when unsourced siblings appear first", () => {
    const brief = namingBriefSnapshotSchema.parse(snapshot()), { pack, guidance } = context();
    const unread = { ...pack.sources[0]!, sourceKey: "source-unretrieved", evidenceStatus: "unretrieved" as const, excerpt: null, contentHash: null, retrieval: null };
    const research = namingResearchPackSchema.parse({ ...pack, sources: [...pack.sources, unread] });
    const factual = guidance.output.assignments.find(row => row.primaryApproach === "other_languages")!;
    const directions = namingAssignmentPlanSchema.parse({ ...guidance, output: { ...guidance.output, assignments: [
      ...guidance.output.assignments.filter(row => row.primaryApproach !== "other_languages"),
      { ...factual, assignmentKey: "unsupported-first", targetCount: 5, sourceKeys: [] },
      { ...factual, assignmentKey: "url-only", targetCount: 5, sourceKeys: [unread.sourceKey] },
      { ...factual, assignmentKey: "retrieved-direction", targetCount: 10, constructionKey: "supported-root" },
    ] } });
    expect(validateNamingAssignmentPlan(brief, research, directions)).toHaveLength(6);
    const before = JSON.stringify(directions);
    for (const partIndex of [0, 3, 6]) {
      const assignment = createProgressiveNamingAssignment({ runId: id(3), snapshot: brief, partIndex, approach: "other_languages", targetCount: 4, research, guidance: directions });
      expect(assignment.constructionKey).toBe("supported-root"); expect(assignment.sourceKeys).toEqual(["source-one"]);
      expect(assignment.sources.every(source => source.evidenceStatus === "retrieved")).toBe(true);
    }
    expect(JSON.stringify(directions)).toBe(before);
    const unsupported = namingAssignmentPlanSchema.parse({ ...directions, output: { ...directions.output,
      assignments: directions.output.assignments.filter(row => row.assignmentKey !== "retrieved-direction") } });
    expect(() => createProgressiveNamingAssignment({ runId: id(3), snapshot: brief, partIndex: 0, approach: "other_languages", targetCount: 4, research, guidance: unsupported })).toThrow("progressive_factual_context_required");
  });

  it("reserves selected routes while three active parts diversify their primary credits", () => {
    const brief = namingBriefSnapshotSchema.parse(snapshot()), counts = brief.preferences.approaches.map(approach => ({ approach, count: 0 }));
    expect(chooseProgressiveNamingApproach(brief, counts, [], PROGRESSIVE_CREATIVE_APPROACHES)).toBe("real_words");
    expect(chooseProgressiveNamingApproach(brief, counts, [{ primaryApproach: "real_words", targetCount: 4 }], PROGRESSIVE_CREATIVE_APPROACHES)).toBe("invented");
    expect(chooseProgressiveNamingApproach(brief, [{ approach: "real_words", count: 34 }, { approach: "invented", count: 34 }], [], PROGRESSIVE_CREATIVE_APPROACHES)).toBeNull();
    expect(() => createProgressiveNamingAssignment({ runId: id(3), snapshot: brief, partIndex: 0, approach: "other_languages", targetCount: 4 })).toThrow("progressive_factual_context_required");
  });

  it("uses genuine Director allocations as soft weights rather than forcing equal final quotas", () => {
    const brief = namingBriefSnapshotSchema.parse(snapshot()), { guidance } = context();
    const weighted = namingAssignmentPlanSchema.parse({ ...guidance, output: { ...guidance.output, assignments: [
      { ...guidance.output.assignments[0]!, targetCount: 75 }, { ...guidance.output.assignments[2]!, targetCount: 45 }, { ...guidance.output.assignments[3]!, targetCount: 30 },
    ] } });
    const counts = brief.preferences.approaches.map(approach => ({ approach, count: 0 })), available = new Set(brief.preferences.approaches);
    for (let index = 0; index < 100; index++) {
      const next = chooseProgressiveNamingApproach(brief, counts, [], available, weighted);
      expect(next).not.toBeNull(); counts.find(row => row.approach === next)!.count++;
    }
    expect(counts[0]!.count).toBeGreaterThan(40); expect(counts[1]!.count).toBeGreaterThan(counts[2]!.count);
    expect(counts.every(row => row.count >= 5)).toBe(true); expect(counts.reduce((sum, row) => sum + row.count, 0)).toBe(100);
  });

  it("publishes supported factual candidates while preserving an unresolved sibling in its original artifact", () => {
    const brief = namingBriefSnapshotSchema.parse(snapshot()), { pack, guidance } = context();
    const assignment = createProgressiveNamingAssignment({ runId: id(3), snapshot: brief, partIndex: 0, approach: "other_languages", targetCount: 2, research: pack, guidance });
    const claims = [{ claimKey: "origin", statement: source().excerpt!, sourceKeys: ["source-one"], requirement: "primary_approach" as const, status: "unverified" as const }];
    const raw = creatorSet(["supported", "unresolved"].map((candidateKey, index) => ({ ...proposal(`Synthetic${index}`, candidateKey, "other_languages", assignment.territoryId), constructionKey: assignment.constructionKey, claims })), assignment.assignmentKey);
    const created = namingCreatorSetSchema.parse({ ...raw, providerReceipt: { ...localReceipt(raw.providerReceipt), assignmentKey: assignment.assignmentKey } });
    const candidates = validateNamingCreatorSet(brief, assignment, created).accepted;
    const rawCuration = curation(), curated = namingCurationSchema.parse({ ...rawCuration, stageKey: "creation", providerReceipt: localReceipt(rawCuration.providerReceipt) });
    const base = envelope("creation", "verifier", 13);
    const checked = bindNamingVerificationSources({ ...base, providerReceipt: localReceipt(base.providerReceipt), sources: pack.sources, output: { role: "verifier", findings: [{ assignmentKey: assignment.assignmentKey, candidateKey: "supported", claimKey: "origin", status: "supported", supportedWording: "Synthetic reference text", sourceKeys: ["source-one"], evidence: [{ sourceKey: "source-one", start: 0, end: 24, quote: "Synthetic reference text" }], supportsPrimaryApproach: true, explanation: "The retained exact passage supports this synthetic attribution." }] } }, { dependencyArtifactIds: [pack.artifactId], artifacts: [pack] });
    const result = createNamingMicrobatch({ key: "part001", snapshot: brief, candidates, curation: curated, verification: checked, sourceContext: { dependencyArtifactIds: [pack.artifactId], artifacts: [pack] } });
    expect(result.candidates.map(row => row.candidateKey)).toEqual(["supported"]);
    expect(created.output.candidates).toHaveLength(2); expect(result.verification).toEqual({ kind: "verified", artifactId: checked.artifactId });
    expect(() => createNamingMicrobatch({ key: "part001", snapshot: brief, candidates, curation: curated })).toThrow("naming_microbatch_no_eligible_candidates");
  });
});
