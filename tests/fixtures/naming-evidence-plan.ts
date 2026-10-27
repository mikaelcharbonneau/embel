import { namingEvidenceAssignmentOutputSchema, type NamingEvidenceAssignmentOutput, type NamingStageRequest, type NamingUnavailableApproach } from "../../src/domain/naming-brain";
import { NAMING_PROGRESSIVE_FACTUAL_APPROACHES } from "../../src/domain/naming-brain-progressive";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { directorFixture } from "./naming-director-allocation";

/** Synthetic plan structures only; no provider output or private account data. */
export function evidenceDirectorFixture() {
  const prior = directorFixture(true);
  if (prior.request.input.role !== "director") throw Error("Synthetic Director fixture required");
  const request = createNamingRoleRequest({ ...prior.request, input: { ...prior.request.input, allocation: undefined }, policy: { ...prior.policy, progressiveContractVersion: 5 } });
  return { ...prior, request, policy: request.policy, options: (output: NamingEvidenceAssignmentOutput) => ({ ...prior.options(output), request,
    receipt: { ...prior.observed, requestKey: request.requestKey, requestHash: request.requestHash } }) };
}
export function evidenceDirectorOutput(request: NamingStageRequest, unavailable: readonly NamingUnavailableApproach["approach"][] = []) {
  if (request.input.role !== "director") throw Error("Synthetic Director request required");
  const input = request.input;
  const retrieved = input.research.sources.filter(source => source.evidenceStatus === "retrieved").map(source => source.sourceKey);
  const supported = input.snapshot.preferences.approaches.filter(approach => !unavailable.some(value => value === approach));
  return namingEvidenceAssignmentOutputSchema.parse({ role: "director", planVersion: 2, round: "initial",
    assignments: Array.from({ length: supported.length ? 15 : 0 }, (_, index) => ({ assignmentKey: `synthetic-direction-${index}`,
      primaryApproach: supported[index % supported.length]!, additionalApproaches: [], territoryId: input.research.output.territories[index % input.research.output.territories.length]!.territoryId,
      constructionKey: `synthetic-construction-${index}`, direction: "Explore the supplied synthetic reference and brief.", targetCount: 10,
      sourceKeys: NAMING_PROGRESSIVE_FACTUAL_APPROACHES.has(supported[index % supported.length]!) ? retrieved.slice(0, 1) : [], avoidPatterns: [], freshTerritory: true })),
    unavailableApproaches: unavailable.map(approach => ({ approach, reason: retrieved.length ? "retrieved_evidence_not_applicable" : "no_retrieved_evidence",
      explanation: retrieved.length ? `The retained synthetic passage does not establish a usable ${approach} attribution.` : `The research retained no passages for ${approach}; retrieval cannot establish its attribution.`, inspectedSourceKeys: retrieved.slice(0, 1) })),
    feedbackHypotheses: [],
  });
}
