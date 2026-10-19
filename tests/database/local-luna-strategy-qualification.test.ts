import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy, LOCAL_STRATEGY_MODEL, strategyPolicy } from "../../src/server/ai/config";
import { strategyJobInputSchema, type StrategyJobPolicy } from "../../src/domain/strategy-jobs";
import { PostgresJobStore } from "../../worker/postgres-store";
import { asRole, createTestDatabase, HASH, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { brainRpc, brainWorker, installBrainFixture, seedBrainFixture } from "./naming-brain-fixture";

const filename = "20261017174000_local_luna_strategy_qualification.sql";
const migration = await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8");
const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"] as const;
type Operation = typeof operations[number];
const signatures = ["fluid_private.local_strategy_job_ready(uuid)", "public.get_local_strategy_availability(uuid)",
 "public.enqueue_local_strategy_job(uuid,integer,text,text,bigint)", "fluid_private.report_local_strategy_ready(text,jsonb,integer)",
 "fluid_private.claim_local_strategy_job(text,integer)"];
type Metadata = { signature: string; body: string; oid: number; owner: number; acl: string[] | null; config: string[]; definer: boolean; volatility: string; leakproof: boolean };

describe("local Luna qualification preserves the hosted Sol runtime (synthetic SQL)", () => {
 let db: TestDatabase, before: Metadata[], after: Metadata[], oldJob: string, oldRows: unknown, hostedRows: unknown;
 const metadata = async () => (await db.query<Metadata>(`select p.oid::regprocedure::text signature,p.prosrc body,p.oid,p.proowner owner,p.proacl acl,
  p.proconfig config,p.prosecdef definer,p.provolatile volatility,p.proleakproof leakproof from pg_proc p
  where p.oid=any($1::regprocedure[]::oid[]) order by array_position($1::regprocedure[]::oid[],p.oid)`, [signatures])).rows;
 const oldSnapshot = async () => (await db.query("select to_jsonb(j) job,to_jsonb(r) reservation from public.jobs j join public.usage_reservations r on r.job_id=j.id where j.id=$1", [oldJob])).rows;
 const hostedSnapshot = async () => (await db.query(`select
  (select jsonb_agg(to_jsonb(p) order by operation) from fluid_private.strategy_runtime_policy p) policies,
  (select jsonb_agg(to_jsonb(b) order by owner_id,operation) from fluid_private.api_strategy_bindings b) bindings`)).rows;
 const ready = async (operation: Operation, policy: StrategyJobPolicy) => (await brainWorker(db, () => db.query<{ ready: boolean }>(
  "select public.report_strategy_worker_ready($1,$2,90) ready", [operation, policy]))).rows[0]!.ready;
 const availability = async (projectId: string) => asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ feed: { status: string; operations: { operation: Operation; maximumCostMicrousd: number }[] } }>(
  "select public.get_local_strategy_availability($1) feed", [projectId])).rows[0]!.feed);
 async function project(operation: Operation) {
  const stage = operation === "strategy.audience" ? "audience" : operation === "strategy.personality" ? "personality" : "competitors";
  return (await brainRpc<{ id: string }>(db, "create_project", ["complete_brand", "Synthetic local qualification", { description: "Synthetic skincare studio", intake: {
   conversation: [{ kind: "user_message", id: "synthetic-message", text: "An explicit synthetic brief", createdAt: "2026-10-18T16:00:00Z" }],
   guidedInterview: { version: 1, stage, turns: [{ id: "synthetic-turn", userMessageId: "synthetic-message", inputRevision: 1, stage,
    purpose: operation === "strategy.reformulate" ? "message" : operation === "strategy.competitors" ? "research" : "propose" }], answers: [] },
  } }, HASH])).id;
 }
 async function enqueue(projectId: string, operation: Operation, key: string, owner = OWNER_A) {
  return asRole(db, "authenticated", owner, async () => (await db.query<{ job: { id: string } }>(
   "select public.enqueue_local_strategy_job($1,1,$2,$3,$4) job", [projectId, operation, key, guidedStrategyPolicy(operation, LOCAL_STRATEGY_MODEL).maximumCostMicrousd])).rows[0]!.job);
 }
 beforeAll(async () => {
  db = await createTestDatabase({ before: filename }); await installBrainFixture(db);
  await db.exec(`grant execute on function public.report_strategy_worker_ready(text,jsonb,integer),public.claim_job(text,integer),
   public.local_strategy_job_action(uuid,text,jsonb),public.read_local_strategy_steps(uuid,uuid,uuid,text) to fixture_naming_brain_a,fixture_naming_brain_b`);
  before = await metadata(); await db.exec(migration); after = await metadata();
 }, 60_000);
 beforeEach(async () => {
  await seedBrainFixture(db);
  for (const operation of operations) {
   const policy = guidedStrategyPolicy(operation);
   await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2) on conflict(operation) do update set enabled=true,policy=excluded.policy", [operation, policy]);
   await db.query(`insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled)
    select $1,$2,oid,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'),'dpl_synthetic_hosted_sol',true from pg_roles where rolname='fixture_naming_brain_b'
    on conflict(owner_id,operation) do update set policy_identity=excluded.policy_identity`, [OWNER_A, operation, policy]);
   await db.query(`insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled)
    select $1,$2,rolname,oid,'fixture-deployment',$3,true from pg_roles where rolname='fixture_naming_brain_a'
    on conflict(owner_id,operation) do update set policy=excluded.policy,enabled=true`, [OWNER_A, operation, policy]);
  }
  const sol = guidedStrategyPolicy("strategy.reformulate"); expect(await ready("strategy.reformulate", sol)).toBe(true);
  const oldProject = await project("strategy.reformulate");
  oldJob = await asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ job: { id: string } }>(
   "select public.enqueue_local_strategy_job($1,1,'strategy.reformulate','synthetic-preserved-sol-job',$2) job", [oldProject, sol.maximumCostMicrousd])).rows[0]!.job.id);
  oldRows = await oldSnapshot(); hostedRows = await hostedSnapshot();
  for (const operation of operations) await db.query("update fluid_private.local_prototype_strategy_capabilities set policy=$2 where owner_id=$1 and operation=$3", [OWNER_A, guidedStrategyPolicy(operation, LOCAL_STRATEGY_MODEL), operation]);
 });
 afterAll(async () => { await db?.close(); });

 it("changes only the five local equality qualifications and preserves identities, ACLs, global policies and old Sol admissions", async () => {
  for (let i = 0; i < signatures.length; i++) {
   const cap = i === 2 ? "cap" : "c", runtime = i === 2 ? "runtime" : "p";
   const original = `${runtime}.policy=${cap}.policy`;
   const replacement = `(${original} or (${cap}.policy->>'model'='gpt-6-luna' and fluid_private.api_text_guided_policy(${cap}.operation,${cap}.policy)))`;
   expect(after[i]!.body.replace(replacement, original)).toBe(before[i]!.body);
   expect({ ...after[i], body: null }).toEqual({ ...before[i], body: null });
  }
  expect(await hostedSnapshot()).toEqual(hostedRows); expect(await oldSnapshot()).toEqual(oldRows);
  for (const operation of operations) expect((await db.query<{ allowed: boolean }>(
   "select fluid_private.api_text_request_policy($1,$2,$3) allowed", [OWNER_A, operation, guidedStrategyPolicy(operation, LOCAL_STRATEGY_MODEL)])).rows[0]!.allowed).toBe(false);
 });

 it("heartbeats, advertises, admits and begins exact local Luna work while every global policy and hosted binding stays Sol", async () => {
  const projects = new Map<Operation, string>();
  for (const operation of operations) projects.set(operation, await project(operation));
  expect((await availability(projects.get("strategy.reformulate")!)).status).toBe("unavailable");
  const admissions: string[] = [];
  for (const operation of operations) {
   const policy = guidedStrategyPolicy(operation, LOCAL_STRATEGY_MODEL);
   expect(await ready(operation, guidedStrategyPolicy(operation))).toBe(false);
   expect(await ready(operation, policy)).toBe(true);
  }
  expect((await availability(projects.get("strategy.reformulate")!)).operations.map(value => value.operation).sort()).toEqual([...operations].sort());
  for (const operation of operations) {
   const admitted = await enqueue(projects.get(operation)!, operation, `synthetic-luna-qualified-${operation}`);
   expect(await enqueue(projects.get(operation)!, operation, `synthetic-luna-qualified-${operation}`)).toEqual(admitted);
   admissions.push(admitted.id);
  }
  const store = new PostgresJobStore(db, { localPrototype: true }), claimed = await brainWorker(db, () => store.claim("synthetic-luna-worker", 60));
  expect(claimed).not.toBeNull(); expect(admissions).toContain(claimed!.id); expect(claimed!.id).not.toBe(oldJob);
  const input = strategyJobInputSchema.parse(claimed!.input); expect(input.policy.model).toBe(LOCAL_STRATEGY_MODEL);
  await brainWorker(db, () => store.registerPlan(claimed!, [{ key: "respond", maximumCostMicrousd: input.policy.maximumCostMicrousd }]));
  expect(await brainWorker(db, () => store.beginStep(claimed!, "respond", input.policy.maximumCostMicrousd))).toBe("started");
  expect(await hostedSnapshot()).toEqual(hostedRows); expect(await oldSnapshot()).toEqual(oldRows);
  expect((await db.query("select count(*)::int count from fluid_private.api_text_dispatches")).rows).toEqual([{ count: 0 }]);
 });

 it("retains operation-disable, freshness, exact-policy and tenant fences rather than allowing a general policy mismatch", async () => {
  const operation = "strategy.reformulate", policy = guidedStrategyPolicy(operation, LOCAL_STRATEGY_MODEL), id = await project(operation);
  await expect(enqueue(id, operation, "synthetic-cross-owner-luna", OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  expect(await ready(operation, { ...policy, maximumCostMicrousd: policy.maximumCostMicrousd + 1 })).toBe(false);
  await db.query("update fluid_private.strategy_runtime_policy set enabled=false where operation=$1", [operation]);
  expect(await ready(operation, policy)).toBe(false);
  await expect(enqueue(id, operation, "synthetic-disabled-luna")).rejects.toThrow("runtime_unavailable");
  await db.query("update fluid_private.strategy_runtime_policy set enabled=true where operation=$1", [operation]);
  expect(await ready(operation, policy)).toBe(true);
  await db.query("update fluid_private.local_prototype_strategy_capabilities set ready_until=clock_timestamp()-interval '1 second' where owner_id=$1 and operation=$2", [OWNER_A, operation]);
  expect((await availability(id)).status).toBe("unavailable");
  await expect(enqueue(id, operation, "synthetic-stale-luna")).rejects.toThrow("runtime_unavailable");
  // Only Luna receives the new arm. A different saved Sol canonical must still
  // match the global runtime exactly, even though both policies are valid.
  await db.query("update fluid_private.local_prototype_strategy_capabilities set policy=$2 where owner_id=$1 and operation=$3", [OWNER_A, guidedStrategyPolicy(operation), operation]);
  await db.query("update fluid_private.strategy_runtime_policy set policy=$2 where operation=$1", [operation, strategyPolicy(operation)]);
  expect(await ready(operation, guidedStrategyPolicy(operation))).toBe(false);
 });

 it("fails closed when the exact five-function predecessor is no longer present", async () => {
  const preserved = await metadata();
  await expect(db.exec(migration)).rejects.toThrow("unexpected_local_luna_qualification_predecessor"); await db.exec("rollback");
  expect(await metadata()).toEqual(preserved);
 });
});
