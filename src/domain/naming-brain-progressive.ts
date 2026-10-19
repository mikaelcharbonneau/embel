import {
  applyNamingVerification, namingBriefSnapshotSchema, namingCurationSchema, namingMicrobatchInputSchema,
  namingValidatedCandidateSchema, type NamingMicrobatchInput, type NamingValidatedCandidate, type NamingVerification,
  type NamingVerificationSourceContext,
} from "./naming-brain";

/** No unsupported factual route can gain a primary credit through the fast path. */
export const NAMING_PROGRESSIVE_FACTUAL_APPROACHES = new Set(["other_languages", "classical_roots", "stories_culture", "people_places"]);

/** Creates publication references, never model outputs or provider receipts. SQL
 * independently binds these references to the saved originals and current index. */
export function createNamingMicrobatch(options: {
  key: string; snapshot: unknown; candidates: readonly NamingValidatedCandidate[]; curation: unknown;
  verification?: NamingVerification; sourceContext?: NamingVerificationSourceContext;
}): NamingMicrobatchInput {
  const snapshot = namingBriefSnapshotSchema.parse(options.snapshot), curation = namingCurationSchema.parse(options.curation);
  const candidates = options.candidates.map(candidate => namingValidatedCandidateSchema.parse(candidate));
  if (curation.providerReceipt.localPipelineVersion !== 2 || curation.providerReceipt.budgetControl !== "local_unlimited_v1"
    || curation.snapshotHash !== snapshot.snapshotHash || candidates.some(candidate => candidate.runId !== curation.runId || candidate.snapshotHash !== snapshot.snapshotHash)) throw new Error("naming_microbatch_scope_mismatch");
  let eligible = candidates;
  if (options.verification) {
    if (!options.sourceContext || options.verification.providerReceipt.localPipelineVersion !== 2) throw new Error("naming_microbatch_verification_missing");
    const checked = applyNamingVerification(candidates, options.verification, options.sourceContext);
    const allowed = new Set(checked.candidates.filter(candidate => candidate.eligible).map(candidate => candidate.candidateId));
    eligible = candidates.filter(candidate => allowed.has(candidate.candidateId)
      && (!NAMING_PROGRESSIVE_FACTUAL_APPROACHES.has(candidate.primaryApproach) || candidate.claims.some(claim => claim.requirement === "primary_approach")));
  } else eligible = candidates.filter(candidate => !candidate.claims.length && !NAMING_PROGRESSIVE_FACTUAL_APPROACHES.has(candidate.primaryApproach));
  if (!eligible.length) throw new Error("naming_microbatch_no_eligible_candidates");
  // Curator concerns are annotations. Unfamiliar sound, imagery and subjective
  // taste never become a new automatic rejection rule.
  return namingMicrobatchInputSchema.parse({ version: 1, key: options.key,
    candidates: eligible.map(({ candidateId, sourceArtifactId, candidateKey, assignmentKey, identityKey }) => ({ candidateId, sourceArtifactId, candidateKey, assignmentKey, identityKey })),
    curationArtifactId: curation.artifactId,
    verification: options.verification ? { kind: "verified", artifactId: options.verification.artifactId } : { kind: "not_required", reason: "no_factual_claims" },
  });
}
