import { readdir, readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtureMigrationNames } from "./fixture-migrations";
import { strategyPolicy } from "../../src/server/ai/config";
import type { ApiTextDispatchMessage } from "../../src/domain/api-text-dispatch";
import { runApiTextDelivery } from "../../worker/api-text-runtime";
import { publishAdmittedDispatch, repairApiTextDispatches } from "../../worker/hosting/publication";
import { transportFixture } from "../server/openai-fixtures";

// Opt-in disposable loopback PostgreSQL only. Independent connections exercise
// real backend/transaction isolation. No hosted URL or provider is accepted.
const url = process.env.FLUID_API_TEXT_POSTGRES_TEST_URL;
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deploymentId = "dpl_multi_account_postgres_fixture";
const policy = strategyPolicy("strategy.reformulate");
const configuration = { apiKey: "synthetic-test-credential", policies: new Map([["strategy.reformulate" as const, policy]]) };
type Admission = { id: string; dispatch: ApiTextDispatchMessage };

describe.skipIf(!url)("multi-account admission and gateway on disposable PostgreSQL", () => {
  const database = `fluid_api_${process.pid}_${Date.now()}`;
  const workerRole = `${database}_worker`, otherRole = `${database}_other`;
  let admin: Client, setup: Client, left: Client, right: Client, worker: Client, parallelWorker: Client, otherWorker: Client;
  let projectA: string, projectB: string;
  let hostileDefaultsDenied = false;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!["127.0.0.1", "localhost"].includes(target.hostname) || !["postgres:", "postgresql:"].includes(target.protocol)) throw new Error("A disposable loopback PostgreSQL fixture is required");
    admin = new Client({ connectionString: target.href, connectionTimeoutMillis: 5000 }); await admin.connect();
    await admin.query(`create database ${database}`); target.pathname = `/${database}`;
    setup = new Client({ connectionString: target.href, connectionTimeoutMillis: 5000 }); await setup.connect();
    await setup.query("set statement_timeout='20s'");
    await setup.query(`
      do $$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin;end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin;end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls;end if;
      end $$;
      create role ${workerRole} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role ${otherRole} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create schema auth; create table auth.users(id uuid primary key,created_at timestamptz default clock_timestamp(),email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text,unique(bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated,service_role; grant select,insert,update,delete on storage.objects to authenticated,service_role;
      create function storage.operation() returns text language sql stable as $$ select current_setting('storage.operation',true) $$;
      create function storage.allow_only_operation(expected_operation text) returns boolean language sql stable as $$
        select coalesce(regexp_replace(storage.operation(),'^storage\\.','')=regexp_replace(expected_operation,'^storage\\.','') and expected_operation<>'',false) $$;
    `);
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    for (const name of fixtureMigrationNames(await readdir(directory))) await setup.query(await readFile(new URL(name, directory), "utf8"));
    // Reproduce the old restricted worker's existing function-only workflow.
    await setup.query(`grant usage on schema public to ${workerRole};
      grant select(job_id,owner_id,project_id,step_key,state,request_key,reserved_cost_microusd) on public.job_steps to ${workerRole};
      grant execute on function public.claim_api_text_job(uuid,text,integer,text,text),public.check_api_text_runtime(text,jsonb,text),
        public.authorize_api_text_dispatch(uuid,uuid,text,text,text),public.heartbeat_job(uuid,uuid,integer),public.register_job_plan(uuid,uuid,jsonb),
        public.begin_job_step(uuid,uuid,text,text,bigint),public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_job(uuid,uuid,text,text),
        public.expire_api_text_job(uuid),public.get_api_text_dispatch(uuid),public.mark_api_text_published(uuid,text,integer,text),
        public.list_pending_api_text_dispatches(integer),public.prepare_api_text_redrive(uuid,text,integer) to ${workerRole}`);
    // Hostile defaults must not acquire privileges on newly introduced objects.
    await setup.query(`alter default privileges in schema public,fluid_private grant execute on functions to ${otherRole}; alter default privileges in schema fluid_private grant select on tables to ${otherRole}`);
    await setup.query(await readFile(new URL("../../supabase/candidates/api_text_multi_account.sql", import.meta.url), "utf8"));
    hostileDefaultsDenied = (await setup.query(`select not has_function_privilege($1,'public.api_text_dispatch_action(jsonb,text,jsonb)','execute')
      and not has_function_privilege($1,'fluid_private.api_text_descriptor_owner(jsonb)','execute')
      and not has_table_privilege($1,'fluid_private.api_text_gateway_context','select') denied`, [otherRole])).rows[0].denied;
    // Synthetic exact worker grants only, after proving candidate grants none.
    await setup.query(`grant usage on schema public to ${workerRole},${otherRole};
      grant execute on function public.api_text_dispatch_action(jsonb,text,jsonb),public.list_api_text_dispatches_v2(integer),public.api_text_multi_account_readiness(jsonb,text) to ${workerRole},${otherRole};
      grant execute on function public.get_api_text_dispatch(uuid) to ${workerRole};`);
    const connect = async () => { const client = new Client({ connectionString: target.href, connectionTimeoutMillis: 5000 }); await client.connect(); await client.query("set statement_timeout='10s'"); return client; };
    left = await connect(); right = await connect(); worker = await connect(); parallelWorker = await connect(); otherWorker = await connect();
    await left.query("set role authenticated"); await right.query("set role authenticated");
    for (const client of [worker, parallelWorker]) await client.query(`set session authorization ${workerRole}`);
    await otherWorker.query(`set session authorization ${otherRole}`);
  }, 60_000);
  beforeEach(async () => {
    // Keep synthetic auth/projects until dropping this database. Truncating
    // auth.users would unnecessarily reset the entire integrated product schema.
    await setup.query("truncate public.jobs,public.usage_accounts,fluid_private.api_text_allowance_rollout,fluid_private.api_text_allowance_cohorts cascade; insert into fluid_private.api_text_allowance_rollout(singleton) values(true); delete from fluid_private.api_strategy_bindings; delete from fluid_private.strategy_billing_routes; delete from fluid_private.api_text_worker_principals; delete from fluid_private.strategy_runtime_policy");
    await setup.query("insert into auth.users(id,email_confirmed_at) values($1,clock_timestamp()),($2,clock_timestamp()) on conflict(id) do update set created_at=clock_timestamp(),email_confirmed_at=clock_timestamp()", [ownerA, ownerB]);
    await setup.query("insert into public.usage_accounts(owner_id,limit_microusd) values($1,0),($2,0)", [ownerA, ownerB]);
    await setup.query("insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$2 from pg_roles where rolname=$1", [workerRole, ownerA]);
    await setup.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1)", [JSON.stringify(policy)]);
    await left.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerA]); await right.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerB]);
    projectA = (await left.query("select id from public.create_project('complete_brand','Fixture',$1::jsonb,$2)", [JSON.stringify({ description: "Synthetic API allowance fixture" }), "a".repeat(64)])).rows[0].id;
    projectB = (await right.query("select id from public.create_project('complete_brand','Fixture',$1::jsonb,$2)", [JSON.stringify({ description: "Synthetic API allowance fixture" }), "b".repeat(64)])).rows[0].id;
  }, 30_000);
  afterEach(async () => { for (const client of [setup, left, right, worker, parallelWorker, otherWorker]) await client?.query("rollback"); }, 15_000);
  afterAll(async () => {
    for (const client of [setup, left, right, worker, parallelWorker, otherWorker]) await client?.end();
    if (admin) { await admin.query(`drop database if exists ${database} with(force)`); await admin.query(`drop role if exists ${workerRole},${otherRole}`); await admin.end(); }
  }, 30_000);
  async function enable(attempts = 1, globalAttempts = 20, ownerCost = 122880, globalCost = 2457600) {
    await setup.query(`insert into fluid_private.api_text_allowance_cohorts(id,enabled,role_name,role_oid,deployment_id,operations,signup_after,signup_before,expires_at,
      owner_attempt_limit,owner_cost_limit,owner_active_limit,account_limit,attempt_limit,cost_limit)
      select 'fixture',true,rolname,oid,$2,array['strategy.reformulate'],clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day',$3,$4,1,10,20,2457600
      from pg_roles where rolname=$1`, [workerRole, deploymentId, attempts, ownerCost]);
    await setup.query("update fluid_private.api_text_allowance_rollout set enabled=true,signup_cohort='fixture',account_limit=10,attempt_limit=$1,cost_limit=$2", [globalAttempts, globalCost]);
  }
  const admit = async (client = right, project = projectB, key = "postgres-multi-account-request") =>
    (await client.query<{ value: Admission }>("select public.enqueue_strategy_job($1,1,'strategy.reformulate',$2,122880) value", [project, key])).rows[0]!.value;
  const action = async <T = unknown>(message: ApiTextDispatchMessage, name: string, args: unknown[] = [], client = worker): Promise<T> =>
    (await client.query("select public.api_text_dispatch_action($1::jsonb,$2,$3::jsonb) value", [JSON.stringify(message), name, JSON.stringify(args)])).rows[0].value;
  const db = (client = worker) => ({ query: (sql: string, values?: unknown[]) => client.query(sql, values) });
  async function blocked(pending: Promise<unknown>) {
    expect(await Promise.race([pending.then(() => "resolved", () => "rejected"), new Promise<string>(resolve => setTimeout(() => resolve("blocked"), 100))])).toBe("blocked");
  }
  async function contextEmpty() { expect((await setup.query("select count(*)::int n from fluid_private.api_text_gateway_context")).rows[0].n).toBe(0); }

  it("removes hostile default grants and keeps the rollout unfunded and disabled", async () => {
    expect(hostileDefaultsDenied).toBe(true);
    await expect(admit()).rejects.toMatchObject({ code: "P0001", message: "runtime_unavailable" });
    expect((await setup.query("select enabled,account_limit,attempt_limit,cost_limit,accounts_used from fluid_private.api_text_allowance_rollout")).rows)
      .toEqual([{ enabled: false, account_limit: 0, attempt_limit: "0", cost_limit: "0", accounts_used: 0 }]);
    expect((await setup.query("select count(*)::int n from fluid_private.api_text_owner_entitlements")).rows[0].n).toBe(0);
  });
  it("preserves the old owner's admission and complete direct-worker flow with rollout and adapter disabled", async () => {
    await setup.query("update public.usage_accounts set limit_microusd=5000000 where owner_id=$1", [ownerA]);
    await setup.query("insert into fluid_private.strategy_billing_routes values($1,'openai_api',1)", [ownerA]);
    await setup.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,'strategy.reformulate',role_oid,encode(sha256(convert_to($2::jsonb::text,'UTF8')),'hex'),$3,true from fluid_private.api_text_worker_principals where owner_id=$1", [ownerA, JSON.stringify(policy), deploymentId]);
    const admitted = await admit(left, projectA); const transport = transportFixture();
    expect(await runApiTextDelivery({ message: admitted.dispatch, database: db(), configuration, deploymentId, transport }))
      .toEqual({ disposition: "ack", state: "succeeded" });
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
    expect((await setup.query("select count(*)::int n from fluid_private.api_text_allowance_admissions")).rows[0].n).toBe(0);
    await contextEmpty();
  });
  it("reads eligibility without granting credit and rolls back every admission write on a refused cap", async () => {
    await enable();
    expect((await right.query("select public.get_strategy_availability($1) value", [projectB])).rows[0].value.status).toBe("available");
    expect((await setup.query("select limit_microusd from public.usage_accounts where owner_id=$1", [ownerB])).rows[0].limit_microusd).toBe("0");
    await expect(right.query("select public.enqueue_strategy_job($1,1,'strategy.reformulate','postgres-refused-cost-cap',1)", [projectB])).rejects.toMatchObject({ code: "22023", message: "accepted_cap_exceeded" });
    expect((await setup.query("select accounts_used,attempts_used,cost_committed from fluid_private.api_text_allowance_rollout")).rows)
      .toEqual([{ accounts_used: 0, attempts_used: "0", cost_committed: "0" }]);
    expect((await setup.query("select count(*)::int n from fluid_private.api_text_owner_entitlements")).rows[0].n).toBe(0);
    expect((await setup.query("select limit_microusd from public.usage_accounts where owner_id=$1", [ownerB])).rows[0].limit_microusd).toBe("0");
  });
  it("serializes different accounts at the global attempt ceiling with no partial funding", async () => {
    await enable(1, 1); await left.query("begin"); await admit(left, projectA);
    const second = admit(); const checked = second.catch(error => error); await blocked(second); await left.query("commit");
    expect(await checked).toMatchObject({ code: "P0001" });
    expect((await setup.query("select accounts_used,attempts_used,cost_committed from fluid_private.api_text_allowance_rollout")).rows)
      .toEqual([{ accounts_used: 1, attempts_used: "1", cost_committed: "122880" }]);
    expect((await setup.query("select limit_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [ownerB])).rows[0]).toEqual({ limit_microusd: "0", reserved_microusd: "0" });
  });
  it("returns concurrent exact replay even after the first request consumes the final allowance", async () => {
    await enable(1, 1); await left.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerB]);
    await left.query("begin"); const first = await admit(left, projectB);
    const second = admit(); await blocked(second); await left.query("commit");
    expect(await second).toEqual(first);
    expect((await setup.query("select count(*)::int n from fluid_private.api_text_allowance_admissions")).rows[0].n).toBe(1);
  });
  it.each(["owner_attempt", "owner_lifetime", "cohort_accounts", "cohort_attempts", "cohort_cost", "global_accounts", "global_cost"])("retains %s exhaustion after cancellation", async limit => {
    await enable(limit === "owner_attempt" ? 1 : 2, 20, limit === "owner_lifetime" ? 122880 : 245760);
    if (limit === "cohort_accounts") await setup.query("update fluid_private.api_text_allowance_cohorts set account_limit=1");
    if (limit === "cohort_attempts") await setup.query("update fluid_private.api_text_allowance_cohorts set attempt_limit=1");
    if (limit === "cohort_cost") await setup.query("update fluid_private.api_text_allowance_cohorts set cost_limit=122880");
    if (limit === "global_accounts") await setup.query("update fluid_private.api_text_allowance_rollout set account_limit=1");
    if (limit === "global_cost") await setup.query("update fluid_private.api_text_allowance_rollout set cost_limit=122880");
    const first = await admit(); await right.query("select public.request_job_cancel($1)", [first.id]);
    await expect(limit.startsWith("owner_") ? admit(right, projectB, "postgres-second-owned-request") : admit(left, projectA)).rejects.toMatchObject({ code: "P0001" });
    expect((await setup.query("select cost_committed from fluid_private.api_text_allowance_rollout")).rows[0].cost_committed).toBe("122880");
    expect((await admit()).id).toBe(first.id);
  });
  it("does not lend a blocked gateway's owner context to another backend or to a later direct call", async () => {
    await enable(); const admitted = await admit();
    await setup.query("begin"); await setup.query("select fluid_private.lock_strategy_owner($1)", [ownerB]);
    const pending = action(admitted.dispatch, "claim", ["fixture-worker", 60]); await blocked(pending);
    expect((await parallelWorker.query("select public.api_text_worker_owner() owner")).rows[0].owner).toBe(ownerA);
    expect((await parallelWorker.query("select public.get_api_text_dispatch($1) value", [admitted.id])).rows[0].value).toBeNull();
    await setup.query("commit"); expect(await pending).toMatchObject({ disposition: "claimed" });
    expect((await worker.query("select public.api_text_worker_owner() owner")).rows[0].owner).toBe(ownerA);
    await contextEmpty();
  });
  it("rejects nested calls and rolls back the context and job change on an inner failure", async () => {
    await enable(); const admitted = await admit(); const literal = JSON.stringify(admitted.dispatch).replace(/'/g, "''");
    await setup.query(`create function fluid_private.fixture_nested_dispatch() returns trigger language plpgsql as $$ begin perform public.api_text_dispatch_action('${literal}'::jsonb,'descriptor'); return new; end $$;
      create trigger fixture_nested_dispatch before update on public.jobs for each row execute function fluid_private.fixture_nested_dispatch()`);
    try { await expect(action(admitted.dispatch, "claim", ["fixture-worker", 60])).rejects.toMatchObject({ code: "42501", message: "nested_dispatch_action" }); }
    finally { await setup.query("drop trigger fixture_nested_dispatch on public.jobs; drop function fluid_private.fixture_nested_dispatch()"); }
    await contextEmpty(); expect(await action(admitted.dispatch, "descriptor")).toMatchObject({ state: "queued" });
  });
  it("refuses descriptor spoofing, foreign principals, foreign leases and raw table reads", async () => {
    await enable(); const admitted = await admit();
    for (const change of [{ jobId: crypto.randomUUID() }, { policyIdentity: "c".repeat(64) }, { dispatchIdentity: "d".repeat(64) }, { deploymentId: "dpl_other" }, { ownerId: ownerA }, { version: 2 }])
      await expect(action({ ...admitted.dispatch, ...change } as ApiTextDispatchMessage, "descriptor")).rejects.toThrow();
    await expect(action(admitted.dispatch, "descriptor", [], otherWorker)).rejects.toMatchObject({ code: "42501" });
    await expect(action(admitted.dispatch, "heartbeat", [crypto.randomUUID(), 60])).rejects.toMatchObject({ message: "lease_lost" });
    await worker.query("select set_config('fluid.owner_id',$1,false),set_config('request.jwt.claim.sub',$1,false)", [ownerB]);
    expect((await worker.query("select public.get_api_text_dispatch($1) value", [admitted.id])).rows[0].value).toBeNull();
    for (const table of ["public.jobs", "public.job_steps", "fluid_private.api_text_gateway_context", "fluid_private.api_text_owner_entitlements", "fluid_private.api_text_allowance_admissions"])
      await expect(worker.query(`select * from ${table}`)).rejects.toMatchObject({ code: "42501" });
    expect((await worker.query("select job_id from public.job_steps where owner_id=$1", [ownerB])).rows).toEqual([]);
    await contextEmpty();
  });
  it("publishes, repairs and completes an owned response through the gateway with one synthetic provider call", async () => {
    await enable(); const admitted = await admit(); const transport = transportFixture(); const send = vi.fn(async () => ({ messageId: "synthetic-message" }));
    const options = { database: db(), deploymentId, send, signal: new AbortController().signal, multiAccount: true };
    expect(await publishAdmittedDispatch(admitted.dispatch, options)).toEqual({ state: "published", messageId: "synthetic-message" });
    expect(await repairApiTextDispatches(options)).toMatchObject({ examined: 1, published: 0, pending: 1, errors: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const execute = () => runApiTextDelivery({ message: admitted.dispatch, database: db(), configuration, deploymentId, transport, multiAccount: true });
    expect(await execute()).toEqual({ disposition: "ack", state: "succeeded" });
    expect(await execute()).toEqual({ disposition: "ack", state: "succeeded" });
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
    expect((await setup.query("select spent_microusd,provider_actual_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [ownerB])).rows[0])
      .toEqual({ spent_microusd: "691", provider_actual_microusd: "691", reserved_microusd: "0" });
    expect((await setup.query("select cost_committed from fluid_private.api_text_owner_entitlements where owner_id=$1", [ownerB])).rows[0].cost_committed).toBe("122880");
    await contextEmpty();
  });
  it("retains unknown usage and pauses further allowance dispatch without replaying inference", async () => {
    await enable(); const admitted = await admit(); const transport = transportFixture();
    vi.mocked(transport.createResponse).mockRejectedValue(new Error("Synthetic lost provider response"));
    const execute = () => runApiTextDelivery({ message: admitted.dispatch, database: db(), configuration, deploymentId, transport, multiAccount: true });
    expect(await execute()).toEqual({ disposition: "ack", state: "needs_reconciliation" }); expect(await execute()).toEqual({ disposition: "ack", state: "needs_reconciliation" });
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
    await expect(admit(left, projectA)).rejects.toMatchObject({ code: "P0001" });
    expect((await setup.query("select reserved_microusd from public.usage_accounts where owner_id=$1", [ownerB])).rows[0].reserved_microusd).toBe("122880");
    await contextEmpty();
  });
  it("allows historical settlement after revocation but forbids another paid dispatch", async () => {
    await enable(); const admitted = await admit();
    const claimed = await action<{ job: { lease_token: string } }>(admitted.dispatch, "claim", ["fixture-worker", 60]); const lease = claimed.job.lease_token;
    await action(admitted.dispatch, "plan", [lease, [{ key: "respond", maximumCostMicrousd: 122880 }]]);
    await action(admitted.dispatch, "begin", [lease, "respond", "synthetic-request-key", 122880]);
    expect(await action(admitted.dispatch, "authorize", [lease, "respond"])).toBe(true);
    await setup.query("update fluid_private.api_text_owner_entitlements set enabled=false");
    expect(await action(admitted.dispatch, "authorize", [lease, "respond"])).toBe(false);
    await action(admitted.dispatch, "complete", [lease, "respond", "succeeded", 1000, {}, "synthetic-response"]);
    await action(admitted.dispatch, "finish", [lease, "succeeded", null]);
    expect(await action(admitted.dispatch, "descriptor")).toMatchObject({ state: "succeeded" }); await contextEmpty();
  });
});
