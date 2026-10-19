import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { createTestDatabase, OWNER_A, type TestDatabase } from "./local-supabase";
import { brainRpc, brainWorker, claimBrain, initialIntent, installBrainFixture, seedBrainFixture } from "./naming-brain-fixture";
import { saveProgressivePart, seedProgressiveFixture } from "./naming-brain-progressive-fixture";

const migrationName = "20261017172000_local_expiry_maintenance.sql";
const signatures = ["public.expire_naming_brain_leases(text,text)", "fluid_private.expire_local_strategy_leases()", "fluid_private.naming_brain_preparation_pending(fluid_private.naming_brain_runs)"];
const namingGuard = " if fluid_private.local_strategy_worker_owner()=o\n and not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(o::text,723902)) then return 0; end if;\n";
const strategyGuard = " if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(o::text,723902)) then return 0; end if;\n";
const oldPreparationPrefix = " select case when not fluid_private.local_naming_progressive_job(r.job_id) then fluid_private.local_naming_previous_preparation_pending(r) else\n";
const newPreparationPrefix = " select case when not fluid_private.local_naming_progressive_job(r.job_id) then fluid_private.local_naming_previous_preparation_pending(r)\n when (select count(*) from fluid_private.naming_brain_feed_entries where run_id=r.id)<>100 then false\n when not exists(select 1 from public.job_steps where job_id=r.job_id and owner_id=r.owner_id and project_id=r.project_id and step_key='creation' and state='succeeded') then false\n else\n";
type FunctionMetadata = { signature: string; body: string; definition: string; oid: number; owner: number; acl: string[]; config: string[]; definer: boolean; volatility: string; language: number; leakproof: boolean };

