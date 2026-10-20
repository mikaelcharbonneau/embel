import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000 });
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { asApiTextWorker, asRole, createTestDatabase, HASH, installApiTextWorkerFixture, OWNER_A, OWNER_B, seedProject, type TestDatabase } from "./local-supabase";
import { admit, availability, enableSyntheticCohort, MULTI_DEPLOYMENT, resetMultiAccountFixture } from "./api-text-multi-account-fixture";

const migrationName = "20261019235937_strategy_testing_legacy_account_ceiling.sql";
const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"] as const;
const policy = guidedStrategyPolicy("strategy.competitors");
const accountLimit = 25_005_002;
type Admission = Awaited<ReturnType<typeof admit>>;
const context = contextSnapshotSchema.parse({ description: "Synthetic retained large account", intake: {
  conversation: [{ id: "synthetic-prompt", kind: "user_message", text: "Synthetic competitor research", createdAt: "2026-10-19T12:00:00.000Z" }],
  guidedInterview: { version: 1, stage: "competitors", turns: [{ id: "synthetic-turn", userMessageId: "synthetic-prompt", stage: "competitors", purpose: "research", inputRevision: 2 }], answers: [] },
} });

/** Disposable PostgreSQL, actual authenticated/restricted worker RPCs, synthetic
 * retained history. No hosted mutation or provider call is used by these tests. */
