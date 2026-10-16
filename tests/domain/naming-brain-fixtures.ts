import { contextSnapshotSchema } from "../../src/domain/projects";
import { namingStrategyBasis, namingStrategyKey } from "../../src/domain/project-naming";

export const id = (n: number) => `61000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
export const at = "2026-10-16T12:00:00Z";
export const hash = "a".repeat(64);
export const context = contextSnapshotSchema.parse({ description: "Synthetic fixture: a garden planning service." });
export function preferences() {
  return { version: 2 as const, creativeLocale: "en", notes: "", minimumGraphemes: null as number | null, maximumGraphemes: null as number | null,
    approaches: ["real_words", "invented", "other_languages"] as ("real_words" | "invented" | "other_languages")[], directness: "all" as const,
    sourceLanguages: ["French"], heritageNotes: "", culturalNotes: "", requiredText: [] as string[], excludedText: [] as string[] };
}
export function snapshot() {
  return { version: 1 as const, ownerId: id(1), projectId: id(2), contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context),
    preferencesVersion: 1, preferences: preferences(), feedbackRevision: 0, steeringRevision: 0, strongSeedIds: [] as string[], steeringInstruction: null,
    recentExamples: [], likedExamples: [], patternSummaries: [], snapshotHash: hash };
}
export function receipt(stageKey = "research", role = "researcher") {
  return { version: 1 as const, provider: "openai" as const, billingMode: "openai_api" as const, runId: id(3), stageKey, role, snapshotHash: hash,
    requestKey: `fixture-request-${stageKey}-0001`, dispatchState: "dispatched" as const, sessionId: "fixture-session", turnId: `fixture-turn-${stageKey}`, agentId: "fixture-agent",
    requestId: null, callIds: ["fixture-call"], observedModel: "fixture-model", toolCalls: [], artifactItemIds: ["fixture-source-item"], usage: null, actualCostMicrousd: null, recordedAt: at };
}
export function source() {
  return { sourceKey: "source-one", url: "https://example.com/synthetic-fixture", title: "Synthetic source", retrievedAt: at, providerItemId: "fixture-source-item",
    evidenceStatus: "retrieved" as const, excerpt: "Synthetic reference text supporting fixture claims.", contentHash: "b".repeat(64) };
}
export function envelope(stageKey = "research", role = "researcher", artifact = 10) {
  return { artifactId: id(artifact), runId: id(3), stageKey, snapshotHash: hash, schemaVersion: 1 as const, promptVersion: "naming-brain-v1" as const, providerReceipt: receipt(stageKey, role) };
}
export function research() {
  return { ...envelope(), sources: [source()], output: { role: "researcher" as const,
    territories: [{ territoryId: "nature", title: "Unexpected nature", direction: "Explore objects, plants and weather.", sourceKeys: ["source-one"] },
      { territoryId: "rhythm", title: "Rhythmic forms", direction: "Explore sound without invented origins.", sourceKeys: [] }],
    facts: [{ claimKey: "fact-one", statement: "This fixture source is synthetic.", sourceKeys: ["source-one"], status: "unverified" as const }],
    interpretations: [{ interpretationKey: "idea-one", statement: "A fruit word could convey approachability.", sourceKeys: [] }], uncertainties: [] } };
}
export function assignment(approach = "real_words", key = "real", targetCount = 90, territoryId = "nature") {
  return { assignmentKey: key, primaryApproach: approach, additionalApproaches: [], territoryId, constructionKey: "original", direction: "Explore unexpected associations, without taste filtering.", targetCount,
    sourceKeys: ["source-one"], avoidPatterns: [], freshTerritory: true };
}
export function plan() {
  return { ...envelope("direction", "director", 11), output: { role: "director" as const, round: "initial" as const,
    assignments: [assignment(), assignment("invented", "invented", 40, "rhythm"), assignment("other_languages", "language", 20)], feedbackHypotheses: [] } };
}
export function proposal(value = "Quorv", candidateKey = "one", approach = "real_words", territoryId = "nature") {
  return { candidateKey, value, primaryApproach: approach, additionalApproaches: [], territoryId, constructionKey: "original", rationale: "A proposed association or sound, not a factual origin.", caution: null,
    claims: [] as { claimKey: string; statement: string; sourceKeys: string[]; requirement: "optional" | "primary_approach"; status: "unverified" }[] };
}
export function creatorSet(proposals: ({ candidateKey: string } & Record<string, unknown>)[] = [proposal()], assignmentKey = "real", offset = 100) {
  return { ...envelope("creation", "creator", offset), output: { role: "creator" as const, assignmentKey, candidates: proposals },
    candidateIds: proposals.map((candidate, index) => ({ candidateKey: candidate.candidateKey, candidateId: id(offset + 1000 + index) })) };
}
export function curation(annotations: unknown[] = []) {
  return { ...envelope("curation", "curator", 12), output: { role: "curator" as const, annotations, gaps: [] } };
}
export function verification(findings: unknown[] = []) {
  return { ...envelope("verification", "verifier", 13), sources: [source()], output: { role: "verifier" as const, findings: findings.map(finding => ({ ...(finding as Record<string, unknown>), evidence: (finding as Record<string, unknown>).evidence ?? [] })) } };
}
