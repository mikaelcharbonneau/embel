import { describe, expect, it } from "vitest";
import * as brain from "../../src/domain/naming-brain";
import * as selection from "../../src/domain/naming-brain-selection";
import { assignment, creatorSet, curation, envelope, id, plan, proposal, research, snapshot, sourceContext, verification } from "./naming-brain-fixtures";

function gapBasis(empty = false) {
  const approaches = brain.NAMING_APPROACHES.map(card => card.id);
  const brief = brain.namingBriefSnapshotSchema.parse({ ...snapshot(), preferences: { ...snapshot().preferences, approaches } });
  const assignments = brain.validateNamingAssignmentPlan(brief, research(), { ...plan(), output: { ...plan().output, assignments: approaches.map((approach, index) => assignment(approach, `route-${index}`, index === 10 ? 10 : 14)) } });
  const candidates = assignments.flatMap((item, route) => brain.validateNamingCreatorSet(brief, item, creatorSet(Array.from({ length: empty || route === 10 ? 0 : 10 }, (_, index) => ({ ...proposal(`Fixture${route}word${index}`, `word-${index}`, item.primaryApproach),
    claims: ["other_languages", "classical_roots", "stories_culture"].includes(item.primaryApproach) ? [{ claimKey: "meaning", statement: "Synthetic factual route attribution", sourceKeys: ["source-one"], requirement: "primary_approach", status: "unverified" }] : [] })), item.assignmentKey, 100 + route * 2000)).accepted);
  const findings = candidates.flatMap(candidate => candidate.claims.map(claim => ({ assignmentKey: candidate.assignmentKey, candidateKey: candidate.candidateKey, claimKey: claim.claimKey, status: "supported", supportedWording: "Synthetic verified route attribution", sourceKeys: ["source-one"], evidence: [{ sourceKey: "source-one", start: 0, end: 24, quote: "Synthetic reference text" }], supportsPrimaryApproach: true, explanation: "Synthetic source fixture support." })));
  return { snapshot: brief, candidates, curation: curation(), verification: brain.applyNamingVerification(candidates, verification(findings), sourceContext()), existingIdentityKeys: [] };
}
function gapPlan(approach = "stories_culture") {
  return { ...envelope("gap", "director", 45), output: { role: "director", round: "gap", assignments: [assignment(approach, "focused-gap", 20)], feedbackHypotheses: [] } };
}
function directorRequest(context: brain.NamingGapContext, brief: brain.NamingBriefSnapshot) {
  return { runId: id(3), stageKey: "gap", role: "director", snapshotHash: brief.snapshotHash, input: { role: "director", snapshot: brief, research: research(), gapContext: context },
    dependencyArtifactIds: [research().artifactId, context.curationArtifactId, context.verificationArtifactId, ...context.sourceArtifactIds], requestKey: "fixture-gap-direction-001", providerCallKey: "gap-direction", assignmentKey: null, requestHash: "c".repeat(64),
    policy: { version: 1, role: "director", protocol: "openai_agents", model: "fixture-selected-model", reasoningEffort: "xhigh", maximumCostMicrousd: 250_000, sessionLimitCents: 25, maxWebSearchCalls: 0, maxInputBytes: 131_072, maxOutputBytes: 524_288, deadlineMs: 240_000, nativeDelegation: false, allowedTools: [], referenceHosts: [] } };
}

describe("saved-output gap direction", () => {
  it("derives an actual five-credit gap without asking all eleven approaches for five more names", () => {
    const basis = gapBasis(), context = selection.createNamingGapContext?.(basis);
    expect(context?.missingCount).toBe(0);
    expect(context?.deficits).toEqual([{ approach: "stories_culture", required: 5, actual: 0, missing: 5 }]);
    expect(context?.currentPool).toHaveLength(100);
    expect(context?.curationArtifactId).toBe(id(12));
    expect(context?.verificationArtifactId).toBe(id(13));
    expect(brain.validateNamingAssignmentPlan(basis.snapshot, research(), gapPlan(), context)).toHaveLength(1);
    expect(() => brain.validateNamingAssignmentPlan(basis.snapshot, research(), gapPlan("invented"), context)).toThrow();
    expect(() => brain.validateNamingAssignmentPlan(basis.snapshot, research(), gapPlan())).toThrow();
  });
  it("permits an honest fifty-target partial gap when actual missing primary credits exceed the cap", () => {
    const basis = gapBasis(true), context = selection.createNamingGapContext?.(basis);
    expect(context?.missingCount).toBe(100);
    expect(context?.deficits.reduce((sum, row) => sum + row.missing, 0)).toBe(55);
    const bounded = { ...gapPlan(), output: { ...gapPlan().output, assignments: brain.NAMING_APPROACHES.slice(0, 10).map((approach, index) => assignment(approach.id, `gap-${index}`, 5)) } };
    expect(brain.validateNamingAssignmentPlan(basis.snapshot, research(), bounded, context)).toHaveLength(10);
  });
  it("requires matching saved gap references only in the gap phase", () => {
    const basis = gapBasis(), context = selection.createNamingGapContext?.(basis);
    expect(context?.currentPool).toHaveLength(100);
    const request = directorRequest(context!, basis.snapshot);
    expect(brain.namingStageRequestSchema.safeParse(request).success).toBe(true);
    expect(brain.namingStageRequestSchema.safeParse({ ...request, stageKey: "direction" }).success).toBe(false);
    const { gapContext: omitted, ...initialInput } = request.input;
    expect(omitted).toBeDefined();
    expect(brain.namingStageRequestSchema.safeParse({ ...request, input: initialInput }).success).toBe(false);
    expect(brain.namingStageRequestSchema.safeParse({ ...request, stageKey: "direction", input: initialInput }).success).toBe(true);
    expect(brain.namingStageRequestSchema.safeParse({ ...request, dependencyArtifactIds: [research().artifactId] }).success).toBe(false);
    expect(brain.namingStageRequestSchema.safeParse({ ...request, input: { ...request.input, gapContext: { ...context, verificationArtifactId: id(999) } } }).success).toBe(false);
  });
  it("rejects fabricated deficits and changed saved values even when their identity is internally consistent", () => {
    const basis = gapBasis(), context = selection.createNamingGapContext?.(basis);
    expect(selection.validateNamingGapContext?.(context, basis)).toEqual(context);
    expect(brain.namingGapContextSchema?.safeParse({ ...context, missingCount: 1 }).success).toBe(false);
    expect(brain.namingGapContextSchema?.safeParse({ ...context, deficits: [] }).success).toBe(false);
    const forged = structuredClone(context!);
    forged.currentPool[0]!.value = "Changed"; forged.currentPool[0]!.identityKey = "changed";
    expect(() => selection.validateNamingGapContext(forged, basis)).toThrow();
  });
});
