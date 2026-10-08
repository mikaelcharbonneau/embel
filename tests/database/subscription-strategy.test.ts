import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyStrategyJobResponseSchema, DEFAULT_SUBSCRIPTION_LIMITS, strategyJobSummarySchema } from "../../src/domain/strategy-jobs";
import { asRole, asSubscriptionWorker, claim, createTestDatabase, enqueue, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";

// Local database fixtures only: no account linking, provider calls or hosted SQL.
const registration = "local-fixture-registration";
const operation = "strategy.reformulate";
const policy = { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "strategy-chatgpt-v1", registrationId: registration, model: "fixture-model", limits: DEFAULT_SUBSCRIPTION_LIMITS };

describe("subscription jobs keep Supabase ownership and durable execution", () => {
  let db: TestDatabase;
  let project: string;
  const configured = new Map<string, typeof policy>();
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { configured.clear(); await resetFixture(db); project = (await seedProject(db)).id; });
  const worker = <T>(run: () => Promise<T>, owner = OWNER_A) => asSubscriptionWorker(db, owner, run);
  async function registerPlan(job: { id: string; lease_token: string }, manifest: readonly { key: string; maximumCostMicrousd: number }[]) {
    await worker(() => db.query("select public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify(manifest)]));
  }
  async function configure(value = policy, owner = OWNER_A, op = operation, ready = true) {
    await worker(() => db.query("select public.configure_subscription_runtime($1,$2,$3::jsonb,true)", [owner, op, JSON.stringify(value)]), owner);
    configured.set(`${owner}:${op}`, value);
    if (ready) await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,$3,$4::jsonb,60)", [owner, value.registrationId, op, JSON.stringify(value)]), owner);
  }
  async function identity(value = policy) {
    return (await db.query<{ identity: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as identity", [JSON.stringify(value)])).rows[0]!.identity;
  }
  async function submit(key = "subscription-fixture-0001", id = project, owner = OWNER_A, op = operation, acceptedIdentity?: string) {
    const accepted = acceptedIdentity ?? await identity(configured.get(`${owner}:${op}`) ?? policy);
    return asRole(db, "authenticated", owner, async () => {
      const rows = await db.query<{ result: unknown }>("select public.enqueue_subscription_strategy_job($1,1,$2,$3,$4) as result", [id, op, key, accepted]);
      return strategyJobSummarySchema.parse(rows.rows[0]!.result);
    });
  }
  async function take(owner = OWNER_A, reg = registration) {
    return worker(async () => (await db.query<{ id: string; lease_token: string; input: unknown; billing_mode: string; max_attempts: number }>("select * from public.claim_subscription_job('local-fixture-worker',$1,$2,60)", [owner, reg])).rows[0], owner);
  }
  async function availability(owner = OWNER_A) {
    return asRole(db, "authenticated", owner, async () => (await db.query<{ result: { status: string; reason?: string; operations: unknown[] } }>("select public.get_strategy_availability(null) as result")).rows[0]!.result);
  }

  it("runs without a currency account and publishes no fake USD estimate", async () => {
    await db.query("delete from public.usage_accounts where owner_id=$1", [OWNER_A]);
    await configure();
    expect(await availability()).toEqual({ status: "available", operations: [{ operation, billingMode: "chatgpt_subscription", policyIdentity: await identity(), limits: DEFAULT_SUBSCRIPTION_LIMITS }] });
    const submitted = await submit();
    expect(submitted.billingMode).toBe("chatgpt_subscription");
    expect(submitted).not.toHaveProperty("reserved_cost_microusd");
    expect((await db.query("select * from public.usage_reservations")).rows).toEqual([]);
    const job = (await take())!;
    expect(job.max_attempts).toBe(1);
    expect(job.input).toMatchObject({ billingMode: "chatgpt_subscription", policy });
    await registerPlan(job, [{ key: "respond", maximumCostMicrousd: 0 }]);
    await worker(() => db.query("select public.begin_job_step($1,$2,'respond','local-request',0)", [job.id, job.lease_token]));
    const result = { version: 1, provider: "openai", billingMode: "chatgpt_subscription", model: policy.model, operation, responseId: "fixture-response", requestId: null, generatedAt: "2026-10-03T12:00:00Z", usage: null, proposal: { message: "Fixture", activity: "", offering: "", knownAudience: "", questions: [] } };
    await worker(() => db.query("select public.complete_job_step($1,$2,'respond','succeeded',0,$3::jsonb,'fixture-request')", [job.id, job.lease_token, JSON.stringify(result)]));
    await worker(() => db.query("select public.finish_job($1,$2,'succeeded')", [job.id, job.lease_token]));
    expect((await db.query<{ state: string }>("select state from public.jobs where id=$1", [job.id])).rows[0]!.state).toBe("succeeded");
    expect((await db.query("select * from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([]);
    await expect(worker(() => db.query("select public.apply_strategy_job_result($1,$2,1,'respond')", [project, job.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(worker(() => db.query("select public.apply_strategy_job_result_v2($1,$2,1,'respond')", [project, job.id]))).rejects.toMatchObject({ code: "42501" });
    const apply = () => asRole(db, "authenticated", OWNER_A, async () => {
      const response = await db.query<{ result: unknown }>("select public.apply_strategy_job_result_v2($1,$2,1,'respond') as result", [project, job.id]);
      return applyStrategyJobResponseSchema.parse(response.rows[0]!.result);
    });
    const applied = await apply();
    expect(applied.application).toMatchObject({ jobId: job.id, stepKey: "respond", inputRevision: 1, appliedRevision: 2 });
    expect(await apply()).toEqual(applied);
    await expect(worker(() => db.query("select * from public.strategy_job_applications"))).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects malformed internal subscription input even at a privileged insert boundary", async () => {
    await expect(db.query("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode) values($1,$2,$3,1,$4,'{}'::jsonb,'malformed-subscription-row',0,1,'chatgpt_subscription')", [OWNER_A, project, operation, "a".repeat(64)])).rejects.toMatchObject({ code: "23514" });
  });

  it("binds registrations permanently to a verified owner and denies browser configuration", async () => {
    await configure();
    await expect(configure(policy, OWNER_B)).rejects.toMatchObject({ code: "23505" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select public.configure_subscription_runtime($1,$2,$3::jsonb)", [OWNER_A, operation, JSON.stringify(policy)]))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select * from public.get_subscription_runtime_bindings()"))).rejects.toMatchObject({ code: "42501" });
    await expect(submit("subscription-other-0001", project, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await submit();
    expect(await take(OWNER_B)).toBeUndefined();
    expect(await take(OWNER_A, "wrong-registration")).toBeUndefined();
    expect(await claim(db)).toBeUndefined();
    expect(await take()).toBeDefined();
  });

  it("requires exact fresh readiness and does not fall back to paid API after logout", async () => {
    await configure(policy, OWNER_A, operation, false);
    expect((await availability()).reason).toBe("worker_unavailable");
    await expect(submit()).rejects.toMatchObject({ code: "P0001" });
    const wrong = await worker(() => db.query<{ ok: boolean }>("select public.report_subscription_worker_ready($1,$2,$3,$4::jsonb,60) as ok", [OWNER_A, registration, operation, JSON.stringify({ ...policy, model: "wrong-model" })]));
    expect(wrong.rows[0]!.ok).toBe(false);
    await configure();
    await submit();
    await worker(() => db.query("select public.disable_subscription_runtime($1,$2)", [OWNER_A, registration]));
    expect((await availability()).reason).toBe("subscription_unavailable");
    expect(await take()).toBeUndefined();
    expect((await db.query<{ state: string }>("select state from public.jobs")).rows[0]!.state).toBe("cancelled");
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select public.enqueue_strategy_job($1,1,$2,'subscription-no-paid-fallback',0)", [project, operation]))).rejects.toMatchObject({ code: "PT409" });
  });

  it("idempotently binds revision plus operation even with a changed request nonce and later outage", async () => {
    await configure();
    const first = await submit();
    expect((await submit("subscription-fixture-0002")).id).toBe(first.id);
    await worker(() => db.query("select public.disable_subscription_runtime($1,$2)", [OWNER_A, registration]));
    expect((await submit()).id).toBe(first.id);
    await expect(submit("subscription-fixture-0001", project, OWNER_A, "strategy.positioning")).rejects.toMatchObject({ code: "23505" });
    const otherProject = (await seedProject(db)).id;
    await enqueue(db, otherProject, "cross-mode-key-00001");
    await expect(submit("cross-mode-key-00001", otherProject)).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a stale subscription revision with a final conflict before creating work", async () => {
    await configure();
    await asRole(db, "authenticated", OWNER_A, () => db.query(
      "select public.append_project_revision($1,1,$2::jsonb,$3)",
      [project, JSON.stringify({ description: "Subsequent explicit local edit" }), "a".repeat(64)],
    ));
    await expect(submit()).rejects.toMatchObject({ code: "PT409", message: "revision_conflict" });
    expect((await db.query("select id from public.jobs")).rows).toEqual([]);
    expect((await db.query("select current_revision from public.projects where id=$1", [project])).rows).toEqual([{ current_revision: 2 }]);
    expect((await db.query("select revision from public.project_revisions where project_id=$1 order by revision", [project])).rows).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it("enforces owner-wide queue and hourly request bounds across operations", async () => {
    const bounded = { ...policy, limits: { ...policy.limits, maxRequestsPerHour: 2, maxQueuedJobs: 1 } };
    await configure(bounded);
    await configure(bounded, OWNER_A, "strategy.positioning");
    const first = await submit();
    expect((await availability()).reason).toBe("quota_unavailable");
    await expect(submit("subscription-fixture-0002", project, OWNER_A, "strategy.positioning")).rejects.toMatchObject({ code: "P0001" });
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.request_job_cancel($1)", [first.id]));
    const second = await submit("subscription-fixture-0002", project, OWNER_A, "strategy.positioning");
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.request_job_cancel($1)", [second.id]));
    const other = (await seedProject(db)).id;
    await expect(submit("subscription-fixture-0003", other)).rejects.toMatchObject({ code: "P0001" });
  });

  it("stores only append-only owner-scoped partial text under a live lease and keeps it on cancel", async () => {
    await configure({ ...policy, limits: { ...policy.limits, maxOutputBytes: 1024 } });
    await submit();
    const job = (await take())!;
    const append = (text: string, token = job.lease_token) => worker(() => db.query("select public.append_subscription_partial($1,$2,$3)", [job.id, token, text]));
    await append('{"message":"');
    await append('{"message":"partial');
    await expect(append("replacement")).rejects.toMatchObject({ code: "40001" });
    await expect(append('{"message":"partial' + "é".repeat(600))).rejects.toMatchObject({ code: "22023" });
    await expect(append("anything", "99999999-9999-4999-8999-999999999999")).rejects.toMatchObject({ code: "PT409" });
    expect((await asRole(db, "authenticated", OWNER_B, () => db.query("select * from public.subscription_job_partials"))).rows).toEqual([]);
    const own = await asRole(db, "authenticated", OWNER_A, () => db.query<{ partial_text: string }>("select partial_text from public.subscription_job_partials"));
    expect(own.rows[0]!.partial_text).toBe('{"message":"partial');
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("update public.subscription_job_partials set partial_text='forged'"))).rejects.toMatchObject({ code: "42501" });
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.request_job_cancel($1)", [job.id]));
    await expect(append('{"message":"partial late')).rejects.toMatchObject({ code: "55000" });
    await worker(() => db.query("select public.finish_job($1,$2,'cancelled')", [job.id, job.lease_token]));
    expect((await db.query<{ partial_text: string }>("select partial_text from public.subscription_job_partials")).rows[0]!.partial_text).toBe('{"message":"partial');
  });

  it("quarantines interrupted dispatch without replaying or losing durable partials", async () => {
    await configure(); await submit(); const job = (await take())!;
    await registerPlan(job, [{ key: "respond", maximumCostMicrousd: 0 }]);
    await worker(() => db.query("select public.begin_job_step($1,$2,'respond','local-request',0)", [job.id, job.lease_token]));
    await worker(() => db.query("select public.append_subscription_partial($1,$2,'partial')", [job.id, job.lease_token]));
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    await worker(() => db.query("select public.expire_job_leases()"));
    expect((await db.query<{ state: string }>("select state from public.jobs where id=$1", [job.id])).rows[0]!.state).toBe("needs_reconciliation");
    expect(await take()).toBeUndefined();
    await expect(worker(() => db.query("select public.complete_job_step($1,$2,'respond','succeeded',0,'{}'::jsonb)", [job.id, job.lease_token]))).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select * from public.subscription_job_partials")).rows).toHaveLength(1);
  });

  it("cancels only the owner/operation superseded by a changed policy while preserving immutable inputs", async () => {
    await configure();
    await configure(policy, OWNER_A, "strategy.positioning");
    const first = await submit();
    const second = await submit("subscription-fixture-positioning", project, OWNER_A, "strategy.positioning");
    const otherPolicy = { ...policy, registrationId: "other-owner-registration" };
    await configure(otherPolicy, OWNER_B);
    const otherProject = (await seedProject(db, OWNER_B)).id;
    const otherJob = await submit("subscription-other-owner-001", otherProject, OWNER_B);
    await configure({ ...policy, model: "selected-different-model" });
    const jobs = (await db.query<{ id: string; state: string; error_code: string | null; input: { policy: unknown } }>("select id,state,error_code,input from public.jobs")).rows;
    expect(jobs.find(value => value.id === first.id)).toMatchObject({ state: "cancelled", error_code: "subscription_policy_changed", input: { policy } });
    expect(jobs.find(value => value.id === second.id)?.state).toBe("queued");
    expect(jobs.find(value => value.id === otherJob.id)?.state).toBe("queued");
    await expect(submit()).rejects.toMatchObject({ code: "PT409" });
    expect((await submit(undefined, undefined, undefined, undefined, await identity(policy))).id).toBe(first.id);
  });

  it("fences changed models, registrations and app limits even when consent predates enqueue", async () => {
    await configure();
    const accepted = await identity();
    for (const changed of [
      { ...policy, model: "another-model" },
      { ...policy, registrationId: "another-registration" },
      { ...policy, limits: { ...policy.limits, deadlineMs: 250_000 } },
    ]) {
      await configure(changed);
      expect(await identity(changed)).not.toBe(accepted);
      await expect(submit(undefined, undefined, undefined, undefined, accepted)).rejects.toMatchObject({ code: "PT409" });
      expect((await db.query("select id from public.jobs")).rows).toEqual([]);
    }
    await configure();
    const job = await submit();
    await expect(submit(undefined, undefined, undefined, undefined, "b".repeat(64))).rejects.toMatchObject({ code: "PT409" });
    await expect(submit("same-revision-different-key", undefined, undefined, undefined, "b".repeat(64))).rejects.toMatchObject({ code: "PT409" });
    expect(job).toHaveProperty("policyIdentity", accepted);
    await expect(db.query("update public.jobs set policy_identity=$1 where id=$2", ["b".repeat(64), job.id])).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects malformed policies, positive USD costs and changed-policy provider results", async () => {
    await expect(configure({ ...policy, limits: { ...policy.limits, maxQueuedJobs: 0 } })).rejects.toMatchObject({ code: "22023" });
    await configure(); await submit(); const job = (await take())!;
    await registerPlan(job, [{ key: "respond", maximumCostMicrousd: 0 }]);
    await expect(worker(() => db.query("select public.begin_job_step($1,$2,'respond','local-request',1)", [job.id, job.lease_token]))).rejects.toMatchObject({ code: "22023" });
    await worker(() => db.query("select public.begin_job_step($1,$2,'respond','local-request',0)", [job.id, job.lease_token]));
    await expect(worker(() => db.query("select public.complete_job_step($1,$2,'respond','failed',1)", [job.id, job.lease_token]))).rejects.toMatchObject({ code: "22023" });
    await configure({ ...policy, model: "changed-model" });
    await expect(worker(() => db.query("select public.complete_job_step($1,$2,'respond','succeeded',0,'{}'::jsonb)", [job.id, job.lease_token]))).rejects.toMatchObject({ code: "55000" });
    await worker(() => db.query("select public.complete_job_step($1,$2,'respond','ambiguous',0,'{}'::jsonb)", [job.id, job.lease_token]));
    expect((await db.query<{ state: string }>("select state from public.jobs where id=$1", [job.id])).rows[0]!.state).toBe("needs_reconciliation");
  });
});
