import "server-only";
import { isDeepStrictEqual } from "node:util";
import { bindNamingVerificationSources, namingAssignmentPlanSchema, namingCreatorSetSchema, namingCurationSchema, namingEvidenceSourceSchema, namingProviderReceiptSchema, namingResearchPackSchema, namingRoleOutputSchema, namingStageRequestSchema, namingVerificationSchema, validateNamingAssignmentPlan, validateNamingCreatorSet,
  type NamingEvidenceSource, type NamingProviderReceipt, type NamingRoleOutput, type NamingStageRequest, type NamingVerificationSourceContext } from "../../../domain/naming-brain";
import { namingOutputSchemas } from "./prompts";
import { namingStableId, namingTextHash } from "./identity";
import type { ManagedFinalOutput } from "./history";

export function namingSourceContext(request: NamingStageRequest, dependencies: readonly NamingRoleOutput[]): NamingVerificationSourceContext {
  return { dependencyArtifactIds: [...request.dependencyArtifactIds], artifacts: dependencies.filter(artifact => request.dependencyArtifactIds.includes(artifact.artifactId)).flatMap<NamingVerificationSourceContext["artifacts"][number]>(artifact => artifact.output.role === "researcher" ? [namingResearchPackSchema.parse(artifact)] : artifact.output.role === "verifier" ? [namingVerificationSchema.parse(artifact)] : []) };
}

/** Only worker-resolved owned dependencies and retained provider items may enrich model JSON. */
export function validateNamingRoleOutput(options: { request: NamingStageRequest; receipt: NamingProviderReceipt; final: ManagedFinalOutput; dependencies: readonly NamingRoleOutput[]; sources: readonly NamingEvidenceSource[] }): NamingRoleOutput {
  const request = namingStageRequestSchema.parse(options.request), receipt = namingProviderReceiptSchema.parse(options.receipt);
  const dependencies = options.dependencies.map(value => namingRoleOutputSchema.parse(value));
  if (dependencies.some(value => value.runId !== request.runId || value.snapshotHash !== request.snapshotHash) || request.dependencyArtifactIds.some(id => !dependencies.some(artifact => artifact.artifactId === id))) throw new Error("dependency_mismatch");
  if (receipt.protocol !== "openai_agents" || receipt.sessionId === null || receipt.turnId === null || receipt.agentId === null || receipt.dispatchState !== "dispatched" || receipt.observedModel !== request.policy.model || receipt.requestHash !== request.requestHash || receipt.requestKey !== request.requestKey || receipt.providerCallKey !== request.providerCallKey || receipt.sessionLimitCents !== request.policy.sessionLimitCents || !receipt.artifactItemIds.includes(options.final.itemId)) throw new Error("provider_receipt_mismatch");
  if (namingTextHash(options.final.text) !== options.final.itemContentHash) throw new Error("provider_item_hash_mismatch");
  const raw: unknown = JSON.parse(options.final.text);
  if (!isDeepStrictEqual(raw, options.final.value)) throw new Error("provider_item_content_mismatch");
  const output = namingOutputSchemas[request.role].parse(raw);
  if (!isDeepStrictEqual(raw, output)) throw new Error("model_output_normalization");
  const artifactId = namingStableId(`artifact:${request.runId}:${request.providerCallKey}:${receipt.sessionId}:${receipt.turnId}:${options.final.itemId}`);
  const envelope = { artifactId, runId: request.runId, stageKey: request.stageKey, snapshotHash: request.snapshotHash, schemaVersion: 1, promptVersion: "naming-brain-v1", providerReceipt: receipt };
  const resolveSources = (keys: readonly string[]): NamingEvidenceSource[] => {
    const sources = new Map<string, NamingEvidenceSource>();
    for (const source of [...dependencies.flatMap(value => "sources" in value ? value.sources : []), ...options.sources]) {
      const parsed = namingEvidenceSourceSchema.parse(source), prior = sources.get(parsed.sourceKey);
      if (prior && !isDeepStrictEqual(prior, parsed)) throw new Error("source_collision");
      sources.set(parsed.sourceKey, parsed);
    }
    return [...new Set(keys)].map(key => {
      const source = sources.get(key);
      if (!source || source.evidenceStatus === "retrieved" && namingTextHash(source.excerpt!) !== source.contentHash) throw new Error("source_evidence_missing");
      return source;
    });
  };
  if (output.role === "researcher") {
    const sources = resolveSources([...output.territories, ...output.facts, ...output.interpretations].flatMap(row => row.sourceKeys));
    const retrieved = new Set(sources.filter(source => source.evidenceStatus === "retrieved").map(source => source.sourceKey));
    return namingResearchPackSchema.parse({ ...envelope, output, sources, readiness: output.facts.some(fact => fact.sourceKeys.length && fact.sourceKeys.every(key => retrieved.has(key))) ? "sourced" : "partial" });
  }
  if (output.role === "director") {
    if (request.input.role !== "director") throw new Error("role_mismatch");
    const artifact = namingAssignmentPlanSchema.parse({ ...envelope, output });
    validateNamingAssignmentPlan(request.input.snapshot, request.input.research, artifact, request.input.gapContext);
    return artifact;
  }
  if (output.role === "creator") {
    if (request.input.role !== "creator") throw new Error("role_mismatch");
    const artifact = namingCreatorSetSchema.parse({ ...envelope, output, candidateIds: output.candidates.map(candidate => ({ candidateKey: candidate.candidateKey, candidateId: namingStableId(`candidate:${artifactId}:${candidate.candidateKey}`) })),
      creatorAttribution: { protocol: "openai_agents", executionKind: "independent_session", assignmentKey: request.input.assignment.assignmentKey, assignmentInputHash: request.requestHash, sessionId: receipt.sessionId, turnId: receipt.turnId, responseId: null, subagentId: null, itemId: options.final.itemId, itemContentHash: options.final.itemContentHash } });
    validateNamingCreatorSet(request.input.snapshot, request.input.assignment, artifact);
    return artifact;
  }
  if (request.input.role !== "curator" && request.input.role !== "verifier") throw new Error("role_mismatch");
  const assignments = new Map(request.input.review.artifacts.map(artifact => [artifact.artifactKey, artifact.assignmentKey]));
  const candidates = new Map(request.input.review.candidates.map(candidate => [`${assignments.get(candidate.artifactKey)}/${candidate.candidateKey}`, candidate]));
  if (output.role === "curator") {
    if (output.annotations.some(row => !candidates.has(`${row.assignmentKey}/${row.candidateKey}`))) throw new Error("curation_reference_mismatch");
    return namingCurationSchema.parse({ ...envelope, output });
  }
  if (output.findings.some(finding => !candidates.get(`${finding.assignmentKey}/${finding.candidateKey}`)?.claims.some(claim => claim.claimKey === finding.claimKey))) throw new Error("verification_reference_mismatch");
  const sources = resolveSources(output.findings.flatMap(finding => finding.sourceKeys));
  return bindNamingVerificationSources({ ...envelope, output, sources }, namingSourceContext(request, dependencies));
}
