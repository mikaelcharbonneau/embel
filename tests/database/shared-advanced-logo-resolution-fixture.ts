import { createHash } from "node:crypto";
import type { SharedAdvancedLogoFixture } from "./shared-advanced-logo-fixture";
import { sharedExecutionSchema } from "../../worker/shared-pool/contracts";
import { logoExportFileRequestKey } from "../../src/features/identity-deliverables/server/publish";
import type { IdentityAssetReservation } from "../../src/server/data/identity-asset-store";

/** Synthetic byte metadata and actual disposable restricted SQL. The native
 * engine integration separately supplies real rendered bytes and Storage RLS. */
export async function prepareAmbiguousSharedExport(f: SharedAdvancedLogoFixture) {
 const prepared = await f.prepareExport();
 const execution = sharedExecutionSchema.parse((await f.action(null, "claim", ["synthetic-export-resolution", 120])).execution);
 await f.action(execution, "begin", [execution.jobId, execution.leaseToken, "prepare-export", `synthetic-export:${execution.jobId}`, 0]);
 const files = [], reservations: IdentityAssetReservation[] = [];
 for (const file of prepared.source.expected) {
  const bytes = Buffer.from(`synthetic-export-resolution:${file.name}`), contentHash = createHash("sha256").update(bytes).digest("hex");
  const publication = { requestKey: logoExportFileRequestKey(execution.jobId, prepared.job.input.sourceSnapshotHash as string, { name: file.name, contentHash }),
   source: { kind: "export", sourceId: execution.jobId }, inputRevisions: prepared.source.source.inputRevisions, mimeType: file.mimeType, contentHash, byteLength: bytes.length };
  const reservation = (await f.action(execution, "prepare_asset", [execution.projectId, { kind: "stage", publication }, execution.jobId, execution.leaseToken])).result as IdentityAssetReservation;
  await f.grant(execution, reservation, "write");
  const verification = { status: "verified", checkedAt: new Date().toISOString(), contentHash, mimeType: file.mimeType, byteLength: bytes.length };
  await f.action(execution, "observe_asset", [reservation.id, verification, execution.jobId, execution.leaseToken]);
  files.push({ ...file, contentHash, byteLength: bytes.length }); reservations.push(reservation);
 }
 const group = { sourceSnapshotHash: prepared.job.input.sourceSnapshotHash, completeness: "complete", failure: null, files, assetReceiptIds: reservations.map(r => r.id) };
 const staged = (await f.action(execution, "stage_exports", [execution.jobId, execution.leaseToken, group])).result;
 // The stage committed; its acknowledgement was lost. Record the original
 // handler's ambiguity rather than claiming a new successful provider outcome.
 await f.action(execution, "complete", [execution.jobId, execution.leaseToken, "prepare-export", "ambiguous", 0, { error: "export_publication_unknown" }, null]);
 async function observeAll() {
  let pages = 0;
  while (true) {
   const page = (await f.action(execution, "recovery", [])).result as { outputs: { reservation: IdentityAssetReservation }[] };
   if (!page.outputs.length) break;
   if (++pages > 34) throw Error("Unbounded synthetic export recovery");
   for (const { reservation } of page.outputs) await f.action(execution, "observe_recovered_asset", [execution.leaseToken, reservation.id,
    { status: "verified", checkedAt: new Date().toISOString(), contentHash: reservation.reference.contentHash, mimeType: reservation.mimeType, byteLength: reservation.byteLength }]);
  }
 }
 return { prepared, execution, reservations, group, staged, observeAll };
}
