import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, type TestDatabase } from "./local-supabase";
import { brainAction, brainRpc, brainWorker, claimBrain, initialIntent, installBrainFixture, seedBrainFixture } from "./naming-brain-fixture";
const candidate = await readFile(new URL("../../supabase/candidates/logo-vector-proposals.sql", import.meta.url), "utf8");
const signatures = ["fluid_private.lock_leased_job(uuid,uuid)", "fluid_private.naming_brain_legacy_lock(uuid,uuid)", "public.claim_job(text,integer)", "public.expire_job_leases()"];

describe("exact Naming/vector candidate lifecycle composition", () => {
  let db: TestDatabase, project: string, metadata: unknown, wrapper: string;
  const catalog = () => db.query("select p.oid::regprocedure::text signature,proowner,proacl from pg_proc p where p.oid=any($1::regprocedure[]) order by p.oid", [signatures]).then(result => result.rows);
  beforeAll(async () => {
    db = await createTestDatabase(); metadata = await catalog(); wrapper = (await db.query<{ prosrc: string }>("select prosrc from pg_proc where oid='fluid_private.lock_leased_job(uuid,uuid)'::regprocedure")).rows[0]!.prosrc;
    await db.exec(candidate); await installBrainFixture(db);
    await db.exec("create role fixture_composition_logo login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant usage on schema public to fixture_composition_logo; grant execute on function public.claim_logo_job(text,integer),public.heartbeat_logo_job(uuid,uuid,integer) to fixture_composition_logo;");
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { project = await seedBrainFixture(db); });
  it("preserves the exact Naming wrapper and function owner/ACL metadata while adding vector exclusion beneath it", async () => {
    expect(await catalog()).toEqual(metadata);
    expect((await db.query<{ prosrc: string }>("select prosrc from pg_proc where oid='fluid_private.lock_leased_job(uuid,uuid)'::regprocedure")).rows[0]!.prosrc).toBe(wrapper);
    const delegated = (await db.query<{ prosrc: string }>("select prosrc from pg_proc where oid='fluid_private.naming_brain_legacy_lock(uuid,uuid)'::regprocedure")).rows[0]!.prosrc;
    expect(delegated).toContain("identity.logo_vector_propose");
    for (const role of ["authenticated", "anon", "service_role", "fixture_subscription_worker_a"]) expect((await db.query("select has_function_privilege($1,'fluid_private.naming_brain_legacy_lock(uuid,uuid)','EXECUTE') granted", [role])).rows[0]).toEqual({ granted: false });
  });
  it("generic claim and expiry cannot acquire either Naming or vector work, and scoped Naming remains fenced", async () => {
    const admitted = await brainRpc<{ run: { jobId: string } }>(db, "ensure_naming_brain_run", [project, initialIntent()]);
    const vector = (await db.query<{ id: string }>("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd) values($1,$2,'identity.logo_vector_propose',1,$3,'{}','composition-vector-job',0) returning id", [OWNER_A, project, "a".repeat(64)])).rows[0]!;
    expect((await asRole(db, "service_role", null, () => db.query("select id from public.claim_job('generic',60)"))).rows).toEqual([]);
    await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_composition_logo'", [OWNER_A]);
    await db.exec("set session authorization fixture_composition_logo");
    try { expect((await db.query("select id from public.claim_logo_job('logo',60)")).rows).toEqual([]); } finally { await db.exec("set session authorization postgres"); }
    const { job } = await claimBrain(db); expect(job.id).toBe(admitted.run.jobId);
    expect(await brainAction(db, job, "heartbeat", { leaseSeconds: 60 })).toMatchObject({ recoveryMode: "execute" });
    await db.query("update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '60 seconds',worker_id='synthetic-vector' where id=$1", [vector.id]);
    const vectorLease = (await db.query<{ lease_token: string }>("select lease_token from public.jobs where id=$1", [vector.id])).rows[0]!.lease_token;
    await expect(brainAction(db, { id: vector.id, lease_token: vectorLease }, "heartbeat", { leaseSeconds: 60 })).rejects.toMatchObject({ code: "42501" });
    await expect(brainWorker(db, () => db.query("select public.heartbeat_job($1,$2,60)", [job.id, job.lease_token]))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "service_role", null, () => db.query("select public.heartbeat_job($1,$2,60)", [job.id, job.lease_token]))).rejects.toMatchObject({ code: "42501" });
    await db.exec("set session authorization fixture_composition_logo");
    try { await expect(db.query("select public.heartbeat_logo_job($1,$2,60)", [job.id, job.lease_token])).rejects.toMatchObject({ code: "40001", message: "lease_lost" }); } finally { await db.exec("set session authorization postgres"); }
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=any($1::uuid[])", [[job.id, vector.id]]);
    await asRole(db, "service_role", null, () => db.query("select public.expire_job_leases()"));
    expect((await db.query<{ state: string }>("select state from public.jobs where id=any($1::uuid[])", [[job.id, vector.id]])).rows).toEqual([{ state: "running" }, { state: "running" }]);
  });
});

it.each(["wrapper", "delegated", "claim", "expiry"] as const)("rejects an unknown %s predecessor instead of accepting a widened hash guard", async target => {
  const db = await createTestDatabase();
  try {
    const signature = signatures[{ wrapper: 0, delegated: 1, claim: 2, expiry: 3 }[target]]!;
    // A harmless body comment is enough to establish an unreviewed predecessor.
    const definition = (await db.query<{ definition: string; body: string }>("select pg_get_functiondef(oid) definition,prosrc body from pg_proc where oid=$1::regprocedure", [signature])).rows[0]!;
    await db.exec(definition.definition.replace(definition.body, `${definition.body}\n-- unreviewed synthetic predecessor`));
    await expect(db.exec(candidate)).rejects.toMatchObject({ code: "55000" });
  } finally { await db.close(); }
}, 30_000);

it("retains the exact historical restricted-runtime composition before Naming is installed", async () => {
  const db = await createTestDatabase({ before: "20261016180000_naming_brain.sql", additionalMigrations: [candidate] });
  try {
    expect((await db.query("select to_regprocedure('fluid_private.naming_brain_legacy_lock(uuid,uuid)') helper")).rows[0]).toEqual({ helper: null });
    expect((await db.query<{ prosrc: string }>("select prosrc from pg_proc where oid='fluid_private.lock_leased_job(uuid,uuid)'::regprocedure")).rows[0]!.prosrc).toContain("identity.logo_vector_propose");
  } finally { await db.close(); }
}, 30_000);
