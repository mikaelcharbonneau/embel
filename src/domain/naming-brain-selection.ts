import { z } from "zod";
import {
  applyNamingVerification, getNamingPreferencesReadiness, namingAppliedVerificationSchema, namingBriefSnapshotSchema, namingCurationSchema,
  namingPreparedSetSchema, namingValidatedCandidateSchema, type NamingAssemblyInput, type NamingCandidateRejection, type NamingPreparedSet, type NamingValidatedCandidate,
} from "./naming-brain";
import { nameIdentityKeySchema } from "./project-naming";
export type { NamingAssemblyInput, NamingPreparedSet } from "./naming-brain";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function candidateRef(candidate: { assignmentKey: string; candidateKey: string }): string { return `${candidate.assignmentKey}/${candidate.candidateKey}`; }
function compare(a: NamingValidatedCandidate, b: NamingValidatedCandidate): number {
  return a.assignmentOrder - b.assignmentOrder || a.generatedOrder - b.generatedOrder || (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0);
}

/** Pure assembly; the persistence boundary must also verify full-index coverage and its writer epoch. */
export function assembleNamingSet(input: NamingAssemblyInput | unknown): NamingPreparedSet {
  assert(input !== null && typeof input === "object", "Assembly requires a complete input");
  const raw = input as NamingAssemblyInput;
  const snapshot = namingBriefSnapshotSchema.parse(raw.snapshot), candidates = z.array(namingValidatedCandidateSchema).max(200).parse(raw.candidates).sort(compare), curation = namingCurationSchema.parse(raw.curation), verification = namingAppliedVerificationSchema.parse(raw.verification);
  assert(getNamingPreferencesReadiness(snapshot.preferences).ready, "Assembly requires saved explicit naming choices");
  assert(curation.runId === verification.runId && curation.snapshotHash === snapshot.snapshotHash && verification.snapshotHash === snapshot.snapshotHash, "Assembly artifacts must bind one frozen run");
  assert(new Set(candidates.map(row => row.candidateId)).size === candidates.length && new Set(candidates.map(candidateRef)).size === candidates.length, "Candidate identities and local references must be unique");
  assert(candidates.every(candidate => candidate.runId === curation.runId && candidate.snapshotHash === snapshot.snapshotHash && snapshot.preferences.approaches.includes(candidate.primaryApproach) && candidate.additionalApproaches.every(approach => snapshot.preferences.approaches.includes(approach))), "Candidate attribution must bind this run and selected approaches");
  const applied = applyNamingVerification(candidates, verification.artifact);
  const byAppliedId = new Map(applied.candidates.map(candidate => [candidate.candidateId, candidate]));
  assert(verification.candidates.length === candidates.length && verification.candidates.every(candidate => JSON.stringify(candidate) === JSON.stringify(byAppliedId.get(candidate.candidateId))), "Applied verification cannot be forged or omit candidates");
  const candidateByRef = new Map(candidates.map(candidate => [candidateRef(candidate), candidate]));
  assert(curation.output.annotations.every(annotation => candidateByRef.has(candidateRef(annotation))), "Curator annotations require a known candidate reference");
  assert(Array.isArray(raw.existingIdentityKeys) || raw.existingIdentityKeys instanceof Set, "Assembly requires the complete-index lookup result, including an explicit empty result");
  assert((Array.isArray(raw.existingIdentityKeys) ? raw.existingIdentityKeys.length : (raw.existingIdentityKeys as ReadonlySet<string>).size) <= 200, "Duplicate lookup is bounded to this candidate pool");
  const candidateIdentities = new Set(candidates.map(candidate => candidate.identityKey));
  const existing = new Set(Array.from(raw.existingIdentityKeys, key => nameIdentityKeySchema.parse(key))), seen = new Set<string>(), rejected: NamingCandidateRejection[] = [];
  assert(Array.from(existing).every(key => candidateIdentities.has(key)), "Duplicate lookup identities must describe the candidate pool");
  const eligible = candidates.filter(candidate => {
    let reason: NamingCandidateRejection["reason"] | null = null;
    if (existing.has(candidate.identityKey)) reason = "duplicate_history";
    else if (seen.has(candidate.identityKey)) reason = "duplicate_response";
    else if (!byAppliedId.get(candidate.candidateId)!.eligible) reason = "unsupported_primary_claim";
    if (reason) { rejected.push({ assignmentKey: candidate.assignmentKey, candidateKey: candidate.candidateKey, candidateId: candidate.candidateId, reason }); return false; }
    seen.add(candidate.identityKey);
    return true;
  });
  // Group order comes from the validated Director order. A shared ending or an
  // unfamiliar name is not a defect, and there is deliberately no taste score.
  const groups = new Map<string, NamingValidatedCandidate[]>();
  for (const candidate of eligible) {
    const key = `${candidate.primaryApproach}/${candidate.territoryId}/${candidate.constructionKey}`;
    const rows = groups.get(key) ?? []; rows.push(candidate); groups.set(key, rows);
  }
  const orderedGroups = Array.from(groups.values()), selected: NamingValidatedCandidate[] = [];
  const counts = new Map(snapshot.preferences.approaches.map(approach => [approach, 0]));
  const positions = new Map(orderedGroups.map(group => [group, 0]));
  function take(group: NamingValidatedCandidate[]): boolean {
    const index = positions.get(group)!, candidate = group[index];
    if (!candidate || selected.length === 100) return false;
    positions.set(group, index + 1); selected.push(candidate); counts.set(candidate.primaryApproach, counts.get(candidate.primaryApproach)! + 1); return true;
  }
  // Round-robin both across approaches and within each approach's territories.
  const approachTurns = new Map(snapshot.preferences.approaches.map(approach => [approach, 0]));
  for (let floor = 0; floor < 5; floor += 1) {
    for (const approach of snapshot.preferences.approaches) {
      const ownGroups = orderedGroups.filter(group => group[0]!.primaryApproach === approach);
      if (!ownGroups.length) continue;
      const next = approachTurns.get(approach)!;
      for (let attempt = 0; attempt < ownGroups.length; attempt += 1) {
        const index = (next + attempt) % ownGroups.length;
        if (take(ownGroups[index]!)) { approachTurns.set(approach, (index + 1) % ownGroups.length); break; }
      }
    }
  }
  while (selected.length < 100) {
    let progressed = false;
    for (const group of orderedGroups) progressed = take(group) || progressed;
    if (!progressed) break;
  }
  const selectedIds = new Set(selected.map(candidate => candidate.candidateId));
  const primaryCounts = snapshot.preferences.approaches.map(approach => ({ approach, count: counts.get(approach)! }));
  const deficits = primaryCounts.filter(row => row.count < 5).map(row => ({ approach: row.approach, required: 5, actual: row.count, missing: 5 - row.count }));
  return namingPreparedSetSchema.parse({ version: 1, runId: curation.runId, stageKey: "prepare", snapshotHash: snapshot.snapshotHash, schemaVersion: 1, promptVersion: "naming-brain-v1",
    targetCount: 100, minimumPerApproach: 5, candidateIds: selected.map(candidate => candidate.candidateId), primaryCounts, retainedUnusedIds: eligible.filter(candidate => !selectedIds.has(candidate.candidateId)).map(candidate => candidate.candidateId),
    fulfillment: { status: !selected.length ? "none" : selected.length === 100 && !deficits.length ? "complete" : "partial", targetCount: 100, acceptedCount: selected.length, missingCount: 100 - selected.length, coverageSatisfied: !deficits.length, message: selected.length === 100 && !deficits.length ? null : `${selected.length} of 100 names are ready.${deficits.length ? " Some selected approaches still need five supported primary credits." : " Further exploration is needed to complete the set."}` },
    deficits, rejected, annotations: curation.output.annotations.map(annotation => ({ candidateId: candidateByRef.get(candidateRef(annotation))!.candidateId, concerns: annotation.concerns })),
    curationArtifactId: curation.artifactId, verificationArtifactId: verification.verificationArtifactId, sourceArtifactIds: Array.from(new Set(candidates.map(candidate => candidate.sourceArtifactId))),
  });
}
