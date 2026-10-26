import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { attestBrainPreferences, brainAction, brainPreferences, brainRpc, brainWorker, claimBrain, initialIntent, prepareBrainFixture, saveBrainArtifact, startBrainFixture } from "./naming-brain-fixture";
import { seedProgressiveFixture } from "./naming-brain-progressive-fixture";
import { seedHostedNamingFixture } from "./hosted-naming-fixture";
import { authorityMigration, authoritySnapshot, continuePayload, expireAuthority, installAuthorityFixture, maintenance, seedAuthorityFixture, workerStatus, type AuthorityJob } from "./naming-worker-authority-fixture";

const sql = await readFile(new URL(`../../supabase/migrations/${authorityMigration}`, import.meta.url), "utf8");
describe("fenced Naming maintenance over real migrated SQL (PGlite)", () => {
  let db: TestDatabase, project: string;
  beforeAll(async () => { db = await createTestDatabase(); await installAuthorityFixture(db); }, 60_000);
  beforeEach(async () => { project = await seedAuthorityFixture(db); });
  afterAll(async () => { await db?.close(); });
  const enroll = async () => (await workerStatus(db)).generation!;
  const createClaim = async () => {
    await brainRpc(db, "ensure_naming_brain_run", [project, initialIntent()]);
    const generation = await enroll(), claim = await maintenance<{ job: AuthorityJob }>(db, generation, "claim");
    return { generation, job: claim.job };
  };

  it("does not let a healthy second publisher displace, renew or mutate the first", async () => {
    const first = await workerStatus(db), before = await authoritySnapshot(db);
    expect(first).toMatchObject({ version: 1, leader: true, ready: true, reason: "leader", generation: 1 });
    const replay = await workerStatus(db); expect(replay.expiresAt).toBe(first.expiresAt);
    expect(await workerStatus(db, null, "other-worker")).toMatchObject({ leader: false, generation: null, expiresAt: null, ready: false, reason: "held" });
    expect(await workerStatus(db, first.generation, "other-worker")).toMatchObject({ leader: false, generation: null, expiresAt: null, reason: "fenced" });
    expect(await authoritySnapshot(db)).toEqual(before);
    const renewed = await workerStatus(db, first.generation); expect(renewed).toMatchObject({ leader: true, generation: 1, ready: true });
    expect(Date.parse(renewed.expiresAt!) - Date.parse(renewed.serverTime)).toBeLessThanOrEqual(60_000);
  });

  it("expires old renewal and increments generation even when the worker ID is reused", async () => {
    const first = await workerStatus(db); await expireAuthority(db);
    expect(await workerStatus(db, first.generation)).toMatchObject({ leader: false, generation: null, expiresAt: null, reason: "expired" });
    expect(await workerStatus(db)).toMatchObject({ leader: true, generation: 2 });
    expect(await workerStatus(db, first.generation)).toMatchObject({ leader: false, reason: "fenced" });
    await expect(maintenance(db, first.generation!, "claim")).rejects.toThrow("leadership_lost");
  });

  it("refuses unknown deployment and stale generation without touching rows", async () => {
    const generation = await enroll(), before = await authoritySnapshot(db);
    expect(await workerStatus(db, null, "fixture-worker", undefined, "unknown-deployment")).toMatchObject({ leader: false, reason: "binding_mismatch", ready: false, generation: null, expiresAt: null });
    await expect(maintenance(db, generation + 1, "claim")).rejects.toThrow("leadership_lost");
    await expect(maintenance(db, generation, "claim", {}, "fixture-worker", "unknown-deployment")).rejects.toMatchObject({ code: "42501" });
    expect(await authoritySnapshot(db)).toEqual(before);
  });

  it("retains maintenance leadership with paid readiness false while policy is disabled", async () => {
    const generation = await enroll(); await db.exec("update fluid_private.naming_brain_pilots set enabled=false");
    expect(await workerStatus(db, generation)).toMatchObject({ leader: true, generation, ready: false });
    expect(await maintenance(db, generation, "claim")).toBeNull();
    expect(await maintenance(db, generation, "preference_work", { limit: 20 })).toEqual([]);
  });

  it("returns boolean false for disabled-policy lost-ack replay until exact fenced renewal", async () => {
    await db.exec("update fluid_private.naming_brain_pilots set enabled=false");
    const first = await workerStatus(db); expect(first).toMatchObject({ leader: true, ready: false });
    await db.exec("update fluid_private.naming_brain_pilots set enabled=true");
    const replay = await workerStatus(db); expect(replay).toMatchObject({ leader: true, ready: false, generation: first.generation, expiresAt: first.expiresAt });
    expect(await workerStatus(db, first.generation)).toMatchObject({ leader: true, ready: true });
  });

  it("keeps empty legacy and v2 probes free of tuple mutations and fences legacy writes after enrollment", async () => {
    const legacy = await authoritySnapshot(db);
    await brainWorker(db, async () => {
      expect((await db.query("select public.claim_naming_brain_job('fixture-worker','fixture-deployment',120) result")).rows).toEqual([{ result: null }]);
      expect((await db.query("select public.expire_naming_brain_leases('fixture-worker','fixture-deployment') result")).rows).toEqual([{ result: 0 }]);
    });
    expect(await authoritySnapshot(db)).toEqual(legacy);
    const generation = await enroll(), before = await authoritySnapshot(db);
    for (let i = 0; i < 4; i++) {
      expect(await maintenance(db, generation, "claim")).toBeNull();
      expect(await maintenance(db, generation, "expire_leases")).toBe(0);
      expect(await maintenance(db, generation, "preference_work", { limit: 20 })).toEqual([]);
    }
    expect(await authoritySnapshot(db)).toEqual(before);
    await expect(brainWorker(db, () => db.query("select public.claim_naming_brain_job('fixture-worker','fixture-deployment',120)"))).rejects.toThrow("worker_authority_required");
    expect(await brainWorker(db, async () => (await db.query<{ result: boolean }>("select public.report_naming_brain_worker_ready('{}','fixture-deployment','other-worker',60) result")).rows[0]!.result)).toBe(false);
    expect(await authoritySnapshot(db)).toEqual(before);
  });

  it("binds only a genuine claim and prevents heartbeat/resume from rebinding old job authority", async () => {
    const { generation, job } = await createClaim();
    expect(await maintenance(db, generation, "assert_continue", continuePayload(job))).toBe(true);
    const sidecar = (await db.query("select * from fluid_private.naming_worker_job_authority")).rows;
    await expireAuthority(db); const next = (await workerStatus(db)).generation!;
    expect(await maintenance(db, next, "assert_continue", continuePayload(job))).toBe(false);
    await brainAction(db, job, "heartbeat", { leaseSeconds: 120 });
    expect((await db.query("select * from fluid_private.naming_worker_job_authority")).rows).toEqual(sidecar);
    expect(await maintenance(db, next, "assert_continue", continuePayload(job))).toBe(false);
    await db.query("update public.jobs set state='queued',lease_token=null,lease_expires_at=null where id=$1", [job.id]);
    await db.query("update fluid_private.naming_brain_runs set recovery_mode='execute' where job_id=$1", [job.id]);
    const reclaimed = await maintenance<{ job: AuthorityJob }>(db, next, "claim");
    expect(reclaimed.job.id).toBe(job.id); expect(reclaimed.job.lease_token).not.toBe(job.lease_token);
    expect(await maintenance(db, next, "assert_continue", continuePayload(reclaimed.job))).toBe(true);
    expect((await db.query<{ generation: number }>("select generation from fluid_private.naming_worker_job_authority")).rows[0]!.generation).toBe(next);
  });

  it.each(["stop", "policy", "owner"])("rechecks %s in the paid continuation gate", async mode => {
    const { generation, job } = await createClaim();
    if (mode === "stop") await brainRpc(db, "stop_naming_feed", [project, { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: "authority-stop-fixture-0001" }]);
    if (mode === "policy") await db.exec("update fluid_private.naming_brain_pilots set enabled=false");
    if (mode === "owner") {
      await expect(brainWorker(db, () => db.query("select public.naming_brain_worker_maintenance_v2('fixture-worker','fixture-deployment',1,'assert_continue',$1)", [JSON.stringify(continuePayload(job))]), OWNER_B)).rejects.toMatchObject({ code: "42501" });
      return;
    }
    expect(await maintenance(db, generation, "assert_continue", continuePayload(job))).toBe(false);
  });

  it.each(["local", "hosted", "historical-capped"])("preserves the %s retained-overrun contract", async profile => {
    let job: AuthorityJob;
    if (profile === "local") { const f = await seedProgressiveFixture(db); job = { id: f.job.id, lease_token: f.job.leaseToken, input: { runId: f.input.runId } }; }
    else if (profile === "hosted") { const f = await seedHostedNamingFixture(db); job = { id: f.job.id, lease_token: f.job.leaseToken, input: { runId: f.input.runId } }; }
    else job = await startBrainFixture(db, project);
    // A real v2 claim is required after enrollment; simulate crash/unlease only.
    const generation = await enroll(); await db.query("update public.jobs set state='queued',lease_token=null,lease_expires_at=null where id=$1", [job.id]);
    const claimed = await maintenance<{ job: AuthorityJob }>(db, generation, "claim"); job = claimed.job;
    await db.query("update fluid_private.naming_brain_runs set observed_overrun=true where job_id=$1", [job.id]);
    expect(await maintenance(db, generation, "assert_continue", continuePayload(job))).toBe(profile !== "historical-capped");
    expect((await db.query("select observed_overrun from fluid_private.naming_brain_runs where job_id=$1", [job.id])).rows).toEqual([{ observed_overrun: true }]);
  });

  it("preserves no-dispatch recovery and its zero-cost settlement proof under v2", async () => {
    const f = await seedProgressiveFixture(db), generation = await enroll();
    await db.query("update public.jobs set state='needs_reconciliation',error_code='progressive_execution_unknown',lease_token=null,lease_expires_at=null where id=$1", [f.job.id]);
    await db.query("update public.job_steps set state='ambiguous',output='{\"artifactIds\":[],\"errorCode\":\"progressive_execution_unknown\"}' where job_id=$1 and step_key='creation'", [f.job.id]);
    expect(await maintenance(db, generation, "expire_leases")).toBe(1);
    expect((await db.query("select state,error_code from public.jobs where id=$1", [f.job.id])).rows).toEqual([{ state: "failed", error_code: "local_planning_failed" }]);
    expect((await db.query("select actual_cost_microusd,settlement_evidence->>'kind' kind from fluid_private.naming_brain_runs where job_id=$1", [f.job.id])).rows).toEqual([{ actual_cost_microusd: 0, kind: "database_no_dispatch" }]);
    expect(await maintenance(db, generation, "expire_leases")).toBe(0);
  });

  it("recovers saved deterministic preparation with paid readiness disabled and keeps exact history", async () => {
    const f = await prepareBrainFixture(db, project, 1), generation = await enroll();
    const original = (await db.query("select to_jsonb(t) value from fluid_private.naming_brain_prepared_sets t")).rows;
    await db.exec("update fluid_private.naming_brain_pilots set enabled=false,ready_until=null");
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [f.job.id]);
    expect(await maintenance(db, generation, "expire_leases")).toBe(1);
    const recovered = await maintenance<{ mode: string; job: AuthorityJob }>(db, generation, "claim");
    expect(recovered.mode).toBe("observe_only"); expect(recovered.job.id).toBe(f.job.id);
    expect(await maintenance(db, generation, "assert_continue", continuePayload(recovered.job))).toBe(false);
    expect(await brainAction(db, recovered.job, "stage", { stageKey: "prepare" })).toMatchObject({ preparation: { preparedSetId: f.preparedSetId } });
    await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')", [recovered.job.id, recovered.job.lease_token]));
    await brainAction(db, recovered.job, "finish", { state: "succeeded", errorCode: null });
    expect((await db.query("select to_jsonb(t) value from fluid_private.naming_brain_prepared_sets t")).rows).toEqual(original);
    expect(await brainRpc(db, "get_naming_brain_job_accounting", [f.job.id])).toMatchObject({ status: "held_unsettled", confirmedActualCostMicrousd: null });
  }, 30_000);

  it("still finalizes stopped terminal observations without needing paid readiness", async () => {
    const job = await startBrainFixture(db, project);
    await saveBrainArtifact(db, job, "research", { role: "researcher", territories: [], facts: [], interpretations: [], uncertainties: [] }, { readiness: "partial", sources: [] });
    await db.query("update public.jobs set state='needs_reconciliation',cancel_requested_at=clock_timestamp(),lease_token=null,lease_expires_at=null where id=$1", [job.id]);
    await db.exec("update fluid_private.naming_brain_runs set recovery_mode='observe_only'");
    await db.exec("update fluid_private.naming_brain_pilots set enabled=false,ready_until=null");
    const generation = await enroll(); expect(await maintenance(db, generation, "claim")).toBeNull();
    expect((await db.query("select state,lease_token from public.jobs where id=$1", [job.id])).rows).toEqual([{ state: "cancelled", lease_token: null }]);
    expect((await db.query("select count(*)::int count from fluid_private.naming_brain_receipts")).rows).toEqual([{ count: 1 }]);
  });

  it("does not mutate unknown unleased, future or exhausted reconciliation records", async () => {
    const f = await seedProgressiveFixture(db);
    // An ambiguous authorized create has no known provider identity. It must not
    // be treated as no-dispatch even after cancellation or observation limits.
    const { progressiveRequest } = await import("./naming-brain-progressive-fixture");
    const request = progressiveRequest(f, "context.research", { role: "researcher", snapshot: f.input.snapshot });
    await brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "context.research", [request]));
    await brainWorker(db, () => f.store.authorizeDispatch(f.job, request));
    await db.query("update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code='progressive_execution_unknown' where id=$1", [f.job.id]);
    const generation = await enroll();
    for (const condition of ["next_observation_at=clock_timestamp()+interval '1 hour'", "observation_attempts=12,next_observation_at=null", "observation_attempts=0,observation_deadline_at=clock_timestamp()-interval '1 hour'"]) {
      await db.exec(`update fluid_private.naming_brain_runs set ${condition}`);
      const before = await authoritySnapshot(db);
      expect(await maintenance(db, generation, "claim")).toBeNull(); expect(await maintenance(db, generation, "expire_leases")).toBe(0);
      expect(await authoritySnapshot(db)).toEqual(before);
    }
  });

  it("bounds expiry at twenty mutations while retaining subsequent recoverable work", async () => {
    const f = await seedProgressiveFixture(db);
    for (let index = 1; index < 25; index++) {
      const p = await brainRpc<{ id: string }>(db, "create_project", ["naming_only", `Recovery fixture ${index}`, { description: "Synthetic recovery only" }, "a".repeat(64)]);
      await brainRpc(db, "save_naming_preferences", [p.id, 0, brainPreferences]); await attestBrainPreferences(db);
      await brainRpc(db, "ensure_local_naming_brain_run", [p.id, initialIntent(`bounded-expiry-fixture-${index}`)]);
      expect((await claimBrain(db)).job.id).toBeTruthy();
    }
    const generation = await enroll(); await db.exec("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second'");
    expect(await maintenance(db, generation, "expire_leases")).toBe(20);
    expect((await db.query("select count(*)::int count from public.jobs where state in('running','cancel_requested')")).rows).toEqual([{ count: 5 }]);
    expect(await maintenance(db, generation, "expire_leases")).toBe(5);
    expect(await maintenance(db, generation, "expire_leases")).toBe(0);
    expect((await db.query<{ run: string }>("select input->>'runId' run from public.jobs where id=$1", [f.job.id])).rows[0]!.run).toBe(f.input.runId);
  }, 30_000);

  it("allows preference attestation bootstrap using the authority gateway", async () => {
    await brainRpc(db, "save_naming_preferences", [project, 1, { ...brainPreferences, notes: "New version for bootstrap attestation" }]);
    const generation = await enroll(), rows = await maintenance<{ projectId: string; preferencesVersion: number; preferencesHash: string; expectedFingerprint: unknown }[]>(db, generation, "preference_work", { limit: 20 });
    expect(rows).toHaveLength(1);
    await maintenance(db, generation, "attest_preferences", { projectId: rows[0]!.projectId, preferencesVersion: rows[0]!.preferencesVersion, preferencesHash: rows[0]!.preferencesHash, readiness: { ready: true, missing: [] }, fingerprint: rows[0]!.expectedFingerprint });
    expect(await maintenance(db, generation, "preference_work", { limit: 20 })).toEqual([]);
  });
});

