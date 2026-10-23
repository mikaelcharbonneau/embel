import { namingBriefSnapshotSchema, namingProviderReceiptSchema, namingResearchPackSchema, type NamingAssignmentOutput } from "../../src/domain/naming-brain";
import { createNamingBrainPolicy, createProgressiveNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { assignment, id, preferences, receipt, research, snapshot } from "../domain/naming-brain-fixtures";

export const directorApproaches = ["real_words", "blends", "modified", "classical_roots", "stories_culture", "people_places", "other_languages", "invented"] as const;
/** Synthetic structure only: no retained account content or provider response is copied. */
export function directorFixture(future = false) {
  const brief = namingBriefSnapshotSchema.parse({ ...snapshot(), preferences: { ...preferences(), approaches: [...directorApproaches] } });
  const prior = research();
  const savedResearch = namingResearchPackSchema.parse({ ...prior, stageKey: "creation", providerReceipt: { ...prior.providerReceipt, stageKey: "creation", budgetControl: "local_unlimited_v1", localPipelineVersion: 2 }, sources: prior.sources.map(source => ({ ...source, contentHash: namingTextHash(source.excerpt!) })) });
  const policy = createProgressiveNamingRolePolicy(createNamingBrainPolicy("fixture-model"), "director", undefined, undefined, true, future ? 2 : undefined);
  const request = createNamingRoleRequest({ runId: id(3), stageKey: "creation", providerCallKey: "context.direction.director", input: { role: "director", snapshot: brief, research: savedResearch }, dependencyArtifactIds: [savedResearch.artifactId], policy });
  const observed = namingProviderReceiptSchema.parse({ ...receipt("creation", "director"), budgetControl: "local_unlimited_v1", localPipelineVersion: 2, requestHash: request.requestHash, requestKey: request.requestKey, providerCallKey: request.providerCallKey, observedModel: policy.model, sessionLimitCents: policy.sessionLimitCents, artifactItemIds: ["synthetic-director-final"] });
  function options(output: NamingAssignmentOutput) {
    const text = JSON.stringify(output);
    return { request, receipt: observed, final: { itemId: "synthetic-director-final", itemContentHash: namingTextHash(text), text, value: output }, dependencies: [savedResearch], sources: [] };
  }
  return { brief, savedResearch, policy, request, observed, options };
}
export function syntheticLegacyDirectorOutput(total: 149 | 150): NamingAssignmentOutput {
  return { role: "director", round: "initial", assignments: Array.from({ length: 16 }, (_, index) => ({ ...assignment(directorApproaches[Math.floor(index / 2)]!, `direction-${index}`, index < (total === 149 ? 5 : 6) ? 10 : 9), primaryApproach: directorApproaches[Math.floor(index / 2)]! })), feedbackHypotheses: [] };
}
export function syntheticFutureDirectorOutput(): NamingAssignmentOutput {
  return { role: "director", round: "initial", assignments: Array.from({ length: 15 }, (_, index) => ({ ...assignment(directorApproaches[index % directorApproaches.length]!, `direction-${index}`, 10), primaryApproach: directorApproaches[index % directorApproaches.length]! })), feedbackHypotheses: [] };
}
