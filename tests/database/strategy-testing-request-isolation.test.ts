import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000 });
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { asApiTextWorker, asRole, createTestDatabase, HASH, installApiTextWorkerFixture, OWNER_A, OWNER_B, seedProject, type TestDatabase } from "./local-supabase";
import { admit, availability, enableSyntheticCohort, MULTI_DEPLOYMENT, resetMultiAccountFixture } from "./api-text-multi-account-fixture";
import { installBrainFixture, seedBrainFixture, startBrainFixture } from "./naming-brain-fixture";

const migrationName = "20261019223706_strategy_testing_request_isolation.sql";
const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"] as const;
type Operation = typeof operations[number];
type Admission = Awaited<ReturnType<typeof admit>>;
const context = contextSnapshotSchema.parse({ description: "Synthetic cross-feature Strategy regression", intake: {
  conversation: [{ id: "synthetic-prompt", kind: "user_message", text: "Synthetic competitor research", createdAt: "2026-10-19T12:00:00.000Z" }],
  guidedInterview: { version: 1, stage: "competitors", turns: [{ id: "synthetic-turn", userMessageId: "synthetic-prompt", stage: "competitors", purpose: "research", inputRevision: 2 }], answers: [] },
} });

/** Full migration replay and actual role/RPC execution in disposable PostgreSQL.
 * Historical jobs are explicit synthetic fixtures. No provider or hosted writes. */