it("rehearses additive deployment over existing history without rewriting evidence or public ACL/OIDs", async () => {
  const db = await createTestDatabase({ before: authorityMigration });
  try {
    await (await import("./naming-brain-fixture")).installBrainFixture(db);
    const f = await seedHostedNamingFixture(db);
    const snapshot = async () => ({
      jobs: (await db.query("select to_jsonb(j) value from public.jobs j")).rows,
      runs: (await db.query("select to_jsonb(r) value from fluid_private.naming_brain_runs r")).rows,
      accounts: (await db.query("select to_jsonb(a) value from public.usage_accounts a order by owner_id")).rows,
      metadata: (await db.query("select oid,proowner,proacl,prosecdef,proconfig,provolatile from pg_proc where oid=any($1::regprocedure[]) order by oid", [["public.claim_naming_brain_job(text,text,integer)", "public.expire_naming_brain_leases(text,text)", "public.attest_naming_brain_preferences(uuid,integer,text,jsonb,jsonb)", "fluid_private.naming_brain_ready(fluid_private.naming_brain_runs,text)"]])).rows,
    });
    const before = await snapshot(); await db.exec(sql); expect(await snapshot()).toEqual(before);
    expect(await workerStatus(db)).toMatchObject({ leader: true, generation: 1 });
    // Existing leased work needs re-claim for paid authority, but durable reads remain.
    expect(await maintenance(db, 1, "assert_continue", { jobId: f.job.id, leaseToken: f.job.leaseToken })).toBe(false);
    expect(await brainWorker(db, () => f.store.loadProgressiveState(f.job))).toBeTruthy();
  } finally { await db.close(); }
}, 60_000);

