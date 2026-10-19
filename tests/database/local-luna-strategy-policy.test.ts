import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy, LOCAL_STRATEGY_MODEL } from "../../src/server/ai/config";
import { strategyJobInputSchema, type StrategyJobPolicy } from "../../src/domain/strategy-jobs";
import { PostgresJobStore } from "../../worker/postgres-store";
import { asRole, createTestDatabase, HASH, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { brainRpc, brainWorker, installBrainFixture, seedBrainFixture } from "./naming-brain-fixture";

const filename = "20261017173000_local_luna_strategy.sql";
const sql = await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8");
const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"] as const;
type Operation = typeof operations[number];
const at = "2026-10-18T16:00:00Z";

describe("future local Luna Strategy SQL policy (synthetic)", () => {
 let db: TestDatabase, oldJob: string, beforeRows: unknown, beforeSecurity: unknown;
 const security = () => db.query("select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc where oid in('fluid_private.api_text_guided_policy(text,jsonb)'::regprocedure,'fluid_private.api_text_request_policy(uuid,text,jsonb)'::regprocedure) order by oid");
 const oldSnapshot = () => db.query("select to_jsonb(j) job,to_jsonb(r) reservation from public.jobs j join public.usage_reservations r on r.job_id=j.id where j.id=$1", [oldJob]);
 async function reportReady(operation: Operation, policy: StrategyJobPolicy) {
  return (await brainWorker(db, () => db.query<{ ready: boolean }>("select public.report_strategy_worker_ready($1,$2,90) ready", [operation, policy]))).rows[0]!.ready;
 }
 async function configure(operation: Operation, policy: StrategyJobPolicy, ready = true) {
  await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2) on conflict(operation) do update set enabled=true,policy=excluded.policy", [operation, policy]);
  await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled) select $1,$2,rolname,oid,'fixture-deployment',$3,true from pg_roles where rolname='fixture_naming_brain_a' on conflict(owner_id,operation) do update set policy=excluded.policy,enabled=true", [OWNER_A, operation, policy]);
  if (ready) expect(await reportReady(operation, policy)).toBe(true);
 }
 async function project(operation: Operation) {
  const stage = operation === "strategy.audience" ? "audience" : operation === "strategy.personality" ? "personality" : "competitors";
  return (await brainRpc<{ id: string }>(db, "create_project", ["complete_brand", "Synthetic Luna Strategy", { description: "Synthetic calm skincare studio", intake: {
   conversation: [{ kind: "user_message", id: "synthetic-user", text: "A synthetic studio brief", createdAt: at }],
   guidedInterview: { version: 1, stage, turns: [{ id: "synthetic-turn", userMessageId: "synthetic-user", inputRevision: 1, stage,
    purpose: operation === "strategy.reformulate" ? "message" : operation === "strategy.competitors" ? "research" : "propose" }], answers: [] },
  } }, HASH])).id;
 }
 async function enqueue(projectId: string, operation: Operation, policy: StrategyJobPolicy, key: string, owner = OWNER_A) {
  return asRole(db, "authenticated", owner, async () => (await db.query<{ job: { id: string } }>("select public.enqueue_local_strategy_job($1,1,$2,$3,$4) job", [projectId, operation, key, policy.maximumCostMicrousd])).rows[0]!.job);
 }
 beforeAll(async () => {
  db = await createTestDatabase({ before: filename }); await installBrainFixture(db); await seedBrainFixture(db);
  await db.exec("grant execute on function public.report_strategy_worker_ready(text,jsonb,integer),public.claim_job(text,integer) to fixture_naming_brain_a,fixture_naming_brain_b");
  const policy = guidedStrategyPolicy("strategy.reformulate"); await configure("strategy.reformulate", policy);
  oldJob = (await enqueue(await project("strategy.reformulate"), "strategy.reformulate", policy, "synthetic-old-sol-strategy")).id;
  beforeRows = (await oldSnapshot()).rows; beforeSecurity = (await security()).rows;
  await db.exec(sql);
 }, 60_000);
 afterAll(async () => { await db?.close(); });

 it("changes only canonical validation while preserving old saved Sol jobs and all security metadata", async () => {
  expect((await oldSnapshot()).rows).toEqual(beforeRows); expect((await security()).rows).toEqual(beforeSecurity);
  for (const role of ["anon", "authenticated", "service_role", "fixture_naming_brain_a"])
   for (const signature of ["api_text_guided_policy(text,jsonb)", "api_text_request_policy(uuid,text,jsonb)"])
    expect((await db.query<{ ok: boolean }>("select has_function_privilege($1,$2,'EXECUTE') ok", [role, `fluid_private.${signature}`])).rows[0]!.ok).toBe(false);
 });
 it("accepts both exact canonicals but rejects Luna in hosted/testing requests even for an enabled testing account", async () => {
  await db.query(`insert into fluid_private.api_text_allowance_cohorts(id,enabled,role_name,role_oid,deployment_id,operations,signup_after,signup_before,expires_at,
   owner_attempt_limit,owner_cost_limit,owner_active_limit,account_limit,attempt_limit,cost_limit)
   select 'luna-fixture',true,rolname,oid,'dpl_synthetic_luna',$1,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day',1,122880,1,1,1,122880
   from pg_roles where rolname='fixture_naming_brain_a'`, [operations]);
  await db.query("insert into fluid_private.api_text_owner_entitlements(owner_id,cohort_id,enabled,attempt_limit,cost_limit,active_limit,expires_at) values($1,'luna-fixture',true,1,122880,1,clock_timestamp()+interval '1 day')", [OWNER_A]);
  for (const operation of operations) {
   await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'luna-fixture',$2,true)", [OWNER_A, operation]);
   for (const model of ["gpt-6.1-sol", LOCAL_STRATEGY_MODEL] as const) {
    const policy = guidedStrategyPolicy(operation, model);
    expect((await db.query<{ canonical: boolean; hosted: boolean }>("select fluid_private.api_text_guided_policy($1,$2) canonical,fluid_private.api_text_request_policy($3,$1,$2) hosted", [operation, policy, OWNER_A])).rows[0]).toEqual({ canonical: true, hosted: model === "gpt-6.1-sol" });
   }
   const policy = guidedStrategyPolicy(operation, LOCAL_STRATEGY_MODEL);
   for (const changed of [{ ...policy, pricingVersion: "2026-10-14" }, { ...policy, maximumCostMicrousd: 1 }, { ...policy, model: "unknown-fixture" }, { ...policy, additionalField: true }])
    expect((await db.query<{ allowed: boolean }>("select fluid_private.api_text_guided_policy($1,$2) allowed", [operation, changed])).rows[0]!.allowed).toBe(false);
  }
  expect((await db.query<{ allowed: boolean }>("select fluid_private.api_text_guided_policy('strategy.positioning',$1) allowed", [guidedStrategyPolicy("strategy.reformulate", LOCAL_STRATEGY_MODEL)])).rows[0]!.allowed).toBe(false);
 });
 it("admits only owned future local Luna jobs with fresh exact readiness and never rebinds the old Sol job", async () => {
  const admissions: string[] = [];
  for (const operation of operations) {
   const policy = guidedStrategyPolicy(operation, LOCAL_STRATEGY_MODEL); await configure(operation, policy, false);
   const id = await project(operation), key = `synthetic-luna-${operation}`;
   await expect(enqueue(id, operation, policy, key, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
   await expect(enqueue(id, operation, policy, key)).rejects.toThrow("runtime_unavailable");
   expect(await reportReady(operation, guidedStrategyPolicy(operation))).toBe(false);
   expect(await reportReady(operation, policy)).toBe(true);
   const admission = await enqueue(id, operation, policy, key); expect(await enqueue(id, operation, policy, key)).toEqual(admission);
   admissions.push(admission.id);
   const saved = (await db.query<{ input: unknown }>("select input from public.jobs where id=$1", [admission.id])).rows[0]!.input;
   expect(strategyJobInputSchema.parse(saved)).toMatchObject({ version: 2, policy, assistantHistory: { entries: [], truncated: false } });
  }
  const store = new PostgresJobStore(db, { localPrototype: true }), claimed = await brainWorker(db, () => store.claim("synthetic-luna-worker", 60));
  expect(claimed).not.toBeNull(); expect(admissions).toContain(claimed!.id); expect(claimed!.id).not.toBe(oldJob);
  expect(strategyJobInputSchema.parse(claimed!.input).policy.model).toBe(LOCAL_STRATEGY_MODEL);
  expect((await oldSnapshot()).rows).toEqual(beforeRows);
  expect((await db.query("select count(*)::integer count from fluid_private.api_text_dispatches")).rows).toEqual([{ count: 0 }]);
 });
 it("refuses a changed predecessor on reapplication without altering the installed metadata", async () => {
  const before = (await security()).rows;
  await expect(db.exec(sql)).rejects.toThrow("unexpected_local_luna_strategy_predecessor"); await db.exec("rollback");
  expect((await security()).rows).toEqual(before);
 });
});
