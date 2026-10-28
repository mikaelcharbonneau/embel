import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedAdvancedLogoFixture, type SharedAdvancedLogoFixture } from "./shared-advanced-logo-fixture";
import { sharedExecutionSchema } from "../../worker/shared-pool/contracts";
import { logoExportFileRequestKey } from "../../src/features/identity-deliverables/server/publish";
import type { IdentityAssetReservation } from "../../src/server/data/identity-asset-store";

describe("bounded unobserved advanced Logo recovery pages (synthetic byte metadata, actual restricted SQL/RLS)", () => {
 let f: SharedAdvancedLogoFixture;
 beforeAll(async () => { f = await createSharedAdvancedLogoFixture(); await f.runtimeReady(); }, 90_000);
 afterAll(async () => { await f?.close(); });
 it("observes seven issued export reservations in stable pages of three without accepting output or losing the frozen capability", async () => {
  const prepared = await f.prepareExport(), claim = await f.action(null, "claim", ["shared-recovery-fixture", 120]), e = sharedExecutionSchema.parse(claim.execution);
  expect(e.jobId).toBe(prepared.jobId);
  await f.action(e, "begin", [e.jobId, e.leaseToken, "prepare-export", `synthetic:${e.jobId}`, 0]);
  const files = prepared.source.expected.slice(0, 8); expect(files.length).toBe(8);
  const issued: IdentityAssetReservation[] = [];
  for (const [index, file] of files.entries()) {
   const bytes = Buffer.from(`synthetic-unpublished-export-byte-fixture:${file.name}`), contentHash = createHash("sha256").update(bytes).digest("hex");
   const publication = { requestKey: logoExportFileRequestKey(e.jobId, prepared.job.input.sourceSnapshotHash as string, { name: file.name, contentHash }),
    source: { kind: "export", sourceId: e.jobId }, inputRevisions: prepared.source.source.inputRevisions, mimeType: file.mimeType, contentHash, byteLength: bytes.length };
   const reservation = (await f.action(e, "prepare_asset", [e.projectId, { kind: "stage", publication }, e.jobId, e.leaseToken])).result as IdentityAssetReservation;
   if (index < 7) { await f.grant(e, reservation, "write"); issued.push(reservation); }
  }
  await f.action(e, "complete", [e.jobId, e.leaseToken, "prepare-export", "ambiguous", 0, { error: "provider_outcome_unknown" }, null]);
  // Withdrawing the current profile cannot replace the old immutable recovery
  // descriptor or grant active/provider authority to the parked execution.
  await f.db.query("delete from fluid_private.shared_worker_policies where slot_id=$1 and operation='identity.logo_export'", [f.slotId]);
  const seen = new Set<string>(); let pages = 0;
  while (true) {
   const page = (await f.action(e, "recovery", [])).result as { outputs: { reservation: IdentityAssetReservation }[]; remaining: boolean; capability: unknown };
   expect(page.capability).toEqual(prepared.capability); expect(page.outputs.length).toBeLessThanOrEqual(3);
   if (!page.outputs.length) { expect(page.remaining).toBe(false); break; }
   pages++; expect(pages).toBeLessThanOrEqual(3);
   expect(page.outputs.map(row => row.reservation.id)).toEqual([...page.outputs.map(row => row.reservation.id)].sort());
   for (const { reservation } of page.outputs) {
    expect(issued.some(value => value.id === reservation.id)).toBe(true); expect(seen.has(reservation.id)).toBe(false); seen.add(reservation.id);
    const verification = { status: "verified", checkedAt: new Date().toISOString(), contentHash: reservation.reference.contentHash, mimeType: reservation.mimeType, byteLength: reservation.byteLength };
    if (pages === 1 && seen.size === 1) await expect(f.action(e, "observe_recovered_asset", [e.leaseToken, reservation.id, { ...verification, contentHash: "f".repeat(64) }])).rejects.toMatchObject({ code: "42501" });
    expect((await f.action(e, "observe_recovered_asset", [e.leaseToken, reservation.id, verification])).result).toMatchObject({ status: "observed_only", providerOutcome: "retained_unknown" });
   }
  }
  expect(seen.size).toBe(7); expect(pages).toBe(3);
  expect((await f.rawJob(e.jobId)).state).toBe("needs_reconciliation");
  expect((await f.db.query<{ count: number }>("select count(*)::int count from public.asset_versions where id in(select version_id from public.logo_asset_publications where job_id=$1)", [e.jobId])).rows[0]!.count).toBe(0);
  await expect(f.action(e, "begin", [e.jobId, e.leaseToken, "prepare-export", "replacement", 0])).rejects.toMatchObject({ code: "42501" });
 });
});
