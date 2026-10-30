import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedAdvancedLogoFixture, type SharedAdvancedLogoFixture } from "./shared-advanced-logo-fixture";
import { OWNER_A, OWNER_B } from "./local-supabase";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { logoCostQuoteSchema } from "../../src/domain/logo-jobs";
import { sharedExecutionSchema, sharedPendingExecutionSchema, type SharedSlotLease } from "../../worker/shared-pool/contracts";
import { parseClaimedJob } from "../../worker/postgres-store";
import { stripReviewedTransactionEnvelope } from "../../scripts/prepare-shared-production-migration.mjs";
import type { IdentityAssetReservation } from "../../src/server/data/identity-asset-store";
import { createSharedLogoLaneEngine } from "../../worker/shared-lanes/logo";
import { createSharedLogoStorageAuthorization } from "../../worker/shared-storage/authorization";
import { qualifiedLogoRasterCapability } from "../../worker/logo-generative-storage-authorization";
import { SHARED_STORAGE_ACTOR, SHARED_STORAGE_ORIGIN, SHARED_STORAGE_SESSION } from "./shared-storage-fixture";

describe("shared raster delivery recovery (actual disposable SQL, synthetic provider/Storage evidence)", () => {
 let f: SharedAdvancedLogoFixture;
 const packet = async (name: string) => { const source = await readFile(new URL(`../../supabase/candidates/${name}.sql`, import.meta.url), "utf8"); return stripReviewedTransactionEnvelope(source, createHash("sha256").update(source).digest("hex")); };
 beforeAll(async () => { f = await createSharedAdvancedLogoFixture(); await f.db.exec(await packet("shared_identity_generation")); }, 90_000);
 afterAll(async () => { await f?.close(); });
 async function uncapped() {
  await f.db.exec(await packet("shared_logo_raster_uncapped"));
  for (const operation of ["identity.logo_concept", "identity.logo_refine"]) {
   const policy = { operation, policyIdentity: (operation === "identity.logo_concept" ? "a5" : "b5").repeat(32), handlerVersion: "logo-image-v1", provider: "openai", model: IMAGE_MODEL,
    engine: null, spendControl: "uncapped", estimatedCostMicrousd: 1 };
   await f.db.query("update fluid_private.shared_worker_policies set policy_identity=$2,policy=$3 where slot_id=$1 and operation=$4", [f.slotId, policy.policyIdentity, policy, operation]);
  }
 }
 async function transaction(run: () => Promise<void>) {
  await f.db.exec("begin");
  try { await run(); } finally { await f.db.exec("rollback;set session authorization postgres"); await f.resetLease(); }
 }
 async function prepare(version: 2 | 3, kind: "concept" | "refinement" = "concept") {
  if (version === 3) await uncapped();
  await f.runtimeReady();
  const base = await f.prepare();
  if (kind === "concept") return base;
  await f.complete(base);
  const input = base.job.input as { batchId: string; slotId: string; attemptId: string };
  const workspace = (await f.owner(OWNER_A, () => f.db.query<{ value: { heads: unknown } }>("select public.get_logo_workspace($1) value", [base.job.projectId]))).rows[0]!.value;
  const quote = logoCostQuoteSchema.parse((await f.owner(OWNER_A, () => f.db.query<{ value: unknown }>("select public.shared_logo_operation($1,'quote',$2) value", [base.job.projectId,
   { operation: "refine_preview", expected: workspace.heads, source: { kind: "concept", batchId: input.batchId, slotId: input.slotId, attemptId: input.attemptId }, instruction: "Round the symbol" }]))).rows[0]!.value);
  const admitted = await f.admitAdvanced(base.job.projectId, quote);
  const claim = await f.action(null, "claim", ["synthetic-raster-recovery", 120]), execution = sharedExecutionSchema.parse(claim.execution), job = parseClaimedJob((claim.result as unknown[])[0]);
  expect(job.id).toBe(admitted.jobId);
  const sourceId = (job.input as { rasterRevisionId: string }).rasterRevisionId;
  const revisions = (await f.action(execution, "read", [job.id, job.leaseToken, "input_revisions", null])).result as typeof base.publication.inputRevisions;
  const publication = { ...base.publication, requestKey: sourceId, source: { kind: "concept" as const, sourceId }, inputRevisions: revisions };
  const reservation = (await f.action(execution, "prepare_asset", [job.projectId, { kind: "stage", publication }, job.id, job.leaseToken])).result as IdentityAssetReservation;
  return { ...base, job, execution, reservation, publication, request: admitted.request };
 }
 type Prepared = Awaited<ReturnType<typeof prepare>>;
 async function interrupt(p: Prepared, options: { image?: boolean; billing?: "recorded" | "unknown"; receipt?: boolean } = {}) {
  const image = options.image ?? true, billing = options.billing ?? "recorded";
  const input = p.job.input as { slotId: string; attemptId: string };
  const key = p.job.operation === "identity.logo_concept" ? `logo-preview-v1:${input.slotId}:${input.attemptId}` : "generate-refinement";
  // Fixture's convenience preparation allocates a publication eagerly. Remove
  // that unissued row to reproduce the actual receipt-before-publication failure.
  if (!image) await f.db.query("delete from public.logo_asset_publications where id=$1", [p.reservation.id]);
  await f.action(p.execution, "begin", [p.job.id, p.job.leaseToken, key, `synthetic:${p.job.id}`, p.job.reservedCostMicrousd]);
  const cost = billing === "recorded" && options.receipt !== false ? 17 : 0;
  const observation = { provider: "openai", model: IMAGE_MODEL, providerRequestId: `synthetic-${p.job.id}`, responseHash: "a".repeat(64), observedAt: new Date().toISOString(),
   billing: billing === "recorded" ? { status: "recorded", confirmedMicrousd: cost } : { status: "unknown", confirmedMicrousd: null },
   artifactHash: p.publication.contentHash, normalizedPixelHash: "b".repeat(64) };
  const receipt = options.receipt === false ? null : (await f.action(p.execution, "receipt", [p.job.id, p.job.leaseToken, observation])).result;
  const verification = { status: "verified", checkedAt: new Date().toISOString(), contentHash: p.publication.contentHash, mimeType: "image/png", byteLength: p.bytes.byteLength };
  if (image && billing === "recorded") {
   await f.grant(p.execution, p.reservation, "write"); await f.put(p.reservation);
   await f.action(p.execution, "observe_asset", [p.reservation.id, verification, p.job.id, p.job.leaseToken]);
  }
  await f.action(p.execution, "complete", [p.job.id, p.job.leaseToken, key, "ambiguous", cost,
   { error: image ? "publication_unknown" : "provider_evidence_unconfirmed" }, options.receipt === false ? null : observation.providerRequestId]);
  return { cost, observation, receipt, verification };
 }
 async function install(version: 2 | 3) {
  if (version === 2) await uncapped();
  await f.db.exec(await packet("shared_logo_raster_recovery"));
 }
 const finish = async (p: Prepared) => (await f.action(p.execution, "finish_known", [])).result;
 const observe = async (p: Prepared, verification: unknown) => f.action(p.execution, "observe_recovered_asset", [p.execution.leaseToken, p.reservation.id, verification]);
 async function ledger(p: Prepared) {
  return (await f.db.query<{ actual_microusd: number; captured_microusd: number; provider_actual_microusd: number; spent_microusd: number }>("select r.*,a.provider_actual_microusd,a.spent_microusd,a.reserved_microusd account_reserved from public.usage_reservations r join public.usage_accounts a on a.owner_id=r.owner_id where r.job_id=$1", [p.job.id])).rows[0]!;
 }

 it("preserves complete historical job JSON and digests when installing the recovery packet", () => transaction(async () => {
  await prepare(2);
  const history = () => f.db.query("select j.id,to_jsonb(j) record,encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex') digest from public.jobs j order by id");
  const before = (await history()).rows;
  expect(before.length).toBeGreaterThan(0);
  await install(2);
  expect((await history()).rows).toEqual(before);
 }));

 it.each([2, 3] as const)("recovers a v%s concept from its original PNG once, across deployment/policy change", version => transaction(async () => {
  const p = await prepare(version), interrupted = await interrupt(p), before = await ledger(p);
  await observe(p, interrupted.verification); // Existing durable readback may predate the repair.
  await install(version);
  await f.takeover("dpl_recovery_new");
  const heads = (await f.owner(OWNER_A, () => f.db.query<{ value: unknown }>("select public.get_logo_workspace($1) value", [p.job.projectId]))).rows[0]!.value;
  expect(await finish(p)).toEqual({ status: "terminal", state: "succeeded" });
  const job = await f.rawJob(p.job.id);
  expect(job).toMatchObject({ state: "succeeded", actual_cost_microusd: interrupted.cost, lease_token: null });
  expect((await f.db.query("select evidence from fluid_private.shared_logo_raster_recoveries where job_id=$1", [p.job.id])).rows[0]).toMatchObject({
   evidence: { originalJob: { state: "needs_reconciliation", reason: "publication_unknown" }, originalStep: { state: "ambiguous", output: { error: "publication_unknown" } } } });
  expect((await f.db.query("select state from public.logo_asset_publications where id=$1", [p.reservation.id])).rows[0]).toEqual({ state: "committed" });
  const after = await ledger(p);
  expect(after).toMatchObject({ actual_microusd: before.actual_microusd, captured_microusd: before.captured_microusd, provider_actual_microusd: before.provider_actual_microusd, spent_microusd: before.spent_microusd, state: "settled" });
  const recovered = (await f.action(p.execution, "recovery", [])).result;
  expect(recovered).toMatchObject({ executionClosed: true, observationJob: { state: "succeeded" } });
  expect(await ledger(p)).toEqual(after);
  expect((await f.db.query("select * from public.logo_raster_results where job_id=$1", [p.job.id])).rows).toHaveLength(1);
  expect((await f.owner(OWNER_A, () => f.db.query<{ value: unknown }>("select public.get_logo_workspace($1) value", [p.job.projectId]))).rows[0]!.value).toEqual(heads);
  await expect(f.action(p.execution, "begin", [p.job.id, p.execution.leaseToken, "replacement", "replacement", 0])).rejects.toMatchObject({ code: "42501" });
 }));

 it.each([[2, "concept"], [3, "concept"], [2, "refinement"], [3, "refinement"]] as const)("ends v%s %s missing-image delivery as failed with its original charge", (version, kind) => transaction(async () => {
  const p = await prepare(version, kind), interrupted = await interrupt(p, { image: false }), before = await ledger(p);
  await install(version);
  expect(await finish(p)).toEqual({ status: "terminal", state: "failed" });
  expect(await f.rawJob(p.job.id)).toMatchObject({ state: "failed", error_code: "logo_image_unavailable", actual_cost_microusd: interrupted.cost });
  expect((await f.db.query("select evidence from fluid_private.shared_logo_raster_recoveries where job_id=$1", [p.job.id])).rows[0]).toMatchObject({ evidence: { originalStep: { output: { error: "provider_evidence_unconfirmed" } } } });
  expect(await ledger(p)).toMatchObject({ actual_microusd: before.actual_microusd, captured_microusd: before.captured_microusd, provider_actual_microusd: before.provider_actual_microusd, state: "settled" });
  expect((await f.db.query("select * from public.logo_provider_responses where job_id=$1", [p.job.id])).rows).toHaveLength(1);
  expect((await f.db.query("select * from public.logo_raster_results where job_id=$1", [p.job.id])).rows).toHaveLength(0);
  const request = (await f.owner(OWNER_A, () => f.db.query<{ value: unknown }>("select public.read_logo_request($1,$2) value", [p.job.projectId, p.request.requestKey]))).rows[0]!.value;
  expect(request).toMatchObject({ status: kind === "concept" ? "partial" : "failed", billing: { status: "recorded", confirmedMicrousd: interrupted.cost } });
  expect((await f.action(p.execution, "recovery", [])).result).toMatchObject({ executionClosed: true });
 }));

 it("preserves duplicate-preview rejection when a second concept has the same pixels", () => transaction(async () => {
  await uncapped(); await f.runtimeReady();
  const base = await f.prepare(OWNER_A, false); await f.complete(base);
  const claim = await f.action(null, "claim", ["synthetic-duplicate-recovery", 120]), execution = sharedExecutionSchema.parse(claim.execution), job = parseClaimedJob((claim.result as unknown[])[0]);
  const sourceId = (job.input as { attemptId: string }).attemptId;
  const publication = { ...base.publication, requestKey: sourceId, source: { kind: "concept" as const, sourceId } };
  const reservation = (await f.action(execution, "prepare_asset", [job.projectId, { kind: "stage", publication }, job.id, job.leaseToken])).result as IdentityAssetReservation;
  const p = { ...base, execution, job, publication, reservation }, interrupted = await interrupt(p);
  await observe(p, interrupted.verification); await install(3);
  const before = await ledger(p);
  expect(await finish(p)).toEqual({ status: "terminal", state: "failed" });
  expect(await f.rawJob(p.job.id)).toMatchObject({ state: "failed", error_code: "duplicate_preview" });
  expect((await f.db.query("select state from public.logo_asset_publications where id=$1", [p.reservation.id])).rows).toEqual([{ state: "staged" }]);
  expect((await f.db.query("select * from public.logo_raster_results where job_id=$1", [p.job.id])).rows).toHaveLength(0);
  expect(await ledger(p)).toMatchObject({ provider_actual_microusd: before.provider_actual_microusd, actual_microusd: before.actual_microusd, state: "settled" });
 }));

 it("rejects mismatched readbacks and rolls back publication and usage if final completion fails", () => transaction(async () => {
  const p = await prepare(3), interrupted = await interrupt(p); await install(3);
  await expect(observe(p, { ...interrupted.verification, contentHash: "f".repeat(64) })).rejects.toMatchObject({ code: "42501" });
  expect(await finish(p)).toEqual({ status: "retained_unknown" });
  await observe(p, interrupted.verification);
  const before = await ledger(p), original = await f.rawJob(p.job.id);
  await f.db.exec("create function public.synthetic_raster_resolution_fault() returns trigger language plpgsql as $$begin if new.state='succeeded' then raise exception 'synthetic_final_write_fault' using errcode='P0001';end if;return new;end$$;create trigger synthetic_raster_resolution_fault before update on public.jobs for each row execute function public.synthetic_raster_resolution_fault()");
  await expect(finish(p)).rejects.toMatchObject({ code: "P0001" });
  expect(await f.rawJob(p.job.id)).toEqual(original); expect(await ledger(p)).toEqual(before);
  expect((await f.db.query("select * from fluid_private.shared_logo_raster_recoveries where job_id=$1", [p.job.id])).rows).toHaveLength(0);
  expect((await f.db.query("select state from public.logo_asset_publications where id=$1", [p.reservation.id])).rows).toEqual([{ state: "staged" }]);
  expect((await f.db.query("select * from public.logo_raster_results where job_id=$1", [p.job.id])).rows).toHaveLength(0);
  expect((await f.db.query("select * from public.asset_versions where id=$1", [p.reservation.reference.versionId])).rows).toHaveLength(0);
 }));

 it.each([2, 3] as const)("recovers a v%s refinement without changing current workspace heads", version => transaction(async () => {
  const p = await prepare(version, "refinement"), interrupted = await interrupt(p);
  await observe(p, interrupted.verification); await install(version);
  const current = (await f.owner(OWNER_A, () => f.db.query<{ value: { heads: unknown } }>("select public.get_logo_workspace($1) value", [p.job.projectId]))).rows[0]!.value;
  await f.owner(OWNER_A, () => f.db.query("select public.apply_logo_workspace_command($1,$2)", [p.job.projectId,
   { method: "saveLogoBrief", body: { requestKey: randomUUID(), expected: current.heads, brief: { name: "Newer brief", activity: "Tests", audience: "Testers", personality: "New", logoTypes: ["wordmark"] } } }]));
  const before = (await f.db.query("select stage,revision_id from public.logo_stage_heads where project_id=$1 order by stage", [p.job.projectId])).rows;
  expect(await finish(p)).toEqual({ status: "terminal", state: "succeeded" });
  expect((await f.db.query("select stage,revision_id from public.logo_stage_heads where project_id=$1 order by stage", [p.job.projectId])).rows).toEqual(before);
  expect((await f.db.query("select * from public.logo_raster_results where job_id=$1", [p.job.id])).rows).toHaveLength(1);
 }));

 it.each(["missing_readback", "wrong_cost", "missing_receipt", "unknown_billing", "cancelled", "deleted", "wrong_source", "wrong_hash", "wrong_input", "null_reason", "foreign_execution"] as const)("retains %s instead of inventing a successful output", kind => transaction(async () => {
  const p = await prepare(3), interrupted = await interrupt(p, { image: !["missing_receipt", "unknown_billing"].includes(kind), receipt: kind !== "missing_receipt", billing: kind === "unknown_billing" ? "unknown" : "recorded" });
  if (!["missing_readback", "missing_receipt", "unknown_billing"].includes(kind)) await observe(p, interrupted.verification);
  await install(3);
  if (kind === "wrong_cost") await f.db.query("update public.jobs set actual_cost_microusd=actual_cost_microusd+1 where id=$1", [p.job.id]);
  if (kind === "cancelled") await f.owner(OWNER_A, () => f.db.query("select public.request_job_cancel($1)", [p.job.id]));
  if (kind === "deleted") await f.db.query("update public.projects set deletion_requested_at=clock_timestamp(),lifecycle_version=lifecycle_version+1 where id=$1", [p.job.projectId]);
  if (kind === "wrong_source") await f.db.query("update public.logo_asset_publications set source_receipt_id=$2 where id=$1", [p.reservation.id, randomUUID()]);
  if (kind === "wrong_hash") await f.db.query("update public.logo_asset_publications set content_hash=$2 where id=$1", [p.reservation.id, "f".repeat(64)]);
  if (kind === "wrong_input") await f.db.query("update public.logo_asset_publications set input_hash=$2 where id=$1", [p.reservation.id, "f".repeat(64)]);
  if (kind === "null_reason") await f.db.query("update public.jobs set error_code=null where id=$1", [p.job.id]);
  const before = await ledger(p);
  if (kind === "foreign_execution") await expect(f.action({ ...p.execution, ownerId: OWNER_B }, "finish_known", [])).rejects.toMatchObject({ code: "42501" });
  else expect(await finish(p)).toEqual({ status: "retained_unknown" });
  expect((await f.rawJob(p.job.id)).state).toBe("needs_reconciliation");
  expect((await f.db.query("select * from public.logo_raster_results where job_id=$1", [p.job.id])).rows).toHaveLength(0);
  expect(await ledger(p)).toEqual(before);
 }));

 it("does not expose the resolver or recovery metadata to customer/worker logins", () => transaction(async () => {
  await uncapped(); await f.db.exec(await packet("shared_logo_raster_recovery"));
  for (const role of ["anon", "authenticated", "service_role", f.roleName, "fixture_production_acl_probe"]) {
   expect((await f.db.query<{ allowed: boolean }>("select has_function_privilege($1,'fluid_private.shared_logo_resolve_raster()','execute') allowed", [role])).rows[0]!.allowed).toBe(false);
  }
  expect((await f.db.query<{ allowed: boolean }>("select has_table_privilege('authenticated','fluid_private.shared_logo_raster_recoveries','select') allowed")).rows[0]!.allowed).toBe(false);
 }));

 it.each(["saved", "lost", "corrupt"] as const)("worker recovery handles %s bytes without a provider call or Storage write", mode => transaction(async () => {
  const p = await prepare(3);
  await interrupt(p, { image: mode !== "lost" }); await install(3);
  const capability = (await f.db.query<{ policy: unknown }>("select policy from fluid_private.shared_job_admissions where job_id=$1", [p.job.id])).rows[0]!.policy;
  const pending = sharedPendingExecutionSchema.parse({ execution: p.execution, job: await f.rawJob(p.job.id), mode: "observe" });
  const creates = vi.fn(), methods: string[] = [];
  const token = () => [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from(JSON.stringify(f.claims())).toString("base64url"), "inert"].join(".");
  const runtime = createSharedLogoLaneEngine({ slot: f.slot, deploymentId: p.execution.deploymentId, workerId: "synthetic-raster-delivery-recovery", capabilities: [capability],
   provider: { apiKey: "inert-not-used", model: IMAGE_MODEL, modelVerificationReceipt: "inert-model-verification" },
   database: { async query(_sql, values = []) {
    const lease = JSON.parse(String(values[0])) as SharedSlotLease, execution = sharedExecutionSchema.parse(JSON.parse(String(values[1])));
    return { rows: [{ envelope: await f.action(execution, String(values[2]), JSON.parse(String(values[3])), lease) }] };
   } },
   storage: async (execution, raw) => {
    const qualified = qualifiedLogoRasterCapability(raw); if (!qualified) throw Error("Unexpected fixture capability");
    return createSharedLogoStorageAuthorization({ targetOrigin: SHARED_STORAGE_ORIGIN, publishableKey: "sb_publishable_inert_fixture", slot: f.slot, execution, capability: qualified,
     session: { authUserId: SHARED_STORAGE_ACTOR, sessionId: SHARED_STORAGE_SESSION, tokenProvider: async () => token() } }, { fetch: async (url, init) => {
      const path = new URL(String(url)).pathname; methods.push((init?.method ?? "GET") + " " + path);
      if (path === "/auth/v1/user") return Response.json({ id: SHARED_STORAGE_ACTOR, is_anonymous: false, email_confirmed_at: "2026-10-01T00:00:00Z" });
      if (path === "/rest/v1/rpc/authorize_shared_logo_storage") {
       const body = JSON.parse(String(init?.body)); return Response.json(await f.grant(execution, body.p_reservation ? p.reservation : null, body.p_mode));
      }
      expect(await f.get(p.reservation)).toHaveLength(1);
      const bytes = Buffer.from(p.bytes); if (mode === "corrupt") bytes[0] = bytes[0]! ^ 1;
      return new Response(bytes, { headers: { "content-type": p.reservation.mimeType } });
     } });
   },
  }, { transport: { createImage: creates } });
  try {
   if (mode === "corrupt") {
    await expect(runtime.recover!([pending])).rejects.toBeDefined();
    expect((await f.rawJob(p.job.id)).state).toBe("needs_reconciliation");
   } else {
    const state = mode === "saved" ? "succeeded" : "failed";
    expect(await runtime.recover!([pending])).toEqual({ disposition: "ack", state });
    expect(await runtime.recover!([pending])).toEqual({ disposition: "ack", state });
    expect((await f.rawJob(p.job.id)).state).toBe(state);
   }
   expect(creates).not.toHaveBeenCalled();
   expect(methods.some(method => method.startsWith("GET /storage/"))).toBe(mode !== "lost");
   expect(methods.every(method => !method.startsWith("POST /storage/"))).toBe(true);
   expect((await f.db.query("select * from public.logo_provider_responses where job_id=$1", [p.job.id])).rows).toHaveLength(1);
  } finally { await runtime.close(); }
 }));
});
