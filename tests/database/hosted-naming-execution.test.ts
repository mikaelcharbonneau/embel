import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainRunSchema, namingFeedEnsureResultSchema, namingFeedSchema, namingProviderReceiptSchema } from "../../src/domain/naming-brain";
import { NamingBrainJobStore, normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { attestBrainPreferences, beginBrainStage, brainPreferences, brainRpc, brainWorker, initialIntent, installBrainFixture, planBrainCall, seedBrainFixture, startBrainFixture } from "./naming-brain-fixture";
import { progressiveRequest, saveProgressivePart, seedProgressiveFixture } from "./naming-brain-progressive-fixture";
import { enableHostedNamingFixture, hostedNamingMigration, seedHostedNamingFixture } from "./hosted-naming-fixture";

const parse = <T>(schema: { parse(input: unknown): T }, input: unknown): T => schema.parse(normalizeNamingStoredJson(input));
describe("explicit hosted owner Naming authority (synthetic database)", () => {
 let db: TestDatabase, project: string;
 const availability = (id: string | null = project, owner = OWNER_A) => brainRpc(db, "get_hosted_naming_availability", [id], owner);
 const ensure = (key = "synthetic-hosted-initial", id = project, owner = OWNER_A) => brainRpc(db, "ensure_hosted_naming_brain_run", [id, initialIntent(key)], owner);
 beforeAll(async () => {
  const sql = await readFile(new URL(`../../supabase/migrations/${hostedNamingMigration}`, import.meta.url), "utf8");
  db = await createTestDatabase({ before: hostedNamingMigration, additionalMigrations: [sql], beforeMigration: async (fixture, current) => {
   if (current === sql) await fixture.exec("create role fixture_hosted_hostile nologin; alter default privileges grant all on tables to fixture_hosted_hostile; alter default privileges grant execute on functions to fixture_hosted_hostile");
  } });
  await installBrainFixture(db);
 }, 60_000);
 beforeEach(async () => { project = await seedBrainFixture(db); });
 afterAll(async () => { await db?.close(); });

 it("starts disabled, strips hostile grants, and enforces authentication and project ownership", async () => {
  expect(await availability()).toEqual({ status: "unavailable", executionAuthority: "hosted_owner_v1", reason: "runtime_disabled" });
  await expect(ensure()).rejects.toThrow("runtime_unavailable");
  await expect(availability(project, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  await expect(ensure("synthetic-hosted-foreign", project, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  await expect(asRole(db, "authenticated", null, () => db.query("select public.get_hosted_naming_availability()"))).rejects.toThrow("unauthenticated");
  for (const role of ["anon", "authenticated", "service_role", "fixture_naming_brain_a", "fixture_hosted_hostile"]) {
   for (const table of ["hosted_naming_capabilities", "hosted_naming_admission_context", "hosted_naming_jobs"])
    expect((await db.query<{ ok: boolean }>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') ok", [role, `fluid_private.${table}`])).rows[0]!.ok).toBe(false);
   expect((await db.query<{ ok: boolean }>("select has_function_privilege($1,'fluid_private.naming_brain_execution_authority(uuid)','EXECUTE') ok", [role])).rows[0]!.ok).toBe(false);
   if (role !== "authenticated") expect((await db.query<{ ok: boolean }>("select has_function_privilege($1,'public.ensure_hosted_naming_brain_run(uuid,jsonb)','EXECUTE') ok", [role])).rows[0]!.ok).toBe(false);
  }
  expect((await db.query<{ secure: boolean }>("select relrowsecurity and relforcerowsecurity secure from pg_class where relname in('hosted_naming_capabilities','hosted_naming_admission_context','hosted_naming_jobs')")).rows).toEqual([{ secure: true }, { secure: true }, { secure: true }]);
 });

 it("requires the exact enabled owner, pilot, role identity, deployment and policy plus a worker heartbeat", async () => {
  await enableHostedNamingFixture(db, false);
  expect((await availability()).reason).toBe("runtime_disabled");
  await db.exec("update fluid_private.hosted_naming_capabilities set enabled=true");
  expect((await availability()).status).toBe("available");
  expect((await availability(null, OWNER_B)).status).toBe("unavailable");
  for (const change of ["deployment_id='wrong-worker-deployment'", "policy_identity=repeat('f',64)", "role_oid=(role_oid::bigint+1)::oid", "owner_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'"]) {
   await db.exec("begin");
   try { await db.exec(`update fluid_private.hosted_naming_capabilities set ${change}`); expect((await availability()).reason).toBe("runtime_disabled"); }
   finally { await db.exec("rollback"); }
  }
  await db.exec("update fluid_private.naming_brain_pilots set ready_until=clock_timestamp()-interval '1 second'");
  expect(await availability()).toEqual({ status: "unavailable", executionAuthority: "hosted_owner_v1", reason: "worker_unavailable" });
  expect(await ensure()).toMatchObject({ status: "blocked", code: "naming_runtime_unavailable" });
  expect((await db.query("select count(*)::int count from fluid_private.hosted_naming_jobs")).rows).toEqual([{ count: 0 }]);
 });

 it("admits one durable hosted job beyond local historical holds and keeps ordinary admission policy unchanged", async () => {
  await enableHostedNamingFixture(db);
  await db.exec("update public.usage_accounts set limit_microusd=0");
  expect(await brainRpc(db, "ensure_naming_brain_run", [project, initialIntent("synthetic-normal-quota")])).toMatchObject({ status: "blocked", code: "account_allowance_unavailable" });
  const first = parse(namingFeedEnsureResultSchema, await ensure());
  expect(first).toMatchObject({ status: "pending", reused: false, run: { executionAuthority: "hosted_owner_v1", localPipelineVersion: 2 } });
  const row = (await db.query<{ id: string; input: Record<string, unknown>; state: string }>("select id,input,state from public.jobs")).rows[0]!;
  expect(row).toMatchObject({ state: "queued", input: { executionAuthority: "hosted_owner_v1", localTimingVersion: 2, localPipelineVersion: 2 } });
  expect((await db.query("select count(*)::int count from fluid_private.local_prototype_jobs")).rows).toEqual([{ count: 0 }]);
  expect((await db.query("select count(*)::int count from fluid_private.hosted_naming_jobs")).rows).toEqual([{ count: 1 }]);
  expect((await db.query("select count(*)::int count from fluid_private.hosted_naming_admission_context")).rows).toEqual([{ count: 0 }]);
  expect((await db.query("select reserved_microusd,state from public.usage_reservations")).rows).toEqual([{ reserved_microusd: 5_000_000, state: "active" }]);
  expect((await db.query("select limit_microusd,reserved_microusd,spent_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ limit_microusd: 0, reserved_microusd: 5_000_000, spent_microusd: 0 }]);
  expect(parse(namingFeedEnsureResultSchema, await ensure())).toMatchObject({ status: "pending", reused: true });
  expect((await db.query("select count(*)::int count from public.jobs")).rows).toEqual([{ count: 1 }]);
  await expect(db.query("update fluid_private.hosted_naming_jobs set deployment_id='changed' where job_id=$1", [row.id])).rejects.toThrow("immutable_allowance_admission");
 });

 it("never relabels a replay, an active unmarked run, or historical local work", async () => {
  await brainRpc(db, "ensure_naming_brain_run", [project, initialIntent()]);
  const before = (await db.query("select to_jsonb(j) job from public.jobs j")).rows;
  await enableHostedNamingFixture(db);
  expect(await brainRpc(db, "ensure_hosted_naming_brain_run", [project, initialIntent()])).toMatchObject({ status: "pending", reused: true });
  expect(await ensure("synthetic-hosted-coalesced")).toMatchObject({ status: "pending", reused: true });
  expect((await db.query("select to_jsonb(j) job from public.jobs j")).rows).toEqual(before);
  expect((await db.query("select count(*)::int count from fluid_private.hosted_naming_jobs")).rows).toEqual([{ count: 0 }]);
  const unmarked = await brainWorker(db, async () => (await db.query<{ value: { executionAuthority: null } }>("select public.claim_naming_brain_job('fixture-worker','fixture-deployment',120) value")).rows[0]!.value);
  expect(unmarked.executionAuthority).toBeNull();

  const local = await seedProgressiveFixture(db);
  await enableHostedNamingFixture(db);
  const saved = (await db.query("select input,input_hash from public.jobs where id=$1", [local.job.id])).rows;
  expect(await brainRpc(db, "ensure_hosted_naming_brain_run", [local.project, local.intent])).toMatchObject({ status: "pending", reused: true });
  expect((await db.query("select input,input_hash from public.jobs where id=$1", [local.job.id])).rows).toEqual(saved);
  expect((await db.query("select count(*)::int count from fluid_private.hosted_naming_jobs")).rows).toEqual([{ count: 0 }]);
 });

 it("does not accept client or session-setting claims of hosted authority", async () => {
  await enableHostedNamingFixture(db);
  await expect(brainRpc(db, "ensure_hosted_naming_brain_run", [project, { ...initialIntent(), executionAuthority: "hosted_owner_v1" }])).rejects.toThrow("invalid_intent");
  await asRole(db, "authenticated", OWNER_A, async () => {
   await db.query("select set_config('embel.execution_authority','hosted_owner_v1',false)");
   await expect(db.query("insert into fluid_private.hosted_naming_admission_context values(pg_backend_pid(),txid_current(),$1,$2,gen_random_uuid())", [OWNER_A, project])).rejects.toMatchObject({ code: "42501" });
  });
  await brainRpc(db, "ensure_naming_brain_run", [project, initialIntent()]);
  expect((await db.query("select input ? 'executionAuthority' marked from public.jobs")).rows).toEqual([{ marked: false }]);
 });

 it("does not acquire a second local marker when both wrappers are called in the same SQL statement", async () => {
  await seedProgressiveFixture(db); await enableHostedNamingFixture(db);
  const other = (await brainRpc<{ id: string }>(db, "create_project", ["naming_only", "Synthetic hosted provenance", { description: "Synthetic naming brief" }, "c".repeat(64)])).id;
  await brainRpc(db, "save_naming_preferences", [other, 0, brainPreferences]); await attestBrainPreferences(db);
  await asRole(db, "authenticated", OWNER_A, () => db.query(`with hosted as materialized(select public.ensure_hosted_naming_brain_run($1,$2::jsonb) result)
  select public.ensure_local_naming_brain_run($1,$2::jsonb) from hosted where hosted.result is not null`, [other, JSON.stringify(initialIntent("synthetic-same-statement"))]));
  expect((await db.query("select count(*)::int count from fluid_private.hosted_naming_jobs where project_id=$1", [other])).rows).toEqual([{ count: 1 }]);
  expect((await db.query("select count(*)::int count from fluid_private.local_prototype_jobs where project_id=$1", [other])).rows).toEqual([{ count: 0 }]);
  expect((await db.query("select fluid_private.naming_brain_execution_authority(id) authority from public.jobs where project_id=$1", [other])).rows).toEqual([{ authority: "hosted_owner_v1" }]);
 });

 it("uses the existing restricted worker to save a genuine-shaped progressive group without widening its grants", async () => {
  const fixture = await seedHostedNamingFixture(db);
  expect(fixture.input.executionAuthority).toBe("hosted_owner_v1");
  const part = await saveProgressivePart(fixture, 0, 4);
  const result = await brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, part.publication!, new AbortController().signal));
  const feed = parse(namingFeedSchema, await brainRpc(db, "get_naming_feed", [fixture.project]));
  expect(feed).toMatchObject({ activeRun: { executionAuthority: "hosted_owner_v1", localPipelineVersion: 2, state: "running" }, progressive: { publishedCount: 4 } });
  expect(feed.entries.map(row => row.entry.candidate.id)).toEqual(result.candidateIds);
  expect(parse(namingBrainRunSchema, await brainRpc(db, "get_naming_brain_run", [fixture.project, fixture.input.runId]))).toMatchObject({ executionAuthority: "hosted_owner_v1", stages: [{ stageKey: "creation" }, { stageKey: "prepare" }] });
  await expect(brainWorker(db, () => db.query("select * from fluid_private.hosted_naming_jobs"))).rejects.toMatchObject({ code: "42501" });
  await expect(brainRpc(db, "get_naming_feed", [fixture.project], OWNER_B)).rejects.toThrow("not_found");
 });

 it("keeps uncertain issued work blocked on its project while another owned project can proceed", async () => {
  const fixture = await seedHostedNamingFixture(db);
  const request = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
  await brainWorker(db, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.research", [request]));
  await brainWorker(db, () => fixture.store.authorizeDispatch(fixture.job, request));
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'creation','ambiguous',$3::jsonb)", [fixture.job.id, fixture.job.leaseToken, JSON.stringify({ artifactIds: [], errorCode: "provider_outcome_unknown" })]));
  const existing = (await db.query("select input,input_hash from public.jobs where id=$1", [fixture.job.id])).rows;
  expect(await ensure("synthetic-unknown-retry", fixture.project)).toMatchObject({ status: "blocked", code: "dispatch_unresolved" });
  const other = (await brainRpc<{ id: string }>(db, "create_project", ["naming_only", "Other synthetic project", { description: "Another synthetic naming brief" }, "b".repeat(64)])).id;
  await brainRpc(db, "save_naming_preferences", [other, 0, brainPreferences]); await attestBrainPreferences(db);
  expect(await brainRpc(db, "ensure_naming_brain_run", [other, initialIntent("synthetic-normal-unknown")])).toMatchObject({ status: "blocked", code: "dispatch_unresolved" });
  expect(await ensure("synthetic-hosted-independent", other)).toMatchObject({ status: "pending" });
  expect((await db.query("select input,input_hash from public.jobs where id=$1", [fixture.job.id])).rows).toEqual(existing);
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1", [fixture.input.runId])).rows).toEqual([{ count: 1 }]);
 });

 it("stops new dispatch after disabling the hosted grant while preserving replay, observation identity and saved groups", async () => {
  const fixture = await seedHostedNamingFixture(db);
  const part = await saveProgressivePart(fixture, 0, 4);
  await brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, part.publication!, new AbortController().signal));
  const request = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
  await brainWorker(db, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.research", [request]));
  await db.exec("update fluid_private.hosted_naming_capabilities set enabled=false");
  expect(await availability(fixture.project)).toMatchObject({ status: "unavailable", reason: "runtime_disabled" });
  await expect(brainWorker(db, () => fixture.store.authorizeDispatch(fixture.job, request))).rejects.toThrow();
  expect(await brainRpc(db, "ensure_hosted_naming_brain_run", [fixture.project, fixture.intent])).toMatchObject({ status: "pending", reused: true });
  const feed = parse(namingFeedSchema, await brainRpc(db, "get_naming_feed", [fixture.project]));
  expect(feed.entries).toHaveLength(4); expect(feed.activeRun).toMatchObject({ executionAuthority: "hosted_owner_v1", localPipelineVersion: 2 });
  expect((await db.query("select fluid_private.naming_brain_execution_authority($1) authority", [fixture.job.id])).rows).toEqual([{ authority: "hosted_owner_v1" }]);
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1 and call_key=$2", [fixture.input.runId, request.providerCallKey])).rows).toEqual([{ count: 0 }]);
 });

 it("keeps Stop idempotent and rejects further paid work while retaining the published names", async () => {
  const fixture = await seedHostedNamingFixture(db);
  const part = await saveProgressivePart(fixture, 0, 4);
  const publication = await brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, part.publication!, new AbortController().signal));
  const intent = { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: "synthetic-hosted-stop" };
  const first = await brainRpc(db, "stop_naming_feed", [fixture.project, intent]);
  expect(await brainRpc(db, "stop_naming_feed", [fixture.project, intent])).toEqual(first);
  expect(await brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, part.publication!, new AbortController().signal))).toEqual(publication);
  const next = { ...part.publication!, key: "part002" };
  await expect(brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, next, new AbortController().signal))).rejects.toThrow("microbatch_stopped");
  expect(parse(namingFeedSchema, await brainRpc(db, "get_naming_feed", [fixture.project]))).toMatchObject({ paused: true, entries: Array(4).fill(expect.any(Object)) });
 });

 it("reclaims an issued request for observation after hosted disablement without authorizing another provider call", async () => {
  const fixture = await seedHostedNamingFixture(db);
  const request = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
  await brainWorker(db, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.research", [request]));
  await brainWorker(db, () => fixture.store.authorizeDispatch(fixture.job, request));
  const receipt = namingProviderReceiptSchema.parse({ version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents",
   budgetControl: "local_unlimited_v1", localPipelineVersion: 2, runId: fixture.input.runId, stageKey: "creation", role: "researcher", snapshotHash: fixture.input.snapshot.snapshotHash,
   providerCallKey: request.providerCallKey, assignmentKey: null, requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents,
   dispatchState: "dispatched", requestId: "synthetic-issued-request", sessionId: "synthetic-issued-session", turnId: "synthetic-issued-turn", agentId: null, responseId: null,
   callIds: [], observedModel: fixture.input.policy.model, toolCalls: [], artifactItemIds: [], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [],
   accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-19T02:00:00Z" });
  await brainWorker(db, () => fixture.store.recordReceipt(fixture.job, receipt));
  await db.exec("update fluid_private.hosted_naming_capabilities set enabled=false");
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [fixture.job.id]);
  await brainWorker(db, () => fixture.store.expireLeases("fixture-worker"));
  const restarted = new NamingBrainJobStore(db, "fixture-deployment"), observed = await brainWorker(db, () => restarted.claim("fixture-worker", 120));
  expect(observed?.id).toBe(fixture.job.id); expect(observed?.leaseToken).not.toBe(fixture.job.leaseToken);
  expect(restarted.executionAuthority(observed!)).toBe("hosted_owner_v1");
  const state = await brainWorker(db, () => restarted.loadProgressiveState(observed!, "context.research"));
  expect(state.stage.recoveryMode).toBe("observe_only"); expect(state.stage.requests).toEqual([request]); expect(state.stage.receipts).toEqual([receipt]);
  await expect(brainWorker(db, () => restarted.authorizeDispatch(observed!, request))).rejects.toThrow();
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1", [fixture.input.runId])).rows).toEqual([{ count: 1 }]);
 });

 it("fences hosted job claim by the exact existing restricted login", async () => {
  await enableHostedNamingFixture(db); await ensure();
  const store = new NamingBrainJobStore(db, "fixture-deployment");
  await expect(brainWorker(db, () => store.claim("fixture-worker", 120), OWNER_B)).rejects.toThrow("worker_owner_mismatch");
  const wrongDeployment = new NamingBrainJobStore(db, "wrong-deployment");
  expect(await brainWorker(db, () => wrongDeployment.claim("fixture-worker", 120))).toBeNull();
  const job = await brainWorker(db, () => store.claim("fixture-worker", 120));
  expect(job?.input).toMatchObject({ executionAuthority: "hosted_owner_v1" });
 });
});

it("installs over issued historical work without rewriting jobs, requests, reservations or account evidence", async () => {
 const db = await createTestDatabase({ before: hostedNamingMigration });
 try {
  await installBrainFixture(db); const project = await seedBrainFixture(db);
  const job = await startBrainFixture(db, project); await beginBrainStage(db, job, "research");
  const { request } = await planBrainCall(db, job, "research");
  await brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify(request)]));
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'research','ambiguous',$3::jsonb)", [job.id, job.lease_token, JSON.stringify({ artifactIds: [], errorCode: "provider_outcome_unknown" })]));
  const tables = ["public.jobs", "public.job_steps", "public.usage_accounts", "public.usage_reservations", "public.naming_batches", "fluid_private.naming_brain_runs", "fluid_private.naming_brain_calls", "fluid_private.naming_brain_intents"];
  const snapshots = async () => Promise.all(tables.map(async table => (await db.query(`select to_jsonb(row)::text value from ${table} row order by to_jsonb(row)::text`)).rows));
  const before = await snapshots();
  const sql = await readFile(new URL(`../../supabase/migrations/${hostedNamingMigration}`, import.meta.url), "utf8");
  await db.exec(sql);
  expect(await snapshots()).toEqual(before);
  expect((await db.query("select state from public.jobs where id=$1", [job.id])).rows).toEqual([{ state: "needs_reconciliation" }]);
  expect((await db.query("select count(*)::int count from fluid_private.hosted_naming_jobs")).rows).toEqual([{ count: 0 }]);
 } finally { await db.close(); }
}, 60_000);
