import { readdir, readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { brief, intent, owner, policy } from "../fixtures/standalone-names";

// Explicit opt-in only; this suite creates and drops a uniquely named disposable
// database on a loopback PostgreSQL fixture. It never accepts a hosted URL.
const url = process.env.FLUID_STANDALONE_NAMES_POSTGRES_TEST_URL;
describe.skipIf(!url)("standalone/project quota concurrency on disposable PostgreSQL", () => {
  let admin: Client, setup: Client, left: Client, right: Client, identity: string, projectId: string;
  const database = `fluid_standalone_${process.pid}_${Date.now()}`;
  const limited = { ...policy, limits: { ...policy.limits, maxRequestsPerHour: 1, maxQueuedJobs: 1 } };
  beforeAll(async () => {
    const target = new URL(url!);
    if (!["127.0.0.1", "localhost"].includes(target.hostname) || !["postgres:", "postgresql:"].includes(target.protocol)) throw new Error("A disposable loopback PostgreSQL fixture is required");
    admin = new Client({ connectionString: target.href, connectionTimeoutMillis: 5000 }); await admin.connect();
    await admin.query(`create database ${database}`); target.pathname = `/${database}`;
    setup = new Client({ connectionString: target.href, connectionTimeoutMillis: 5000 }); await setup.connect();
    await setup.query(`
      begin;
      do $$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin;end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin;end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls;end if;
      end $$;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text,unique(bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated,service_role; grant select,insert,update,delete on storage.objects to authenticated,service_role;
      commit;
    `);
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql") && (name <= "20261004160000_project_naming.sql" || name.endsWith("_naming_initial_250.sql"))).sort()) await setup.query(await readFile(new URL(name, directory), "utf8"));
    await setup.query(await readFile(new URL("../../supabase/candidates/standalone_ai_names.sql", import.meta.url), "utf8"));
    left = new Client({ connectionString: target.href, connectionTimeoutMillis: 5000 }); right = new Client({ connectionString: target.href, connectionTimeoutMillis: 5000 }); await left.connect(); await right.connect();
    for (const client of [left, right]) {
      await client.query("set role authenticated"); await client.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]); await client.query("set statement_timeout='15s'");
    }
  }, 30000);
  beforeEach(async () => {
    await setup.query("truncate auth.users cascade"); await setup.query("insert into auth.users values($1)", [owner]);
    await setup.query("insert into fluid_private.subscription_registrations(registration_id,owner_id) values($1,$2)", [policy.registrationId, owner]);
    await setup.query("insert into fluid_private.subscription_runtime_policy(owner_id,operation,registration_id,enabled,policy,worker_ready_until) values($1,'naming.generate',$2,true,$3::jsonb,clock_timestamp()+interval '1 hour')", [owner, policy.registrationId, JSON.stringify(limited)]);
    await setup.query("insert into fluid_private.standalone_names_runtime(owner_id,enabled,ready_policy,worker_ready_until) values($1,true,$2::jsonb,clock_timestamp()+interval '1 hour')", [owner, JSON.stringify(limited)]);
    identity = (await setup.query("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') value", [JSON.stringify(limited)])).rows[0].value;
    projectId = (await left.query("select * from public.create_project('naming_only','Fixture',$1::jsonb,$2)", [{ description: brief.description }, "a".repeat(64)])).rows[0].id;
    await left.query("select public.save_naming_preferences($1,0,$2::jsonb)", [projectId, JSON.stringify({ version: 1, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null })]);
  });
  afterAll(async () => {
    await left?.query("rollback"); await right?.query("rollback"); await left?.end(); await right?.end(); await setup?.end();
    // The disposable engine can host another agent's independent fixture DB.
    // Keep shared synthetic roles until its owner removes the whole container.
    if (admin) { await admin.query(`drop database if exists ${database} with(force)`); await admin.end(); }
  });
  const standalone = (client: Client) => client.query("select public.enqueue_standalone_names($1::jsonb) value", [JSON.stringify({ ...intent, acceptedPolicyIdentity: identity })]);
  const project = (client: Client) => client.query("select public.enqueue_subscription_naming_job($1,1,1,0,'fixture-concurrent-project',$2) value", [projectId, identity]);
  async function blocked(pending: Promise<unknown>) {
    const state = await Promise.race([pending.then(() => "resolved", () => "rejected"), new Promise<string>(resolve => setTimeout(() => resolve("blocked"), 100))]);
    expect(state).toBe("blocked");
  }
  it("serializes a project request behind standalone admission and enforces the combined cap", async () => {
    await left.query("begin"); await standalone(left); const second = project(right); const checked = second.catch(error => error);
    await blocked(second); await left.query("commit"); expect(await checked).toMatchObject({ code: "P0001" });
    expect((await setup.query("select (select count(*) from public.jobs)+(select count(*) from public.standalone_name_jobs) n")).rows[0].n).toBe("1");
  });
  it("serializes standalone admission behind a project request and enforces the same cap", async () => {
    await left.query("begin"); await project(left); const second = standalone(right); const checked = second.catch(error => error);
    await blocked(second); await left.query("commit"); expect(await checked).toMatchObject({ code: "P0001" });
    expect((await setup.query("select count(*) n from public.standalone_name_jobs")).rows[0].n).toBe("0");
  });
  it("returns the original intent after concurrent replay and cancellation without another admission", async () => {
    await left.query("begin"); const first = await standalone(left); const replay = standalone(right);
    await blocked(replay); await left.query("commit"); const repeated = await replay;
    expect(repeated.rows[0].value.job.id).toBe(first.rows[0].value.job.id);
    await left.query("select public.cancel_standalone_names($1)", [first.rows[0].value.job.id]);
    expect((await standalone(right)).rows[0].value.job.state).toBe("cancelled");
    expect((await setup.query("select count(*) n from public.standalone_name_jobs")).rows[0].n).toBe("1");
  });
  it("leaves project admission unchanged when standalone is disabled and unused", async () => {
    await setup.query("update fluid_private.standalone_names_runtime set enabled=false");
    const result = await project(left); expect(result.rows[0].value.job.state).toBe("queued");
    expect((await setup.query("select count(*) n from public.standalone_name_jobs")).rows[0].n).toBe("0");
  });
  it("rejects an accepted old policy when a concurrent model change wins the row lock", async () => {
    const replacement = { ...limited, model: "fixture-replacement-model" };
    await setup.query("begin");
    await setup.query("update fluid_private.subscription_runtime_policy set policy=$1::jsonb", [JSON.stringify(replacement)]);
    await setup.query("update fluid_private.standalone_names_runtime set ready_policy=$1::jsonb", [JSON.stringify(replacement)]);
    const pending = standalone(right); const checked = pending.catch(error => error);
    await blocked(pending); await setup.query("commit");
    expect(await checked).toMatchObject({ code: "PT409" });
    expect((await setup.query("select count(*) n from public.standalone_name_jobs")).rows[0].n).toBe("0");
  });
});
