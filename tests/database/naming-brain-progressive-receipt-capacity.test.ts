import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createNamingReviewProjection, namingCurationSchema, namingCreatorSetSchema, namingProviderReceiptSchema, validateNamingCreatorSet, type NamingProviderReceipt } from "../../src/domain/naming-brain";
import { createNamingMicrobatch } from "../../src/domain/naming-brain-progressive";
import { createProgressiveNamingAssignment } from "../../src/server/ai/naming-brain/progressive-assignments";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { historicalNamingClaimDatabase } from "./naming-brain-historical-claim";
import { createTestDatabase, OWNER_A, type TestDatabase } from "./local-supabase";
import { beginBrainStage, brainAction, brainGapEnvelope, brainManifest, brainRpc, brainWorker, claimBrain, initialIntent, installBrainFixture, planBrainCall, seedBrainFixture, startBrainFixture } from "./naming-brain-fixture";
import { progressiveRequest, recordProgressiveOutput, saveProgressiveOutput, saveProgressivePart, saveProgressiveResearch, seedProgressiveFixture } from "./naming-brain-progressive-fixture";

const filename = "20261017171000_local_progressive_receipt_capacity.sql";
const migration = await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8");
const signature = "public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)";
type FunctionMetadata = { oid: number; body: string; proowner: number; prosecdef: boolean; provolatile: string; proconfig: string[]; proleakproof: boolean; acl: string | null };
type History = { receipts: string | null; calls: string | null; plans: string | null; artifacts: string | null; provider_records: string | null; feed: string | null; run: string | null; job: string | null };

async function metadata(db: TestDatabase) {
 return (await db.query<FunctionMetadata>("select oid,md5(prosrc) body,proowner,prosecdef,provolatile,proconfig,proleakproof,proacl::text acl from pg_proc where oid=$1::regprocedure", [signature])).rows[0]!;
}
async function history(db: TestDatabase, runId: string) {
 return (await db.query<History>(`select
 (select md5(jsonb_agg(to_jsonb(q) order by q.id)::text) from fluid_private.naming_brain_receipts q where run_id=$1) receipts,
 (select md5(jsonb_agg(to_jsonb(q) order by q.call_key)::text) from fluid_private.naming_brain_calls q where run_id=$1) calls,
 (select md5(jsonb_agg(to_jsonb(q) order by q.phase_key)::text) from fluid_private.naming_brain_progressive_plans q where run_id=$1) plans,
 (select md5(jsonb_agg(to_jsonb(q) order by q.id)::text) from fluid_private.naming_brain_artifacts q where run_id=$1) artifacts,
 (select md5(jsonb_agg(to_jsonb(q) order by q.id)::text) from fluid_private.naming_brain_provider_records q where run_id=$1) provider_records,
 (select md5(jsonb_agg(to_jsonb(q) order by q.position)::text) from fluid_private.naming_brain_feed_entries q where run_id=$1) feed,
 (select md5(to_jsonb(q)::text) from fluid_private.naming_brain_runs q where id=$1) run,
 (select md5(to_jsonb(q)::text) from public.jobs q where id=(select job_id from fluid_private.naming_brain_runs where id=$1)) job`, [runId])).rows[0];
}

/** Test-only bulk history seed: valid copies retain the same authorized call and
 * provider identity, with distinct observation timestamps/digests. The boundary
 * append and all recovery writes use the real restricted worker RPC. */
async function fillHistory(db: TestDatabase, runId: string, count: number) {
 await db.query(`with base as(select * from fluid_private.naming_brain_receipts where run_id=$1 order by created_at desc,id desc limit 1),
 numbered as(select base.*,base.receipt||jsonb_build_object('recordedAt',to_char(timestamptz '2026-10-18T12:00:00Z'+n*interval '1 millisecond','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) next_receipt
 from base cross join generate_series((select count(*)::integer+1 from fluid_private.naming_brain_receipts where run_id=$1),$2::integer) n)
 insert into fluid_private.naming_brain_receipts(run_id,owner_id,project_id,stage_key,call_key,receipt,content_hash)
 select run_id,owner_id,project_id,stage_key,call_key,next_receipt,encode(sha256(convert_to(next_receipt::text,'UTF8')),'hex') from numbered`, [runId, count]);
}
async function latestReceipt(db: TestDatabase, runId: string) {
 return namingProviderReceiptSchema.parse((await db.query<{ receipt: unknown }>("select receipt from fluid_private.naming_brain_receipts where run_id=$1 order by created_at desc,id desc limit 1", [runId])).rows[0]!.receipt);
}

