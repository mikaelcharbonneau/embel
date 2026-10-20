import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000 });
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { asApiTextWorker, asRole, createTestDatabase, HASH, installApiTextWorkerFixture, OWNER_A, OWNER_B, seedProject, type TestDatabase } from "./local-supabase";
import { admit, availability, enableSyntheticCohort, MULTI_DEPLOYMENT, MULTI_POLICY, resetMultiAccountFixture } from "./api-text-multi-account-fixture";
import { installBrainFixture, seedBrainFixture, startBrainFixture } from "./naming-brain-fixture";

const migrationName = "20261020021500_strategy_deleted_request_quarantine.sql";
const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"] as const;
type Operation = typeof operations[number];
type Admission = Awaited<ReturnType<typeof admit>>;
const targetOperation = "strategy.competitors";
const targetPolicy = guidedStrategyPolicy(targetOperation);
const contextFor = (operation: Operation) => {
  const stage = operation === "strategy.audience" ? "audience" : operation === "strategy.personality" ? "personality" : "competitors";
  return contextSnapshotSchema.parse({ description: "Synthetic deleted Strategy quarantine regression", intake: {
    conversation: [{ id: "synthetic-prompt", kind: "user_message", text: "Synthetic research", createdAt: "2026-10-19T12:00:00.000Z" }],
    guidedInterview: { version: 1, stage, turns: [{ id: "synthetic-turn", userMessageId: "synthetic-prompt", stage,
      purpose: operation === "strategy.reformulate" ? "message" : stage === "competitors" ? "research" : "propose", inputRevision: 2 }], answers: [] },
  } });
};

/** Full migrated disposable PostgreSQL and real authenticated/restricted gateway
 * calls. All retained jobs are explicit synthetic fixtures, never provider calls. */
