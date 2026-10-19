import "server-only";
import { z } from "zod";
import { namingBriefSnapshotSchema, namingCandidateProposalSchema, namingCreatorAttributionSchema, namingProviderReceiptSchema, namingVerificationFindingSchema, namingDisplayRationale } from "@/domain/naming-brain";
import { nameIdentityKey, namingStrategyBasisSchema, namingStrategyKeyFromBasis, type ProjectNameCandidate } from "@/domain/project-naming";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

/** Derive the existing display key from JSONB; it is not a stored authority. */
export function normalizeNamingBrain(value: unknown, ownerId: string): unknown {
 if (Array.isArray(value)) return value.map(item => normalizeNamingBrain(item, ownerId));
 if (value === null || typeof value !== "object") return value;
 const row: Record<string, unknown> = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeNamingBrain(child, ownerId)]));
 if (("ownerId" in row && row.ownerId !== ownerId) || ("owner_id" in row && row.owner_id !== ownerId)) throw new ApiError("not_found");
 if (row.strategyBasis) {
  const basis = namingStrategyBasisSchema.safeParse(row.strategyBasis);
  if (!basis.success) throw new ApiError("integration_unavailable");
  row.strategyKey = namingStrategyKeyFromBasis(basis.data);
 }
 return row;
}
const sourceFields = {
 ownerId: z.uuid(), projectId: z.uuid(), candidateId: z.uuid(), runId: z.uuid(), jobId: z.uuid(), batchId: z.uuid(),
 snapshot: namingBriefSnapshotSchema, sourceArtifactId: z.uuid(), sourceStageKey: z.enum(["creation", "gap"]),
 sourceCandidate: namingCandidateProposalSchema, providerReceipt: namingProviderReceiptSchema, creatorAttribution: namingCreatorAttributionSchema,
 verificationFindings: z.array(namingVerificationFindingSchema).max(8),
 preparedCandidateIds: z.array(z.uuid()).min(1).max(100),
};
const sourceSchema = z.union([
 z.strictObject({ ...sourceFields, verificationArtifactId: z.uuid(), preparedSetId: z.uuid() }),
 z.strictObject({ ...sourceFields, verificationArtifactId: z.uuid().nullable(), preparedSetId: z.null(), microbatchId: z.uuid(), verificationMode: z.enum(["verified", "not_required"]) }).superRefine((value, ctx) => {
  if (value.sourceStageKey !== "creation" || value.providerReceipt.localPipelineVersion !== 2 || value.providerReceipt.budgetControl !== "local_unlimited_v1"
   || (value.verificationMode === "verified") !== (value.verificationArtifactId !== null)
   || value.verificationMode === "not_required" && (value.sourceCandidate.claims.length !== 0 || value.verificationFindings.length !== 0 || ["other_languages", "classical_roots", "stories_culture", "people_places"].includes(value.sourceCandidate.primaryApproach))) ctx.addIssue({ code: "custom", message: "Microbatch provenance must retain its actual verification requirement" });
 }),
]);
export async function loadManagedNamingSources(auth: AuthenticatedContext, projectId: string, candidates: readonly ProjectNameCandidate[]) {
 const ids = candidates.filter(candidate => candidate.origin.kind === "generated" && candidate.origin.billingMode === "openai_api").map(candidate => candidate.id);
 const proofs = new Map<string, unknown>();
 if (!ids.length) return proofs;
 const { data, error } = await auth.client.rpc("get_naming_brain_candidate_sources", { p_project_id: projectId, p_candidate_ids: ids });
 if (error) throw new ApiError(error.code === "P0002" ? "not_found" : "integration_unavailable");
 const parsed = z.array(sourceSchema).max(100).safeParse(normalizeNamingBrain(data, auth.userId));
 if (!parsed.success || parsed.data.length !== ids.length) throw new ApiError("integration_unavailable");
 for (const proof of parsed.data) {
  if (proof.projectId !== projectId || !ids.includes(proof.candidateId) || proofs.has(proof.candidateId)) throw new ApiError("integration_unavailable");
  proofs.set(proof.candidateId, proof);
 }
 return proofs;
}
export async function verifyManagedNamingSource(auth: AuthenticatedContext, candidate: ProjectNameCandidate, supplied?: unknown) {
 const origin = candidate.origin;
 if (origin.kind !== "generated" || origin.billingMode !== "openai_api") throw new ApiError("integration_unavailable");
 let raw = supplied;
 if (raw === undefined) {
  const { data, error } = await auth.client.rpc("get_naming_brain_candidate_source", { p_project_id: candidate.projectId, p_candidate_id: candidate.id });
  if (error) throw new ApiError(error.code === "P0002" ? "not_found" : "integration_unavailable");
  raw = data;
 }
 const result = sourceSchema.safeParse(normalizeNamingBrain(raw, auth.userId));
 if (!result.success) throw new ApiError("integration_unavailable");
 const proof = result.data, receipt = proof.providerReceipt, source = proof.sourceCandidate, attribution = proof.creatorAttribution;
 const findings = proof.verificationFindings;
 if (new Set(findings.map(finding => finding.claimKey)).size !== findings.length || findings.some(finding => finding.assignmentKey !== receipt.assignmentKey || finding.candidateKey !== source.candidateKey || !source.claims.some(claim => claim.claimKey === finding.claimKey))) throw new ApiError("integration_unavailable");
 const notes = source.claims.map(claim => { const finding = findings.find(finding => finding.claimKey === claim.claimKey); return { claimKey: claim.claimKey, originalStatement: claim.statement, status: finding?.status ?? "unresolved", explanation: finding?.explanation ?? "No completed verification supports this claim." }; });
 if (proof.projectId !== candidate.projectId || proof.candidateId !== candidate.id || proof.runId !== origin.runId || proof.jobId !== origin.jobId || proof.batchId !== origin.batchId || proof.sourceArtifactId !== origin.sourceArtifactId || proof.sourceStageKey !== origin.sourceStageKey
  || proof.snapshot.contextRevision !== candidate.contextRevision || JSON.stringify(proof.snapshot.strategyBasis) !== JSON.stringify(candidate.strategyBasis)
  || !proof.preparedCandidateIds.includes(candidate.id) || new Set(proof.preparedCandidateIds).size !== proof.preparedCandidateIds.length
  || source.value !== candidate.value || namingDisplayRationale(source.rationale, source.claims, findings) !== candidate.rationale || JSON.stringify(candidate.verificationNotes ?? []) !== JSON.stringify(notes) || (source.caution ?? undefined) !== candidate.caution || nameIdentityKey(source.value) !== candidate.identityKey
  || receipt.runId !== origin.runId || receipt.snapshotHash !== proof.snapshot.snapshotHash || receipt.stageKey !== origin.sourceStageKey
  || receipt.protocol !== origin.protocol || receipt.observedModel !== origin.model || receipt.requestId !== origin.requestId || receipt.recordedAt !== origin.generatedAt
  || attribution.itemId !== origin.providerItemId || !receipt.artifactItemIds.includes(attribution.itemId)
  || receipt.sessionId !== origin.sessionId || receipt.turnId !== origin.turnId || receipt.agentId !== origin.agentId || receipt.responseId !== origin.responseId
  || attribution.sessionId !== receipt.sessionId || attribution.turnId !== receipt.turnId || attribution.responseId !== receipt.responseId) throw new ApiError("integration_unavailable");
 return proof;
}