async function legacyCall(db: TestDatabase, local = false) {
 const project = await seedBrainFixture(db);
 let job: Awaited<ReturnType<typeof startBrainFixture>>;
 if (local) {
  const policy = guidedStrategyPolicy("strategy.reformulate");
  await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
  await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
  await brainRpc(db, "ensure_local_naming_brain_run", [project, initialIntent()]); job = (await claimBrain(db)).job;
  await brainAction(db, job, "plan", { manifest: brainManifest, gapEnvelope: brainGapEnvelope });
 } else job = await startBrainFixture(db, project);
 await beginBrainStage(db, job, "research");
 const { request, snapshot, allocation } = await planBrainCall(db, job, "research");
 const savedRequest = { ...request, policy: { ...request.policy, ...(local ? { budgetControl: "local_unlimited_v1" } : {}) } };
 await brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify(savedRequest)]));
 const receipt = namingProviderReceiptSchema.parse({ version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents", ...(local ? { budgetControl: "local_unlimited_v1" } : {}), runId: job.input.runId, stageKey: "research", role: "researcher", snapshotHash: snapshot.snapshotHash, providerCallKey: allocation.providerCallKey, assignmentKey: null, requestKey: allocation.requestKey, requestHash: allocation.requestHash, sessionLimitCents: allocation.sessionLimitCents, dispatchState: "not_dispatched", requestId: null, sessionId: null, turnId: null, agentId: null, responseId: null, callIds: [], observedModel: null, toolCalls: [], artifactItemIds: [], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-18T10:00:00Z" });
 const append = (value: unknown) => brainWorker(db, () => db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify(value)]));
 await append(receipt); return { job, receipt, append };
}

/** Scale only byte measurements in this disposable function. The production
 * 8/64MiB thresholds, actual stored JSON measurements and all other guards stay
 * intact; this exercises both boundaries without allocating a64MiB fixture. */
async function byteBoundary(db: TestDatabase, runId: string, receipt: NamingProviderReceipt, append: (value: NamingProviderReceipt) => Promise<unknown>, limit: number) {
 const original = (await db.query<{ definition: string }>("select pg_get_functiondef($1::regprocedure) definition", [signature])).rows[0]!.definition;
 const instrumented = original.replace("sum(octet_length(receipt::text))", "sum(octet_length(receipt::text))*1024")
  .replace("totals.receipt_bytes+", "totals.receipt_bytes*1024+")
  .replace("+octet_length(p_receipt::text)>", "+octet_length(p_receipt::text)*1024>");
 expect(instrumented).not.toBe(original);
 await db.exec(instrumented);
 try {
  for (let index = 0; index < 100; index++) {
   const next = namingProviderReceiptSchema.parse({ ...receipt, requestId: `req_byte_boundary_${index}`, recordedAt: new Date(Date.parse("2026-10-18T13:00:00Z") + index).toISOString() });
   const measurement = (await db.query<{ stored: number; incoming: number; count: number }>("select (select coalesce(sum(octet_length(receipt::text)),0)::integer from fluid_private.naming_brain_receipts where run_id=$1) stored,octet_length($2::jsonb::text)::integer incoming,(select count(*)::integer from fluid_private.naming_brain_receipts where run_id=$1) count", [runId, JSON.stringify(next)])).rows[0]!;
   if ((measurement.stored + measurement.incoming) * 1024 > limit) {
    expect(measurement.stored * 1024).toBeLessThanOrEqual(limit); expect(measurement.count).toBeLessThan(500);
    await expect(append(next)).rejects.toThrow("receipt_capacity"); return;
   }
   await append(next);
  }
  throw Error("synthetic_byte_boundary_not_reached");
 } finally { await db.exec(original); }
}

