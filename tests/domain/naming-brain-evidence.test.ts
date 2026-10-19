import { describe, expect, it } from "vitest";
import * as brain from "../../src/domain/naming-brain";
import { creatorSet, envelope, id, plan, proposal, research, snapshot } from "./naming-brain-fixtures";

function inheritedFixture() {
  const original = research();
  const assignment = brain.validateNamingAssignmentPlan(snapshot(), original, plan())[2]!;
  const candidate = { ...proposal("Brume", "word", "other_languages"), claims: [{ claimKey: "meaning", statement: "Synthetic language attribution", sourceKeys: ["source-one"], requirement: "primary_approach", status: "unverified" }] };
  const candidates = brain.validateNamingCreatorSet(snapshot(), assignment, creatorSet([candidate], "language")).accepted;
  const base = envelope("verification", "verifier", 13);
  const artifact = { ...base, providerReceipt: { ...base.providerReceipt, artifactItemIds: ["actual-verifier-item"] }, sources: original.sources,
    output: { role: "verifier", findings: [{ assignmentKey: "language", candidateKey: "word", claimKey: "meaning", status: "supported", supportedWording: "Synthetic verified fixture wording", sourceKeys: ["source-one"], evidence: [{ sourceKey: "source-one", start: 0, end: 24, quote: "Synthetic reference text" }], supportsPrimaryApproach: true, explanation: "The retained fixture quote supports this synthetic finding." }] } };
  return { original, candidates, artifact, context: { dependencyArtifactIds: [original.artifactId], artifacts: [original] } };
}

describe("inherited verification evidence", () => {
  it("reuses exact owned Research evidence without inventing a current-session observation", () => {
    const { artifact, candidates, context, original } = inheritedFixture();
    const bound = brain.bindNamingVerificationSources?.(artifact, context);
    expect(bound?.sourceDependencies[0]?.artifactId).toBe(original.artifactId);
    expect(bound?.sourceDependencies[0]?.providerReceipt.sessionId).toBe(original.providerReceipt.sessionId);
    expect(bound?.sourceDependencies[0]?.providerReceipt.turnId).toBe("fixture-turn-research");
    expect(bound?.sources[0]).toEqual(original.sources[0]);
    expect(bound?.providerReceipt.artifactItemIds).toEqual(["actual-verifier-item"]);
    expect(brain.applyNamingVerification(candidates, bound, context).candidates[0]).toMatchObject({ eligible: true, primaryCredit: "other_languages" });
    expect(() => brain.applyNamingVerification(candidates, bound)).toThrow(/dependency|Dependency/);
  });
  it("rejects missing or forged inherited dependencies and altered source bodies or hashes", () => {
    const { artifact, context } = inheritedFixture();
    const bound = brain.bindNamingVerificationSources?.(artifact, context);
    expect(bound?.sources).toHaveLength(1);
    expect(() => brain.bindNamingVerificationSources(artifact, { ...context, dependencyArtifactIds: [] })).toThrow();
    expect(() => brain.bindNamingVerificationSources(artifact, { dependencyArtifactIds: [], artifacts: [] })).toThrow();
    expect(() => brain.validateNamingVerificationSources({ ...bound, sourceDependencies: bound!.sourceDependencies.map(row => ({ ...row, artifactId: id(999) })) }, context)).toThrow();
    for (const patch of [{ contentHash: "f".repeat(64) }, { excerpt: "Counterfeit text under an original source hash." }]) {
      expect(() => brain.bindNamingVerificationSources({ ...artifact, output: { role: "verifier", findings: [] }, sources: artifact.sources.map(source => ({ ...source, ...patch })) }, context)).toThrow();
    }
    const foreign = { ...context.artifacts[0]!, runId: id(999), providerReceipt: { ...context.artifacts[0]!.providerReceipt, runId: id(999) } };
    expect(() => brain.bindNamingVerificationSources(artifact, { dependencyArtifactIds: [foreign.artifactId], artifacts: [foreign] })).toThrow();
  });
  it("does not launder an old source by merely copying its item ID into the new receipt", () => {
    const { artifact } = inheritedFixture();
    const laundering = { ...artifact, providerReceipt: { ...artifact.providerReceipt, artifactItemIds: [artifact.sources[0]!.providerItemId] } };
    expect(() => brain.bindNamingVerificationSources(laundering, { dependencyArtifactIds: [], artifacts: [] })).toThrow();
  });
  it("accepts new evidence only when its original provenance and current receipt agree", () => {
    const { artifact } = inheritedFixture();
    const freshSource = { ...artifact.sources[0]!, sourceKey: "fresh-source", providerItemId: "fresh-item", provenance: { ...artifact.sources[0]!.provenance!, itemId: "fresh-item", turnId: artifact.providerReceipt.turnId } };
    const fresh = { ...artifact, output: { role: "verifier", findings: [] }, providerReceipt: { ...artifact.providerReceipt, artifactItemIds: ["fresh-item"] }, sources: [freshSource] };
    expect(brain.bindNamingVerificationSources?.(fresh, { dependencyArtifactIds: [], artifacts: [] }).sourceDependencies).toEqual([]);
    expect(() => brain.bindNamingVerificationSources({ ...fresh, providerReceipt: { ...fresh.providerReceipt, artifactItemIds: [] } }, { dependencyArtifactIds: [], artifacts: [] })).toThrow();
  });
});

it("reuses Research and earlier Verification observations in a gap through their distinct owned original receipts", () => {
  const { original, artifact, candidates, context } = inheritedFixture();
  const freshSource = { ...artifact.sources[0]!, sourceKey: "fresh-source", providerItemId: "fresh-item", provenance: { ...artifact.sources[0]!.provenance!, itemId: "fresh-item", turnId: artifact.providerReceipt.turnId } };
  const prior = brain.bindNamingVerificationSources({ ...artifact, providerReceipt: { ...artifact.providerReceipt, artifactItemIds: ["fresh-item"] }, sources: [...artifact.sources, freshSource] }, context);
  const gapBase = envelope("gap", "verifier", 61), closure = { dependencyArtifactIds: [original.artifactId, prior.artifactId], artifacts: [original, prior] };
  const gap = brain.bindNamingVerificationSources({ ...gapBase, providerReceipt: { ...gapBase.providerReceipt, artifactItemIds: ["actual-gap-verifier-item"] }, sources: prior.sources,
    output: { role: "verifier", findings: artifact.output.findings.map(finding => ({ ...finding, sourceKeys: ["fresh-source"], evidence: finding.evidence.map(quote => ({ ...quote, sourceKey: "fresh-source" })) })) } }, closure);
  expect(gap.sourceDependencies.find(row => row.sources.some(source => source.sourceKey === "source-one"))?.artifactId).toBe(original.artifactId);
  expect(gap.sourceDependencies.find(row => row.sources.some(source => source.sourceKey === "fresh-source"))?.providerReceipt.turnId).toBe(prior.providerReceipt.turnId);
  expect(gap.providerReceipt.artifactItemIds).toEqual(["actual-gap-verifier-item"]);
  expect(brain.applyNamingVerification(candidates, gap, closure).candidates[0]?.eligible).toBe(true);
  expect(() => brain.validateNamingVerificationSources({ ...gap, sourceDependencies: gap.sourceDependencies.map(dependency => dependency.artifactId === prior.artifactId ? { ...dependency, artifactId: id(999) } : dependency) }, closure)).toThrow();
  expect(() => brain.bindNamingVerificationSources({ ...artifact, output: { role: "verifier", findings: [] } }, { dependencyArtifactIds: [id(100)], artifacts: [creatorSet()] })).toThrow();
});
