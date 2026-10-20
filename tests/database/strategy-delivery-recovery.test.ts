import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, HASH, installApiTextWorkerFixture, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { admit, enableSyntheticCohort, multiAccountSnapshot, resetMultiAccountFixture } from "./api-text-multi-account-fixture";

const migration = "20261020033500_strategy_delivery_recovery.sql";
type Delivery = { job: { id: string }; dispatchState: string; canRetryDelivery: boolean; dispatch: unknown };

describe("owner-scoped Strategy delivery recovery (disposable database only)", () => {
  let db: TestDatabase, project: string, otherProject: string, job: Awaited<ReturnType<typeof admit>>;
  let beforeCatalog: unknown, afterCatalog: unknown;
  const catalog = async () => (await db.query("select oid,proowner,proacl,prosrc,prosecdef,provolatile,proconfig from pg_proc where pronamespace in ('public'::regnamespace,'fluid_private'::regnamespace) and proname<>'get_strategy_job_deliveries' order by oid")).rows;
  const read = (owner = OWNER_B, target = project, ids = [job.id]) => asRole(db, "authenticated", owner,
    async () => (await db.query<{ value: Delivery }>("select public.get_strategy_job_deliveries($1,$2::uuid[]) value", [target, ids])).rows.map(row => row.value));
  beforeAll(async () => {
    db = await createTestDatabase({ before: migration });
    await installApiTextWorkerFixture(db);
    await db.exec("alter table auth.users add column created_at timestamptz default clock_timestamp(),add column email_confirmed_at timestamptz");
    beforeCatalog = await catalog();
    await db.exec("create role fixture_delivery_hostile nologin; alter default privileges in schema public grant execute on functions to fixture_delivery_hostile");
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
    afterCatalog = await catalog();
  }, 90_000);
  beforeEach(async () => {
    const projects = await resetMultiAccountFixture(db); project = projects.b; otherProject = projects.a;
    await enableSyntheticCohort(db);
    // Accepted maximum deliberately differs from the reservation; recovery must
    // not reconstruct either the original request key or its accepted amount.
    job = await admit(db, OWNER_B, project, "synthetic-delivery-original-key", 200_000);
  });
  afterAll(async () => { await db?.close(); });

  it("adds only one scoped EXECUTE capability and preserves existing function definitions/security", async () => {
    expect(afterCatalog).toEqual(beforeCatalog);
    const row = (await db.query<{ prosecdef: boolean; provolatile: string; proconfig: string[]; grantees: string[] }>(`
      select p.prosecdef,p.provolatile,p.proconfig,array_agg(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end order by a.grantee) grantees
      from pg_proc p,lateral aclexplode(p.proacl) a
      where p.oid='public.get_strategy_job_deliveries(uuid,uuid[])'::regprocedure and a.grantee<>p.proowner
      group by p.oid`)).rows[0]!;
    expect(row).toEqual({ prosecdef: true, provolatile: "s", proconfig: ['search_path=""'], grantees: ["authenticated"] });
    expect((await db.query("select has_column_privilege('authenticated','public.jobs','input','select') input,has_column_privilege('authenticated','public.jobs','idempotency_key','select') request_key")).rows)
      .toEqual([{ input: false, request_key: false }]);
    for (const role of ["anon", "service_role"] as const) await expect(asRole(db, role, OWNER_B, () => db.query("select public.get_strategy_job_deliveries($1,$2)", [project, [job.id]]))).rejects.toThrow(/permission denied/);
  });

  it("returns the exact admitted descriptor without touching any durable or allowance state", async () => {
    const before = await multiAccountSnapshot(db);
    const result = await read();
    expect(result).toEqual([{ job: expect.objectContaining({ id: job.id, state: "queued" }), dispatchState: "dispatch_pending", canRetryDelivery: true, dispatch: job.dispatch }]);
    expect(await read()).toEqual(result);
    expect(await multiAccountSnapshot(db)).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/acceptedMaxCost|idempotency_key|lease_token|publication_generation|published_message_id|context|policy":/);
  });

  it("rejects foreign projects and never returns a foreign job under an owned project", async () => {
    await expect(read(OWNER_A)).rejects.toThrow("not_found");
    expect(await read(OWNER_A, otherProject)).toEqual([]);
    expect(await read(OWNER_B, project, ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"])).toEqual([]);
    await expect(read(OWNER_B, project, [])).rejects.toThrow("invalid_input");
    await expect(read(OWNER_B, project, Array(65).fill(job.id))).rejects.toThrow("invalid_input");
    for (const ids of [null, [null], [[job.id], [job.id]]]) {
      await expect(asRole(db, "authenticated", OWNER_B, () => db.query("select public.get_strategy_job_deliveries($1,$2::uuid[])", [project, ids]))).rejects.toThrow("invalid_input");
    }
    await expect(asRole(db, "authenticated", null, () => db.query("select public.get_strategy_job_deliveries($1,$2)", [project, [job.id]]))).rejects.toThrow("unauthenticated");
  });

  it("distinguishes a confirmed publication from an unconfirmed initial handoff", async () => {
    await db.query("update fluid_private.api_text_dispatches set published_at=clock_timestamp(),published_message_id='synthetic-queue-message' where job_id=$1", [job.id]);
    expect(await read()).toEqual([{ job: expect.objectContaining({ id: job.id }), dispatchState: "published", canRetryDelivery: false, dispatch: null }]);
  });

  it.each(["succeeded", "failed", "partial", "cancelled", "needs_reconciliation"])("never exposes delivery for a %s job", async state => {
    await db.query("update public.jobs set state=$2 where id=$1", [job.id, state]);
    expect(await read()).toEqual([]);
  });

  it("never exposes delivery after a claim or cancellation", async () => {
    await db.query("update public.jobs set state='running',attempts=1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '1 minute' where id=$1", [job.id]);
    expect(await read()).toEqual([]);
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_job_cancel($1)", [job.id]));
    expect(await read()).toEqual([]);
  });

  it("retains the database invariant forbidding an expiry without its lease token", async () => {
    await expect(db.query("update public.jobs set lease_expires_at=clock_timestamp()+interval '1 minute' where id=$1", [job.id])).rejects.toThrow(/check constraint/);
    expect((await read())[0]?.canRetryDelivery).toBe(true);
  });

  it("never returns a descriptor when any retained step exists", async () => {
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values($1,$2,$3,'synthetic','synthetic-retained-step','ambiguous',1)", [job.id, OWNER_B, project]);
    expect((await read())[0]).toMatchObject({ canRetryDelivery: false, dispatch: null });
  });

  it.each([
    ["a previous attempt", "update public.jobs set attempts=1 where id=$1"],
    ["a cancellation", "update public.jobs set cancel_requested_at=clock_timestamp() where id=$1"],
    ["a registered plan", "update public.jobs set plan_manifest='[]',plan_fingerprint=repeat('a',64),plan_registered_at=clock_timestamp() where id=$1"],
    ["a redrive generation", "update fluid_private.api_text_dispatches set publication_generation=1,generation_started_at=clock_timestamp() where job_id=$1"],
  ])("withholds the descriptor for %s", async (_name, sql) => {
    await db.query(sql, [job.id]);
    expect(await read()).toEqual([{ job: expect.objectContaining({ id: job.id }), dispatchState: "dispatch_pending", canRetryDelivery: false, dispatch: null }]);
  });

  it("withholds delivery for stale and deleted project snapshots", async () => {
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.append_project_revision($1,1,$2,$3)", [project, { description: "Synthetic newer saved version" }, HASH]));
    expect((await read())[0]).toMatchObject({ canRetryDelivery: false, dispatch: null });
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_project_deletion($1,2,0)", [project]));
    expect(await read()).toEqual([]);
  });
});