describe("progressive receipt observation capacity over restricted SQL (synthetic)", () => {
 let db: TestDatabase, fixture: Awaited<ReturnType<typeof seedProgressiveFixture>>;
 beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 60_000);
 beforeEach(async () => { fixture = await seedProgressiveFixture(db); });
 afterAll(async () => { await db?.close(); });

 it("recovers the same 94-name run past receipt500 and completes100 without changing its original calls or publications", async () => {
  const priorDb = await createTestDatabase({ before: filename });
  try {
   await installBrainFixture(priorDb);
   const f = await seedProgressiveFixture(priorDb);
   await saveProgressiveResearch(f);
   for (let index = 0; index < 16; index++) {
    const part = await saveProgressivePart(f, index, index === 15 ? 4 : 6, f.input.snapshot.preferences.approaches[index % 3]!);
    await brainWorker(priorDb, () => f.store.publishMicrobatch(f.job, part.publication!, new AbortController().signal));
   }
   const assignment = createProgressiveNamingAssignment({ runId: f.input.runId, snapshot: f.input.snapshot, partIndex: 16, approach: "invented", targetCount: 6 });
   const creatorRequest = progressiveRequest(f, "part017.creation", { role: "creator", snapshot: f.input.snapshot, assignment });
   const proposals = Array.from({ length: 6 }, (_, index) => ({ candidateKey: `final-${index}`, value: `SyntheticFinal${index}`, primaryApproach: "invented", additionalApproaches: [], territoryId: assignment.territoryId, constructionKey: assignment.constructionKey, rationale: "Synthetic imaginative association.", caution: null, claims: [] }));
   const creator = namingCreatorSetSchema.parse(await saveProgressiveOutput(f, "part017.creation", creatorRequest, { role: "creator", assignmentKey: assignment.assignmentKey, candidates: proposals }, { candidateIds: proposals.map(row => ({ candidateKey: row.candidateKey, candidateId: crypto.randomUUID() })) }));
   const candidates = validateNamingCreatorSet(f.input.snapshot, assignment, creator).accepted;
   const curatorRequest = progressiveRequest(f, "part017.curation", { role: "curator", snapshot: f.input.snapshot, review: createNamingReviewProjection({ runId: f.input.runId, snapshotHash: f.input.snapshot.snapshotHash, candidates }), validationRejections: [] }, [creator.artifactId]);
   const curation = namingCurationSchema.parse(await recordProgressiveOutput(f, "part017.curation", curatorRequest, { role: "curator", annotations: [], gaps: [] }));
   await fillHistory(priorDb, f.input.runId, 500);
   const next = namingProviderReceiptSchema.parse({ ...curation.providerReceipt, recordedAt: "2026-10-18T14:00:00Z" });
   await expect(brainWorker(priorDb, () => f.store.recordReceipt(f.job, next))).rejects.toThrow("receipt_capacity");
   // Digest replay is acknowledged even when the historical aggregate is full.
   await brainWorker(priorDb, () => f.store.recordReceipt(f.job, curation.providerReceipt));
   await brainWorker(priorDb, () => f.store.completeStep(f.job, "creation", { status: "needs_reconciliation", code: "receipt_capacity", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [], errorCode: "receipt_capacity" } }));
   const before = await history(priorDb, f.input.runId), beforeMetadata = await metadata(priorDb);
   const oldIds = (await priorDb.query<{ id: string }>("select id from fluid_private.naming_brain_receipts where run_id=$1", [f.input.runId])).rows.map(row => row.id);
   await priorDb.exec(migration);
   expect(await history(priorDb, f.input.runId)).toEqual(before);
   const afterMetadata = await metadata(priorDb);
   expect(afterMetadata.body).not.toBe(beforeMetadata.body);
   expect({ ...afterMetadata, body: beforeMetadata.body }).toEqual(beforeMetadata);
   // Synthetic clock eligibility only; live recovery never rewrites a schedule.
   await priorDb.query("update fluid_private.naming_brain_runs set next_observation_at=clock_timestamp()-interval '1 second' where id=$1", [f.input.runId]);
   const store = new NamingBrainJobStore(await historicalNamingClaimDatabase(priorDb), "fixture-deployment");
   const recovered = await brainWorker(priorDb, () => store.claim("fixture-worker", 120));
   expect(recovered?.id).toBe(f.job.id);
   await brainWorker(priorDb, () => store.beginStep(recovered!, "creation", 1_500_000));
   await brainWorker(priorDb, () => store.recordReceipt(recovered!, next));
   const completed = namingCurationSchema.parse({ ...curation, providerReceipt: next });
   await brainWorker(priorDb, () => store.saveArtifact(recovered!, completed));
   expect(await brainWorker(priorDb, () => store.resumeExecution(recovered!, "creation"))).toBe(true);
   const publication = createNamingMicrobatch({ key: "part017", snapshot: f.input.snapshot, candidates, curation: completed });
   expect(await brainWorker(priorDb, () => store.publishMicrobatch(recovered!, publication, new AbortController().signal))).toMatchObject({ publishedCount: 100 });
   const stage = await brainWorker(priorDb, () => store.loadStage(recovered!, "creation"));
   await brainWorker(priorDb, () => store.completeStep(recovered!, "creation", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: stage.artifacts.map(row => row.artifactId) } }));
   await brainWorker(priorDb, () => store.beginStep(recovered!, "prepare", 0));
   await brainWorker(priorDb, () => store.finalizeProgressive(recovered!));
   await brainWorker(priorDb, () => store.completeStep(recovered!, "prepare", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }));
   await brainWorker(priorDb, () => store.finish(recovered!, "succeeded"));
   const after = await history(priorDb, f.input.runId);
   expect(after).toMatchObject({ calls: before!.calls, plans: before!.plans });
   expect((await priorDb.query("select md5(jsonb_agg(to_jsonb(q) order by q.id)::text) receipts from fluid_private.naming_brain_receipts q where id=any($1::uuid[])", [oldIds])).rows[0]).toEqual({ receipts: before!.receipts });
   expect((await priorDb.query("select md5(jsonb_agg(to_jsonb(q) order by q.position)::text) feed from fluid_private.naming_brain_feed_entries q where run_id=$1 and position<=94", [f.input.runId])).rows[0]).toEqual({ feed: before!.feed });
   expect((await priorDb.query("select count(*)::integer count from fluid_private.naming_brain_runs where project_id=$1", [f.project])).rows).toEqual([{ count: 1 }]);
  } finally { await priorDb.close(); }
 }, 30_000);

 it("retains a finite5000 aggregate, acknowledges exact digest replay at the bound, and preserves provider identities", async () => {
  const artifact = await saveProgressiveResearch(fixture), receipt = artifact.providerReceipt;
  if (receipt.protocol !== "openai_agents") throw Error("synthetic_managed_receipt_required");
  await fillHistory(db, fixture.input.runId, 5000);
  await brainWorker(db, () => fixture.store.recordReceipt(fixture.job, receipt));
  await brainWorker(db, () => fixture.store.recordReceipt(fixture.job, { ...receipt, recordedAt: "2026-10-18T14:00:00Z" }));
  await expect(brainWorker(db, () => fixture.store.recordReceipt(fixture.job, { ...receipt, requestId: "req_new_at_capacity", recordedAt: "2026-10-18T14:00:00Z" }))).rejects.toThrow("receipt_capacity");
  await expect(brainWorker(db, () => fixture.store.recordReceipt(fixture.job, { ...receipt, sessionId: "synthetic-foreign-session" }))).rejects.toThrow("provider_identity_changed");
  expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_receipts where run_id=$1", [fixture.input.runId])).rows).toEqual([{ count: 5000 }]);
 });

 it("keeps hosted/default runs at500 with the same call and provider binding checks", async () => {
  const { job, receipt, append } = await legacyCall(db);
  await fillHistory(db, job.input.runId, 500);
  await append(receipt);
  await append({ ...receipt, recordedAt: "2026-10-18T14:00:00Z" });
  await expect(append({ ...receipt, requestId: "req_new_at_capacity", recordedAt: "2026-10-18T14:00:00Z" })).rejects.toThrow("receipt_capacity");
  await expect(append({ ...receipt, requestHash: "f".repeat(64) })).rejects.toThrow("receipt_mismatch");
  expect((await db.query("select input ? 'localPipelineVersion' profile2 from public.jobs where id=$1", [job.id])).rows).toEqual([{ profile2: false }]);
 });

 it("enforces the progressive64MiB byte envelope independently of the5000 receipt count", async () => {
  const artifact = await saveProgressiveResearch(fixture);
  await byteBoundary(db, fixture.input.runId, artifact.providerReceipt, value => brainWorker(db, () => fixture.store.recordReceipt(fixture.job, value)), 67_108_864);
 });

 it("preserves the hosted8MiB byte envelope independently of the500 receipt count", async () => {
  const { job, receipt, append } = await legacyCall(db);
  await byteBoundary(db, job.input.runId, receipt, append, 8_388_608);
 });

 it("does not upgrade an already admitted local seven-stage run when the new migrations arrive", async () => {
  const priorDb = await createTestDatabase({ before: "20261017170000_local_progressive_naming.sql" });
  try {
   await installBrainFixture(priorDb);
   const { job, receipt, append } = await legacyCall(priorDb, true);
   await fillHistory(priorDb, job.input.runId, 500);
   const input = (await priorDb.query("select input from public.jobs where id=$1", [job.id])).rows;
   await priorDb.exec(await readFile(new URL("../../supabase/migrations/20261017170000_local_progressive_naming.sql", import.meta.url), "utf8"));
   await priorDb.exec(migration);
   expect((await priorDb.query("select input from public.jobs where id=$1", [job.id])).rows).toEqual(input);
   expect((await priorDb.query("select input ? 'localPipelineVersion' profile2 from public.jobs where id=$1", [job.id])).rows).toEqual([{ profile2: false }]);
   await append(receipt);
   await expect(append({ ...receipt, recordedAt: "2026-10-18T14:00:00Z" })).rejects.toThrow("receipt_capacity");
  } finally { await priorDb.close(); }
 });

 it("preserves the per-receipt512KiB check and refuses a changed predecessor instead of reapplying", async () => {
  await saveProgressiveResearch(fixture);
  const base = await latestReceipt(db, fixture.input.runId);
  await expect(brainWorker(db, () => db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)", [fixture.job.id, fixture.job.leaseToken, JSON.stringify({ ...base, recordedAt: "2026-10-18T14:00:00Z", syntheticOversize: "x".repeat(524_288) })]))).rejects.toThrow();
  const before = await metadata(db);
  await expect(db.exec(migration)).rejects.toThrow("unexpected_progressive_receipt_capacity_predecessor");
  await db.exec("rollback");
  expect(await metadata(db)).toEqual(before);
 });
});
