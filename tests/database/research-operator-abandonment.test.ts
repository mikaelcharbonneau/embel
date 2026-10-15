import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000 });
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { asApiTextWorker, asRole, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { admit, availability, createMultiAccountFixture, enableSyntheticCohort, resetMultiAccountFixture } from "./api-text-multi-account-fixture";

const jobId = "6b310a38-eadf-4d64-9474-b7632cfa2340";
const stepId = "bf70b5ce-3a48-4b8d-92c0-f4e29b145595";
const responseId = "resp_0959915f311fe770016ad02385554087d29b4acba26b8d485b";
const policyId = "aec17e433d66a556c6762a1c945b83464e4a4ac4851ac91118df4c2eddbe739b";
const deploymentId = "dpl_AsMYHhJeVxxMtmfRmRM1QT379Shd";
const dispatchId = "74dd47827976d8e6b83f39f146019cd7f11c7cb343aaf5a10d8212ecc0e1ce77";
const stepKey = "strategy-openai-guided-v1:strategy.competitors:0d8273285a00846d419b430c";
const nativeOutputHash = "c787e1485edc74f13cd1d03736b536933b7a3c75fc9f5ac826e7890977382dde";
const nativeInputHash = "8db2a72d2376339aad0bdde50f2097ab98d84e6bfa1aeb05fed6542d28efe6ef";
const packet = new URL("../../supabase/migrations/20261015011434_terminal_research_operator_adjudication.sql", import.meta.url);
const application = new URL("../../supabase/candidates/research_operator_abandonment_6b310a38_apply.sql", import.meta.url);
const table = "fluid_private.api_text_operator_adjudications";
const descriptor = { version: 1, jobId, policyIdentity: policyId, deploymentId, dispatchIdentity: dispatchId };

/** Disposable PGlite only. Production IDs identify the candidate, but fixture
 * owner/project/input/output are explicitly substituted synthetic local values.
 * No captured customer content, hosted database, provider or credential is used. */
describe("single historical research operator-abandonment proposal", () => {
  let db: TestDatabase;
  let projects: { a: string; b: string };
  let insert: string;
  let unapprovedInsert: string;
  let beforeSecurity: unknown;
  let afterSecurity: unknown;
  let outputHash: string;
  const security = () => db.query(`select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof
    from pg_proc where oid in ('fluid_private.api_text_paid_paused(uuid)'::regprocedure,
    'fluid_private.api_text_allowance_paused()'::regprocedure) order by oid`);
  const paused = async () => (await db.query<{ owner: boolean; global: boolean }>(
    "select fluid_private.api_text_paid_paused($1) owner,fluid_private.api_text_allowance_paused() global", [OWNER_B])).rows[0]!;
  const matches = async () => (await db.query<{ value: boolean }>(
    "select fluid_private.research_operator_adjudication_matches($1) value", [jobId])).rows[0]!.value;
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const relation of ["public.jobs", "public.job_steps", "public.usage_accounts", "public.usage_reservations", "public.projects", "public.project_revisions",
      "fluid_private.api_text_dispatches", "fluid_private.api_text_allowance_admissions", "fluid_private.api_text_testing_admissions",
      "fluid_private.api_text_allowance_rollout", "fluid_private.api_text_allowance_cohorts", "fluid_private.api_text_owner_entitlements", table])
      result[relation] = (await db.query(`select to_jsonb(t) data from ${relation} t order by to_jsonb(t)::text`)).rows;
    return result;
  };
  async function rejected(sql: string, values: unknown[] = [], message?: string) {
    await db.exec("savepoint rejected_operation");
    let error: unknown;
    try { await db.query(sql, values); } catch (caught) { error = caught; }
    await db.exec("rollback to savepoint rejected_operation; release savepoint rejected_operation");
    expect(error).toBeDefined();
    if (message) expect(String(error)).toContain(message);
  }
  const action = async (name: string, args: unknown[] = []) => asApiTextWorker(db, OWNER_A, async () =>
    (await db.query<{ value: Record<string, unknown> }>("select public.api_text_dispatch_action($1,$2,$3) value", [descriptor, name, args])).rows[0]!.value);

  beforeAll(async () => {
    db = await createMultiAccountFixture();
    for (const name of ["20261014142522_api_text_unlimited_testing.sql", "20261014170000_guided_strategy_runtime.sql"])
      await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"));
    projects = await resetMultiAccountFixture(db);
    await enableSyntheticCohort(db, { globalAttempts: 1, globalCost: 122880, accounts: 1 });
    const trial = await admit(db, OWNER_B, projects.b, "synthetic-consumed-trial");
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_job_cancel($1)", [trial.id]));
    await db.query("update fluid_private.api_text_allowance_cohorts set operations=array['strategy.reformulate','strategy.competitors'],deployment_id=$1,expires_at=clock_timestamp()-interval '1 hour'", [deploymentId]);
    await db.exec("update fluid_private.api_text_allowance_rollout set signup_cohort=null; update fluid_private.api_text_owner_entitlements set expires_at=clock_timestamp()-interval '1 hour'");
    for (const operation of ["strategy.reformulate", "strategy.competitors"] as const) {
      const policy = guidedStrategyPolicy(operation);
      await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'fixture',$2,true)", [OWNER_B, operation]);
      await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2) on conflict(operation) do update set policy=excluded.policy", [operation, policy]);
      await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,$2,oid,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'),$4,true from pg_roles where rolname='fixture_api_text_a' on conflict(owner_id,operation) do update set policy_identity=excluded.policy_identity,deployment_id=excluded.deployment_id", [OWNER_B, operation, policy, deploymentId]);
    }
    const context = contextSnapshotSchema.parse({ description: "Synthetic operator adjudication fixture", intake: {
      conversation: [{ id: "synthetic-message", kind: "user_message", text: "Synthetic research idea", createdAt: "2026-10-15T00:00:00.000Z" }],
      guidedInterview: { version: 1, stage: "competitors", turns: [{ id: "synthetic-turn", userMessageId: "synthetic-message", stage: "competitors", purpose: "research", inputRevision: 2 }], answers: [] },
    } });
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.append_project_revision($1,1,$2,$3)", [projects.b, context, "a".repeat(64)]));
    const input = { version: 2, policy: guidedStrategyPolicy("strategy.competitors"), context, acceptedMaxCostMicrousd: 15892880, assistantHistory: { entries: [], truncated: false } };
    const output = { error: "provider_unexpected_output", result: { responseId, model: "gpt-6.1-sol", requestId: null,
      usage: { inputTokens: 21753, outputTokens: 825, cachedInputTokens: 0, cacheWriteInputTokens: 5817, webSearchCalls: 2 }, partialText: "Explicit synthetic unusable output; no verified source." } };
    const inputHash = (await db.query<{ hash: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') hash", [input])).rows[0]!.hash;
    outputHash = (await db.query<{ hash: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') hash", [output])).rows[0]!.hash;
    await db.query(`insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,
      plan_manifest,plan_fingerprint,plan_registered_at,attempts,max_attempts,reserved_cost_microusd,actual_cost_microusd,error_code)
      values($1,$2,$3,'strategy.competitors',1,$4,$5,'synthetic-original-key','needs_reconciliation',$6,
      '36e8eb404ddd2553e88c99e60fb7269546bb639938af1d54f5b7e106a2cd2a09',clock_timestamp(),1,3,15892880,74665,'provider_outcome_unknown')`,
    [jobId, OWNER_B, projects.b, inputHash, input, [{ key: stepKey, maximumCostMicrousd: 15892880 }]]);
    await db.query(`insert into public.job_steps(id,job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,actual_cost_microusd,output,provider_request_id,completed_at)
      values($1,$2,$3,$4,$5,'8d98c0dd974e9cab53f8219dd47be631fb5d803798a8b4321ec72218456e60e3','ambiguous',15892880,74665,$6,$7,'2026-10-15 00:51:40.064741+00')`,
    [stepId, jobId, OWNER_B, projects.b, stepKey, output, responseId]);
    await db.query("insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd,actual_microusd,captured_microusd) values($1,$2,$3,15892880,74665,74665)", [jobId, OWNER_B, projects.b]);
    await db.query("update public.usage_accounts set reserved_microusd=15818215,spent_microusd=237859,provider_actual_microusd=237859 where owner_id=$1", [OWNER_B]);
    await db.query(`insert into fluid_private.api_text_dispatches(job_id,owner_id,project_id,policy_identity,deployment_id,dispatch_identity,published_message_id,published_at)
      values($1,$2,$3,$4,$5,$6,'synthetic-published-message','2026-10-15 00:51:15.830025+00')`, [jobId, OWNER_B, projects.b, policyId, deploymentId, dispatchId]);
    await db.query("insert into fluid_private.api_text_allowance_admissions(job_id,owner_id,cohort_id,role_name,role_oid,maximum_cost_microusd) select $1,$2,'fixture',rolname,oid,15892880 from pg_roles where rolname='fixture_api_text_a'", [jobId, OWNER_B]);
    await db.query("insert into fluid_private.api_text_testing_admissions(job_id) values($1)", [jobId]);
    const substitute = (sql: string) => sql.replaceAll("6840f4c2-15a6-45a7-97be-41e7e5e37f42", OWNER_B)
      .replaceAll("8aa59964-7057-4a96-8142-82561fc5ffda", projects.b).replaceAll(nativeInputHash, inputHash).replaceAll(nativeOutputHash, outputHash);
    const candidate = substitute(await readFile(packet, "utf8"));
    unapprovedInsert = substitute(await readFile(application, "utf8")).match(/insert into[\s\S]*?15892880,74665,15818215\);/)![0];
    insert = unapprovedInsert.replace("REPLACE_APPROVED_OPERATOR_DECISION_REFERENCE", "operator-decision:synthetic-local-test-only");
    beforeSecurity = (await security()).rows;
    await db.exec("create role fixture_adjudication_hostile nologin; alter default privileges in schema fluid_private grant all on tables to fixture_adjudication_hostile; alter default privileges in schema fluid_private grant execute on functions to fixture_adjudication_hostile");
    await db.exec("alter function fluid_private.api_text_paid_paused(uuid) security definer");
    await expect(db.exec(candidate)).rejects.toThrow("unexpected_research_adjudication_predecessor");
    await db.exec("rollback; alter function fluid_private.api_text_paid_paused(uuid) security invoker");
    await db.exec(candidate);
    afterSecurity = (await security()).rows;
  }, 300_000);
  beforeEach(async () => { await db.exec("begin"); });
  afterEach(async () => { await db.exec("set session authorization postgres; reset role; rollback"); });
  afterAll(async () => { await db?.close(); }, 30_000);

  it("pins actual source bytes and completed-status branch order without inventing an envelope", () => {
    const source = execFileSync("git", ["show", "af6faf18912cc24afb37179a6988a11f83cf9cdf:src/server/ai/strategy-response.ts"], { encoding: "utf8" });
    expect(createHash("sha256").update(source).digest("hex")).toBe("419acb2adcdb5bf27ee99f92bf3f737876efad9ca8c4a7c1836f1c00a68a1255");
    expect(source.indexOf('if (response.status !== "completed")')).toBeLessThan(source.indexOf('if (invalidItems) return uncertain("provider_unexpected_output"'));
    expect(source).toContain("store: false, background: false, stream: false");
  });

  it("installs no adjudication, preserves existing function identities/ACLs, and grants no new privilege", async () => {
    expect(afterSecurity).toEqual(beforeSecurity);
    expect((await db.query(`select * from ${table}`)).rows).toEqual([]);
    expect(await paused()).toEqual({ owner: true, global: true });
    for (const role of ["anon", "authenticated", "service_role", "fixture_api_text_a", "fixture_api_text_b", "fixture_adjudication_hostile"]) {
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role, table])).rows[0]!.allowed).toBe(false);
      for (const fn of ["record_research_operator_adjudication()", "research_operator_adjudication_matches(uuid)"])
        expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, `fluid_private.${fn}`])).rows[0]!.allowed).toBe(false);
    }
    expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass", [table])).rows)
      .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it("requires a separately supplied decision reference and rolls back rejected adjudications", async () => {
    const before = await snapshot();
    await rejected(unapprovedInsert, [], "operator_decision_reference_required");
    await rejected(insert.replace("'operator-decision:synthetic-local-test-only'", "null"), [], "operator_decision_reference_required");
    expect(await snapshot()).toEqual(before);
    for (const role of ["anon", "authenticated", "service_role"] as const)
      await asRole(db, role, OWNER_B, () => rejected(insert, [], "permission denied"));
    await asApiTextWorker(db, OWNER_A, () => rejected(insert, [], "permission denied"));
    expect(await snapshot()).toEqual(before);
  });

  it("permits truncating an empty adjudication table without changing data or security", async () => {
    const before = await snapshot();
    const existingSecurity = (await security()).rows;
    await db.query(`truncate ${table}`);
    expect(await snapshot()).toEqual(before);
    expect((await security()).rows).toEqual(existingSecurity);
  });

  it("changes only job state/error/finish and appends the receipt while every financial and evidence row stays unchanged", async () => {
    const before = await snapshot();
    await db.query(insert);
    const after = await snapshot();
    for (const key of Object.keys(before).filter(key => key !== "public.jobs" && key !== table)) expect(after[key], key).toEqual(before[key]);
    const rows = (value: unknown) => (value as Array<{ data: Record<string, unknown> }>).map(({ data }) => {
      if (data.id !== jobId) return data;
      const copy = { ...data }; delete copy.state; delete copy.error_code; delete copy.finished_at; return copy;
    });
    expect(rows(after["public.jobs"])).toEqual(rows(before["public.jobs"]));
    expect((await db.query("select state,error_code,finished_at is not null finished from public.jobs where id=$1", [jobId])).rows)
      .toEqual([{ state: "failed", error_code: "operator_abandoned_billing_unresolved", finished: true }]);
    expect((await db.query(`select output_sha256,observed_microusd,retained_microusd,operator_role,operator_session,original_job_state from ${table}`)).rows)
      .toEqual([{ output_sha256: outputHash, observed_microusd: 74665, retained_microusd: 15818215, operator_role: "postgres", operator_session: "postgres", original_job_state: "needs_reconciliation" }]);
    expect(await matches()).toBe(true);
    expect(await paused()).toEqual({ owner: false, global: false });
  });

  it("rejects wrong identities, output/source hashes, and source revision atomically", async () => {
    const before = await snapshot();
    for (const [from, to] of [[jobId, crypto.randomUUID()], [OWNER_B, OWNER_A], [projects.b, projects.a], [stepId, crypto.randomUUID()],
      [outputHash, "0".repeat(64)], ["af6faf18912cc24afb37179a6988a11f83cf9cdf", "0".repeat(40)],
      ["419acb2adcdb5bf27ee99f92bf3f737876efad9ca8c4a7c1836f1c00a68a1255", "1".repeat(64)]])
      await rejected(insert.replaceAll(from!, to!));
    expect(await snapshot()).toEqual(before);
  });

  it("rejects an already changed outcome or accounting row before recording a decision", async () => {
    await db.query("update public.job_steps set output=jsonb_set(output,'{error}','\"provider_outcome_unknown\"') where id=$1", [stepId]);
    await rejected(insert, [], "research_adjudication_evidence_mismatch");
    expect((await db.query(`select * from ${table}`)).rows).toEqual([]);
  });

  it("keeps the receipt append-only, rejects duplicate adjudication, and cannot settle through the ordinary finish API", async () => {
    await db.query(insert); const before = await snapshot();
    await rejected(`update ${table} set reason='A changed operator reason that must remain forbidden'` , [], "immutable_operator_adjudication");
    await rejected(`delete from ${table}`, [], "immutable_operator_adjudication");
    await rejected(`truncate ${table}`, [], "immutable_operator_adjudication");
    await rejected(insert, [], "research_adjudication_evidence_mismatch");
    await asApiTextWorker(db, OWNER_A, () => rejected("select public.api_text_dispatch_action($1,'finish',$2)", [descriptor, [crypto.randomUUID(), "failed", "ignored"]]));
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["output", "update public.job_steps set output=output||'{\"unexpected\":true}' where id=$1", stepId],
    ["step cost", "update public.job_steps set actual_cost_microusd=actual_cost_microusd+1 where id=$1", stepId],
    ["job input", "update public.jobs set input=input||'{\"unexpected\":true}' where id=$1", jobId],
    ["job restart", "update public.jobs set state='queued' where id=$1", jobId],
    ["reserve release", "update public.usage_reservations set state='settled' where job_id=$1", jobId],
    ["ledger hold", "update public.usage_accounts set reserved_microusd=reserved_microusd-1 where owner_id=$1", OWNER_B],
    ["publication", "update fluid_private.api_text_dispatches set publication_generation=1,generation_started_at=clock_timestamp(),published_at=null,published_message_id=null where job_id=$1", jobId],
  ])("restores the pause if %s changes after the immutable receipt", async (_name, sql, key) => {
    await db.query(insert); await db.query(sql, [key]);
    expect(await matches()).toBe(false); expect(await paused()).toEqual({ owner: true, global: true });
  });

  it("does not hide an additional step, unrelated ambiguous outcome, or confirmed overrun", async () => {
    await db.query(insert);
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values($1,$2,$3,'unexpected-extra-step','unexpected-extra-key','in_flight',0)", [jobId, OWNER_B, projects.b]);
    expect(await matches()).toBe(false); expect(await paused()).toEqual({ owner: true, global: true });
    await db.query("delete from public.job_steps where job_id=$1 and step_key='unexpected-extra-step'", [jobId]);
    const other = crypto.randomUUID();
    await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd) values($1,$2,$3,'strategy.reformulate',1,repeat('b',64),'{}','synthetic-other-unknown','needs_reconciliation',0)", [other, OWNER_A, projects.a]);
    await db.query("insert into fluid_private.api_text_allowance_admissions(job_id,owner_id,cohort_id,role_name,role_oid,maximum_cost_microusd) select $1,$2,'fixture',rolname,oid,122880 from pg_roles where rolname='fixture_api_text_a'", [other, OWNER_A]);
    expect(await matches()).toBe(true); expect(await paused()).toEqual({ owner: false, global: true });
    await db.query("update public.jobs set state='failed',actual_cost_microusd=122881 where id=$1", [other]);
    expect(await paused()).toEqual({ owner: false, global: true });
    await db.query("update public.jobs set actual_cost_microusd=15892881 where id=$1", [jobId]);
    expect(await paused()).toEqual({ owner: true, global: true });
  });

  it("does not retry or publish the abandoned request, and a late completion cannot charge or replace its evidence", async () => {
    await db.query(insert); const before = await snapshot();
    expect(await action("claim", ["synthetic-worker", 60])).toMatchObject({ disposition: "terminal", state: "failed" });
    expect(await action("descriptor")).toMatchObject({ state: "failed", retryable: false });
    await asApiTextWorker(db, OWNER_A, () => rejected("select public.api_text_dispatch_action($1,'complete',$2)",
      [descriptor, [crypto.randomUUID(), stepKey, "succeeded", 99999, {}, "resp_late_synthetic"]]));
    expect(await snapshot()).toEqual(before);
  });

  it("requires an explicit new admission, preserves one active request, and leaves ordinary-account/signup gates closed", async () => {
    await db.query(insert);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
    expect((await availability(db, OWNER_A, projects.a)).status).toBe("unavailable");
    await asRole(db, "authenticated", OWNER_A, () => rejected("select public.enqueue_strategy_job($1,1,'strategy.reformulate','ordinary-still-closed',122880)", [projects.a]));
    const next = await asRole(db, "authenticated", OWNER_B, async () => (await db.query<{ value: { id: string } }>(
      "select public.enqueue_strategy_job($1,2,'strategy.competitors','explicit-synthetic-new-request',15892880) value", [projects.b])).rows[0]!.value);
    expect(next.id).not.toBe(jobId);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await asRole(db, "authenticated", OWNER_B, () => rejected("select public.enqueue_strategy_job($1,2,'strategy.competitors','blocked-second-active',15892880)", [projects.b]));
    await db.query("update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '1 minute' where id=$1", [next.id]);
    await asRole(db, "authenticated", OWNER_B, () => rejected("select public.enqueue_strategy_job($1,2,'strategy.competitors','blocked-running-active',15892880)", [projects.b]));
    expect((await db.query("select reserved_microusd,actual_microusd,captured_microusd,state from public.usage_reservations where job_id=$1", [jobId])).rows)
      .toEqual([{ reserved_microusd: 15892880, actual_microusd: 74665, captured_microusd: 74665, state: "active" }]);
    expect((await db.query("select signup_cohort from fluid_private.api_text_allowance_rollout")).rows).toEqual([{ signup_cohort: null }]);
    expect((await db.query("select count(*)::int count from fluid_private.api_text_owner_entitlements where owner_id=$1", [OWNER_A])).rows).toEqual([{ count: 0 }]);
    expect(await matches()).toBe(true);
  });
});
