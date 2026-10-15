import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// Full synthetic admission/dispatch/settlement workflows can exceed the
// repository's 15-second default on cold shared runners. No provider is used.
vi.setConfig({ testTimeout: 60_000 });
import { asApiTextWorker, asRole, HASH, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { admit, availability, createMultiAccountFixture, enableLegacyOwner, enableSyntheticCohort,
  multiAccountSnapshot, MULTI_DEPLOYMENT, MULTI_POLICY, resetMultiAccountFixture } from "./api-text-multi-account-fixture";

const migration = new URL("../../supabase/migrations/20261014142522_api_text_unlimited_testing.sql", import.meta.url);
type Admission = Awaited<ReturnType<typeof admit>>;
const modifiedNames = ["api_text_policy_allowed", "api_text_allowance_available", "enqueue_strategy_job", "enqueue_job",
  "check_api_text_runtime", "api_text_descriptor", "begin_job_step", "api_text_multi_account_readiness", "claim_api_text_job", "authorize_api_text_dispatch"];

/** Disposable, synthetic database only. No provider, hosted DB or real account. */
describe("operator-granted unlimited aggregate text testing", () => {
  let db: TestDatabase;
  let projects: { a: string; b: string };
  let existingSecurity: unknown;
  let afterSecurity: unknown;
  const security = () => db.query(`select p.oid,n.nspname,p.proname,p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname=any($1::text[]) order by p.oid`, [modifiedNames]);
  beforeAll(async () => {
    db = await createMultiAccountFixture();
    existingSecurity = (await security()).rows;
    await db.exec("create role fixture_testing_hostile nologin; alter default privileges in schema public,fluid_private grant execute on functions to fixture_testing_hostile; alter default privileges in schema fluid_private grant all on tables to fixture_testing_hostile");
    await db.exec(await readFile(migration, "utf8"));
    afterSecurity = (await security()).rows;
  }, 300_000);
  // Reset traverses the whole disposable schema; bound cold fixture cleanup
  // separately from each admission/dispatch assertion's normal deadline.
  beforeEach(async () => { projects = await resetMultiAccountFixture(db); }, 30_000);
  afterAll(async () => { await db?.close(); }, 30_000);

  const action = async <T = unknown>(admitted: Admission, name: string, args: unknown[] = []) => asApiTextWorker(db, OWNER_A,
    async () => (await db.query<{ result: T }>("select public.api_text_dispatch_action($1,$2,$3) result", [admitted.dispatch, name, args])).rows[0]!.result);
  async function start(admitted: Admission) {
    const claim = await action<{ disposition: string; job: { lease_token: string } }>(admitted, "claim", ["synthetic-testing-worker", 300]);
    expect(claim.disposition).toBe("claimed");
    const lease = claim.job.lease_token;
    await action(admitted, "plan", [lease, [{ key: "respond", maximumCostMicrousd: 122880 }]]);
    await action(admitted, "begin", [lease, "respond", `synthetic-response:${admitted.id}`, 122880]);
    return lease;
  }
  async function finish(admitted: Admission, lease: string, cost = 1858) {
    await action(admitted, "complete", [lease, "respond", "succeeded", cost, {}, `synthetic-provider:${admitted.id}`]);
    await action(admitted, "finish", [lease, "succeeded", null]);
  }
  async function exhaustedOwner() {
    await enableSyntheticCohort(db, { globalAttempts: 1, globalCost: 122880, accounts: 1 });
    await db.exec("update fluid_private.api_text_allowance_cohorts set attempt_limit=1,cost_limit=122880,account_limit=1");
    const trial = await admit(db, OWNER_B, projects.b, "synthetic-original-one-trial");
    await finish(trial, await start(trial));
    return trial;
  }
  async function grantTesting() {
    await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,enabled) values($1,'fixture',true)", [OWNER_B]);
  }
  async function expiredAndOverspent() {
    const trial = await exhaustedOwner();
    await grantTesting();
    await db.exec("update fluid_private.api_text_allowance_cohorts set expires_at=clock_timestamp()-interval '1 hour'; update fluid_private.api_text_owner_entitlements set expires_at=clock_timestamp()-interval '1 hour'");
    // Deliberately synthetic accumulated usage above both the original account
    // allowance and the old $5 ceiling; the production migration changes neither.
    await db.query("update public.usage_accounts set spent_microusd=6000001,provider_actual_microusd=6000001 where owner_id=$1", [OWNER_B]);
    return trial;
  }
  async function counters() {
    const result: Record<string, unknown> = {};
    for (const table of ["api_text_allowance_rollout", "api_text_allowance_cohorts", "api_text_owner_entitlements"])
      result[table] = (await db.query(`select to_jsonb(t) value from fluid_private.${table} t order by to_jsonb(t)::text`)).rows;
    return result;
  }
  async function snapshot() {
    return { ...await multiAccountSnapshot(db), testingAccess: (await db.query("select * from fluid_private.api_text_testing_access order by owner_id")).rows,
      testingAdmissions: (await db.query("select * from fluid_private.api_text_testing_admissions order by job_id")).rows,
      testingContext: (await db.query("select * from fluid_private.api_text_testing_admission_context")).rows };
  }
  async function emptyContexts() {
    expect((await db.query("select * from fluid_private.api_text_testing_admission_context")).rows).toEqual([]);
    expect((await db.query("select * from fluid_private.api_text_gateway_context")).rows).toEqual([]);
  }

  it("changes no existing ACL/security metadata and denies all new capabilities despite hostile defaults", async () => {
    expect(afterSecurity).toEqual(existingSecurity);
    expect((await db.query("select * from fluid_private.api_text_testing_access")).rows).toEqual([]);
    const tables = ["api_text_testing_access", "api_text_testing_admissions", "api_text_testing_admission_context"];
    const functions = ["api_text_testing_enabled(uuid,text)", "api_text_testing_enqueue_matches(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)",
      "api_text_testing_job_allowed(uuid)", "api_text_testing_gateway_matches(uuid,text,jsonb,text,uuid)"];
    for (const role of ["anon", "authenticated", "service_role", "fixture_api_text_a", "fixture_api_text_b", "fixture_testing_hostile"]) {
      for (const table of tables) expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role, `fluid_private.${table}`])).rows[0]!.allowed).toBe(false);
      for (const fn of functions) expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, `fluid_private.${fn}`])).rows[0]!.allowed).toBe(false);
    }
    expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where relname=any($1::text[])", [tables])).rows)
      .toEqual(tables.map(() => ({ relrowsecurity: true, relforcerowsecurity: true })));
  });

  it("does not auto-enroll an owner and defaults an operator-created access row to disabled", async () => {
    await expect(db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id) values($1,'fixture')", [OWNER_B])).rejects.toThrow();
    await exhaustedOwner();
    await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id) values($1,'fixture')", [OWNER_B]);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(admit(db, OWNER_B, projects.b)).rejects.toThrow();
    await asRole(db, "authenticated", OWNER_B, async () => {
      await expect(db.query("update fluid_private.api_text_testing_access set enabled=true where owner_id=$1", [OWNER_B])).rejects.toThrow();
      await expect(db.query("select fluid_private.api_text_testing_enabled($1,'strategy.reformulate')", [OWNER_B])).rejects.toThrow();
    });
    expect((await db.query("select enabled from fluid_private.api_text_testing_access")).rows).toEqual([{ enabled: false }]);
  });

  it("keeps repeated bounded requests working after all trial caps, expiry and $5 accumulated spend, recording every actual cost", async () => {
    const trial = await expiredAndOverspent();
    const originalAdmission = (await db.query("select * from fluid_private.api_text_allowance_admissions where job_id=$1", [trial.id])).rows;
    const originalCounters = await counters();
    const beforeRead = await snapshot();
    expect(await availability(db, OWNER_B, projects.b)).toEqual({ status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 122880 }] });
    expect(await snapshot()).toEqual(beforeRead);
    expect((await availability(db, OWNER_A, projects.a)).status).toBe("unavailable");
    await expect(admit(db, OWNER_A, projects.a)).rejects.toThrow();
    const readiness = await asApiTextWorker(db, OWNER_A, () => db.query("select * from public.api_text_multi_account_readiness($1,$2)", [[{ operation: "strategy.reformulate", policy: MULTI_POLICY }], MULTI_DEPLOYMENT]));
    expect(readiness.rows).toEqual([{ operation: "strategy.reformulate", ready: true }]);
    for (let index = 0; index < 3; index++) {
      const admitted = await admit(db, OWNER_B, projects.b, `synthetic-continuing-test-${index}`);
      expect(await action(admitted, "descriptor")).toMatchObject({ jobId: admitted.id, state: "queued", retryable: true });
      expect(await action(admitted, "runtime", ["strategy.reformulate", MULTI_POLICY])).toBe(true);
      const listed = await asApiTextWorker(db, OWNER_A, () => db.query<{ result: { jobId: string } }>("select public.list_api_text_dispatches_v2(25) result"));
      expect(listed.rows.map(row => row.result.jobId)).toContain(admitted.id);
      const legacyList = await asApiTextWorker(db, OWNER_A, () => db.query("select public.list_pending_api_text_dispatches(25) result"));
      expect(legacyList.rows).toEqual([]);
      const lease = await start(admitted);
      expect(await action(admitted, "authorize", [lease, "respond"])).toBe(true);
      await finish(admitted, lease, 1000);
      expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
      await emptyContexts();
    }
    expect(await counters()).toEqual(originalCounters);
    expect((await db.query("select limit_microusd,spent_microusd,provider_actual_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_B])).rows)
      .toEqual([{ limit_microusd: 122880, spent_microusd: 6003001, provider_actual_microusd: 6003001, reserved_microusd: 0 }]);
    expect((await db.query("select reserved_microusd,actual_microusd,captured_microusd,state from public.usage_reservations where job_id<>$1 order by job_id", [trial.id])).rows)
      .toEqual(Array.from({ length: 3 }, () => ({ reserved_microusd: 122880, actual_microusd: 1000, captured_microusd: 1000, state: "settled" })));
    expect((await db.query("select * from fluid_private.api_text_testing_admissions")).rows).toHaveLength(3);
    expect((await db.query("select * from fluid_private.api_text_allowance_admissions where job_id=$1", [trial.id])).rows).toEqual(originalAdmission);
    expect((await db.query("select * from fluid_private.api_text_testing_admissions where job_id=$1", [trial.id])).rows).toEqual([]);
  });

  it("enforces one active request and stable exact replay without consuming old counters", async () => {
    await expiredAndOverspent();
    const admitted = await admit(db, OWNER_B, projects.b);
    const before = await snapshot();
    expect(await admit(db, OWNER_B, projects.b)).toEqual(admitted);
    expect(await snapshot()).toEqual(before);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(admit(db, OWNER_B, projects.b, "synthetic-concurrent-second")).rejects.toThrow();
    await expect(admit(db, OWNER_B, projects.b, "multi-account-fixture-request", 122881)).rejects.toThrow("idempotency_conflict");
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_job_cancel($1)", [admitted.id]));
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
    await admit(db, OWNER_B, projects.b, "synthetic-after-cancellation");
  });

  it("rolls back every testing write on rejected admission and retains the per-request maximum and token policy", async () => {
    await expiredAndOverspent();
    const before = await snapshot();
    await expect(admit(db, OWNER_B, projects.b, "synthetic-rejected-accepted-cost", 1)).rejects.toThrow("accepted_cap_exceeded");
    expect(await snapshot()).toEqual(before);
    const admitted = await admit(db, OWNER_B, projects.b);
    const claimed = await action<{ job: { lease_token: string; reserved_cost_microusd: number; input: { policy: unknown } } }>(admitted, "claim", ["synthetic-worker", 300]);
    expect(claimed.job.reserved_cost_microusd).toBe(122880);
    expect(claimed.job.input.policy).toEqual(MULTI_POLICY);
    const lease = claimed.job.lease_token;
    await expect(action(admitted, "plan", [lease, [{ key: "respond", maximumCostMicrousd: 122881 }]])).rejects.toThrow();
    await action(admitted, "plan", [lease, [{ key: "respond", maximumCostMicrousd: 122880 }]]);
    await expect(action(admitted, "begin", [lease, "respond", "synthetic-request-key", 122881])).rejects.toThrow();
    await action(admitted, "begin", [lease, "respond", "synthetic-request-key", 122880]);
    await expect(action(admitted, "begin", [lease, "respond", "synthetic-request-key", 122880])).rejects.toThrow("step_already_started");
    await emptyContexts();
  });

  it("rolls back an inserted job, reservation and original admission if the immutable testing marker cannot be written", async () => {
    await expiredAndOverspent(); const before = await snapshot();
    await db.exec(`create function fluid_private.fixture_reject_testing_marker() returns trigger language plpgsql as $$
      begin raise exception 'synthetic_marker_failure'; end $$;
      create trigger fixture_reject_testing_marker before insert on fluid_private.api_text_testing_admissions
      for each row execute function fluid_private.fixture_reject_testing_marker()`);
    try { await expect(admit(db, OWNER_B, projects.b)).rejects.toThrow("synthetic_marker_failure"); }
    finally { await db.exec("drop trigger fixture_reject_testing_marker on fluid_private.api_text_testing_admissions; drop function fluid_private.fixture_reject_testing_marker()"); }
    expect(await snapshot()).toEqual(before);
    await emptyContexts();
  });

  it("does not grant aggregate bypass to a raw generic enqueue, another operation, or forged owner/session settings", async () => {
    await expiredAndOverspent();
    const before = await snapshot();
    const input = { version: 1, context: { description: "Explicit local fixture" }, policy: MULTI_POLICY, acceptedMaxCostMicrousd: 122880 };
    for (const operation of ["strategy.reformulate", "strategy.audience", "naming.generate", "identity.logo_concept"])
      await expect(asRole(db, "service_role", OWNER_B, () => db.query("select public.enqueue_job($1,$2,$3,1,$4,$5,'synthetic-raw-enqueue',122880,3)", [OWNER_B, projects.b, operation, HASH, input]))).rejects.toThrow("budget_exceeded");
    await asRole(db, "authenticated", OWNER_B, async () => {
      await db.query("select set_config('fluid.testing_enabled','true',false),set_config('fluid.owner_id',$1,false)", [OWNER_B]);
      for (const operation of ["strategy.audience", "strategy.personality", "strategy.positioning", "strategy.competitors"])
        await expect(db.query("select public.enqueue_strategy_job($1,1,$2,'synthetic-unsupported-operation',122880)", [projects.b, operation])).rejects.toThrow();
      await expect(db.query("select public.enqueue_strategy_job($1,1,'strategy.reformulate','synthetic-foreign-project',122880)", [projects.a])).rejects.toThrow("not_found");
      await expect(db.query("select public.enqueue_job($1,$2,'strategy.reformulate',1,$3,$4,'synthetic-raw-enqueue',122880,3)", [OWNER_B, projects.b, HASH, input])).rejects.toThrow();
    });
    expect(await snapshot()).toEqual(before);
  });

  it("keeps immutable markers and the exact descriptor/worker boundary", async () => {
    await expiredAndOverspent(); const admitted = await admit(db, OWNER_B, projects.b);
    for (const change of [{ jobId: crypto.randomUUID() }, { deploymentId: "dpl_other" }, { policyIdentity: "0".repeat(64) }, { dispatchIdentity: "0".repeat(64) }, { ownerId: OWNER_B }])
      await expect(action({ ...admitted, dispatch: { ...admitted.dispatch, ...change } }, "descriptor")).rejects.toThrow();
    await expect(asApiTextWorker(db, OWNER_B, () => db.query("select public.api_text_dispatch_action($1,'descriptor')", [admitted.dispatch]))).rejects.toThrow("worker_owner_mismatch");
    await expect(db.query("update fluid_private.api_text_testing_admissions set created_at=clock_timestamp() where job_id=$1", [admitted.id])).rejects.toThrow("immutable_allowance_admission");
    await expect(db.query("delete from fluid_private.api_text_testing_admissions where job_id=$1", [admitted.id])).rejects.toThrow("immutable_allowance_admission");
    await expect(db.query("delete from fluid_private.api_text_allowance_admissions where job_id=$1", [admitted.id])).rejects.toThrow("immutable_allowance_admission");
    await emptyContexts();
  });

  it.each([
    ["testing access", "update fluid_private.api_text_testing_access set enabled=false"],
    ["entitlement", "update fluid_private.api_text_owner_entitlements set enabled=false"],
    ["cohort", "update fluid_private.api_text_allowance_cohorts set enabled=false"],
    ["rollout", "update fluid_private.api_text_allowance_rollout set enabled=false"],
    ["binding", "update fluid_private.api_strategy_bindings set enabled=false"],
    ["runtime", "update fluid_private.strategy_runtime_policy set enabled=false"],
    ["billing route", "update fluid_private.strategy_billing_routes set billing_mode='chatgpt_subscription'"],
    ["bounded token policy", "update fluid_private.strategy_runtime_policy set policy=jsonb_set(policy,'{maxOutputTokens}','8192')"],
    ["deployment binding", "update fluid_private.api_strategy_bindings set deployment_id='dpl_other'"],
    ["worker role", "alter role fixture_api_text_a inherit"],
  ])("withdraws %s before further paid authorization while preserving settlement", async (_name, sql) => {
    await expiredAndOverspent(); const admitted = await admit(db, OWNER_B, projects.b); const lease = await start(admitted);
    expect(await action(admitted, "authorize", [lease, "respond"])).toBe(true);
    await db.exec(sql);
    if (_name === "worker role") {
      // An invalid principal cannot even enter the gateway. Restore it only to
      // record the outcome; access withdrawal is covered by the other cases.
      await expect(action(admitted, "authorize", [lease, "respond"])).rejects.toThrow("worker_owner_mismatch");
      await db.exec("alter role fixture_api_text_a noinherit; update fluid_private.api_text_testing_access set enabled=false");
    }
    expect(await action(admitted, "authorize", [lease, "respond"])).toBe(false);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(admit(db, OWNER_B, projects.b, "synthetic-after-access-withdrawal")).rejects.toThrow();
    await finish(admitted, lease, 900);
    expect(await action(admitted, "descriptor")).toMatchObject({ state: "succeeded" });
    expect((await admit(db, OWNER_B, projects.b)).id).toBe(admitted.id);
    expect((await db.query("select spent_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_B])).rows)
      .toEqual([{ spent_microusd: 6000901, reserved_microusd: 0 }]);
    await emptyContexts();
  });

  it.each(["queued", "running"])("requires current testing access and the exact gateway even with ordinary credit for a %s job", async state => {
    await exhaustedOwner(); await grantTesting();
    await db.query("update public.usage_accounts set limit_microusd=5000000 where owner_id=$1", [OWNER_B]);
    const admitted = await admit(db, OWNER_B, projects.b);
    // Synthetic legacy principal ownership exposes the direct-worker surface
    // for this account; testing jobs must still require their exact gateway.
    await db.query("update fluid_private.api_text_worker_principals set owner_id=$1 where role_name='fixture_api_text_a'", [OWNER_B]);
    const directClaim = () => asApiTextWorker(db, OWNER_A, async () => (await db.query<{ result: { disposition: string } }>(
      "select public.claim_api_text_job($1,'synthetic-direct-worker',300,$2,$3) result", [admitted.id, admitted.dispatch.policyIdentity, MULTI_DEPLOYMENT])).rows[0]!.result);
    expect(await directClaim()).toMatchObject({ disposition: "unavailable" });
    const directRuntime = () => asApiTextWorker(db, OWNER_A, async () => (await db.query<{ result: boolean }>(
      "select public.check_api_text_runtime('strategy.reformulate',$1,$2) result", [MULTI_POLICY, MULTI_DEPLOYMENT])).rows[0]!.result);
    expect(await directRuntime()).toBe(false);
    const lease = state === "running" ? await start(admitted) : null;
    if (lease) {
      expect(await action(admitted, "authorize", [lease, "respond"])).toBe(true);
      expect(await asApiTextWorker(db, OWNER_A, async () => (await db.query<{ result: boolean }>(
        "select public.authorize_api_text_dispatch($1,$2,'respond',$3,$4) result", [admitted.id, lease, admitted.dispatch.policyIdentity, MULTI_DEPLOYMENT])).rows[0]!.result)).toBe(false);
    }
    await db.exec("update fluid_private.api_text_testing_access set enabled=false");
    expect(await action(admitted, "runtime", ["strategy.reformulate", MULTI_POLICY])).toBe(false);
    expect(await action(admitted, "descriptor")).toMatchObject({ retryable: false });
    expect(await directRuntime()).toBe(false);
    if (lease) {
      expect(await action(admitted, "authorize", [lease, "respond"])).toBe(false);
      await finish(admitted, lease);
    } else {
      expect(await action(admitted, "claim", ["synthetic-worker", 300])).toMatchObject({ disposition: "unavailable" });
      expect(await directClaim()).toMatchObject({ disposition: "unavailable" });
      await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_job_cancel($1)", [admitted.id]));
    }
    await emptyContexts();
  });

  it.each(["ambiguous", "overrun"])("preserves the global and owner pause after %s while retaining real usage", async outcome => {
    await expiredAndOverspent(); const admitted = await admit(db, OWNER_B, projects.b); const lease = await start(admitted);
    const actual = outcome === "overrun" ? 122881 : 0;
    await action(admitted, "complete", [lease, "respond", outcome === "ambiguous" ? "ambiguous" : "succeeded", actual, {}, "synthetic-uncertain-response"]);
    expect(await action(admitted, "descriptor")).toMatchObject({ state: "needs_reconciliation", retryable: false });
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(admit(db, OWNER_B, projects.b, "synthetic-after-unresolved-result")).rejects.toThrow();
    expect(await action(admitted, "runtime", ["strategy.reformulate", MULTI_POLICY])).toBe(false);
    const readiness = await asApiTextWorker(db, OWNER_A, () => db.query("select * from public.api_text_multi_account_readiness($1,$2)", [[{ operation: "strategy.reformulate", policy: MULTI_POLICY }], MULTI_DEPLOYMENT]));
    expect(readiness.rows).toEqual([{ operation: "strategy.reformulate", ready: false }]);
    expect((await db.query<{ provider_actual_microusd: number }>("select provider_actual_microusd from public.usage_accounts where owner_id=$1", [OWNER_B])).rows[0]!.provider_actual_microusd).toBe(6000001 + actual);
    await emptyContexts();
  });

  it("preserves ordinary quotas and the configured legacy owner's direct worker path", async () => {
    await exhaustedOwner();
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(admit(db, OWNER_B, projects.b)).rejects.toThrow();
    await enableLegacyOwner(db);
    const admitted = await admit(db, OWNER_A, projects.a);
    expect((await db.query("select * from fluid_private.api_text_testing_admissions")).rows).toEqual([]);
    const claim = await asApiTextWorker(db, OWNER_A, () => db.query<{ result: { disposition: string; job: { lease_token: string } } }>("select public.claim_api_text_job($1,'synthetic-legacy-worker',300,$2,$3) result", [admitted.id, admitted.dispatch.policyIdentity, admitted.dispatch.deploymentId]));
    expect(claim.rows[0]!.result.disposition).toBe("claimed");
    const lease = claim.rows[0]!.result.job.lease_token;
    await asApiTextWorker(db, OWNER_A, async () => {
      await db.query("select public.register_job_plan($1,$2,$3)", [admitted.id, lease, [{ key: "respond", maximumCostMicrousd: 122880 }]]);
      await db.query("select public.begin_job_step($1,$2,'respond','synthetic-legacy-key',122880)", [admitted.id, lease]);
      await db.query("select public.complete_job_step($1,$2,'respond','succeeded',1000,'{}','synthetic-legacy-response')", [admitted.id, lease]);
      await db.query("select public.finish_job($1,$2,'succeeded',null)", [admitted.id, lease]);
    });
    expect((await db.query("select spent_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ spent_microusd: 1000, reserved_microusd: 0 }]);
  });
});
