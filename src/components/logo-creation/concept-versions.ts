import type { IdentityAssetReceipt } from "@/domain/logo-deliverables";
import type { LogoConceptBatch } from "@/domain/logo-jobs";
import type { LogoRasterSource } from "@/domain/logo-workspace";
import type { LogoRefinementHistoryState } from "./refinement-history";
import { acceptedConceptAttempt } from "./presentation";
import { logoCandidateKey } from "./candidate-review";

export type LogoCardVersion = { key: string; source: LogoRasterSource; preview: IdentityAssetReceipt; createdAt: string; label: string };
/** Resolve only verified lineage back to an actual retained concept attempt. */
export function conceptVersions(batch: LogoConceptBatch | null, history: LogoRefinementHistoryState): Record<string, LogoCardVersion[]> {
  if (!batch) return {};
  const records = new Map(history.items.filter(row => row.verified).map(row => [row.record.id, row.record]));
  function root(source: LogoRasterSource, seen = new Set<string>()): string | null {
    if (source.kind === "concept") return source.batchId === batch!.id && batch!.slots.some(slot => slot.id === source.slotId && slot.attempts.some(attempt => attempt.id === source.attemptId && attempt.state === "succeeded")) ? source.slotId : null;
    if (seen.has(source.rasterRevisionId)) return null;
    seen.add(source.rasterRevisionId);
    const record = records.get(source.rasterRevisionId);
    return record && record.source.kind !== "vector" ? root(record.source, seen) : null;
  }
  const result: Record<string, LogoCardVersion[]> = {};
  for (const slot of batch.slots) {
    const attempt = acceptedConceptAttempt(slot);
    if (!attempt?.preview) continue;
    const source = { kind: "concept" as const, batchId: batch.id, slotId: slot.id, attemptId: attempt.id };
    result[slot.id] = [{ key: logoCandidateKey(source), source, preview: attempt.preview, createdAt: batch.createdAt, label: "Original" }];
  }
  for (const record of [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (record.state !== "succeeded" || record.billing.status !== "recorded" || record.preview?.publicationState !== "committed") continue;
    const slot = root({ kind: "refinement", rasterRevisionId: record.id });
    if (!slot || !result[slot]) continue;
    const source = { kind: "refinement" as const, rasterRevisionId: record.id };
    result[slot].push({ key: logoCandidateKey(source), source, preview: record.preview, createdAt: record.createdAt, label: `Version ${result[slot].length + 1}` });
  }
  return result;
}
