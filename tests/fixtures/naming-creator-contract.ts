import { namingBriefSnapshotSchema, namingProviderReceiptSchema, namingRoleOutputSchema, validateNamingAssignmentPlan, type NamingCreatorOutput } from "../../src/domain/naming-brain";
import { createNamingBrainPolicy, createProgressiveNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { assignment, id, plan, proposal, receipt, research, snapshot } from "../domain/naming-brain-fixtures";

/** Synthetic reproduction of unassigned secondary credit; contains no live provider data. */
export function creatorContractFixture(version: 2 | 3 = 2) {
  const original = snapshot();
  const brief = namingBriefSnapshotSchema.parse({ ...original, preferences: { ...original.preferences, approaches: ["real_words", "classical_roots"] } });
  const direction = plan(); direction.output.assignments = [assignment("real_words", "real", 90), assignment("classical_roots", "roots", 60)];
  const validated = validateNamingAssignmentPlan(brief, research(), direction)[1]!;
  const policy = createProgressiveNamingRolePolicy(createNamingBrainPolicy("fixture-selected-model"), "creator", undefined, undefined, true, version);
  const request = createNamingRoleRequest({ runId: id(3), stageKey: "creation", providerCallKey: "part012.creation.creator", input: { role: "creator", snapshot: brief, assignment: validated }, dependencyArtifactIds: [validated.planArtifactId], policy });
  const observed = namingProviderReceiptSchema.parse({ ...receipt("creation", "creator"), budgetControl: "local_unlimited_v1", localPipelineVersion: 2, assignmentKey: request.assignmentKey, requestKey: request.requestKey, providerCallKey: request.providerCallKey, requestHash: request.requestHash, sessionLimitCents: policy.sessionLimitCents, observedModel: policy.model, artifactItemIds: ["synthetic-creator-final"] });
  const output: NamingCreatorOutput = { role: "creator", assignmentKey: "roots", candidates: Array.from({ length: 6 }, (_, i) => ({ ...proposal(`Synthroot${i}`, `candidate-${i}`, "classical_roots"), primaryApproach: "classical_roots", claims: [{ claimKey: `claim-${i}`, statement: "Synthetic fixture root statement.", sourceKeys: ["source-one"], status: "unverified", requirement: "primary_approach" }] })) };
  const options = (value: unknown = output) => { const text = JSON.stringify(value); return { request, receipt: observed, final: { itemId: "synthetic-creator-final", itemContentHash: namingTextHash(text), text, value }, dependencies: [namingRoleOutputSchema.parse(direction)], sources: [] }; };
  return { request, output, options };
}