it("rejects predecessor drift atomically and strips hostile default ACLs from new objects", async () => {
  const db = await createTestDatabase({ before: authorityMigration });
  try {
    await db.exec("alter function public.claim_naming_brain_job(text,text,integer) set search_path=public");
    await expect(db.exec(sql)).rejects.toThrow("unexpected_naming_worker_authority_predecessor"); await db.exec("rollback");
    expect((await db.query("select to_regclass('fluid_private.naming_worker_leadership') value")).rows).toEqual([{ value: null }]);
    await db.exec(`alter function public.claim_naming_brain_job(text,text,integer) set search_path='';
      create role fixture_hostile nologin; alter default privileges grant execute on functions to fixture_hostile;
      alter default privileges grant all on tables to fixture_hostile;`);
    await db.exec(sql);
    const leakage = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
      (n.nspname='fluid_private' and p.proname like 'naming_worker_%' or n.nspname='public' and p.proname in('report_naming_brain_worker_status','naming_brain_worker_maintenance_v2'))
      and (has_function_privilege('fixture_hostile',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') or has_function_privilege('service_role',p.oid,'EXECUTE'))`);
    expect(leakage.rows).toEqual([]);
    expect((await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='fluid_private' and c.relname in('naming_worker_leadership','naming_worker_job_authority','naming_worker_gateway_context')
      and (not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege('fixture_hostile',c.oid,'SELECT')
      or has_table_privilege('authenticated',c.oid,'SELECT') or has_table_privilege('service_role',c.oid,'SELECT'))`)).rows).toEqual([]);
    for (const role of ["anon", "authenticated", "service_role"] as const) await expect(asRole(db, role, OWNER_A, () => db.query("select public.report_naming_brain_worker_status('{}','fixture-deployment','attacker',null,60)"))).rejects.toMatchObject({ code: "42501" });
  } finally { await db.close(); }
}, 60_000);

it("aborts object collisions without leaving a partially applied authority migration", async () => {
  const db = await createTestDatabase({ before: authorityMigration });
  try {
    await db.exec("create table fluid_private.naming_worker_leadership(synthetic_collision boolean)");
    await expect(db.exec(sql)).rejects.toMatchObject({ code: "42P07" }); await db.exec("rollback");
    expect((await db.query("select to_regclass('fluid_private.naming_worker_job_authority') value")).rows).toEqual([{ value: null }]);
    expect((await db.query("select to_regprocedure('public.report_naming_brain_worker_status(jsonb,text,text,bigint,integer)')::text value")).rows).toEqual([{ value: null }]);
    expect((await db.query("select column_name from information_schema.columns where table_schema='fluid_private' and table_name='naming_worker_leadership'")).rows).toEqual([{ column_name: "synthetic_collision" }]);
  } finally { await db.close(); }
}, 60_000);