describe("bounded local expiry maintenance (disposable SQL)", () => {
 let db: TestDatabase, project: string, before: FunctionMetadata[], after: FunctionMetadata[], migration: string;
 const metadata = async () => (await db.query<FunctionMetadata>(`select p.oid,p.oid::regprocedure::text signature,p.prosrc body,pg_get_functiondef(p.oid) definition,
 p.proowner owner,p.proacl acl,p.proconfig config,p.prosecdef definer,p.provolatile volatility,p.prolang language,p.proleakproof leakproof
 from pg_proc p where p.oid=any($1::regprocedure[]::oid[]) order by array_position($1::regprocedure[]::oid[],p.oid)`, [signatures])).rows;
 async function snapshot() {
  return (await db.query(`select
   (select md5(coalesce(jsonb_agg(to_jsonb(j) order by id)::text,'[]')) from public.jobs j) jobs,
   (select md5(coalesce(jsonb_agg(to_jsonb(s) order by job_id,step_key)::text,'[]')) from public.job_steps s) steps,
   (select md5(coalesce(jsonb_agg(to_jsonb(r) order by id)::text,'[]')) from fluid_private.naming_brain_runs r) runs,
   (select md5(coalesce(jsonb_agg(to_jsonb(r) order by job_id)::text,'[]')) from public.usage_reservations r) holds,
   (select md5(coalesce(jsonb_agg(to_jsonb(c) order by run_id,stage_key,call_key)::text,'[]')) from fluid_private.naming_brain_calls c) calls`)).rows;
 }
 async function enableLocal() {
  const policy = guidedStrategyPolicy("strategy.reformulate");
  await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
  await db.query(`insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until)
   select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds'
   from pg_roles where rolname='fixture_naming_brain_a'`, [OWNER_A, policy]);
 }
 beforeAll(async () => {
  migration = await readFile(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url), "utf8");
  db = await createTestDatabase({ before: migrationName });
  before = await metadata(); await db.exec(migration); after = await metadata();
  await installBrainFixture(db);
  await db.exec("grant execute on function public.expire_job_leases() to fixture_naming_brain_a,fixture_naming_brain_b");
 }, 60_000);
 beforeEach(async () => { project = await seedBrainFixture(db); await enableLocal(); });
 afterAll(async () => { await db?.close(); });

 it("preserves function identity/privileges and every native/eligible branch, adding only local maintenance guards", async () => {
  for (let i = 0; i < before.length; i++) {
   const original = before[i]!.body, changed = after[i]!.body;
   expect({ ...after[i], body: null, definition: null }).toEqual({ ...before[i], body: null, definition: null });
   expect(i === 2 ? changed.replace(newPreparationPrefix, oldPreparationPrefix) : changed.replace(i === 0 ? namingGuard : strategyGuard, "")).toBe(original);
  }
  expect(after[0]!.body).toContain(namingGuard); expect(after[1]!.body).toContain(strategyGuard);
  for (const role of ["anon", "authenticated", "service_role", "fixture_naming_brain_a"])
   expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'fluid_private.expire_local_strategy_leases()','EXECUTE') allowed", [role])).rows[0]!.allowed).toBe(false);
  // The exact predecessor guard makes unknown composition fail before replacing
  // any function, rather than silently accepting an already modified runtime.
  await expect(db.exec(migration)).rejects.toThrow("unexpected_local_expiry_predecessor");
  await db.exec("rollback");
 });

 it("keeps normal restricted Naming expiry idempotent and retains the original reservation", async () => {
  await brainRpc(db, "ensure_local_naming_brain_run", [project, initialIntent("synthetic-expiry-maintenance")]);
  const { job } = await claimBrain(db);
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
  const holds = (await db.query("select to_jsonb(r) value from public.usage_reservations r where job_id=$1", [job.id])).rows;
  const expire = () => brainWorker(db, () => db.query<{ count: number }>("select public.expire_naming_brain_leases('fixture-worker','fixture-deployment') count"));
  expect((await expire()).rows).toEqual([{ count: 1 }]); expect((await expire()).rows).toEqual([{ count: 0 }]);
  expect((await db.query("select state,lease_token,lease_expires_at from public.jobs where id=$1", [job.id])).rows).toEqual([{ state: "queued", lease_token: null, lease_expires_at: null }]);
  expect((await db.query("select to_jsonb(r) value from public.usage_reservations r where job_id=$1", [job.id])).rows).toEqual(holds);
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls")).rows).toEqual([{ count: 0 }]);
  await expect(brainWorker(db, () => db.query("select public.expire_naming_brain_leases('fixture-worker','fixture-deployment')"), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).rejects.toMatchObject({ code: "42501" });
 });

 it("skips a busy local owner without changing leases/history, while hosted Naming never uses that skip", async () => {
  await brainRpc(db, "ensure_local_naming_brain_run", [project, initialIntent("synthetic-expiry-busy")]);
  const { job } = await claimBrain(db);
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
  const preserved = await snapshot();
  // PGlite has one backend, so it cannot create competing-session advisory
  // contention. Inject only the primitive's busy result into the real function
  // body; all owner checks and lease/settlement branches remain actual SQL.
  const naming = after[0]!.definition.replace("pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(o::text,723902))", "false");
  const strategy = after[1]!.definition.replace("pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(o::text,723902))", "false");
  await db.exec(naming); await db.exec(strategy);
  try {
   expect((await brainWorker(db, () => db.query("select public.expire_naming_brain_leases('fixture-worker','fixture-deployment') count"))).rows).toEqual([{ count: 0 }]);
   expect((await brainWorker(db, () => db.query("select public.expire_job_leases() count"))).rows).toEqual([{ count: 0 }]);
   expect(await snapshot()).toEqual(preserved);
   // Removing the local capability is the historical/hosted boundary. The same
   // restricted Naming pilot still expires its lease by the unchanged branch.
   await db.exec("delete from fluid_private.local_prototype_strategy_capabilities");
   expect((await brainWorker(db, () => db.query("select public.expire_naming_brain_leases('fixture-worker','fixture-deployment') count"))).rows).toEqual([{ count: 1 }]);
  } finally { await db.exec(after[0]!.definition); await db.exec(after[1]!.definition); }
 });

 it("returns false at genuine94 and unfinished100 before evaluating any costly preparation predicate", async () => {
  const fixture = await seedProgressiveFixture(db);
  for (let index = 0; index < 16; index++) {
   const part = await saveProgressivePart(fixture, index, index === 15 ? 4 : 6, fixture.input.snapshot.preferences.approaches[index % 3]!);
   await brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, part.publication!, new AbortController().signal));
  }
  const helpers = ["fluid_private.local_naming_progressive_current(fluid_private.naming_brain_runs)", "fluid_private.local_naming_progressive_researched(fluid_private.naming_brain_runs)",
   "fluid_private.local_naming_progressive_counts(fluid_private.naming_brain_runs)", "fluid_private.naming_brain_call_terminal(fluid_private.naming_brain_calls)"];
  const originals = (await db.query<{ definition: string }>("select pg_get_functiondef(oid) definition from unnest($1::regprocedure[]::oid[]) oid", [helpers])).rows.map(row => row.definition);
  const check = () => db.query("select fluid_private.naming_brain_preparation_pending(r) pending from fluid_private.naming_brain_runs r where id=$1", [fixture.input.runId]);
  const preserved94 = await snapshot();
  // Fault injection proves the CASE gate excludes every expensive helper. It
  // does not claim to reproduce native planner/JIT performance in PGlite.
  const forbidHelpers = async () => {
   for (const definition of originals) {
    const opening = definition.indexOf("AS $function$"), closing = definition.lastIndexOf("$function$");
    expect(opening).toBeGreaterThan(0); expect(closing).toBeGreaterThan(opening);
    await db.exec(definition.slice(0, opening).replace("LANGUAGE sql", "LANGUAGE plpgsql") + "AS $function$ begin raise exception 'synthetic_expensive_preparation_predicate'; end $function$" + definition.slice(closing + "$function$".length));
   }
  };
  const restore = async () => { for (const definition of originals) await db.exec(definition); };
  await forbidHelpers();
  try { expect((await check()).rows).toEqual([{ pending: false }]); expect(await snapshot()).toEqual(preserved94); }
  finally { await restore(); }
  const final = await saveProgressivePart(fixture, 16, 6, "invented");
  await brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, final.publication!, new AbortController().signal));
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_feed_entries where run_id=$1", [fixture.input.runId])).rows).toEqual([{ count: 100 }]);
  const preserved100 = await snapshot(); await forbidHelpers();
  try { expect((await check()).rows).toEqual([{ pending: false }]); expect(await snapshot()).toEqual(preserved100); }
  finally { await restore(); }
 }, 60_000);
});