describe.each(["original planning", "bounded evidence planning"] as const)("deleted-project Strategy testing quarantine: %s", planning => {
  let db: TestDatabase;
  let projects: { a: string; b: string };
  let oldProject: string;
  let beforeData: unknown; let afterData: unknown; let beforeGlobals: unknown; let afterGlobals: unknown;
  let beforeSecurity: Array<{ oid: number }>; let afterSecurity: Array<{ oid: number }>;
  const security = async () => (await db.query<{ oid: number }>("select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc where pronamespace in ('public'::regnamespace,'fluid_private'::regnamespace) order by oid")).rows;
  const globalGuards = async () => (await db.query("select oid,md5(prosrc) body_hash,prosrc from pg_proc where oid in ('fluid_private.api_text_allowance_paused()'::regprocedure,'fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)'::regprocedure) order by oid")).rows;
  async function allData() {
    const tables = (await db.query<{ relation: string }>("select c.oid::regclass::text relation from pg_class c where c.relnamespace in ('public'::regnamespace,'fluid_private'::regnamespace) and c.relkind='r' order by 1")).rows;
    const result: Record<string, unknown> = {};
    for (const { relation } of tables) result[relation] = (await db.query(`select count(*)::integer count,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text),'')) digest from ${relation} t`)).rows;
    return result;
  }
  async function prepare() {
    projects = await resetMultiAccountFixture(db);
    oldProject = (await seedProject(db, OWNER_B)).id;
    await enableSyntheticCohort(db);
    const trial = await admit(db, OWNER_B, projects.b, "synthetic-trial-before-testing");
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_job_cancel($1)", [trial.id]));
    await db.query("update fluid_private.api_text_allowance_cohorts set operations=$1", [operations]);
    for (const operation of operations) {
      const policy = guidedStrategyPolicy(operation);
      await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'fixture',$2,true)", [OWNER_B, operation]);
      await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2) on conflict(operation) do update set policy=excluded.policy", [operation, policy]);
      await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,$2,oid,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'),$4,true from pg_roles where rolname='fixture_api_text_a' on conflict(owner_id,operation) do update set policy_identity=excluded.policy_identity", [OWNER_B, operation, policy, MULTI_DEPLOYMENT]);
    }
    await append(projects.b, targetOperation);
  }
  beforeAll(async () => {
    db = await createTestDatabase({ before: migrationName });
    await installApiTextWorkerFixture(db); await installBrainFixture(db);
    await db.exec("alter table auth.users add column created_at timestamptz default clock_timestamp(),add column email_confirmed_at timestamptz; grant execute on function public.api_text_dispatch_action(jsonb,text,jsonb),public.list_api_text_dispatches_v2(integer),public.api_text_multi_account_readiness(jsonb,text) to fixture_api_text_a,fixture_api_text_b");
    await prepare(); await oldRequest();
    expect(await availability(db, OWNER_B, projects.b)).toMatchObject({ status: "unavailable", reason: "request_unresolved" });
    await expect(enqueue()).rejects.toThrow();
    beforeData = await allData(); beforeSecurity = await security(); beforeGlobals = await globalGuards();
    const migration = await readFile(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url), "utf8");
    await db.exec("alter function public.check_api_text_runtime(text,jsonb,text) security invoker");
    await expect(db.exec(migration)).rejects.toThrow("unexpected_strategy_quarantine_predecessor");
    await db.exec("rollback; alter function public.check_api_text_runtime(text,jsonb,text) security definer");
    await db.exec("create role fixture_quarantine_hostile nologin; alter default privileges in schema public,fluid_private grant execute on functions to fixture_quarantine_hostile");
    await db.exec(migration);
    afterData = await allData(); afterSecurity = await security(); afterGlobals = await globalGuards();
    // Replay the complete existing boundary suite with the additive planner-only
    // migration too. Capture quarantine's own catalog comparison before tuning;
    // strategy-evidence-join-planning.test.ts checks that separate exact delta.
    if (planning === "bounded evidence planning")
      await db.exec(await readFile(new URL("../../supabase/migrations/20261020031000_strategy_evidence_join_planning.sql", import.meta.url), "utf8"));
  }, 120_000);
  beforeEach(prepare, 30_000);
  afterAll(async () => { await db?.close(); });

  const append = (project: string, operation: Operation, owner = OWNER_B) => asRole(db, "authenticated", owner,
    () => db.query("select public.append_project_revision($1,1,$2,$3)", [project, contextFor(operation), HASH]));
  const enqueue = (project = projects.b, key = "synthetic-new-research", operation: Operation = targetOperation, owner = OWNER_B) => asRole(db, "authenticated", owner,
    async () => (await db.query<{ value: Admission }>("select public.enqueue_strategy_job($1,2,$2,$3,$4) value", [project, operation, key, guidedStrategyPolicy(operation).maximumCostMicrousd])).rows[0]!.value);
  const action = <T = unknown>(job: Admission, name: string, args: unknown[] = [], worker = OWNER_A) => asApiTextWorker(db, worker,
    async () => (await db.query<{ value: T }>("select public.api_text_dispatch_action($1,$2,$3) value", [job.dispatch, name, args])).rows[0]!.value);
  async function start(job: Admission, operation: Operation = targetOperation, begin = true) {
    const claimed = await action<{ disposition: string; job: { lease_token: string } }>(job, "claim", ["synthetic-quarantine-worker", 300]);
    expect(claimed.disposition).toBe("claimed");
    const lease = claimed.job.lease_token, policy = guidedStrategyPolicy(operation);
    await action(job, "plan", [lease, [{ key: "guided", maximumCostMicrousd: policy.maximumCostMicrousd }]]);
    if (begin) await action(job, "begin", [lease, "guided", `synthetic:${job.id}`, policy.maximumCostMicrousd]);
    return lease;
  }
  const deleteProject = (project = oldProject, owner = OWNER_B) => asRole(db, "authenticated", owner,
    async () => (await db.query<{ value: { deletion_state: string } }>("select public.request_project_deletion($1,2,0) value", [project])).rows[0]!.value);
  const restoreProject = (project = oldProject) => asRole(db, "authenticated", OWNER_B,
    () => db.query("select public.restore_project_deletion($1,2,1)", [project]));
  async function oldRequest(options: { operation?: Operation; project?: string; deleted?: boolean } = {}) {
    const operation = options.operation ?? "strategy.audience", project = options.project ?? oldProject;
    await append(project, operation);
    const job = await enqueue(project, `synthetic-old:${randomUUID()}`, operation);
    await start(job, operation);
    // Explicit synthetic unknown provider outcome: retain the actual in_flight
    // step and NULL output, as seen in the original blocked audience request.
    await db.query("update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code='provider_request_rejected' where id=$1", [job.id]);
    if (options.deleted !== false) expect((await deleteProject(project)).deletion_state).toBe("awaiting_resolution");
    return job;
  }
  const quarantined = async (job: string, target: string | null = projects.b, operation = targetOperation, owner = OWNER_B) =>
    (await db.query<{ value: boolean }>("select fluid_private.api_text_deleted_strategy_quarantined($1,$2,$3,$4) value", [owner, operation, target, job])).rows[0]!.value;
  const paused = async (target: string | null = projects.b, operation = targetOperation, owner = OWNER_B) =>
    (await db.query<{ value: boolean }>("select fluid_private.api_text_strategy_paused($1,$2,$3) value", [owner, operation, target])).rows[0]!.value;
  async function retained(job: string) {
    const result: Record<string, unknown> = {};
    for (const table of ["public.jobs", "public.job_steps", "public.usage_reservations", "fluid_private.api_text_testing_admissions", "fluid_private.api_text_allowance_admissions", "fluid_private.api_text_dispatches"])
      result[table] = (await db.query(`select to_jsonb(t) data from ${table} t where ${table === "public.jobs" ? "id" : "job_id"}=$1 order by to_jsonb(t)::text`, [job])).rows;
    return result;
  }
  const account = async () => (await db.query<{ reserved_microusd: number; spent_microusd: number; provider_actual_microusd: number }>("select reserved_microusd,spent_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1", [OWNER_B])).rows[0]!;
  async function blocked(job: Admission) {
    expect(await quarantined(job.id)).toBe(false);
    expect((await availability(db, OWNER_B, projects.b)).operations).not.toContainEqual(expect.objectContaining({ operation: targetOperation }));
    await expect(enqueue()).rejects.toThrow();
  }
  // Corruptions below are deliberate disposable-fixture negatives only. Never
  // disable lifecycle guards; project deletion/Restore always use owner RPCs.
  async function changeAdmission(table: "api_text_testing_admissions" | "api_text_allowance_admissions" | "api_text_dispatches", statement: string, values: unknown[]) {
    await db.exec(`alter table fluid_private.${table} disable trigger user`);
    try { await db.query(statement, values); }
    finally { await db.exec(`alter table fluid_private.${table} enable trigger user`); }
  }

  it("preserves all retained rows and existing function OIDs, owners, security settings and ACLs", () => {
    expect(afterData).toEqual(beforeData); expect(afterGlobals).toEqual(beforeGlobals);
    expect(afterSecurity.filter(row => beforeSecurity.some(before => before.oid === row.oid))).toEqual(beforeSecurity);
  });

  it("keeps new quarantine helpers private even with hostile function defaults", async () => {
    await expect(asApiTextWorker(db, OWNER_A, () => db.query("select fluid_private.api_text_deleted_strategy_quarantined($1,$2,$3,$4)", [OWNER_B, targetOperation, projects.b, randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    const newIds = afterSecurity.filter(row => !beforeSecurity.some(before => before.oid === row.oid)).map(row => row.oid);
    const helpers = (await db.query<{ signature: string }>("select oid::regprocedure::text signature from pg_proc where oid=any($1::oid[]) and pronamespace='fluid_private'::regnamespace", [newIds])).rows;
    expect(helpers).toHaveLength(6);
    for (const role of ["anon", "authenticated", "service_role", "fixture_api_text_a", "fixture_api_text_b", "fixture_quarantine_hostile"])
      for (const { signature } of helpers)
        expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows).toEqual([{ allowed: false }]);
  });

  it.each(["strategy.audience", "strategy.competitors"] as const)("executes a complete new competitors request after retained deleted %s without changing its evidence or hold", async operation => {
    const old = await oldRequest({ operation });
    const original = await retained(old.id), ledger = await account();
    expect((await db.query("select j.state,j.cancel_requested_at,j.lease_token,j.lease_expires_at,s.state step_state,s.output,r.state reservation_state,r.reserved_microusd from public.jobs j join public.job_steps s on s.job_id=j.id join public.usage_reservations r on r.job_id=j.id where j.id=$1", [old.id])).rows).toEqual([expect.objectContaining({ state: "needs_reconciliation", cancel_requested_at: expect.any(Date), lease_token: null, lease_expires_at: null, step_state: "in_flight", output: null, reservation_state: "active", reserved_microusd: guidedStrategyPolicy(operation).maximumCostMicrousd })]);
    expect(await quarantined(old.id)).toBe(true);
    expect(await paused()).toBe(false);
    expect((await db.query("select fluid_private.api_text_paid_paused($1) value", [OWNER_B])).rows).toEqual([{ value: true }]);
    expect((await db.query("select fluid_private.api_text_allowance_paused() value")).rows).toEqual([{ value: true }]);
    expect((await db.query("select fluid_private.api_text_policy_allowed($1,$2,$3,$4,null) value", [OWNER_B, targetOperation, targetPolicy, MULTI_DEPLOYMENT])).rows).toEqual([{ value: false }]);
    expect((await db.query("select fluid_private.api_text_allowance_available($1,$2) value", [OWNER_B, targetOperation])).rows).toEqual([{ value: null }]);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
    const fresh = await enqueue(); expect(await enqueue()).toEqual(fresh);
    expect(await availability(db, OWNER_B, projects.b)).toMatchObject({ reason: "request_active" });
    await expect(enqueue(projects.b, "synthetic-second-active-request")).rejects.toThrow();
    expect(await action(fresh, "descriptor")).toMatchObject({ retryable: true });
    const lease = await start(fresh);
    expect(await action(fresh, "runtime", [targetOperation, targetPolicy])).toBe(true);
    expect(await action(fresh, "authorize", [lease, "guided"])).toBe(true);
    await action(fresh, "complete", [lease, "guided", "succeeded", 10, {}, "resp_synthetic_quarantine"]);
    await action(fresh, "finish", [lease, "succeeded", null]);
    expect(await retained(old.id)).toEqual(original);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
    expect(await account()).toEqual({ ...ledger, spent_microusd: Number(ledger.spent_microusd) + 10, provider_actual_microusd: Number(ledger.provider_actual_microusd) + 10 });
    expect((await db.query("select reserved_microusd,actual_microusd,state from public.usage_reservations where job_id=$1", [fresh.id])).rows).toEqual([{ reserved_microusd: targetPolicy.maximumCostMicrousd, actual_microusd: 10, state: "settled" }]);
    expect(await action(old, "descriptor")).toMatchObject({ retryable: false });
    expect(await action(old, "claim", ["synthetic-old-retry", 300])).toMatchObject({ disposition: "terminal" });
    await expect(enqueue(oldProject, "synthetic-replacement-after-deletion", operation)).rejects.toThrow();
    expect(await retained(old.id)).toEqual(original);
    for (const table of ["api_text_gateway_context", "api_text_testing_admission_context"])
      expect((await db.query(`select * from fluid_private.${table}`)).rows).toEqual([]);
  });

  it("requires the complete retained ledger while accepting exact captured usage and another intact hold", async () => {
    const old = await oldRequest(), otherProject = (await seedProject(db, OWNER_B)).id, other = randomUUID();
    await db.query("update public.jobs set actual_cost_microusd=10 where id=$1", [old.id]);
    await db.query("update public.usage_reservations set actual_microusd=10,captured_microusd=10 where job_id=$1", [old.id]);
    await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd) values($1,$2,$3,'naming.generate',1,$4,'{}',$5,'failed',77)", [other, OWNER_B, otherProject, HASH, `synthetic-extra-hold:${other}`]);
    await db.query("insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) values($1,$2,$3,77)", [other, OWNER_B, otherProject]);
    await db.query("update public.usage_accounts set reserved_microusd=reserved_microusd-10+77,spent_microusd=spent_microusd+10,provider_actual_microusd=provider_actual_microusd+10 where owner_id=$1", [OWNER_B]);
    expect(await quarantined(old.id)).toBe(true);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
    const original = await retained(old.id), extra = await retained(other), ledger = await account();
    const fresh = await enqueue(); const lease = await start(fresh);
    expect(await action(fresh, "authorize", [lease, "guided"])).toBe(true);
    expect(await retained(old.id)).toEqual(original); expect(await retained(other)).toEqual(extra);
    expect((await account()).reserved_microusd).toBe(Number(ledger.reserved_microusd) + targetPolicy.maximumCostMicrousd);
  });

  it("keeps exact original replay observable after Restore without creating or retrying work", async () => {
    const old = await oldRequest(); const original = await retained(old.id);
    await restoreProject();
    const key = (await db.query<{ idempotency_key: string }>("select idempotency_key from public.jobs where id=$1", [old.id])).rows[0]!.idempotency_key;
    expect((await enqueue(oldProject, key, "strategy.audience")).id).toBe(old.id);
    expect(await action(old, "descriptor")).toMatchObject({ retryable: false });
    expect(await action(old, "claim", ["synthetic-restored-old-retry", 300])).toMatchObject({ disposition: "terminal" });
    expect(await retained(old.id)).toEqual(original);
    expect(await paused()).toBe(true);
    await expect(enqueue()).rejects.toThrow();
  });

  it.each(["absent-marker", "absent-cancellation", "not-deleted", "restored", "non-strategy", "reservation-missing", "reservation-settled", "reservation-amount", "reservation-actual", "captured-mismatch", "allowance-missing", "dispatch-missing", "allowance-owner", "allowance-amount", "ledger-short", "ledger-excess", "grant-disabled", "grant-missing", "target-deleted"])("fails closed for %s", async mode => {
    const old = await oldRequest({ deleted: mode !== "not-deleted" });
    if (mode === "absent-marker") await changeAdmission("api_text_testing_admissions", "delete from fluid_private.api_text_testing_admissions where job_id=$1", [old.id]);
    else if (mode === "absent-cancellation") await db.query("update public.jobs set cancel_requested_at=null where id=$1", [old.id]);
    else if (mode === "restored") await restoreProject();
    else if (mode === "non-strategy") await db.query("update public.jobs set operation='naming.generate' where id=$1", [old.id]);
    else if (mode === "reservation-missing") await db.query("delete from public.usage_reservations where job_id=$1", [old.id]);
    else if (mode === "reservation-settled") await db.query("update public.usage_reservations set state='settled' where job_id=$1", [old.id]);
    else if (mode === "reservation-amount") await db.query("update public.usage_reservations set reserved_microusd=reserved_microusd-1 where job_id=$1", [old.id]);
    else if (mode === "reservation-actual") await db.query("update public.usage_reservations set actual_microusd=1 where job_id=$1", [old.id]);
    else if (mode === "captured-mismatch") await db.query("update public.usage_reservations set captured_microusd=1 where job_id=$1", [old.id]);
    else if (mode === "allowance-missing") {
      await changeAdmission("api_text_testing_admissions", "delete from fluid_private.api_text_testing_admissions where job_id=$1", [old.id]);
      await changeAdmission("api_text_allowance_admissions", "delete from fluid_private.api_text_allowance_admissions where job_id=$1", [old.id]);
    }
    else if (mode === "dispatch-missing") await changeAdmission("api_text_dispatches", "delete from fluid_private.api_text_dispatches where job_id=$1", [old.id]);
    else if (mode === "allowance-owner") await changeAdmission("api_text_allowance_admissions", "update fluid_private.api_text_allowance_admissions set owner_id=$2 where job_id=$1", [old.id, OWNER_A]);
    else if (mode === "allowance-amount") await changeAdmission("api_text_allowance_admissions", "update fluid_private.api_text_allowance_admissions set maximum_cost_microusd=15892880 where job_id=$1", [old.id]);
    else if (mode === "ledger-short" || mode === "ledger-excess") await db.query("update public.usage_accounts set reserved_microusd=reserved_microusd+$2 where owner_id=$1", [OWNER_B, mode === "ledger-short" ? -1 : 1]);
    else if (mode === "grant-disabled") await db.query("update fluid_private.api_text_testing_access set enabled=false where owner_id=$1 and operation=$2", [OWNER_B, targetOperation]);
    else if (mode === "grant-missing") await db.query("delete from fluid_private.api_text_testing_access where owner_id=$1 and operation=$2", [OWNER_B, targetOperation]);
    else if (mode === "target-deleted") await deleteProject(projects.b);
    if (mode === "non-strategy") {
      // The existing feature isolation may ignore a different feature, but this
      // new Strategy-only quarantine predicate must never grant it authority.
      expect(await quarantined(old.id)).toBe(false);
    } else await blocked(old);
  });

  it.each(["queued", "running", "cancel_requested"])("does not quarantine %s work", async state => {
    await append(oldProject, "strategy.audience");
    const old = await enqueue(oldProject, `synthetic-active:${randomUUID()}`, "strategy.audience");
    if (state !== "queued") await start(old, "strategy.audience");
    if (state === "cancel_requested") expect((await deleteProject()).deletion_state).toBe("stopping");
    expect((await db.query("select state from public.jobs where id=$1", [old.id])).rows).toEqual([{ state }]);
    await blocked(old);
  });

  it.each(["live", "expired", "token-only", "expiry-only"])("rejects any remaining lease witness, including %s", async mode => {
    const old = await oldRequest();
    // Current table constraints forbid these malformed rows. Deliberately relax
    // only lease CHECKs inside a rolled-back local transaction to prove the
    // helper independently fails closed if retained historical data is malformed.
    await db.exec("begin");
    try {
      const checks = (await db.query<{ name: string }>("select conname name from pg_constraint where conrelid='public.jobs'::regclass and contype='c' and pg_get_constraintdef(oid) like '%lease_%' ")).rows;
      for (const { name } of checks) await db.exec(`alter table public.jobs drop constraint "${name}"`);
      await db.query("update public.jobs set lease_token=$2,lease_expires_at=$3 where id=$1", [old.id, mode === "expiry-only" ? null : randomUUID(), mode === "token-only" ? null : new Date(Date.now() + (mode === "expired" ? -300_000 : 300_000))]);
      expect(await quarantined(old.id)).toBe(false);
      expect(await paused()).toBe(true);
    } finally { await db.exec("rollback"); }
  });

  it("preserves same-project, null/foreign scopes and ordinary-account guards", async () => {
    const old = await oldRequest();
    for (const target of [oldProject, null, projects.a, randomUUID()]) {
      expect(await quarantined(old.id, target)).toBe(false);
      expect(await paused(target)).toBe(true);
    }
    expect(await quarantined(old.id, projects.b, targetOperation, OWNER_A)).toBe(false);
    expect(await quarantined(randomUUID())).toBe(false);
    await expect(availability(db, OWNER_A, projects.b)).rejects.toMatchObject({ code: "P0002" });
    await expect(enqueue(projects.b, "synthetic-foreign", targetOperation, OWNER_A)).rejects.toMatchObject({ code: "P0002" });
    await db.query("update fluid_private.api_text_testing_access set enabled=false where owner_id=$1", [OWNER_B]);
    expect(await paused()).toBe(true);
    expect(await quarantined(old.id)).toBe(false);
    await expect(enqueue()).rejects.toThrow();
  });

  it.each(["actual-overrun", "cost_overrun", "provider_cost_exceeded"])("preserves confirmed owner-wide overrun block: %s", async mode => {
    const old = await oldRequest();
    if (mode === "actual-overrun") {
      await db.query("update public.jobs set actual_cost_microusd=reserved_cost_microusd+1 where id=$1", [old.id]);
      await db.query("update public.usage_reservations set actual_microusd=reserved_microusd+1 where job_id=$1", [old.id]);
    } else await db.query("update public.jobs set error_code=$2 where id=$1", [old.id, mode]);
    expect(await paused()).toBe(true); await blocked(old);
  });

  it("preserves a different request's account-wide confirmed overrun", async () => {
    const old = await oldRequest();
    const id = randomUUID();
    await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd,actual_cost_microusd) values($1,$2,$3,'naming.generate',1,$4,'{}',$5,'failed',100,101)", [id, OWNER_B, projects.b, HASH, `synthetic-overrun:${id}`]);
    expect(await paused()).toBe(true);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(enqueue()).rejects.toThrow();
    expect(await quarantined(old.id)).toBe(true); // Quarantine never overrides the independent overrun branch.
  });

  it("retains provider-observed Naming overruns before final job cost is known", async () => {
    const namingProject = await seedBrainFixture(db), run = await startBrainFixture(db, namingProject);
    const target = (await seedProject(db, OWNER_A)).id;
    await db.query("insert into fluid_private.api_text_allowance_cohorts(id,enabled,role_name,role_oid,deployment_id,operations,signup_after,signup_before,expires_at,owner_attempt_limit,owner_cost_limit,owner_active_limit,account_limit,attempt_limit,cost_limit) select 'fixture',true,rolname,oid,$1,array['strategy.competitors'],clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day',1,122880,1,10,20,2457600 from pg_roles where rolname='fixture_api_text_a' on conflict(id) do update set enabled=true", [MULTI_DEPLOYMENT]);
    await db.query("insert into fluid_private.api_text_owner_entitlements(owner_id,cohort_id,attempt_limit,cost_limit,active_limit,expires_at) values($1,'fixture',1,122880,1,clock_timestamp()+interval '1 day')", [OWNER_A]);
    await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'fixture','strategy.competitors',true)", [OWNER_A]);
    expect(await paused(target, targetOperation, OWNER_A)).toBe(false);
    await db.query("update fluid_private.naming_brain_runs set observed_overrun=true where job_id=$1", [run.id]);
    expect((await db.query("select state,actual_cost_microusd from public.jobs where id=$1", [run.id])).rows).toEqual([{ state: "running", actual_cost_microusd: 0 }]);
    expect(await paused(target, targetOperation, OWNER_A)).toBe(true);
  });

  it.each(["before-claim", "before-begin", "before-authorize"])("rechecks restored deletion status %s while preserving exact new request replay", async when => {
    const old = await oldRequest({ operation: targetOperation }); const fresh = await enqueue();
    let lease: string | undefined;
    if (when !== "before-claim") lease = await start(fresh, targetOperation, when === "before-authorize");
    await restoreProject(); expect(await quarantined(old.id)).toBe(false);
    if (when === "before-claim") expect(await action(fresh, "claim", ["synthetic-restored-before-claim", 300])).toMatchObject({ disposition: "unavailable" });
    else if (when === "before-begin") await expect(action(fresh, "begin", [lease, "guided", `synthetic:${fresh.id}`, targetPolicy.maximumCostMicrousd])).rejects.toThrow("runtime_unavailable");
    else expect(await action(fresh, "authorize", [lease, "guided"])).toBe(false);
    expect((await enqueue()).id).toBe(fresh.id);
    expect((await db.query("select count(*)::integer count from public.jobs where idempotency_key='synthetic-new-research'")).rows).toEqual([{ count: 1 }]);
  });

  const readiness = (worker = OWNER_A, deployment = MULTI_DEPLOYMENT, policy: unknown = targetPolicy) => asApiTextWorker(db, worker,
    async () => (await db.query<{ operation: string; ready: boolean }>("select * from public.api_text_multi_account_readiness($1,$2)", [[{ operation: targetOperation, policy }], deployment])).rows);

  it.each(["worker", "deployment", "policy", "grant", "restored-source", "missing-source-dispatch", "no-active-target"])("keeps readiness witness scoped and non-authorizing: %s", async mode => {
    const old = await oldRequest();
    expect(await readiness()).toEqual([{ operation: targetOperation, ready: true }]);
    if (mode === "worker") {
      await db.query("insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_api_text_b'", [OWNER_B]);
      expect(await readiness(OWNER_B)).toEqual([{ operation: targetOperation, ready: false }]);
      expect(await asApiTextWorker(db, OWNER_B, async () => (await db.query<{ value: boolean }>("select public.check_api_text_runtime($1,$2,$3) value", [targetOperation, targetPolicy, MULTI_DEPLOYMENT])).rows[0]!.value)).toBe(false);
    }
    else if (mode === "deployment") expect(await readiness(OWNER_A, "dpl_forged")).toEqual([{ operation: targetOperation, ready: false }]);
    else if (mode === "policy") expect(await readiness(OWNER_A, MULTI_DEPLOYMENT, { ...targetPolicy, model: "forged" })).toEqual([{ operation: targetOperation, ready: false }]);
    else {
      if (mode === "grant") await db.query("update fluid_private.api_text_testing_access set enabled=false where owner_id=$1 and operation=$2", [OWNER_B, targetOperation]);
      else if (mode === "restored-source") await restoreProject();
      else if (mode === "missing-source-dispatch") await changeAdmission("api_text_dispatches", "delete from fluid_private.api_text_dispatches where job_id=$1", [old.id]);
      else await deleteProject(projects.b);
      expect(await readiness()).toEqual([{ operation: targetOperation, ready: false }]);
    }
    expect(await asApiTextWorker(db, OWNER_A, async () => (await db.query<{ value: boolean }>("select public.check_api_text_runtime($1,$2,$3) value", [targetOperation, targetPolicy, MULTI_DEPLOYMENT])).rows[0]!.value)).toBe(false);
  });

  it.each(["unresolved", "overrun"])("does not exempt another owner's admitted %s from global allowance and worker-readiness guards", async mode => {
    // Ordinary enrollment retains the bounded v1 policy. Restore the guided
    // testing runtime only after this genuine foreign admission is established.
    await db.query("update fluid_private.strategy_runtime_policy set policy=$1 where operation='strategy.reformulate'", [MULTI_POLICY]);
    const foreign = await admit(db, OWNER_A, projects.a, "synthetic-foreign-before-quarantine");
    await db.query("update fluid_private.strategy_runtime_policy set policy=$1 where operation='strategy.reformulate'", [guidedStrategyPolicy("strategy.reformulate")]);
    const old = await oldRequest();
    expect(await quarantined(old.id)).toBe(true);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
    await db.query("update public.jobs set state='needs_reconciliation',error_code='provider_request_rejected',actual_cost_microusd=case when $2 then reserved_cost_microusd+1 else 0 end where id=$1", [foreign.id, mode === "overrun"]);
    expect((await db.query("select fluid_private.api_text_allowance_paused() value")).rows).toEqual([{ value: true }]);
    expect((await availability(db, OWNER_B, projects.b)).operations).not.toContainEqual(expect.objectContaining({ operation: targetOperation }));
    await expect(enqueue()).rejects.toThrow();
    expect(await readiness()).toEqual([{ operation: targetOperation, ready: false }]);
  });

  it("rejects a valid owner legacy principal that is not this admission's current cohort worker role", async () => {
    await oldRequest({ operation: targetOperation }); const fresh = await enqueue();
    await db.query("insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_api_text_b'", [OWNER_B]);
    expect(await action(fresh, "descriptor", [], OWNER_B)).toMatchObject({ retryable: false });
    expect(await action(fresh, "runtime", [targetOperation, targetPolicy], OWNER_B)).toBe(false);
    expect(await action(fresh, "claim", ["synthetic-wrong-legacy-worker", 300], OWNER_B)).toMatchObject({ disposition: "unavailable" });
    expect(await readiness(OWNER_B)).toEqual([{ operation: targetOperation, ready: false }]);
    expect(await action(fresh, "descriptor")).toMatchObject({ retryable: true });
  });

  it("requires the exact trusted current gateway, worker, policy and deployment for same-operation runtime quarantine", async () => {
    await oldRequest({ operation: targetOperation }); const fresh = await enqueue(); const lease = await start(fresh);
    await db.query("update fluid_private.api_text_worker_principals set owner_id=$1 where role_name='fixture_api_text_a'", [OWNER_B]);
    expect((await db.query("select fluid_private.api_text_testing_gateway_project($1,$2,$3,$4) value", [OWNER_B, targetOperation, targetPolicy, MULTI_DEPLOYMENT])).rows).toEqual([{ value: null }]);
    expect(await asApiTextWorker(db, OWNER_A, async () => (await db.query<{ value: boolean }>("select public.check_api_text_runtime($1,$2,$3) value", [targetOperation, targetPolicy, MULTI_DEPLOYMENT])).rows[0]!.value)).toBe(false);
    await expect(action(fresh, "runtime", [targetOperation, targetPolicy], OWNER_B)).rejects.toThrow();
    for (const change of [{ deploymentId: "dpl_forged" }, { policyIdentity: "f".repeat(64) }, { jobId: randomUUID() }])
      await expect(action({ ...fresh, dispatch: { ...fresh.dispatch, ...change } }, "authorize", [lease, "guided"])).rejects.toThrow();
    await expect(action(fresh, "runtime", [targetOperation, { ...targetPolicy, model: "forged" }])).rejects.toThrow();
    await expect(asApiTextWorker(db, OWNER_A, () => db.query("select public.begin_job_step($1,$2,'guided','synthetic-raw',$3)", [fresh.id, lease, targetPolicy.maximumCostMicrousd]))).rejects.toThrow();
    expect(await action(fresh, "runtime", [targetOperation, targetPolicy])).toBe(true);
    expect(await action(fresh, "authorize", [lease, "guided"])).toBe(true);
    expect((await db.query("select * from fluid_private.api_text_gateway_context")).rows).toEqual([]);
  });
});
