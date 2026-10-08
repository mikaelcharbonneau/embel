import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountProjectResponseSchema } from "../../src/domain/project-api";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { applyStrategyJobResponseSchema, strategyJobInputSchema, strategyJobSummarySchema, type StrategyOperation } from "../../src/domain/strategy-jobs";
import { asApiTextWorker, asRole, claim, createTestDatabase, HASH, installApiTextWorkerFixture, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";

// Explicit local fixtures. No provider calls, credential setup or hosted mutations.
const policy = {
  version: 1, pricingVersion: "2026-10-03", handlerVersion: "strategy-openai-v1", model: "gpt-6.1-sol",
  maxInputTokens: 32768, maxOutputTokens: 4096, maxWebSearchCalls: 0,
  inputMicrousdPerMillionTokens: 2_000_000, cachedInputMicrousdPerMillionTokens: 100_000,
  cacheWriteMicrousdPerMillionTokens: 2_500_000, outputMicrousdPerMillionTokens: 10_000_000,
  webSearchMicrousdPerCall: 10_000, maximumCostMicrousd: 122_880,
};
const deployment = "strategy-fixture-approved-deployment";
const existingCompetitor = { id: "11111111-1111-4111-8111-111111111111", name: "Existing user competitor", relevance: "User retained", selected: true, origin: "user", sources: [] };
const context = contextSnapshotSchema.parse({
  description: "Explicit local strategy database fixture.", activity: "User activity", offering: "User offering", reformulationConfirmed: true,
  competitors: [existingCompetitor], competitorReviewComplete: true,
  audienceSegments: [{ id: "22222222-2222-4222-8222-222222222222", label: "Existing user audience", reason: "User retained", needs: ["Need"], selected: true, origin: "user" }],
  personality: { sincerity: 30, excitement: 40, competence: 50, sophistication: 60, ruggedness: 70 }, positioning: "Existing user positioning",
  intake: { audienceReviewedAt: "2026-10-03T12:00:00Z", personalityReviewedAt: "2026-10-03T12:00:00Z", positioningReviewedAt: "2026-10-03T12:00:00Z" },
});

describe("strategy database ownership, policy and immutable results (local PostgreSQL)", () => {
  let db: TestDatabase;
  let projectId: string;
  let policyIdentity: string;
  beforeAll(async () => { db = await createTestDatabase(); await installApiTextWorkerFixture(db); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await resetFixture(db);
    await db.exec("delete from fluid_private.strategy_runtime_policy");
    await db.query("update public.usage_accounts set limit_microusd = 5000000");
    await db.query("insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_api_text_a'", [OWNER_A]);
    policyIdentity = (await db.query<{ identity: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as identity", [JSON.stringify(policy)])).rows[0]!.identity;
    projectId = await asRole(db, "authenticated", OWNER_A, async () => {
      const result = await db.query<{ id: string }>("select * from public.create_project('complete_brand','Local strategy fixture',$1::jsonb,$2)", [JSON.stringify(context), HASH]);
      return result.rows[0]!.id;
    });
  });

  // Qualification exists only in this disposable database. No provider call,
  // credential or live role is created by these exact local binding fixtures.
  async function enable(operation: StrategyOperation = "strategy.reformulate", ready = true) {
    await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2::jsonb) on conflict(operation) do update set enabled=true,policy=excluded.policy", [operation, JSON.stringify(policy)]);
    await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,$2,role_oid,$3,$4,$5 from fluid_private.api_text_worker_principals where owner_id=$1 on conflict(owner_id,operation) do update set policy_identity=excluded.policy_identity,deployment_id=excluded.deployment_id,enabled=excluded.enabled", [OWNER_A, operation, policyIdentity, deployment, ready]);
    if (!(await db.query("select 1 from fluid_private.strategy_billing_routes where owner_id=$1", [OWNER_A])).rows.length) {
      await db.query("select fluid_private.set_strategy_billing_route($1,0,'openai_api')", [OWNER_A]);
    }
  }
  const worker = <T,>(run: () => Promise<T>) => asApiTextWorker(db, OWNER_A, run);
  async function submit({ actor = OWNER_A, id = projectId, revision = 1, operation = "strategy.reformulate", key = "local-strategy-request-0001", cap = 122_880 }: { actor?: string; id?: string; revision?: number; operation?: string; key?: string; cap?: number } = {}) {
    return asRole(db, "authenticated", actor, async () => {
      const result = await db.query<{ result: unknown }>("select public.enqueue_strategy_job($1,$2,$3,$4,$5) as result", [id, revision, operation, key, cap]);
      return strategyJobSummarySchema.parse(result.rows[0]!.result);
    });
  }
  async function availability(actor = OWNER_A, id: string | null = projectId) {
    return asRole(db, "authenticated", actor, async () => {
      const result = await db.query<{ result: { status: string; operations: unknown[]; reason?: string } }>("select public.get_strategy_availability($1) as result", [id]);
      return result.rows[0]!.result;
    });
  }

  it("is unavailable by default and never creates budgets or jobs", async () => {
    expect(await availability()).toEqual({ status: "unavailable", operations: [], reason: "runtime_disabled" });
    await expect(submit()).rejects.toMatchObject({ code: "P0001" });
    expect((await db.query("select * from public.jobs")).rows).toEqual([]);
    await enable();
    await db.query("delete from public.usage_accounts where owner_id=$1", [OWNER_A]);
    expect(await availability(OWNER_A, null)).toEqual({ status: "unavailable", operations: [], reason: "budget_unavailable" });
    await expect(submit()).rejects.toMatchObject({ code: "P0001" });
    expect((await db.query("select * from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([]);
  });

  it("requires the exact owner, policy and enabled deployment binding rather than a legacy heartbeat", async () => {
    await enable("strategy.reformulate", false);
    expect((await availability()).reason).toBe("runtime_disabled");
    await expect(submit()).rejects.toMatchObject({ code: "P0001", message: "runtime_unavailable" });
    // A service-role heartbeat cannot activate the new restricted dispatch path.
    await asRole(db, "service_role", null, () => db.query("select public.report_strategy_worker_ready($1,$2::jsonb,60)", ["strategy.reformulate", JSON.stringify(policy)]));
    await expect(submit()).rejects.toMatchObject({ code: "P0001", message: "runtime_unavailable" });
    await enable();
    expect(await availability()).toEqual({ status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 122_880 }] });
    const check = (actualPolicy: unknown, actualDeployment = deployment) => worker(() => db.query<{ ready: boolean }>("select public.check_api_text_runtime('strategy.reformulate',$1::jsonb,$2) as ready", [JSON.stringify(actualPolicy), actualDeployment]));
    expect((await check(policy)).rows[0]!.ready).toBe(true);
    expect((await check({ ...policy, model: "mismatch" })).rows[0]!.ready).toBe(false);
    expect((await check(policy, "unapproved-deployment")).rows[0]!.ready).toBe(false);
    await db.query("update fluid_private.strategy_runtime_policy set policy=jsonb_set(policy,'{model}','\"changed\"'::jsonb)");
    expect((await availability()).reason).toBe("runtime_disabled");
    await expect(submit()).rejects.toMatchObject({ code: "P0001", message: "runtime_unavailable" });
    await enable();
    await db.query("update fluid_private.api_strategy_bindings set enabled=false where owner_id=$1", [OWNER_A]);
    await expect(submit()).rejects.toMatchObject({ code: "P0001", message: "runtime_unavailable" });
    expect((await db.query("select * from public.jobs")).rows).toEqual([]);
  });

  it("enforces RPC grants, identity, project ownership and read isolation at the database", async () => {
    await enable();
    await expect(asRole(db, "anon", null, () => db.query("select public.get_strategy_availability(null)"))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select public.enqueue_job($1,$2,'strategy.reformulate',1,$3,'{}'::jsonb,'arbitrary-input',1,1)", [OWNER_A, projectId, HASH]))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select public.report_strategy_worker_ready('strategy.reformulate',$1::jsonb,60)", [JSON.stringify(policy)]))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select * from fluid_private.strategy_runtime_policy"))).rejects.toMatchObject({ code: "42501" });
    await expect(submit({ actor: OWNER_B })).rejects.toMatchObject({ code: "P0002" });
    await expect(availability(OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    const job = await submit();
    expect(job.owner_id).toBe(OWNER_A);
    await asRole(db, "authenticated", OWNER_B, async () => {
      expect((await db.query("select id from public.jobs where id=$1", [job.id])).rows).toEqual([]);
      expect((await db.query("select * from public.job_steps where job_id=$1", [job.id])).rows).toEqual([]);
      await expect(db.query("select public.request_job_cancel($1)", [job.id])).rejects.toMatchObject({ code: "P0002" });
    });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select lease_token,input from public.jobs where id=$1", [job.id]))).rejects.toMatchObject({ code: "42501" });
    expect(job).not.toHaveProperty("lease_token");
    expect(job).not.toHaveProperty("input");
  });

  it("resolves revision and reservation from trusted records, not caller claims", async () => {
    await enable();
    await expect(submit({ operation: "identity.image" })).rejects.toMatchObject({ code: "22023" });
    await expect(submit({ revision: 2 })).rejects.toMatchObject({ code: "PT409" });
    await expect(submit({ cap: 1 })).rejects.toMatchObject({ code: "22023" });
    await expect(submit({ key: "short" })).rejects.toMatchObject({ code: "22023" });
    const job = await submit({ cap: 999999 });
    const rows = await db.query<{ input: unknown; input_hash: string; max_attempts: number }>("select input,input_hash,max_attempts from public.jobs where id=$1", [job.id]);
    expect(strategyJobInputSchema.parse(rows.rows[0]!.input)).toEqual({ version: 1, context, policy, acceptedMaxCostMicrousd: 999999 });
    expect(rows.rows[0]!.input_hash).toBe(HASH);
    expect(rows.rows[0]!.max_attempts).toBe(3);
    expect((await db.query("select owner_id,policy_identity,deployment_id from fluid_private.api_text_dispatches where job_id=$1", [job.id])).rows).toEqual([{ owner_id: OWNER_A, policy_identity: policyIdentity, deployment_id: deployment }]);
    expect(job).toHaveProperty("reserved_cost_microusd", 122_880);
    expect((await db.query<{ reserved_microusd: number }>("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0]!.reserved_microusd).toBe(122_880);
  });

  it("replays idempotently after revision or runtime changes and rejects changed intent", async () => {
    await enable();
    const job = await submit();
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.append_project_revision($1,1,$2::jsonb,$3)", [projectId, JSON.stringify({ ...context, description: "Changed local fixture" }), HASH]));
    await db.exec("update fluid_private.strategy_runtime_policy set enabled=false");
    expect(await submit()).toEqual(job);
    await expect(submit({ revision: 2 })).rejects.toMatchObject({ code: "23505" });
    await expect(submit({ operation: "strategy.competitors" })).rejects.toMatchObject({ code: "23505" });
    await expect(submit({ cap: 122_881 })).rejects.toMatchObject({ code: "23505" });
    expect((await db.query("select * from public.jobs")).rows).toHaveLength(1);
    expect((await db.query("select * from public.usage_reservations")).rows).toHaveLength(1);
  });

  it("excludes unaffordable operations and cancellation releases only the correct reservation", async () => {
    await enable();
    await db.query("update public.usage_accounts set limit_microusd=122880 where owner_id=$1", [OWNER_A]);
    const job = await submit();
    expect((await availability()).reason).toBe("budget_unavailable");
    await expect(submit({ key: "local-strategy-request-0002" })).rejects.toMatchObject({ code: "P0001" });
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.request_job_cancel($1)", [job.id]));
    expect((await availability()).status).toBe("available");
    expect((await submit()).state).toBe("cancelled");
    expect((await db.query<{ reserved_microusd: number }>("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0]!.reserved_microusd).toBe(0);
  });

  async function completed(operation: StrategyOperation, proposal: unknown) {
    let job: ReturnType<typeof strategyJobSummarySchema.parse>;
    let lease: { id: string; lease_token: string };
    let execute: <T>(run: () => Promise<T>) => Promise<T>;
    if (operation === "strategy.competitors") {
      // Current competitor admission stays disabled. Seed a clearly synthetic
      // pre-activation job so retained historical results still exercise apply.
      await expect(submit({ operation })).rejects.toMatchObject({ code: "P0001", message: "runtime_unavailable" });
      const created = await asRole(db, "service_role", null, () => db.query<{ result: unknown }>("select to_jsonb(historical) as result from public.enqueue_job($1,$2,$3,1,$4,$5::jsonb,'historical-competitor-fixture',122880,1) historical", [OWNER_A, projectId, operation, HASH, JSON.stringify({ version: 1, context, policy, acceptedMaxCostMicrousd: 122880 })]));
      job = strategyJobSummarySchema.parse(created.rows[0]!.result);
      lease = await claim(db);
      execute = run => asRole(db, "service_role", null, run);
      expect((await db.query("select * from fluid_private.api_text_dispatches where job_id=$1", [job.id])).rows).toEqual([]);
    } else {
      await enable(operation);
      job = await submit({ operation });
      expect(await claim(db)).toBeUndefined(); // Generic service-role claim cannot take restricted work.
      const claimed = await worker(() => db.query<{ result: { disposition: string; job: { id: string; lease_token: string } } }>("select public.claim_api_text_job($1,'strategy-fixture',60,$2,$3) as result", [job.id, policyIdentity, deployment]));
      expect(claimed.rows[0]!.result.disposition).toBe("claimed");
      lease = claimed.rows[0]!.result.job;
      execute = worker;
    }
    expect(lease.id).toBe(job.id);
    await execute(() => db.query("select public.register_job_plan($1,$2,$3::jsonb)", [job.id, lease.lease_token, JSON.stringify([{ key: "proposal", maximumCostMicrousd: 122_880 }])]));
    const output = {
      version: 1, operation, provider: "openai", model: "gpt-6.1-sol", responseId: "local-fixture-response", requestId: null, generatedAt: "2026-10-03T12:00:00Z",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 }, proposal,
    };
    await execute(async () => {
      await db.query("select public.begin_job_step($1,$2,'proposal','fixture-provider-request',122880)", [job.id, lease.lease_token]);
      await db.query("select public.complete_job_step($1,$2,'proposal','succeeded',2,$3::jsonb,'local-fixture-response')", [job.id, lease.lease_token, JSON.stringify(output)]);
      await db.query("select public.finish_job($1,$2,'succeeded',null)", [job.id, lease.lease_token]);
    });
    return job;
  }
  async function apply(jobId: string, actor = OWNER_A, revision = 1, id = projectId, stepKey = "proposal") {
    return asRole(db, "authenticated", actor, async () => {
      const result = await db.query<{ result: unknown }>("select public.apply_strategy_job_result_v2($1,$2,$3,$4) as result", [id, jobId, revision, stepKey]);
      const { project, application } = applyStrategyJobResponseSchema.parse(result.rows[0]!.result);
      return { ...project, application };
    });
  }

  it("applies only the owned real step, appends unselected proposals and preserves existing choices/history", async () => {
    const proposal = { message: "Explicit local result fixture", competitors: [{ id: "33333333-3333-4333-8333-333333333333", name: "New fixture competitor", relevance: "Fixture reason", origin: "research", selected: false, sources: [{ url: "https://example.com/fixture", title: "Local fixture", retrievedAt: "2026-10-03T12:00:00Z" }] }] };
    const job = await completed("strategy.competitors", proposal);
    await expect(apply(job.id, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    const result = await apply(job.id);
    expect(result.current_revision).toBe(2);
    const parsed = contextSnapshotSchema.parse(result.context);
    expect(parsed.competitors).toEqual([existingCompetitor, ...proposal.competitors]);
    expect(parsed.audienceSegments).toEqual(context.audienceSegments);
    expect(parsed.personality).toEqual(context.personality);
    expect(parsed.positioning).toBe(context.positioning);
    expect(parsed.competitorReviewComplete).toBe(false);
    expect(parsed.intake.audienceReviewedAt).toBeNull();
    expect(parsed.intake.personalityReviewedAt).toBeNull();
    const original = await db.query<{ context: unknown }>("select context from public.project_revisions where project_id=$1 and revision=1", [projectId]);
    expect(original.rows[0]!.context).toEqual(context);
    expect(await apply(job.id)).toEqual(result);
    await expect(apply(job.id, OWNER_A, 2)).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select * from public.project_revisions where project_id=$1", [projectId])).rows).toHaveLength(2);
  });

  const reformulation = { message: "Local fixture", activity: "Proposed activity", offering: "Proposed offering", knownAudience: "Proposed audience", questions: [] };

  it("preserves the deployed original RPC response and revision rules without inventing an application receipt", async () => {
    const job = await completed("strategy.reformulate", reformulation);
    const legacyApply = () => asRole(db, "authenticated", OWNER_A, async () => {
      const response = await db.query<{ result: unknown }>("select public.apply_strategy_job_result($1,$2,1,'proposal') as result", [projectId, job.id]);
      return response.rows[0]!.result;
    });
    const raw = await legacyApply();
    // The already deployed server wraps the original RPC's bare project.
    const { project } = accountProjectResponseSchema.parse({ project: raw });
    expect(project).toMatchObject({ id: projectId, owner_id: OWNER_A, current_revision: 2, context: { activity: reformulation.activity } });
    expect(raw).not.toHaveProperty("project");
    expect(raw).not.toHaveProperty("application");
    expect((await db.query("select * from public.strategy_job_applications where job_id=$1", [job.id])).rows).toEqual([]);
    await expect(legacyApply()).rejects.toMatchObject({ code: "PT409" });
    await expect(apply(job.id)).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select * from public.project_revisions where project_id=$1", [projectId])).rows).toHaveLength(2);
  });

  it("records one exact immutable receipt and recovers repeated original apply without another revision", async () => {
    const job = await completed("strategy.reformulate", reformulation);
    const first = await apply(job.id);
    expect(first.application).toMatchObject({ jobId: job.id, stepKey: "proposal", inputRevision: 1, appliedRevision: 2 });
    expect(await apply(job.id)).toEqual(first);
    expect(await apply(job.id)).toEqual(first);
    const own = await asRole(db, "authenticated", OWNER_A, () => db.query("select * from public.strategy_job_applications where job_id=$1", [job.id]));
    expect(own.rows).toHaveLength(1);
    expect(own.rows[0]).toMatchObject({ owner_id: OWNER_A, project_id: projectId, job_id: job.id, step_key: "proposal", input_revision: 1, applied_revision: 2 });
    expect((await db.query("select * from public.project_revisions where project_id=$1", [projectId])).rows).toHaveLength(2);
    await expect(apply(job.id, OWNER_A, 2)).rejects.toMatchObject({ code: "PT409" });
    await expect(apply(job.id, OWNER_A, 1, projectId, "different-step")).rejects.toMatchObject({ code: "P0002" });
    await expect(db.query("update public.strategy_job_applications set applied_at=now() where job_id=$1", [job.id])).rejects.toMatchObject({ code: "55000" });
    await expect(db.query("delete from public.strategy_job_applications where job_id=$1", [job.id])).rejects.toMatchObject({ code: "55000" });
  });

  it("enforces receipt ownership and refuses direct client or worker receipt writes", async () => {
    const job = await completed("strategy.reformulate", reformulation);
    await apply(job.id);
    const foreign = await asRole(db, "authenticated", OWNER_B, () => db.query("select * from public.strategy_job_applications"));
    expect(foreign.rows).toEqual([]);
    await expect(apply(job.id, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    for (const role of ["authenticated", "anon", "service_role"] as const) {
      await expect(asRole(db, role, role === "authenticated" ? OWNER_A : null, () => db.query(
        "insert into public.strategy_job_applications(job_id,step_key,owner_id,project_id,input_revision,applied_revision) values($1,'proposal',$2,$3,1,2)", [job.id, OWNER_A, projectId],
      ))).rejects.toMatchObject({ code: "42501" });
      await expect(asRole(db, role, role === "authenticated" ? OWNER_A : null, () => db.query("delete from public.strategy_job_applications where job_id=$1", [job.id]))).rejects.toMatchObject({ code: "42501" });
      await expect(asRole(db, role, role === "authenticated" ? OWNER_A : null, () => db.query("update public.strategy_job_applications set applied_at=now() where job_id=$1", [job.id]))).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asRole(db, "anon", null, () => db.query("select * from public.strategy_job_applications"))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "service_role", null, () => db.query("select * from public.strategy_job_applications"))).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps a historical receipt but refuses replay after a later user revision", async () => {
    const job = await completed("strategy.reformulate", reformulation);
    const applied = await apply(job.id);
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.append_project_revision($1,2,$2::jsonb,$3)", [projectId, JSON.stringify({ ...applied.context, activity: "Subsequent user edit" }), HASH]));
    await expect(apply(job.id)).rejects.toMatchObject({ code: "PT409" });
    const receipt = await asRole(db, "authenticated", OWNER_A, () => db.query("select input_revision,applied_revision from public.strategy_job_applications where job_id=$1", [job.id]));
    expect(receipt.rows).toEqual([{ input_revision: 1, applied_revision: 2 }]);
    expect((await db.query("select current_revision from public.projects where id=$1", [projectId])).rows).toEqual([{ current_revision: 3 }]);
    expect((await db.query("select * from public.project_revisions where project_id=$1", [projectId])).rows).toHaveLength(3);
  });

  it("never creates a receipt for an unapplied result made stale by a user edit", async () => {
    const job = await completed("strategy.reformulate", reformulation);
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.append_project_revision($1,1,$2::jsonb,$3)", [projectId, JSON.stringify({ ...context, activity: "User edit before apply" }), HASH]));
    await expect(apply(job.id)).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select * from public.strategy_job_applications")).rows).toEqual([]);
    expect((await db.query("select * from public.project_revisions where project_id=$1", [projectId])).rows).toHaveLength(2);
  });

  it("rolls back the project append when the atomic receipt insert fails", async () => {
    const job = await completed("strategy.reformulate", reformulation);
    await db.exec("create trigger local_fixture_reject_receipt before insert on public.strategy_job_applications for each row execute function fluid_private.prevent_history_change()");
    try {
      await expect(apply(job.id)).rejects.toMatchObject({ code: "55000" });
      expect((await db.query("select current_revision from public.projects where id=$1", [projectId])).rows).toEqual([{ current_revision: 1 }]);
      expect((await db.query("select * from public.project_revisions where project_id=$1", [projectId])).rows).toHaveLength(1);
      expect((await db.query("select * from public.strategy_job_applications")).rows).toEqual([]);
    } finally {
      await db.exec("drop trigger local_fixture_reject_receipt on public.strategy_job_applications");
    }
    expect((await apply(job.id)).current_revision).toBe(2);
  });

  it.each([
    ["strategy.reformulate", { message: "Local fixture", activity: "Proposed activity", offering: "Proposed offering", knownAudience: "Proposed audience", questions: [] }],
    ["strategy.audience", { message: "Local fixture", segments: [{ id: "33333333-3333-4333-8333-333333333333", label: "Proposed audience", reason: "Fixture", needs: [], origin: "proposal", selected: false, sources: [] }] }],
    ["strategy.personality", { message: "Local fixture", personality: { sincerity: 20, excitement: 20, competence: 20, sophistication: 20, ruggedness: 20 } }],
    ["strategy.positioning", { message: "Local fixture", positioning: "Proposed local positioning" }],
  ] as const)("creates immutable unreviewed context from %s", async (operation, proposal) => {
    const job = await completed(operation, proposal);
    const result = await apply(job.id);
    const updated = contextSnapshotSchema.parse(result.context);
    expect(updated.intake.positioningReviewedAt).toBeNull();
    expect(updated.competitors).toEqual(context.competitors);
    if (operation === "strategy.reformulate") {
      expect(updated.activity).toBe("Proposed activity");
      expect(updated.reformulationConfirmed).toBe(false);
    } else if (operation === "strategy.audience") {
      expect(updated.audienceSegments[0]).toEqual(context.audienceSegments[0]);
      expect(updated.audienceSegments[1]?.selected).toBe(false);
    } else if (operation === "strategy.personality") {
      expect(updated.personality?.sincerity).toBe(20);
      expect(updated.intake.personalityReviewedAt).toBeNull();
    } else {
      expect(updated.positioning).toBe("Proposed local positioning");
      expect(updated.intake.personalityReviewedAt).toBe(context.intake.personalityReviewedAt);
    }
  });

  it("refuses fabricated apply output and jobs without a succeeded result", async () => {
    await enable();
    const job = await submit();
    await expect(apply(job.id)).rejects.toMatchObject({ code: "P0002" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,output) values($1,$2,$3,'proposal','forged','succeeded',0,'{}'::jsonb)", [job.id, OWNER_A, projectId]))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select public.apply_strategy_job_result($1,$2,1,'proposal','{}'::jsonb)", [projectId, job.id]))).rejects.toMatchObject({ code: "42883" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select public.apply_strategy_job_result_v2($1,$2,1,'proposal','{}'::jsonb)", [projectId, job.id]))).rejects.toMatchObject({ code: "42883" });
  });
});