describe("existing Strategy testing with a retained account allowance above the legacy ceiling", () => {
  let db: TestDatabase; let projects: { a: string; b: string }; let oldProject: string;
  let beforeData: unknown; let afterData: unknown; let beforeSecurity: unknown; let afterSecurity: unknown;
  const security = () => db.query("select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc where pronamespace in ('public'::regnamespace,'fluid_private'::regnamespace) order by oid");
  async function allData() {
    const tables = (await db.query<{ relation: string }>("select c.oid::regclass::text relation from pg_class c where c.relnamespace in ('public'::regnamespace,'fluid_private'::regnamespace) and c.relkind='r' order by 1")).rows;
    const result: Record<string, unknown> = {};
    for (const { relation } of tables) result[relation] = (await db.query(`select count(*)::integer count,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text),'')) digest from ${relation} t`)).rows;
    return result;
  }
  async function prepare() {
    projects = await resetMultiAccountFixture(db); oldProject = (await seedProject(db, OWNER_B)).id;
    await enableSyntheticCohort(db);
    const trial = await admit(db, OWNER_B, projects.b, "synthetic-trial-before-testing");
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_job_cancel($1)", [trial.id]));
    await db.query("update fluid_private.api_text_allowance_cohorts set operations=$1", [operations]);
    for (const operation of operations) {
      const approved = guidedStrategyPolicy(operation);
      await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'fixture',$2,true)", [OWNER_B, operation]);
      await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2) on conflict(operation) do update set policy=excluded.policy", [operation, approved]);
      await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,$2,oid,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'),$4,true from pg_roles where rolname='fixture_api_text_a' on conflict(owner_id,operation) do update set policy_identity=excluded.policy_identity", [OWNER_B, operation, approved, MULTI_DEPLOYMENT]);
    }
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.append_project_revision($1,1,$2,$3)", [projects.b, context, HASH]));
    await db.query("update public.usage_accounts set limit_microusd=$2,spent_microusd=5002,provider_actual_microusd=5002 where owner_id=$1", [OWNER_B, accountLimit]);
  }
  beforeAll(async () => {
    db = await createTestDatabase({ before: migrationName }); await installApiTextWorkerFixture(db);
    await db.exec("alter table auth.users add column created_at timestamptz default clock_timestamp(),add column email_confirmed_at timestamptz; grant execute on function public.api_text_dispatch_action(jsonb,text,jsonb),public.list_api_text_dispatches_v2(integer),public.api_text_multi_account_readiness(jsonb,text) to fixture_api_text_a,fixture_api_text_b");
    await prepare(); await history(); await history({ operation: "identity.logo_concept", state: "failed" });
    // Reproduce the deployed bug with correct authority, no scoped pause, and
    // real retained usage; a larger recorded allowance rejects approved testing.
    expect((await db.query("select fluid_private.api_text_testing_project_scope($1,'strategy.competitors',$2) enabled,fluid_private.api_text_strategy_paused($1,'strategy.competitors',$2) paused", [OWNER_B, projects.b])).rows).toEqual([{ enabled: true, paused: false }]);
    expect(await availability(db, OWNER_B, projects.b)).toMatchObject({ status: "unavailable", reason: "budget_unavailable" });
    await expect(enqueue()).rejects.toThrow("runtime_unavailable");
    beforeData = await allData(); beforeSecurity = (await security()).rows;
    const migration = await readFile(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url), "utf8");
    await db.exec("alter function public.check_api_text_runtime(text,jsonb,text) security invoker");
    await expect(db.exec(migration)).rejects.toThrow("unexpected_strategy_ceiling_predecessor");
    await db.exec("rollback; alter function public.check_api_text_runtime(text,jsonb,text) security definer; create role fixture_ceiling_hostile nologin; alter default privileges in schema public,fluid_private grant execute on functions to fixture_ceiling_hostile");
    await db.exec(migration); afterData = await allData(); afterSecurity = (await security()).rows;
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
  }, 120_000);
  beforeEach(prepare, 30_000);
  afterAll(async () => { await db?.close(); });

  const enqueue = (accepted = policy.maximumCostMicrousd, owner = OWNER_B) => asRole(db, "authenticated", owner,
    async () => (await db.query<{ value: Admission }>("select public.enqueue_strategy_job($1,2,'strategy.competitors','synthetic-large-account-research',$2) value", [projects.b, accepted])).rows[0]!.value);
  const action = <T = unknown>(job: Admission, name: string, args: unknown[] = [], worker = OWNER_A) => asApiTextWorker(db, worker,
    async () => (await db.query<{ value: T }>("select public.api_text_dispatch_action($1,$2,$3) value", [job.dispatch, name, args])).rows[0]!.value);
  async function start(job: Admission) {
    const result = await action<{ disposition: string; job: { lease_token: string } }>(job, "claim", ["synthetic-ceiling-worker", 300]);
    expect(result.disposition).toBe("claimed"); const lease = result.job.lease_token;
    await action(job, "plan", [lease, [{ key: "guided", maximumCostMicrousd: policy.maximumCostMicrousd }]]);
    await action(job, "begin", [lease, "guided", `synthetic:${job.id}`, policy.maximumCostMicrousd]);
    return lease;
  }
  async function history(options: { operation?: string; project?: string; state?: string; actual?: number; reserved?: number } = {}) {
    const project = options.project ?? oldProject, id = randomUUID(), reserved = options.reserved ?? 100;
    await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd,actual_cost_microusd,error_code) values($1,$2,$3,$4,1,$5,'{}',$6,$7,$9,$8,'provider_request_rejected')", [id, OWNER_B, project, options.operation ?? "naming.generate", HASH, `synthetic-history:${id}`, options.state ?? "needs_reconciliation", options.actual ?? 0, reserved]);
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values($1,$2,$3,'synthetic','synthetic','ambiguous',$4)", [id, OWNER_B, project, reserved]);
    await db.query("insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) values($1,$2,$3,$4)", [id, OWNER_B, project, reserved]);
    await db.query("update public.usage_accounts set reserved_microusd=reserved_microusd+$2 where owner_id=$1", [OWNER_B, reserved]);
    return id;
  }
  const retained = (ids: string[]) => db.query("select to_jsonb(j) job,to_jsonb(s) step,to_jsonb(r) reservation from public.jobs j left join public.job_steps s on s.job_id=j.id left join public.usage_reservations r on r.job_id=j.id where j.id=any($1::uuid[]) order by j.id", [ids]);
  const account = () => db.query<{ limit_microusd: number; spent_microusd: number; provider_actual_microusd: number; reserved_microusd: number }>("select limit_microusd,spent_microusd,provider_actual_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_B]);

  it("preserves all application rows and existing function identities/ACLs even with hostile defaults", () => {
    expect(afterData).toEqual(beforeData); expect(afterSecurity).toEqual(beforeSecurity);
  });

  it.each(["remaining allowance", "exhausted aggregate allowance"])("executes availability through settlement with %s and unrelated historical holds", async mode => {
    const ids = [await history({ reserved: mode === "exhausted aggregate allowance" ? 40_000_000 : 100 }), await history({ operation: "identity.logo_concept", state: "failed" })];
    if (mode === "exhausted aggregate allowance") await db.query("update public.usage_accounts set spent_microusd=30000000,provider_actual_microusd=30000000 where owner_id=$1", [OWNER_B]);
    const original = await retained(ids); const originalAccount = (await account()).rows[0]!;
    expect((await availability(db, OWNER_B, projects.b)).operations).toContainEqual(expect.objectContaining({ operation: "strategy.competitors", maximumCostMicrousd: policy.maximumCostMicrousd }));
    const job = await enqueue(); expect(await enqueue()).toEqual(job);
    expect(await action(job, "descriptor")).toMatchObject({ retryable: true });
    const listed = await asApiTextWorker(db, OWNER_A, () => db.query<{ value: { jobId: string; retryable: boolean } }>("select public.list_api_text_dispatches_v2(25) value"));
    expect(listed.rows.map(row => row.value)).toContainEqual(expect.objectContaining({ jobId: job.id, retryable: true }));
    const lease = await start(job);
    expect(await action(job, "runtime", ["strategy.competitors", policy])).toBe(true);
    expect(await action(job, "authorize", [lease, "guided"])).toBe(true);
    await action(job, "complete", [lease, "guided", "succeeded", 10, {}, "resp_synthetic_ceiling"]);
    await action(job, "finish", [lease, "succeeded", null]);
    expect(await retained(ids)).toEqual(original);
    expect((await account()).rows).toEqual([{ ...originalAccount, spent_microusd: Number(originalAccount.spent_microusd) + 10, provider_actual_microusd: Number(originalAccount.provider_actual_microusd) + 10 }]);
    expect((await db.query("select reserved_microusd,actual_microusd,state from public.usage_reservations where job_id=$1", [job.id])).rows).toEqual([{ reserved_microusd: policy.maximumCostMicrousd, actual_microusd: 10, state: "settled" }]);
    expect((await db.query("select * from fluid_private.api_text_gateway_context")).rows).toEqual([]);
    expect((await db.query("select * from fluid_private.api_text_testing_admission_context")).rows).toEqual([]);
  });

  it.each(["disabled", "missing"])("does not exempt a large account with %s testing authority", async mode => {
    if (mode === "disabled") await db.query("update fluid_private.api_text_testing_access set enabled=false where owner_id=$1", [OWNER_B]);
    else await db.query("delete from fluid_private.api_text_testing_access where owner_id=$1", [OWNER_B]);
    const before = await allData();
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(enqueue()).rejects.toThrow(); expect(await allData()).toEqual(before);
  });

  it("keeps ordinary allowances bounded both above the ceiling and when their normal quota is exhausted", async () => {
    projects = await resetMultiAccountFixture(db); await enableSyntheticCohort(db, { attempts: 2, ownerCost: 245760 });
    const first = await admit(db, OWNER_B, projects.b);
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_job_cancel($1)", [first.id]));
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
    await db.query("update public.usage_accounts set limit_microusd=$2 where owner_id=$1", [OWNER_B, accountLimit]);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(admit(db, OWNER_B, projects.b, "synthetic-ordinary-large-account")).rejects.toThrow();
    await db.query("update public.usage_accounts set limit_microusd=245760,spent_microusd=245760,provider_actual_microusd=245760 where owner_id=$1", [OWNER_B]);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(admit(db, OWNER_B, projects.b, "synthetic-ordinary-exhausted-account")).rejects.toThrow();
  });

  it("does not give an existing unmarked ordinary job testing authority after a grant", async () => {
    projects = await resetMultiAccountFixture(db); await enableSyntheticCohort(db, { attempts: 2, ownerCost: 245760 });
    const oldJob = await admit(db, OWNER_B, projects.b);
    await db.query("update public.usage_accounts set limit_microusd=$2 where owner_id=$1", [OWNER_B, accountLimit]);
    await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'fixture','strategy.reformulate',true)", [OWNER_B]);
    expect((await db.query("select * from fluid_private.api_text_testing_admissions where job_id=$1", [oldJob.id])).rows).toEqual([]);
    expect(await action(oldJob, "descriptor")).toMatchObject({ retryable: false });
    expect(await action(oldJob, "claim", ["synthetic-unmarked-worker", 300])).toMatchObject({ disposition: "unavailable" });
  });

  it("retains exact project/owner and operation scope, including conservative null inspection", async () => {
    for (const project of [null, projects.a]) expect((await db.query("select fluid_private.api_text_project_allowance_available($1,'strategy.competitors',$2) value", [OWNER_B, project])).rows).toEqual([{ value: null }]);
    expect((await db.query("select fluid_private.api_text_allowance_available($1,'strategy.competitors') value", [OWNER_B])).rows).toEqual([{ value: null }]);
    await expect(enqueue(policy.maximumCostMicrousd, OWNER_A)).rejects.toMatchObject({ code: "P0002" });
    await db.query("update fluid_private.api_text_testing_access set enabled=false where owner_id=$1 and operation='strategy.competitors'", [OWNER_B]);
    expect((await availability(db, OWNER_B, projects.b)).operations).not.toContainEqual(expect.objectContaining({ operation: "strategy.competitors" }));
    await expect(enqueue()).rejects.toThrow();
  });

  it("retains accepted and planned per-request maximum costs", async () => {
    await expect(enqueue(policy.maximumCostMicrousd - 1)).rejects.toThrow("accepted_cap_exceeded");
    const job = await enqueue();
    const claim = await action<{ job: { lease_token: string } }>(job, "claim", ["synthetic-bound-worker", 300]);
    const lease = claim.job.lease_token;
    await expect(action(job, "plan", [lease, [{ key: "guided", maximumCostMicrousd: policy.maximumCostMicrousd + 1 }]])).rejects.toThrow();
    await action(job, "plan", [lease, [{ key: "guided", maximumCostMicrousd: policy.maximumCostMicrousd }]]);
    await expect(action(job, "begin", [lease, "guided", "synthetic-oversized-step", policy.maximumCostMicrousd + 1])).rejects.toThrow();
  });

  it.each(["grant", "same-project-unknown", "other-strategy-unknown", "owner-overrun"])("rechecks %s immediately before dispatch despite the large retained allowance", async blocker => {
    const job = await enqueue(); const lease = await start(job);
    expect(await action(job, "authorize", [lease, "guided"])).toBe(true);
    if (blocker === "grant") await db.query("update fluid_private.api_text_testing_access set enabled=false where owner_id=$1 and operation='strategy.competitors'", [OWNER_B]);
    else if (blocker === "same-project-unknown") await history({ project: projects.b });
    else if (blocker === "other-strategy-unknown") await history({ operation: "strategy.audience" });
    else await history({ actual: 101 });
    expect(await action(job, "authorize", [lease, "guided"])).toBe(false);
  });

  it("does not grant a raw/forged worker or job-independent runtime any exception", async () => {
    const job = await enqueue(); const lease = await start(job);
    await expect(action(job, "runtime", ["strategy.competitors", policy], OWNER_B)).rejects.toThrow();
    await expect(action({ ...job, dispatch: { ...job.dispatch, deploymentId: "dpl_forged" } }, "authorize", [lease, "guided"])).rejects.toThrow();
    expect(await asApiTextWorker(db, OWNER_A, async () => (await db.query<{ value: boolean }>("select public.check_api_text_runtime('strategy.competitors',$1,$2) value", [policy, MULTI_DEPLOYMENT])).rows[0]!.value)).toBe(false);
    // Even a synthetic legacy principal for this exact owner cannot supply the
    // absent trusted gateway context or inherit the large-account exception.
    await db.query("update fluid_private.api_text_worker_principals set owner_id=$1 where role_name='fixture_api_text_a'", [OWNER_B]);
    expect(await asApiTextWorker(db, OWNER_A, async () => (await db.query<{ value: boolean }>("select public.check_api_text_runtime('strategy.competitors',$1,$2) value", [policy, MULTI_DEPLOYMENT])).rows[0]!.value)).toBe(false);
    expect(await asApiTextWorker(db, OWNER_A, async () => (await db.query<{ value: boolean }>("select public.authorize_api_text_dispatch($1,$2,'guided',$3,$4) value", [job.id, lease, job.dispatch.policyIdentity, MULTI_DEPLOYMENT])).rows[0]!.value)).toBe(false);
    expect(await action(job, "authorize", [lease, "guided"])).toBe(true);
  });
});
