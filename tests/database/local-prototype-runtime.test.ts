import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000 });
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { strategyJobInputSchema } from "../../src/domain/strategy-jobs";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { PostgresJobStore } from "../../worker/postgres-store";
import { asRole, createTestDatabase, HASH, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { attestBrainPreferences, beginBrainStage, brainAction, brainGapEnvelope, brainManifest, brainPreferences, brainRpc, brainWorker, initialIntent, installBrainFixture, planBrainCall, seedBrainFixture, startBrainFixture } from "./naming-brain-fixture";

const migrationName = "20261017090000_local_prototype_runtime.sql";
const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"] as const;
const textPolicy = guidedStrategyPolicy("strategy.reformulate"), researchPolicy = guidedStrategyPolicy("strategy.competitors");
const at = "2026-10-17T12:00:00Z";
function context(stage: "competitors" | "audience" | "personality" = "competitors", purpose: "message" | "research" | "propose" = "message") {
 return contextSnapshotSchema.parse({ description: "Synthetic local prototype brief", intake: { conversation: [{ kind: "user_message", id: "synthetic-prompt", text: "A synthetic coffee workshop", createdAt: at }],
  guidedInterview: { version: 1, stage, turns: [{ id: "synthetic-turn", userMessageId: "synthetic-prompt", inputRevision: 1, stage, purpose }], answers: [] } } });
}
type Admission = { id: string; owner_id: string; project_id: string; reserved_cost_microusd: number; input_revision: number; state: string };

describe("explicit local prototype SQL boundaries (synthetic database)", () => {
 let db: TestDatabase; let namingProject: string;
 const owner = <T>(run: () => Promise<T>, id = OWNER_A) => asRole(db, "authenticated", id, run);
 const availability = (project: string | null = null, id = OWNER_A) => owner(async () => (await db.query<{ value: { status: string; operations: unknown[] } }>("select public.get_local_strategy_availability($1) value", [project])).rows[0]!.value, id);
 const project = async (purpose: "message" | "research" = "message", id = OWNER_A) => (await brainRpc<{ id: string }>(db, "create_project", ["complete_brand", "Synthetic prototype", context("competitors", purpose), HASH], id)).id;
 const enqueue = (id: string, key = "synthetic-local-request", operation: typeof operations[number] = "strategy.reformulate", accepted = guidedStrategyPolicy(operation).maximumCostMicrousd) => owner(async () => (await db.query<{ value: Admission }>("select public.enqueue_local_strategy_job($1,1,$2,$3,$4) value", [id, operation, key, accepted])).rows[0]!.value);
 const ready = async (operation: typeof operations[number] = "strategy.reformulate", policy = guidedStrategyPolicy(operation)) => brainWorker(db, async () => (await db.query<{ ready: boolean }>("select public.report_strategy_worker_ready($1,$2,60) ready", [operation, policy])).rows[0]!.ready);
 async function enable(heartbeat = true) {
  for (const operation of operations) {
   const policy = guidedStrategyPolicy(operation);
   await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2) on conflict(operation) do update set enabled=true,policy=excluded.policy", [operation, policy]);
   await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled) select $1,$2,rolname,oid,'fixture-deployment',$3,true from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, operation, policy]);
   if (heartbeat) expect(await ready(operation)).toBe(true);
  }
 }
 beforeAll(async () => {
  const sql = await readFile(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url), "utf8");
  db = await createTestDatabase({ before: migrationName, additionalMigrations: [sql], beforeMigration: async (fixture, current) => {
   if (current === sql) await fixture.exec("create role fixture_local_hostile nologin; alter default privileges grant all on tables to fixture_local_hostile; alter default privileges grant execute on functions to fixture_local_hostile");
  } });
  await installBrainFixture(db);
  await db.exec(`grant execute on function public.report_strategy_worker_ready(text,jsonb,integer),public.claim_job(text,integer),public.local_strategy_job_action(uuid,text,jsonb),public.expire_job_leases(),public.read_local_strategy_steps(uuid,uuid,uuid,text) to fixture_naming_brain_a,fixture_naming_brain_b`);
 }, 60_000);
 beforeEach(async () => { namingProject = await seedBrainFixture(db); await db.exec("update public.usage_accounts set limit_microusd=80000000"); });
 afterAll(async () => { await db?.close(); });

 it("starts disabled, denies private/default-granted access, and binds local availability to the authenticated owner", async () => {
  expect(await availability()).toMatchObject({ status: "unavailable", operations: [] });
  for (const role of ["anon", "authenticated", "service_role", "fixture_naming_brain_a", "fixture_local_hostile"])
   for (const table of ["local_prototype_strategy_capabilities", "local_prototype_jobs", "local_prototype_admission_context"])
    expect((await db.query<{ ok: boolean }>("select has_table_privilege($1,$2,'SELECT') ok", [role, `fluid_private.${table}`])).rows[0]!.ok).toBe(false);
  await enable();
  expect(await availability()).toMatchObject({ status: "available", operations: [...operations].sort().map(operation => ({ operation, maximumCostMicrousd: guidedStrategyPolicy(operation).maximumCostMicrousd, interviewVersion: 1 })) });
  expect(await availability(null, OWNER_B)).toMatchObject({ status: "unavailable" });
  await expect(availability(namingProject, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
 });

 it("requires an exact restricted-worker heartbeat without changing hosted readiness or granting table reads", async () => {
  await enable(false); expect((await availability()).status).toBe("unavailable");
  expect(await ready("strategy.reformulate", { ...textPolicy, model: "unsupported-fixture" })).toBe(false);
  expect(await brainWorker(db, async () => (await db.query<{ ready: boolean }>("select public.report_strategy_worker_ready($1,$2,60) ready", ["strategy.reformulate", textPolicy])).rows[0]!.ready, OWNER_B)).toBe(false);
  expect(await ready()).toBe(true); expect((await availability()).operations).toHaveLength(1);
  expect((await db.query("select worker_ready_until from fluid_private.strategy_runtime_policy where operation='strategy.reformulate'")).rows).toEqual([{ worker_ready_until: null }]);
  await db.exec("update fluid_private.local_prototype_strategy_capabilities set enabled=false where operation='strategy.reformulate'");
  expect((await availability()).status).toBe("unavailable");
 });

 it("admits the unchanged owned guided request with real reservation and exact replay, without business entitlements or dispatch", async () => {
  await enable(); const id = await project("research");
  await expect(enqueue(id, "synthetic-understated-request", "strategy.competitors", researchPolicy.maximumCostMicrousd - 1)).rejects.toThrow("accepted_cap_exceeded");
  const first = await enqueue(id, "synthetic-research-request", "strategy.competitors");
  expect(await enqueue(id, "synthetic-research-request", "strategy.competitors")).toEqual(first);
  expect(strategyJobInputSchema.parse((await db.query<{ input: unknown }>("select input from public.jobs where id=$1", [first.id])).rows[0]!.input)).toMatchObject({ version: 2, context: context("competitors", "research"), assistantHistory: { entries: [], truncated: false }, policy: researchPolicy });
  expect((await db.query("select reserved_microusd,actual_microusd,state from public.usage_reservations where job_id=$1", [first.id])).rows).toEqual([{ reserved_microusd: researchPolicy.maximumCostMicrousd, actual_microusd: 0, state: "active" }]);
  for (const table of ["api_text_dispatches", "api_text_allowance_admissions", "api_text_owner_entitlements"])
   expect((await db.query(`select count(*)::integer count from fluid_private.${table}`)).rows).toEqual([{ count: 0 }]);
  await expect(owner(() => db.query("select public.enqueue_local_strategy_job($1,1,'strategy.competitors','synthetic-foreign-request',15892880)", [id]), OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  await expect(enqueue(id, "synthetic-second-same-project", "strategy.competitors")).rejects.toMatchObject({ code: "PT409" });
 });

 it("executes the existing job store through scoped metadata reads and preserves tenant, lease and settlement fences", async () => {
  await enable(); const id = await project(); const admission = await enqueue(id);
  const store = new PostgresJobStore(db, { localPrototype: true });
  await brainWorker(db, async () => {
   await expect(db.query("select * from public.job_steps")).rejects.toMatchObject({ code: "42501" });
   const job = (await store.claim("fixture-local-strategy", 60))!; expect(job.id).toBe(admission.id);
   await expect(db.query("select * from public.read_local_strategy_steps($1,$2,$3,null)", [job.id, OWNER_B, id])).rejects.toMatchObject({ code: "42501" });
   await store.registerPlan(job, [{ key: "guided", maximumCostMicrousd: textPolicy.maximumCostMicrousd }]);
   expect(await store.beginStep(job, "guided", textPolicy.maximumCostMicrousd)).toBe("started");
   expect(await store.heartbeat(job, 60)).toEqual({ cancelled: false });
   await store.completeStep(job, "guided", { status: "succeeded", costMicrousd: 1000, result: {
    version: 1, provider: "openai", operation: "strategy.reformulate", model: "gpt-6.1-sol", responseId: "resp_synthetic_local", requestId: null, generatedAt: at,
    usage: { inputTokens: 100, outputTokens: 80, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 },
    proposal: { message: "Synthetic result for SQL lifecycle verification", activity: "Coffee education", offering: "Coffee workshops", knownAudience: "Independent cafe owners", questions: [] },
   }, providerRequestId: "resp_synthetic_local" });
   expect(await store.beginStep(job, "guided", textPolicy.maximumCostMicrousd)).toBe("already_succeeded");
   await store.finish(job, "succeeded");
  });
  expect((await db.query("select actual_microusd,state from public.usage_reservations where job_id=$1", [admission.id])).rows).toEqual([{ actual_microusd: 1000, state: "settled" }]);
  const apply = () => owner(async () => (await db.query<{ value: { project: { id: string; owner_id: string; current_revision: number; context: { activity: string; offering: string; knownAudience: string } }; application: { inputRevision: number; appliedRevision: number } } }>("select public.apply_strategy_job_result_v2($1,$2,1,'guided') value", [id, admission.id])).rows[0]!.value);
  const applied = await apply();
  expect(applied).toMatchObject({ project: { id, owner_id: OWNER_A, current_revision: 2, context: { activity: "Coffee education", offering: "Coffee workshops", knownAudience: "Independent cafe owners" } }, application: { inputRevision: 1, appliedRevision: 2 } });
  expect(await apply()).toEqual(applied);
  await expect(owner(() => db.query("select public.apply_strategy_job_result_v2($1,$2,1,'guided')", [id, admission.id]), OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  await expect(brainWorker(db, () => db.query("select * from public.read_local_strategy_steps($1,$2,$3,null)", [admission.id, OWNER_A, id]), OWNER_B)).rejects.toMatchObject({ code: "42501" });
 });

 it("expires an undispatched cancelled Strategy lease and releases only its own reservation", async () => {
  await enable(); const id = await project(); const admission = await enqueue(id); const store = new PostgresJobStore(db, { localPrototype: true });
  const job = await brainWorker(db, () => store.claim("fixture-local-strategy", 60)); expect(job!.id).toBe(admission.id);
  await brainRpc(db, "request_job_cancel", [admission.id]);
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [admission.id]);
  expect(await brainWorker(db, () => store.expireLeases())).toBe(1);
  expect((await db.query("select state from public.jobs where id=$1", [admission.id])).rows).toEqual([{ state: "cancelled" }]);
  expect((await db.query("select actual_microusd,state from public.usage_reservations where job_id=$1", [admission.id])).rows).toEqual([{ actual_microusd: 0, state: "settled" }]);
 });

 it("isolates unresolved projects while serializing live claims and retaining every reservation", async () => {
  await enable(); const a = await project(), b = await project(); const first = await enqueue(a, "synthetic-first-project");
  const second = await enqueue(b, "synthetic-second-project"); const store = new PostgresJobStore(db, { localPrototype: true });
  await brainWorker(db, async () => {
   const job = (await store.claim("fixture-local-strategy", 60))!;
   expect(job.id).toBe(first.id); expect(await store.claim("fixture-other-process", 60)).toBeNull();
   await store.registerPlan(job, [{ key: "guided", maximumCostMicrousd: textPolicy.maximumCostMicrousd }]);
   await store.beginStep(job, "guided", textPolicy.maximumCostMicrousd);
   await store.completeStep(job, "guided", { status: "needs_reconciliation", code: "synthetic_uncertain", costMicrousd: 0, providerRequestId: null });
   expect((await store.claim("fixture-local-strategy", 60))!.id).toBe(second.id);
  });
  expect((await availability()).status).toBe("available");
  expect((await availability(a)).status).toBe("unavailable");
  await expect(enqueue(a, "synthetic-no-replacement")).rejects.toThrow("paid_outcome_unresolved");
  expect((await db.query("select state,reserved_microusd from public.usage_reservations where job_id=$1", [first.id])).rows).toEqual([{ state: "active", reserved_microusd: textPolicy.maximumCostMicrousd }]);
 });

 it("blocks dispatch after readiness disable but still permits lease-fenced cancellation and settlement", async () => {
  await enable(); const id = await project(); const admission = await enqueue(id); const store = new PostgresJobStore(db, { localPrototype: true });
  const job = await brainWorker(db, () => store.claim("fixture-local-strategy", 60)); expect(job).not.toBeNull();
  await brainWorker(db, () => store.registerPlan(job!, [{ key: "guided", maximumCostMicrousd: textPolicy.maximumCostMicrousd }]));
  await db.exec("update fluid_private.local_prototype_strategy_capabilities set enabled=false");
  await expect(brainWorker(db, () => store.beginStep(job!, "guided", textPolicy.maximumCostMicrousd))).rejects.toThrow("runtime_unavailable");
  await brainRpc(db, "request_job_cancel", [admission.id]);
  await brainWorker(db, () => store.finish(job!, "cancelled"));
  expect((await db.query("select actual_microusd,state from public.usage_reservations where job_id=$1", [admission.id])).rows).toEqual([{ actual_microusd: 0, state: "settled" }]);
 });

 it("admits only explicit new local Naming work across an unrelated quarantine and preserves its full historical hold", async () => {
  const old = await startBrainFixture(db, namingProject); await beginBrainStage(db, old, "research");
  const { request } = await planBrainCall(db, old, "research");
  await brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [old.id, old.lease_token, request]));
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'research','ambiguous',$3)", [old.id, old.lease_token, { artifactIds: [], errorCode: "provider_request_rejected" }]));
  const historical = (await db.query("select to_jsonb(j) job,to_jsonb(r) reservation from public.jobs j join public.usage_reservations r on r.job_id=j.id where j.id=$1", [old.id])).rows;
  await enable();
  expect((await availability(namingProject)).status).toBe("unavailable");
  await expect(enqueue(namingProject, "synthetic-same-project-strategy")).rejects.toThrow("paid_outcome_unresolved");
  const fresh = (await brainRpc<{ id: string }>(db, "create_project", ["naming_only", "Synthetic new local Naming", { description: "Synthetic preserved-quarantine isolation" }, HASH])).id;
  await brainRpc(db, "save_naming_preferences", [fresh, 0, brainPreferences]); await attestBrainPreferences(db);
  const hosted = await brainRpc<{ status: string; code: string }>(db, "ensure_naming_brain_run", [fresh, initialIntent("synthetic-hosted-remains-blocked")]);
  expect(hosted).toMatchObject({ status: "blocked", code: "dispatch_unresolved" });
  const local = await brainRpc<{ status: string; run: { jobId: string } }>(db, "ensure_local_naming_brain_run", [fresh, initialIntent("synthetic-local-naming-admit")]);
  expect(local.status).toBe("pending");
  expect((await db.query("select job_id from fluid_private.local_prototype_jobs where job_id=$1", [local.run.jobId])).rows).toEqual([{ job_id: local.run.jobId }]);
  expect((await db.query("select to_jsonb(j) job,to_jsonb(r) reservation from public.jobs j join public.usage_reservations r on r.job_id=j.id where j.id=$1", [old.id])).rows).toEqual(historical);
  expect((await db.query("select sum(coalesce(actual_cost_microusd,5000000))::integer held from fluid_private.naming_brain_runs")).rows).toEqual([{ held: 10_000_000 }]);
  expect((await db.query("select * from fluid_private.local_prototype_admission_context")).rows).toEqual([]);
  const same = await brainRpc<{ status: string; run?: { jobId: string } }>(db, "ensure_local_naming_brain_run", [namingProject, initialIntent("synthetic-old-project-no-retry")]);
  expect(same.run?.jobId ?? old.id).toBe(old.id);
  expect((await db.query("select job_id from fluid_private.local_prototype_jobs where job_id=$1", [old.id])).rows).toEqual([]);
  const claimed = await brainWorker(db, async () => (await db.query<{ value: { job: { id: string; lease_token: string } } }>("select public.claim_naming_brain_job('fixture-worker','fixture-deployment',60) value")).rows[0]!.value);
  expect(claimed.job.id).toBe(local.run.jobId);
  await brainAction(db, claimed.job, "plan", { manifest: brainManifest, gapEnvelope: brainGapEnvelope });
  await beginBrainStage(db, claimed.job, "research");
  await expect(brainWorker(db, () => db.query("select public.local_strategy_job_action($1,'finish',$2)", [claimed.job.id, [claimed.job.lease_token, "succeeded", null]]))).rejects.toMatchObject({ code: "42501" });
  for (const fn of ["heartbeat_job(uuid,uuid,integer)", "register_job_plan(uuid,uuid,jsonb)", "begin_job_step(uuid,uuid,text,text,bigint)", "complete_job_step(uuid,uuid,text,text,bigint,jsonb,text)", "finish_job(uuid,uuid,text,text)"])
   expect((await db.query<{ ok: boolean }>("select has_function_privilege('fixture_naming_brain_a',$1,'EXECUTE') ok", [`public.${fn}`])).rows[0]!.ok).toBe(false);
 });

 it("preserves the local worker branches when composing the historical vector proposal candidate", async () => {
  const security = () => db.query("select oid,proowner,proacl,prosecdef,proconfig,provolatile,proleakproof from pg_proc where oid in('fluid_private.lock_leased_job(uuid,uuid)'::regprocedure,'public.claim_job(text,integer)'::regprocedure,'public.expire_job_leases()'::regprocedure) order by oid");
  const before = (await security()).rows;
  await db.exec(await readFile(new URL("../../supabase/candidates/logo-vector-proposals.sql", import.meta.url), "utf8"));
  expect((await security()).rows).toEqual(before);
  await enable(); const id = await project(); const admission = await enqueue(id);
  const store = new PostgresJobStore(db, { localPrototype: true });
  await brainWorker(db, async () => {
   const job = (await store.claim("fixture-composed-local-strategy", 60))!; expect(job.id).toBe(admission.id);
   await store.registerPlan(job, [{ key: "guided", maximumCostMicrousd: textPolicy.maximumCostMicrousd }]);
   expect(await store.beginStep(job, "guided", textPolicy.maximumCostMicrousd)).toBe("started");
   await store.completeStep(job, "guided", { status: "failed", code: "synthetic_known_failure", costMicrousd: 0, providerRequestId: null });
   await store.finish(job, "failed");
   expect(await store.expireLeases()).toBe(0);
  });
  expect((await db.query("select actual_microusd,state from public.usage_reservations where job_id=$1", [admission.id])).rows).toEqual([{ actual_microusd: 0, state: "settled" }]);
 });
});