describe("hosted Strategy testing request isolation", () => {
  let db: TestDatabase; let projects: { a: string; b: string }; let oldProject: string;
  let beforeSecurity: Array<{ oid: number }>; let afterSecurity: Array<{ oid: number }>;
  let beforeData: Record<string, unknown>; let afterData: Record<string, unknown>;
  const security = async () => (await db.query<{ oid: number }>("select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc where pronamespace in ('public'::regnamespace,'fluid_private'::regnamespace) order by oid")).rows;
  async function allData() {
    const tables = (await db.query<{ relation: string }>("select c.oid::regclass::text relation from pg_class c where c.relnamespace in ('public'::regnamespace,'fluid_private'::regnamespace) and c.relkind='r' order by 1")).rows;
    const result: Record<string, unknown> = {};
    for (const { relation } of tables) result[relation] = (await db.query(`select count(*)::integer count,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text),'')) digest from ${relation} t`)).rows;
    return result;
  }
  beforeAll(async () => {
    db = await createTestDatabase({ before: migrationName });
    await installApiTextWorkerFixture(db);
    await installBrainFixture(db);
    await db.exec("alter table auth.users add column created_at timestamptz default clock_timestamp(),add column email_confirmed_at timestamptz; grant execute on function public.api_text_dispatch_action(jsonb,text,jsonb),public.list_api_text_dispatches_v2(integer),public.api_text_multi_account_readiness(jsonb,text) to fixture_api_text_a,fixture_api_text_b");
    projects = await resetMultiAccountFixture(db); oldProject = (await seedProject(db, OWNER_B)).id;
    await history(); await history({ operation: "identity.logo_concept", state: "failed", code: "publication_not_committed" });
    beforeData = await allData();
    const migration = await readFile(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url), "utf8");
    beforeSecurity = await security();
    await db.exec("alter function public.check_api_text_runtime(text,jsonb,text) security invoker");
    await expect(db.exec(migration)).rejects.toThrow("unexpected_strategy_isolation_predecessor");
    await db.exec("rollback; alter function public.check_api_text_runtime(text,jsonb,text) security definer; create role fixture_isolation_hostile nologin; alter default privileges in schema fluid_private grant execute on functions to fixture_isolation_hostile");
    await db.exec(migration); afterSecurity = await security(); afterData = await allData();
  }, 120_000);
  beforeEach(async () => {
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
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.append_project_revision($1,1,$2,$3)", [projects.b, context, HASH]));
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  const enqueue = (project = projects.b, key = "synthetic-isolated-research", operation: Operation = "strategy.competitors", owner = OWNER_B) => asRole(db, "authenticated", owner,
    async () => (await db.query<{ value: Admission }>("select public.enqueue_strategy_job($1,2,$2,$3,$4) value", [project, operation, key, guidedStrategyPolicy(operation).maximumCostMicrousd])).rows[0]!.value);
  const action = <T = unknown>(job: Admission, name: string, args: unknown[] = [], worker = OWNER_A) => asApiTextWorker(db, worker,
    async () => (await db.query<{ value: T }>("select public.api_text_dispatch_action($1,$2,$3) value", [job.dispatch, name, args])).rows[0]!.value);
  async function start(job: Admission, begin = true) {
    expect(await action(job, "descriptor")).toMatchObject({ retryable: true });
    const result = await action<{ disposition: string; job: { lease_token: string } }>(job, "claim", ["synthetic-isolation-worker", 300]);
    expect(result.disposition).toBe("claimed"); const lease = result.job.lease_token;
    await action(job, "plan", [lease, [{ key: "guided", maximumCostMicrousd: guidedStrategyPolicy("strategy.competitors").maximumCostMicrousd }]]);
    if (begin) await action(job, "begin", [lease, "guided", `synthetic:${job.id}`, guidedStrategyPolicy("strategy.competitors").maximumCostMicrousd]);
    return lease;
  }
  async function history(options: { operation?: string; project?: string; owner?: string; state?: string; ambiguous?: boolean; actual?: number; code?: string } = {}) {
    const owner = options.owner ?? OWNER_B, project = options.project ?? oldProject, id = randomUUID();
    await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd,actual_cost_microusd,error_code) values($1,$2,$3,$4,1,$5,'{}',$6,$7,100,$8,$9)",
      [id, owner, project, options.operation ?? "naming.generate", HASH, `synthetic-history:${id}`, options.state ?? "needs_reconciliation", options.actual ?? 0, options.code ?? "provider_request_rejected"]);
    if (options.ambiguous !== false) await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values($1,$2,$3,'synthetic','synthetic','ambiguous',100)", [id, owner, project]);
    await db.query("insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) values($1,$2,$3,100)", [id, owner, project]);
    await db.query("update public.usage_accounts set reserved_microusd=reserved_microusd+100 where owner_id=$1", [owner]);
    return id;
  }
  const historySnapshot = (ids: string[]) => db.query("select to_jsonb(j) job,to_jsonb(s) step,to_jsonb(r) reservation from public.jobs j left join public.job_steps s on s.job_id=j.id left join public.usage_reservations r on r.job_id=j.id where j.id=any($1::uuid[]) order by j.id", [ids]);
  const paused = (project: string | null = projects.b, operation = "strategy.competitors") => db.query<{ value: boolean }>("select fluid_private.api_text_strategy_paused($1,$2,$3) value", [OWNER_B, operation, project]);

  it("preserves existing function identities/security and denies new helpers despite hostile defaults", async () => {
    expect(afterData).toEqual(beforeData);
    expect(afterSecurity.filter(row => beforeSecurity.some(before => before.oid === row.oid))).toEqual(beforeSecurity);
    for (const role of ["anon", "authenticated", "service_role", "fixture_api_text_a", "fixture_isolation_hostile"])
      for (const signature of ["api_text_strategy_outcome_resolved(uuid)", "api_text_testing_project_scope(uuid,text,uuid)", "api_text_strategy_paused(uuid,text,uuid)", "api_text_strategy_runtime_paused(uuid,text,jsonb,text)", "api_text_project_allowance_available(uuid,text,uuid)"])
        expect((await db.query<{ ok: boolean }>("select has_function_privilege($1,$2,'EXECUTE') ok", [role, `fluid_private.${signature}`])).rows[0]!.ok).toBe(false);
  });

  it("admits and executes research across unrelated Naming/Logo uncertainty without changing their history or holds", async () => {
    const ids = [await history(), await history({ operation: "identity.logo_concept", state: "failed", code: "publication_not_committed" })];
    const before = await historySnapshot(ids);
    expect((await db.query<{ value: boolean }>("select fluid_private.api_text_paid_paused($1) value", [OWNER_B])).rows[0]!.value).toBe(true);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
    const job = await enqueue(); expect(await enqueue()).toEqual(job);
    const lease = await start(job);
    expect(await action(job, "runtime", ["strategy.competitors", guidedStrategyPolicy("strategy.competitors")])).toBe(true);
    expect(await action(job, "authorize", [lease, "guided"])).toBe(true);
    await action(job, "complete", [lease, "guided", "succeeded", 10, {}, "resp_synthetic_isolation"]);
    await action(job, "finish", [lease, "succeeded", null]);
    expect(await historySnapshot(ids)).toEqual(before);
    expect((await db.query("select * from fluid_private.api_text_gateway_context")).rows).toEqual([]);
    expect((await db.query("select actual_microusd,state from public.usage_reservations where job_id=$1", [job.id])).rows).toEqual([{ actual_microusd: 10, state: "settled" }]);
  });

  it.each(["naming.generate", "identity.logo_concept"])("keeps same-project %s uncertainty blocked and reports its actual cause", async operation => {
    await history({ project: projects.b, operation });
    expect(await availability(db, OWNER_B, projects.b)).toMatchObject({ status: "unavailable", reason: "request_unresolved" });
    await expect(enqueue()).rejects.toThrow();
  });

  it("keeps unresolved Strategy anywhere on the account blocking every Strategy operation", async () => {
    await history({ operation: "strategy.personality" });
    for (const operation of operations) expect((await paused(projects.b, operation)).rows[0]!.value).toBe(true);
    expect(await availability(db, OWNER_B, projects.b)).toMatchObject({ reason: "request_unresolved" });
    await expect(enqueue()).rejects.toThrow();
  });

  it.each([{ actual: 101 }, { code: "cost_overrun" }, { code: "provider_cost_exceeded" }])("retains owner-wide confirmed overrun blocks: %j", async overrun => {
    await history(overrun); expect((await paused()).rows[0]!.value).toBe(true);
    await expect(enqueue()).rejects.toThrow();
  });

  it("keeps provider-observed Naming overruns blocking before a final job cost is known", async () => {
    const namingProject = await seedBrainFixture(db);
    const run = await startBrainFixture(db, namingProject);
    const strategyProject = (await seedProject(db, OWNER_A)).id;
    await db.query("insert into fluid_private.api_text_owner_entitlements(owner_id,cohort_id,attempt_limit,cost_limit,active_limit,expires_at) values($1,'fixture',1,122880,1,clock_timestamp()+interval '1 day')", [OWNER_A]);
    await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'fixture','strategy.competitors',true)", [OWNER_A]);
    const check = () => db.query<{ value: boolean }>("select fluid_private.api_text_strategy_paused($1,'strategy.competitors',$2) value", [OWNER_A, strategyProject]);
    expect((await check()).rows[0]!.value).toBe(false);
    await db.query("update fluid_private.naming_brain_runs set observed_overrun=true where job_id=$1", [run.id]);
    expect((await db.query("select state,actual_cost_microusd from public.jobs where id=$1", [run.id])).rows).toEqual([{ state: "running", actual_cost_microusd: 0 }]);
    expect((await check()).rows[0]!.value).toBe(true);
  });

  it("keeps null/foreign project and ordinary accounts conservative without disclosing another owner's project", async () => {
    await history();
    expect((await paused(null)).rows[0]!.value).toBe(true);
    expect((await paused(projects.a)).rows[0]!.value).toBe(true);
    await expect(availability(db, OWNER_A, projects.b)).rejects.toMatchObject({ code: "P0002" });
    await expect(enqueue(projects.b, "synthetic-foreign-enqueue", "strategy.competitors", OWNER_A)).rejects.toThrow();
    await db.query("update fluid_private.api_text_testing_access set enabled=false where owner_id=$1", [OWNER_B]);
    expect((await paused()).rows[0]!.value).toBe(true);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(enqueue()).rejects.toThrow();
  });

  it.each(["same-project", "strategy-other-project"])("preserves the single relevant active slot: %s", async mode => {
    await history({ project: mode === "same-project" ? projects.b : oldProject, operation: mode === "same-project" ? "naming.generate" : "strategy.audience", state: "queued", ambiguous: false });
    expect(await availability(db, OWNER_B, projects.b)).toMatchObject({ reason: "request_active" });
    await expect(enqueue()).rejects.toThrow();
  });

  it("ignores another owner's uncertain requests", async () => {
    await history({ owner: OWNER_A, project: projects.a, operation: "strategy.competitors" });
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
    expect((await enqueue()).id).toBeTruthy();
  });

  it.each(["after-admission", "after-claim", "after-begin"])("rechecks new same-project uncertainty %s", async when => {
    const job = await enqueue(); let lease: string | undefined;
    if (when !== "after-admission") lease = await start(job, when === "after-begin");
    await history({ project: projects.b });
    if (when === "after-admission") expect(await action(job, "claim", ["synthetic-worker", 300])).toMatchObject({ disposition: "unavailable" });
    else if (when === "after-claim") await expect(action(job, "begin", [lease, "guided", `synthetic:${job.id}`, guidedStrategyPolicy("strategy.competitors").maximumCostMicrousd])).rejects.toThrow("runtime_unavailable");
    else expect(await action(job, "authorize", [lease, "guided"])).toBe(false);
    expect((await enqueue()).id).toBe(job.id); // Exact replay observes, never replaces.
  });

  it("requires exact gateway, worker, policy and deployment and denies raw step execution", async () => {
    await history(); const job = await enqueue();
    await expect(action(job, "claim", ["synthetic-worker", 300], OWNER_B)).rejects.toThrow();
    for (const change of [{ deploymentId: "dpl_forged" }, { policyIdentity: "f".repeat(64) }])
      await expect(action({ ...job, dispatch: { ...job.dispatch, ...change } }, "claim", ["synthetic-worker", 300])).rejects.toThrow();
    const lease = await start(job, false);
    await expect(asApiTextWorker(db, OWNER_A, () => db.query("select public.begin_job_step($1,$2,'guided','synthetic-raw',15892880)", [job.id, lease]))).rejects.toThrow();
    await expect(action(job, "runtime", ["strategy.competitors", { ...guidedStrategyPolicy("strategy.competitors"), model: "forged" }])).rejects.toThrow();
    await action(job, "begin", [lease, "guided", `synthetic:${job.id}`, 15892880]);
    expect(await action(job, "authorize", [lease, "guided"])).toBe(true);
    await db.query("update fluid_private.api_text_testing_access set enabled=false where owner_id=$1 and operation='strategy.competitors'", [OWNER_B]);
    expect(await action(job, "authorize", [lease, "guided"])).toBe(false);
  });
});
