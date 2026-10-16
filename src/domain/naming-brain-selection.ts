import { z } from "zod";
import {
  applyNamingVerification, getNamingPreferencesReadiness, namingAppliedVerificationSchema, namingBriefSnapshotSchema, namingCurationSchema,
  namingGapContextSchema, namingPreparedSetSchema, namingValidatedCandidateSchema, type NamingGapContext, type NamingApproach, type NamingAssemblyInput, type NamingCandidateRejection, type NamingPreparedSet, type NamingValidatedCandidate,
} from "./naming-brain";
import { nameIdentityKeySchema } from "./project-naming";
export type { NamingAssemblyInput, NamingPreparedSet, NamingGapContext } from "./naming-brain";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function candidateRef(candidate: { assignmentKey: string; candidateKey: string }): string { return `${candidate.assignmentKey}/${candidate.candidateKey}`; }
function compare(a: NamingValidatedCandidate, b: NamingValidatedCandidate): number {
  return a.assignmentOrder - b.assignmentOrder || a.generatedOrder - b.generatedOrder || (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0);
}

function grouped(candidates: readonly NamingValidatedCandidate[]): NamingValidatedCandidate[][] {
  const groups = new Map<string, NamingValidatedCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.primaryApproach}/${candidate.territoryId}/${candidate.constructionKey}`;
    const rows = groups.get(key) ?? []; rows.push(candidate); groups.set(key, rows);
  }
  return Array.from(groups.values());
}

/** Maximum matching reserves distinct identities for primary floors before duplicate removal. */
function identityRepresentatives(candidates: readonly NamingValidatedCandidate[], approaches: readonly NamingApproach[]): NamingValidatedCandidate[] {
  const groups = grouped(candidates);
  const preferences = new Map(approaches.map(approach => {
    const own = groups.filter(group => group[0]!.primaryApproach === approach), ordered: NamingValidatedCandidate[] = [], seen = new Set<string>();
    for (let index = 0; own.some(group => index < group.length); index += 1) {
      for (const group of own) {
        const candidate = group[index];
        if (candidate && !seen.has(candidate.identityKey)) { ordered.push(candidate); seen.add(candidate.identityKey); }
      }
    }
    return [approach, ordered] as const;
  }));
  const slots = Array.from({ length: 5 }, () => approaches).flat();
  const ownerByIdentity = new Map<string, number>(), matchedBySlot = new Map<number, NamingValidatedCandidate>();
  function augment(slot: number, visited: Set<string>): boolean {
    const choices = preferences.get(slots[slot]!)!;
    // Preserve existing choices when a free identity suffices; otherwise move a
    // previous slot along an augmenting path. Every replacement is a real record.
    const free = choices.find(candidate => !visited.has(candidate.identityKey) && !ownerByIdentity.has(candidate.identityKey));
    if (free) { ownerByIdentity.set(free.identityKey, slot); matchedBySlot.set(slot, free); return true; }
    for (const candidate of choices) {
      if (visited.has(candidate.identityKey)) continue;
      visited.add(candidate.identityKey);
      const owner = ownerByIdentity.get(candidate.identityKey)!;
      if (augment(owner, visited)) { ownerByIdentity.set(candidate.identityKey, slot); matchedBySlot.set(slot, candidate); return true; }
    }
    return false;
  }
  for (let slot = 0; slot < slots.length; slot += 1) augment(slot, new Set());
  const representatives = new Map(Array.from(matchedBySlot.values(), candidate => [candidate.identityKey, candidate]));
  for (const candidate of candidates) if (!representatives.has(candidate.identityKey)) representatives.set(candidate.identityKey, candidate);
  return Array.from(representatives.values()).sort(compare);
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
  const applied = applyNamingVerification(candidates, verification.artifact, verification.sourceContext);
  const byAppliedId = new Map(applied.candidates.map(candidate => [candidate.candidateId, candidate]));
  assert(verification.candidates.length === candidates.length && verification.candidates.every(candidate => JSON.stringify(candidate) === JSON.stringify(byAppliedId.get(candidate.candidateId))), "Applied verification cannot be forged or omit candidates");
  const candidateByRef = new Map(candidates.map(candidate => [candidateRef(candidate), candidate]));
  assert(curation.output.annotations.every(annotation => candidateByRef.has(candidateRef(annotation))), "Curator annotations require a known candidate reference");
  assert(Array.isArray(raw.existingIdentityKeys) || raw.existingIdentityKeys instanceof Set, "Assembly requires the complete-index lookup result, including an explicit empty result");
  assert((Array.isArray(raw.existingIdentityKeys) ? raw.existingIdentityKeys.length : (raw.existingIdentityKeys as ReadonlySet<string>).size) <= 200, "Duplicate lookup is bounded to this candidate pool");
  const candidateIdentities = new Set(candidates.map(candidate => candidate.identityKey));
  const existing = new Set(Array.from(raw.existingIdentityKeys, key => nameIdentityKeySchema.parse(key))), rejected: NamingCandidateRejection[] = [];
  assert(Array.from(existing).every(key => candidateIdentities.has(key)), "Duplicate lookup identities must describe the candidate pool");
  const eligibleAlternatives = candidates.filter(candidate => {
    let reason: NamingCandidateRejection["reason"] | null = null;
    if (existing.has(candidate.identityKey)) reason = "duplicate_history";
    else if (!byAppliedId.get(candidate.candidateId)!.eligible) reason = "unsupported_primary_claim";
    if (reason) { rejected.push({ assignmentKey: candidate.assignmentKey, candidateKey: candidate.candidateKey, candidateId: candidate.candidateId, reason }); return false; }
    return true;
  });
  const eligible = identityRepresentatives(eligibleAlternatives, snapshot.preferences.approaches), representativeIds = new Set(eligible.map(candidate => candidate.candidateId));
  for (const candidate of eligibleAlternatives) if (!representativeIds.has(candidate.candidateId)) rejected.push({ assignmentKey: candidate.assignmentKey, candidateKey: candidate.candidateKey, candidateId: candidate.candidateId, reason: "duplicate_response" });
  const sourceOrder = new Map(candidates.map((candidate, index) => [candidate.candidateId, index]));
  rejected.sort((a, b) => sourceOrder.get(a.candidateId)! - sourceOrder.get(b.candidateId)!);
  // Group order comes from the validated Director order. A shared ending or an
  // unfamiliar name is not a defect, and there is deliberately no taste score.
  const orderedGroups = grouped(eligible), selected: NamingValidatedCandidate[] = [];
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


/** Derive Director gap instructions from the same saved outputs used for assembly. */
export function createNamingGapContext(input: NamingAssemblyInput | unknown): NamingGapContext {
  const prepared = assembleNamingSet(input), raw = input as NamingAssemblyInput;
  const candidates = z.array(namingValidatedCandidateSchema).max(200).parse(raw.candidates).sort(compare);
  const selected = new Set(prepared.candidateIds), unused = new Set(prepared.retainedUnusedIds), rejected = new Set(prepared.rejected.map(row => row.candidateId));
  assert(candidates.every(candidate => selected.has(candidate.candidateId) || unused.has(candidate.candidateId) || rejected.has(candidate.candidateId)), "Every saved candidate must retain its actual assembly disposition");
  return namingGapContextSchema.parse({ version: 1, runId: prepared.runId, snapshotHash: prepared.snapshotHash, missingCount: prepared.fulfillment.missingCount, primaryCounts: prepared.primaryCounts, deficits: prepared.deficits,
    currentPool: candidates.map(candidate => ({ candidateId: candidate.candidateId, sourceArtifactId: candidate.sourceArtifactId, value: candidate.value, identityKey: candidate.identityKey, primaryApproach: candidate.primaryApproach, disposition: selected.has(candidate.candidateId) ? "selected" : unused.has(candidate.candidateId) ? "unused" : "rejected" })),
    curationArtifactId: prepared.curationArtifactId, verificationArtifactId: prepared.verificationArtifactId, sourceArtifactIds: prepared.sourceArtifactIds });
}
export function validateNamingGapContext(contextInput: unknown, assemblyInput: NamingAssemblyInput | unknown): NamingGapContext {
  const context = namingGapContextSchema.parse(contextInput);
  assert(JSON.stringify(context) === JSON.stringify(createNamingGapContext(assemblyInput)), "Gap context must match the exact saved assembly inputs and actual deficits");
  return context;
}
