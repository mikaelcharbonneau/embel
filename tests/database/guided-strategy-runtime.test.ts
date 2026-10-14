import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000 });
import { guidedStrategyPolicy, strategyPolicy } from "../../src/server/ai/config";
import { contextSnapshotSchema, type ContextSnapshot } from "../../src/domain/projects";
import { strategyJobInputSchema } from "../../src/domain/strategy-jobs";
import { asApiTextWorker, asRole, HASH, OWNER_A, OWNER_B, seedProject, type TestDatabase } from "./local-supabase";
import { admit, availability, createMultiAccountFixture, enableSyntheticCohort, MULTI_DEPLOYMENT, resetMultiAccountFixture } from "./api-text-multi-account-fixture";

const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"] as const;
type Operation = typeof operations[number];
const cost = 15_892_880;
type Admission = Awaited<ReturnType<typeof admit>>;
const at = "2026-10-14T12:00:00.000Z";

/** Disposable SQL and synthetic step results only. No hosted/provider access. */
describe("guided strategy private policy and frozen interview admission", () => {
  let db: TestDatabase; let projects: { a: string; b: string }; let beforeSecurity: unknown; let afterSecurity: unknown;
  const security = () => db.query("select p.oid,p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','fluid_private') order by p.oid");
  beforeAll(async () => {
    db = await createMultiAccountFixture();
    await db.exec(await readFile(new URL("../../supabase/migrations/20261014142522_api_text_unlimited_testing.sql", import.meta.url), "utf8"));
    beforeSecurity = (await security()).rows;
    await db.exec("create role fixture_guided_hostile nologin; alter default privileges in schema fluid_private grant execute on functions to fixture_guided_hostile");
    const migration = await readFile(new URL("../../supabase/migrations/20261014170000_guided_strategy_runtime.sql", import.meta.url), "utf8");
    await db.exec("alter function public.authorize_api_text_dispatch(uuid,uuid,text,text,text) security invoker");
    await expect(db.exec(migration)).rejects.toThrow("unexpected_guided_strategy_predecessor");
    await db.exec("rollback; alter function public.authorize_api_text_dispatch(uuid,uuid,text,text,text) security definer");
    await db.exec(migration);
    afterSecurity = (await security()).rows;
  }, 300_000);
  beforeEach(async () => { projects = await resetMultiAccountFixture(db); }, 30_000);
  afterAll(async () => { await db?.close(); }, 30_000);

  async function grant() {
    await enableSyntheticCohort(db, { globalAttempts: 1, globalCost: 122880, accounts: 1 });
    await db.exec("update fluid_private.api_text_allowance_cohorts set attempt_limit=1,cost_limit=122880,account_limit=1");
    const trial = await admit(db, OWNER_B, projects.b, "guided-consumed-old-trial");
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_job_cancel($1)", [trial.id]));
    await db.query("update fluid_private.api_text_allowance_cohorts set operations=$1,expires_at=clock_timestamp()-interval '1 hour'", [operations]);
    await db.exec("update fluid_private.api_text_allowance_rollout set signup_cohort=null; update fluid_private.api_text_owner_entitlements set expires_at=clock_timestamp()-interval '1 hour'");
    for (const operation of operations) {
      const policy = guidedStrategyPolicy(operation);
      await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'fixture',$2,true)", [OWNER_B, operation]);
      await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2) on conflict(operation) do update set policy=excluded.policy", [operation, policy]);
      await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,$2,oid,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'),$4,true from pg_roles where rolname='fixture_api_text_a' on conflict(owner_id,operation) do update set policy_identity=excluded.policy_identity", [OWNER_B, operation, policy, MULTI_DEPLOYMENT]);
    }
    await db.query("update public.usage_accounts set spent_microusd=6000001,provider_actual_microusd=6000001 where owner_id=$1", [OWNER_B]);
  }
  function context(revision = 2, stage: "competitors" | "audience" | "personality" = "competitors", purpose: "research" | "message" | "propose" = "research") {
    return contextSnapshotSchema.parse({ description: "Explicit synthetic interview", intake: {
      conversation: [{ id: "actual-user-message", kind: "user_message", text: "Synthetic workshop idea", createdAt: at }],
      guidedInterview: { version: 1, stage, turns: [{ id: `turn-${revision}`, userMessageId: "actual-user-message", stage, purpose, inputRevision: revision }], answers: [] },
    } });
  }
  async function save(value: unknown = context(), expected = 1) {
    return asRole(db, "authenticated", OWNER_B, () => db.query("select public.append_project_revision($1,$2,$3,$4)", [projects.b, expected, value, HASH]));
  }
  async function enqueue(operation: Operation = "strategy.competitors", accepted = guidedStrategyPolicy(operation).maximumCostMicrousd, revision = 2, key = "guided-synthetic-request") {
    return asRole(db, "authenticated", OWNER_B, async () => (await db.query<{ result: Admission }>("select public.enqueue_strategy_job($1,$2,$3,$4,$5) result", [projects.b, revision, operation, key, accepted])).rows[0]!.result);
  }
  async function action<T = unknown>(job: Admission, name: string, args: unknown[] = []) {
    return asApiTextWorker(db, OWNER_A, async () => (await db.query<{ result: T }>("select public.api_text_dispatch_action($1,$2,$3) result", [job.dispatch, name, args])).rows[0]!.result);
  }
  async function start(job: Admission, maximum = cost) {
    const claim = await action<{ disposition: string; job: { lease_token: string } }>(job, "claim", ["guided-synthetic-worker", 300]);
    expect(claim.disposition).toBe("claimed"); const lease = claim.job.lease_token;
    await action(job, "plan", [lease, [{ key: "guided", maximumCostMicrousd: maximum }]]);
    await action(job, "begin", [lease, "guided", `guided:${job.id}`, maximum]);
    return lease;
  }
  const counters = async () => (await db.query("select jsonb_build_object('rollout',(select to_jsonb(r) from fluid_private.api_text_allowance_rollout r),'cohort',(select to_jsonb(c) from fluid_private.api_text_allowance_cohorts c),'entitlement',(select to_jsonb(e) from fluid_private.api_text_owner_entitlements e)) value")).rows;

  it("preserves existing security metadata, grants nothing and requires explicit per-operation testing", async () => {
    const old = beforeSecurity as Array<{ oid: number }>; const next = afterSecurity as Array<{ oid: number }>;
    expect(next.filter(row => old.some(item => item.oid === row.oid))).toEqual(old);
    expect((await db.query("select * from fluid_private.api_text_testing_access")).rows).toEqual([]);
    for (const fn of ["api_text_guided_policy(text,jsonb)", "api_text_request_policy(uuid,text,jsonb)", "guided_interview_context(jsonb,jsonb)", "guided_api_strategy_input(uuid,uuid,integer,text,jsonb,bigint)"])
      for (const role of ["anon", "authenticated", "service_role", "fixture_api_text_a", "fixture_guided_hostile"])
        expect((await db.query<{ ok: boolean }>("select has_function_privilege($1,$2,'EXECUTE') ok", [role, `fluid_private.${fn}`])).rows[0]!.ok).toBe(false);
    await enableSyntheticCohort(db);
    expect(await availability(db, OWNER_B, projects.b)).toEqual({ status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 122880 }] });
    await save(); await expect(enqueue()).rejects.toThrow();
  });

  it("exposes exact guided capabilities only to the granted account and reserves the complete research bound", async () => {
    await grant(); await save(); const before = await counters();
    expect(await availability(db, OWNER_B, projects.b)).toEqual({ status: "available", operations: [...operations].sort().map(operation => ({ operation, maximumCostMicrousd: guidedStrategyPolicy(operation).maximumCostMicrousd, interviewVersion: 1 })) });
    const readiness = await asApiTextWorker(db, OWNER_A, () => db.query("select * from public.api_text_multi_account_readiness($1,$2)", [operations.map(operation => ({ operation, policy: guidedStrategyPolicy(operation) })), MULTI_DEPLOYMENT]));
    expect(readiness.rows).toEqual(operations.map(operation => ({ operation, ready: true })));
    expect((await availability(db, OWNER_A, projects.a)).status).toBe("unavailable");
    const job = await enqueue(); expect(await enqueue()).toEqual(job);
    const stored = (await db.query<{ input: unknown; reserved_cost_microusd: number }>("select input,reserved_cost_microusd from public.jobs where id=$1", [job.id])).rows[0]!;
    expect(stored.reserved_cost_microusd).toBe(cost); expect(strategyJobInputSchema.parse(stored.input)).toMatchObject({ version: 2, assistantHistory: { entries: [], truncated: false }, policy: guidedStrategyPolicy("strategy.competitors") });
    await expect(enqueue("strategy.competitors", cost, 2, "guided-second-active-request")).rejects.toThrow();
    expect(await action(job, "runtime", ["strategy.competitors", guidedStrategyPolicy("strategy.competitors")])).toBe(true);
    const lease = await start(job); expect(await action(job, "authorize", [lease, "guided"])).toBe(true);
    await action(job, "complete", [lease, "guided", "succeeded", 10691, {}, "resp_synthetic_guided"]);
    await action(job, "finish", [lease, "succeeded", null]);
    expect(await counters()).toEqual(before);
    expect((await db.query("select maximum_cost_microusd from fluid_private.api_text_allowance_admissions where job_id=$1", [job.id])).rows).toEqual([{ maximum_cost_microusd: cost }]);
    expect((await db.query("select reserved_microusd,actual_microusd,state from public.usage_reservations where job_id=$1", [job.id])).rows).toEqual([{ reserved_microusd: cost, actual_microusd: 10691, state: "settled" }]);
    expect((await db.query("select * from fluid_private.api_text_testing_admission_context")).rows).toEqual([]);
    expect((await db.query("select * from fluid_private.api_text_gateway_context")).rows).toEqual([]);
  });

  it("admits research directly from the initial owned revision", async () => {
    await grant();
    const first = await asRole(db, "authenticated", OWNER_B, async () => (await db.query<{ id: string }>("select * from public.create_project('complete_brand','Synthetic initial interview',$1,$2)", [context(1), HASH])).rows[0]!);
    const job = await asRole(db, "authenticated", OWNER_B, async () => (await db.query<{ result: Admission }>("select public.enqueue_strategy_job($1,1,'strategy.competitors','guided-first-revision',15892880) result", [first.id])).rows[0]!.result);
    expect((await db.query("select input_revision,input->'version' version from public.jobs where id=$1", [job.id])).rows).toEqual([{ input_revision: 1, version: 2 }]);
  });

  it.each(["strategy.reformulate", "strategy.audience", "strategy.personality"] as const)("retains the exact text reservation for guided %s", async operation => {
    await grant();
    const stage = operation === "strategy.reformulate" ? "competitors" : operation === "strategy.audience" ? "audience" : "personality";
    await save(context(2, stage, operation === "strategy.reformulate" ? "message" : "propose"));
    const job = await enqueue(operation); const lease = await start(job, 122880);
    expect(await action(job, "authorize", [lease, "guided"])).toBe(true);
    expect((await db.query("select maximum_cost_microusd from fluid_private.api_text_allowance_admissions where job_id=$1", [job.id])).rows).toEqual([{ maximum_cost_microusd: 122880 }]);
    const input = strategyJobInputSchema.parse((await db.query<{ input: unknown }>("select input from public.jobs where id=$1", [job.id])).rows[0]!.input);
    expect(input).toMatchObject({ version: 2, policy: guidedStrategyPolicy(operation) });
    await action(job, "complete", [lease, "guided", "succeeded", 691, {}, "resp_synthetic_guided_text"]);
    await action(job, "finish", [lease, "succeeded", null]);
  });

  it("rejects understated caps, changed policies, wrong turn operation and obsolete or foreign references", async () => {
    await grant(); await save();
    await expect(enqueue("strategy.competitors", cost - 1)).rejects.toThrow("accepted_cap_exceeded");
    await expect(enqueue("strategy.audience")).rejects.toThrow("guided_turn_conflict");
    await expect(enqueue("strategy.competitors", cost, 1)).rejects.toThrow();
    await expect(db.query("update fluid_private.strategy_runtime_policy set policy=jsonb_set(policy,'{maximumCostMicrousd}','1') where operation='strategy.competitors'")).rejects.toThrow();
    await asRole(db, "authenticated", OWNER_A, async () => {
      await expect(db.query("select public.enqueue_strategy_job($1,2,'strategy.competitors','guided-foreign-owner',15892880)", [projects.b])).rejects.toThrow("not_found");
      await expect(db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'fixture','strategy.competitors',true)", [OWNER_A])).rejects.toThrow();
    });
    const invalid = context(3); invalid.intake.guidedInterview!.turns[0]!.userMessageId = "forged-message";
    await save(invalid, 2); await expect(enqueue("strategy.competitors", cost, 3)).rejects.toThrow("invalid_guided_interview");
    expect((await db.query("select * from fluid_private.api_text_testing_admissions")).rows).toEqual([]);
  });

  it("retains the exact descriptor, role, lease and cost fences for research", async () => {
    await grant(); await save(); const job = await enqueue();
    for (const change of [{ deploymentId: "dpl_other" }, { policyIdentity: "0".repeat(64) }, { dispatchIdentity: "0".repeat(64) }, { ownerId: OWNER_B }])
      await expect(action({ ...job, dispatch: { ...job.dispatch, ...change } }, "descriptor")).rejects.toThrow();
    await expect(asApiTextWorker(db, OWNER_B, () => db.query("select public.api_text_dispatch_action($1,'descriptor')", [job.dispatch]))).rejects.toThrow("worker_owner_mismatch");
    const lease = await start(job);
    await expect(action(job, "authorize", [crypto.randomUUID(), "guided"])).rejects.toThrow();
    expect(await action(job, "authorize", [lease, "other-step"])).toBe(false);
    await expect(action(job, "plan", [lease, [{ key: "changed", maximumCostMicrousd: cost + 1 }]])).rejects.toThrow();
    await expect(db.query("update fluid_private.api_text_allowance_admissions set maximum_cost_microusd=122880 where job_id=$1", [job.id])).rejects.toThrow("immutable_allowance_admission");
  });

  it.each([
    ["operation grant", "update fluid_private.api_text_testing_access set enabled=false where operation='strategy.competitors'"],
    ["runtime", "update fluid_private.strategy_runtime_policy set enabled=false where operation='strategy.competitors'"],
    ["binding", "update fluid_private.api_strategy_bindings set enabled=false where operation='strategy.competitors'"],
    ["cohort", "update fluid_private.api_text_allowance_cohorts set enabled=false"],
  ])("withdraws %s before another dispatch while retaining settlement", async (_name, sql) => {
    await grant(); await save(); const job = await enqueue(); const lease = await start(job);
    await db.exec(sql); expect(await action(job, "authorize", [lease, "guided"])).toBe(false);
    await action(job, "complete", [lease, "guided", "succeeded", 10691, {}, "resp_synthetic_after_withdrawal"]);
    await action(job, "finish", [lease, "succeeded", null]);
    await expect(enqueue("strategy.competitors", cost, 2, "guided-after-withdrawal")).rejects.toThrow();
  });

  it("quarantines uncertain research without releasing or redispatching its reservation", async () => {
    await grant(); await save(); const job = await enqueue(); const lease = await start(job);
    await action(job, "complete", [lease, "guided", "ambiguous", 0, { partialText: "Synthetic incomplete research" }, null]);
    expect(await action(job, "descriptor")).toMatchObject({ state: "needs_reconciliation", retryable: false });
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    expect((await db.query("select reserved_microusd,state from public.usage_reservations where job_id=$1", [job.id])).rows).toEqual([{ reserved_microusd: cost, state: "active" }]);
    await expect(enqueue("strategy.competitors", cost, 2, "guided-after-uncertainty")).rejects.toThrow();
  });

  it("freezes only completed owned results with exact source identities and bounded history", async () => {
    await grant();
    async function source(project: string, owner: string, index: number, corrupt = false) {
      const responseId = `resp_synthetic_history_${index}`;
      const input = { version: 1, policy: strategyPolicy("strategy.reformulate") };
      const output = { version: 1, provider: "openai", operation: "strategy.reformulate", model: "gpt-6.1-sol", responseId,
        requestId: null, generatedAt: at, usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 },
        proposal: { message: `Synthetic history ${index}`, activity: "", offering: "", knownAudience: "", questions: [] } };
      const job = (await db.query<{ id: string }>("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,state,progress,finished_at) values($1,$2,'strategy.reformulate',1,$3,$4,$5,0,'succeeded',100,clock_timestamp()) returning id", [owner, project, HASH, input, `guided-history-source-${index}`])).rows[0]!;
      await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,provider_request_id,output,completed_at) values($1,$2,$3,'source',$4,'succeeded',0,$5,$6,clock_timestamp())", [job.id, owner, project, `history-${index}`, corrupt ? "resp_unmatched" : responseId, output]);
      return job.id;
    }
    const ids: string[] = [];
    for (let index = 0; index < 6; index++) ids.push(await source(projects.b, OWNER_B, index));
    await source(projects.a, OWNER_A, 7);
    const other = await seedProject(db, OWNER_B); await source(other.id, OWNER_B, 8);
    await source(projects.b, OWNER_B, 9, true);
    await save(); const job = await enqueue();
    const stored = (await db.query<{ input: unknown }>("select input from public.jobs where id=$1", [job.id])).rows[0]!;
    const parsed = strategyJobInputSchema.parse(stored.input); expect(parsed.version).toBe(2);
    if (parsed.version !== 2) throw new Error("Missing frozen history");
    expect(parsed.assistantHistory.entries.map(entry => entry.jobId)).toEqual(ids.reverse().slice(0, 5));
    expect(parsed.assistantHistory.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(parsed.assistantHistory)).byteLength).toBeLessThanOrEqual(32768);
    expect(parsed.assistantHistory.entries.every(entry => entry.ownerId === OWNER_B && entry.projectId === projects.b && entry.inputRevision < 2)).toBe(true);
  });

  it("canonicalizes guided metadata and ends reviewed guided naming readiness at personality", async () => {
    const value: ContextSnapshot = context(); value.competitorReviewComplete = true;
    value.audienceSegments = [{ id: crypto.randomUUID(), label: "Synthetic audience", needs: [], reason: "", selected: true, origin: "user", sources: [] }];
    value.intake.audienceReviewedAt = at; value.personality = { sincerity: 70, excitement: 20, competence: 80, sophistication: 10, ruggedness: 10 };
    value.intake.personalityReviewedAt = at; value.intake.guidedInterview!.stage = "complete";
    expect((await db.query<{ context: ContextSnapshot }>("select fluid_private.identity_material_context($1) context", [value])).rows[0]!.context).toEqual(value);
    expect((await db.query("select fluid_private.naming_readiness('complete_brand',$1) readiness", [value])).rows).toEqual([{ readiness: { ready: true, missing: [] } }]);
    value.intake.guidedInterview!.stage = "personality";
    expect((await db.query("select fluid_private.naming_readiness('complete_brand',$1) readiness", [value])).rows).toEqual([{ readiness: { ready: true, missing: [] } }]);
    value.intake.personalityReviewedAt = null;
    expect((await db.query("select fluid_private.naming_readiness('complete_brand',$1) readiness", [value])).rows).toEqual([{ readiness: { ready: false, missing: ["personality"] } }]);
    value.intake.personalityReviewedAt = at;
    value.intake.audienceReviewedAt = null;
    expect((await db.query("select fluid_private.naming_readiness('complete_brand',$1) readiness", [value])).rows).toEqual([{ readiness: { ready: false, missing: ["audience"] } }]);
    value.intake.audienceReviewedAt = at;
    const invalid = structuredClone(value); invalid.intake.guidedInterview!.turns[0]!.userMessageId = "missing";
    await expect(db.query("select fluid_private.identity_material_context($1)", [invalid])).rejects.toThrow("invalid_guided_interview");
    delete value.intake.guidedInterview;
    expect((await db.query("select fluid_private.naming_readiness('complete_brand',$1) readiness", [value])).rows).toEqual([{ readiness: { ready: false, missing: ["reformulation", "positioning"] } }]);
  });
});
