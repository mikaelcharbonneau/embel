import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000 });
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { asApiTextWorker, asRole, OWNER_A, OWNER_B, seedProject, type TestDatabase } from "./local-supabase";
import { admit, availability, createMultiAccountFixture, enableSyntheticCohort, resetMultiAccountFixture } from "./api-text-multi-account-fixture";

const incidents = [
  { job: "6b310a38-eadf-4d64-9474-b7632cfa2340", project: "8aa59964-7057-4a96-8142-82561fc5ffda", step: "bf70b5ce-3a48-4b8d-92c0-f4e29b145595", input: "8db2a72d2376339aad0bdde50f2097ab98d84e6bfa1aeb05fed6542d28efe6ef", output: "c787e1485edc74f13cd1d03736b536933b7a3c75fc9f5ac826e7890977382dde", plan: "36e8eb404ddd2553e88c99e60fb7269546bb639938af1d54f5b7e106a2cd2a09", suffix: "0d8273285a00846d419b430c", request: "8d98c0dd974e9cab53f8219dd47be631fb5d803798a8b4321ec72218456e60e3", response: "resp_0959915f311fe770016ad02385554087d29b4acba26b8d485b", completed: "2026-10-15 00:51:40.064741+00", deployment: "dpl_AsMYHhJeVxxMtmfRmRM1QT379Shd", dispatch: "74dd47827976d8e6b83f39f146019cd7f11c7cb343aaf5a10d8212ecc0e1ce77", published: "2026-10-15 00:51:15.830025+00", actual: 74665, revision: 1 },
  { job: "5f31a4ff-f747-4464-bc79-64b757fe5df3", project: "4da54b89-43b8-4da6-a092-ce6113fd3916", step: "a4794328-be5e-4c7e-a6b0-9a6f007e0f05", input: "fcf1028e9f40eca0bf4b24187593b7251fac4701589e387840e591919d3e0332", output: "2182808eb117289a1e340943063c4033fbaef6ff534c030965a20578353e3a6c", plan: "d7caefe8330aaae7a052f0637c6e4b7da54a0514ab8352387ba610453ab528b6", suffix: "3358af25ab3cafbf9b34ad16", request: "fbb6da4354b3ca12e5e56415b97800a1d0b34e311f39a35d34dc76129b0d6d42", response: "resp_01fb73b509bba760016ad0313774d487d2911a901d0890e66e", completed: "2026-10-15 01:50:07.395506+00", deployment: "dpl_dH4b38QkzS5sQnFDuYHZgsVv84Jy", dispatch: "3332203ce900ff11305e3b8e9f3278dfea93bbda03ae2aa3c021fc797124e1a0", published: "2026-10-15 01:49:38.166426+00", actual: 81399, revision: 1 },
  { job: "beb22588-79a8-4f59-a403-5d540e811315", project: "fecf071f-8b3c-48da-bdd5-39ea75e0a537", step: "904cfc01-ff0e-4a04-a4c7-5f4c85cc32bf", input: "2a49b6d84b0e6f498c9281328290a7912e63d7638602894721f18dca5662a9c8", output: "67d92b51de3c01b002123d57ca43003c063ae8acb96f406e91b0c3e5874a1bed", plan: "fd5c6364c0c49538a0c715733ade47fb2c010ac9a8f40ad02cdd645d73262073", suffix: "d25a425fc0ea3e7321aa0a74", request: "e2f5c1d8dbefcdde4a7558cb5c71cdb969c8447b474d05b48b0c74d9f9a55aa9", response: "resp_0fef346ef57106ff016ad17254f2cc87d1b34a6eebe38cf99c", completed: "2026-10-16 00:40:15.771752+00", deployment: "dpl_DyFpKiQWg3kGoRJnqarxR286CDXY", dispatch: "fcd2695d4f8ff84392053443a48e3b5fe32f2bfd5108adc1402271fb3e5a32da", published: "2026-10-16 00:39:44.176857+00", actual: 70038, revision: 4 },
] as const;
const target = incidents[2];
const table = "fluid_private.api_text_operator_adjudications";
const policyId = "aec17e433d66a556c6762a1c945b83464e4a4ac4851ac91118df4c2eddbe739b";
const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const packetPath = "supabase/migrations/20261016020816_third_terminal_research_operator_adjudication.sql";
const applyPath = "supabase/candidates/research_operator_abandonment_beb22588_apply.sql";

/** All customer content, owners, projects and native row fingerprints are
 * replaced ONLY in this disposable PGlite fixture. No provider or hosted DB. */
describe("third exact local research recovery", () => {
  let db: TestDatabase, insert: string, unapproved: string, candidate: string;
  let targetProject: string, otherProject: string;
  let beforeSecurity: unknown, beforeInstallation: unknown;
  let hostilePredecessorError: string | undefined, securityAfterHostileAttempt: unknown, dataAfterHostileAttempt: unknown;
  const replacements = new Map<string, string>();
  const substitute = (sql: string) => [...replacements].reduce((text, [from, to]) => text.replaceAll(from, to), sql);
  const noTransaction = (sql: string) => sql.replace(/^begin;$/m, "").replace(/^commit;$/m, "");
  const paused = async () => (await db.query("select fluid_private.api_text_paid_paused($1) owner,fluid_private.api_text_allowance_paused() global", [OWNER_B])).rows[0];
  const matches = async (job = target.job) => (await db.query<{ value: boolean }>("select fluid_private.research_operator_adjudication_matches($1) value", [job])).rows[0]!.value;
  const security = async () => (await db.query(`select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof,
    case when oid<>'fluid_private.record_research_operator_adjudication()'::regprocedure then md5(prosrc) end source
    from pg_proc where oid in ('fluid_private.api_text_paid_paused(uuid)'::regprocedure,'fluid_private.api_text_allowance_paused()'::regprocedure,
    'fluid_private.record_research_operator_adjudication()'::regprocedure,'fluid_private.research_operator_adjudication_matches(uuid)'::regprocedure) order by oid`)).rows;
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const relation of ["public.jobs", "public.job_steps", "public.usage_accounts", "public.usage_reservations", "public.projects", "public.project_revisions",
      "fluid_private.api_text_dispatches", "fluid_private.api_text_allowance_admissions", "fluid_private.api_text_testing_admissions",
      "fluid_private.api_text_allowance_rollout", "fluid_private.api_text_allowance_cohorts", "fluid_private.api_text_owner_entitlements", table])
      result[relation] = (await db.query(`select to_jsonb(t) data from ${relation} t order by to_jsonb(t)::text`)).rows;
    return result;
  };
  async function rejected(sql: string, values: unknown[] = [], message?: string) {
    await db.exec("savepoint rejected_operation"); let error: unknown;
    try { await db.query(sql, values); } catch (caught) { error = caught; }
    await db.exec("rollback to savepoint rejected_operation; release savepoint rejected_operation");
    expect(error).toBeDefined(); if (message) expect(String(error)).toContain(message);
  }
  beforeAll(async () => {
    db = await createMultiAccountFixture();
    for (const name of ["20261014142522_api_text_unlimited_testing.sql", "20261014170000_guided_strategy_runtime.sql"])
      await db.exec(await read(`supabase/migrations/${name}`));
    const projects = await resetMultiAccountFixture(db); otherProject = projects.a;
    await enableSyntheticCohort(db, { globalAttempts: 1, globalCost: 122880, accounts: 1 });
    const trial = await admit(db, OWNER_B, projects.b, "synthetic-consumed-trial");
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_job_cancel($1)", [trial.id]));
    await db.query("update fluid_private.api_text_allowance_cohorts set operations=array['strategy.reformulate','strategy.competitors'],deployment_id=$1,expires_at=clock_timestamp()-interval '1 hour'", [target.deployment]);
    await db.exec("update fluid_private.api_text_allowance_rollout set signup_cohort=null; update fluid_private.api_text_owner_entitlements set expires_at=clock_timestamp()-interval '1 hour'");
    for (const operation of ["strategy.reformulate", "strategy.competitors"] as const) {
      const policy = guidedStrategyPolicy(operation);
      await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'fixture',$2,true)", [OWNER_B, operation]);
      await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2) on conflict(operation) do update set policy=excluded.policy", [operation, policy]);
      await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,$2,oid,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'),$4,true from pg_roles where rolname='fixture_api_text_a' on conflict(owner_id,operation) do update set policy_identity=excluded.policy_identity,deployment_id=excluded.deployment_id", [OWNER_B, operation, policy, target.deployment]);
    }
    replacements.set("6840f4c2-15a6-45a7-97be-41e7e5e37f42", OWNER_B);
    for (const incident of incidents) {
      const project = (await seedProject(db, OWNER_B)).id;
      replacements.set(incident.project, project);
      if (incident === target) targetProject = project;
      const context = contextSnapshotSchema.parse({ description: "Explicit synthetic recovery fixture", intake: {
        conversation: [{ id: "fixture-message", kind: "user_message", text: "Synthetic research", createdAt: "2026-10-15T00:00:00.000Z" }],
        guidedInterview: { version: 1, stage: "competitors", turns: [{ id: "fixture-turn", userMessageId: "fixture-message", stage: "competitors", purpose: "research", inputRevision: Math.max(2, incident.revision) }], answers: [] },
      } });
      // The third incident actually references revision four. Seed its owned
      // immutable revisions through the checked RPC rather than bypassing the FK.
      for (let revision = 1; revision < Math.max(2, incident.revision); revision++) {
        await asRole(db, "authenticated", OWNER_B, () => db.query("select public.append_project_revision($1,$2,$3,$4)", [project, revision, context, "a".repeat(64)]));
      }
      const input = { version: 2, policy: guidedStrategyPolicy("strategy.competitors"), context, acceptedMaxCostMicrousd: 15892880, assistantHistory: { entries: [], truncated: false } };
      const output = { error: incident === target ? "provider_invalid_output" : "provider_unexpected_output", result: { responseId: incident.response,
        model: "gpt-6.1-sol", partialText: "Explicit synthetic rejected result; no customer text", outputDiagnostics: { version: 1, responseStatus: "completed", outputItemCount: 4, toolCalls: 2, issueCount: 0, usageExceeded: false } } };
      const hash = async (value: unknown) => (await db.query<{ hash: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') hash", [value])).rows[0]!.hash;
      const inputHash = await hash(input); replacements.set(incident.input, inputHash); replacements.set(incident.output, await hash(output));
      const stepKey = `strategy-openai-guided-v1:strategy.competitors:${incident.suffix}`;
      await db.query(`insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,
        plan_manifest,plan_fingerprint,plan_registered_at,attempts,max_attempts,reserved_cost_microusd,actual_cost_microusd,error_code)
        values($1::uuid,$2,$3,'strategy.competitors',$4,$5,$6,$1::text,'needs_reconciliation',$7,$8,clock_timestamp(),1,3,15892880,$9,'provider_outcome_unknown')`,
      [incident.job, OWNER_B, project, incident.revision, inputHash, input, [{ key: stepKey, maximumCostMicrousd: 15892880 }], incident.plan, incident.actual]);
      await db.query(`insert into public.job_steps(id,job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,actual_cost_microusd,output,provider_request_id,completed_at)
        values($1,$2,$3,$4,$5,$6,'ambiguous',15892880,$7,$8,$9,$10)`, [incident.step, incident.job, OWNER_B, project, stepKey, incident.request, incident.actual, output, incident.response, incident.completed]);
      await db.query("insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd,actual_microusd,captured_microusd) values($1,$2,$3,15892880,$4,$4)", [incident.job, OWNER_B, project, incident.actual]);
      await db.query(`insert into fluid_private.api_text_dispatches(job_id,owner_id,project_id,policy_identity,deployment_id,dispatch_identity,published_message_id,published_at)
        values($1,$2,$3,$4,$5,$6,'fixture-message',$7)`, [incident.job, OWNER_B, project, policyId, incident.deployment, incident.dispatch, incident.published]);
      await db.query("insert into fluid_private.api_text_allowance_admissions(job_id,owner_id,cohort_id,role_name,role_oid,maximum_cost_microusd) select $1,$2,'fixture',rolname,oid,15892880 from pg_roles where rolname='fixture_api_text_a'", [incident.job, OWNER_B]);
      await db.query("insert into fluid_private.api_text_testing_admissions(job_id) values($1)", [incident.job]);
    }
    await db.query("update public.usage_accounts set reserved_microusd=47452538,spent_microusd=558045,provider_actual_microusd=558045 where owner_id=$1", [OWNER_B]);
    await db.exec(substitute(await read("supabase/migrations/20261015011434_terminal_research_operator_adjudication.sql")));
    const appliedInsert = async (path: string) => substitute(await read(path)).match(/insert into[\s\S]*?15892880,\d+,\d+\);/)![0]
      .replace("REPLACE_APPROVED_OPERATOR_DECISION_REFERENCE", "operator-decision:synthetic-local-fixture");
    await db.query(await appliedInsert("supabase/candidates/research_operator_abandonment_6b310a38_apply.sql"));
    const sourceHash = async () => (await db.query<{ hash: string }>("select md5(prosrc) hash from pg_proc where oid='fluid_private.record_research_operator_adjudication()'::regprocedure")).rows[0]!.hash;
    await db.exec(substitute(await read("supabase/migrations/20261015020136_second_terminal_research_operator_adjudication.sql")).replace("e6a1f54f15666b89447de29fa715b1cc", await sourceHash()));
    await db.query(await appliedInsert("supabase/candidates/research_operator_abandonment_5f31a4ff_apply.sql"));
    await db.exec("alter table public.jobs add column project_deletion_requested_at timestamptz");
    await db.exec(await read("supabase/migrations/20261016002628_research_receipt_deletion_compat.sql"));
    for (const [relation, key, nativeHash, omit] of [
      ["public.jobs", "id", "f3a0835adf7581dabc5084a776fe13429465c5dc7239fe0d93a66eb9650791a9", "-array['state','error_code','finished_at']"],
      ["public.job_steps", "job_id", "201be1b5c6aa340385ac9e62257cb4c716fe7ff313775a856e5e27eeb8aae7e9", ""],
      ["public.usage_reservations", "job_id", "d96ea336ae475b613bd83f925613d551d1323b25b724cdc133a2050e6f1524e0", ""],
      ["fluid_private.api_text_dispatches", "job_id", "63c40777f2a3a92f42062699c01cf1ad4687a432e7e69b8f8d6eec9888545865", ""],
      ["fluid_private.api_text_allowance_admissions", "job_id", "f59a91649e20eef79df2ca093e808a975170ba3e6536a093b6079fea116e74f3", ""],
      ["fluid_private.api_text_testing_admissions", "job_id", "fe8e2ffd05da1b3e6e259a8257648add0761686cbf51d0b882e4a2c5b157474f", ""],
      ["public.usage_accounts", "owner_id", "b8a103280f61e6bb333b998b475627aefa934bb85a1562a23e05a1e2fed3aedf", ""],
    ]) {
      const hash = (await db.query<{ hash: string }>(`select encode(sha256(convert_to((to_jsonb(t)${omit})::text,'UTF8')),'hex') hash from ${relation} t where ${key}=$1`, [key === "owner_id" ? OWNER_B : target.job])).rows[0]!.hash;
      replacements.set(nativeHash!, hash);
    }
    candidate = substitute(await read(packetPath)).replace("2b5fd4b7bf66738d87f211e72a858e12", await sourceHash());
    unapproved = substitute(await read(applyPath)).match(/insert into[\s\S]*?15892880,70038,15822842\);/)![0];
    insert = unapproved.replace("REPLACE_APPROVED_OPERATOR_DECISION_REFERENCE", "operator-decision:synthetic-current-fixture");
    beforeSecurity = await security(); beforeInstallation = await snapshot();
    // Exercise the hostile predecessor before the first installation, while the
    // recorder still has its reviewed predecessor bytes. Execute the complete
    // DDL packet rather than a prepared multi-command query, and roll it back.
    await db.exec("begin; alter function fluid_private.api_text_paid_paused(uuid) security definer");
    try { await db.exec(noTransaction(candidate)); }
    catch (error) { hostilePredecessorError = String(error); }
    finally { await db.exec("rollback"); }
    securityAfterHostileAttempt = await security(); dataAfterHostileAttempt = await snapshot();
    await db.exec(candidate);
  }, 300_000);
  beforeEach(async () => { await db.exec("begin"); });
  afterEach(async () => { await db.exec("rollback; set session authorization postgres; reset role"); });
  afterAll(async () => { await db?.close(); }, 30_000);

  it("installs no receipt or data change and preserves both existing matches and function security", async () => {
    expect(await security()).toEqual(beforeSecurity); expect(await snapshot()).toEqual(beforeInstallation);
    expect(await paused()).toEqual({ owner: true, global: true });
    for (const incident of incidents.slice(0, 2)) expect(await matches(incident.job as typeof target.job)).toBe(true);
    for (const role of ["anon", "authenticated", "service_role", "fixture_api_text_a", "fixture_api_text_b"])
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role, table])).rows[0]!.allowed).toBe(false);
  });
  it("requires an external operator decision and rejects unprivileged writes atomically", async () => {
    const before = await snapshot(); await rejected(unapproved, [], "operator_decision_reference_required");
    for (const role of ["anon", "authenticated", "service_role"] as const) await asRole(db, role, OWNER_B, () => rejected(insert, [], "permission denied"));
    await asApiTextWorker(db, OWNER_A, () => rejected(insert, [], "permission denied"));
    expect(await snapshot()).toEqual(before);
  });
  it("changes only the target state/error/finish and appends its receipt, retaining all holds and old receipts", async () => {
    const before = await snapshot(); await db.query(insert); const after = await snapshot();
    for (const key of Object.keys(before).filter(key => key !== "public.jobs" && key !== table)) expect(after[key], key).toEqual(before[key]);
    const jobs = (value: unknown) => (value as Array<{ data: Record<string, unknown> }>).map(({ data }) => {
      const copy = { ...data }; if (copy.id === target.job) { delete copy.state; delete copy.error_code; delete copy.finished_at; } return copy;
    });
    expect(jobs(after["public.jobs"])).toEqual(jobs(before["public.jobs"]));
    for (const incident of incidents) expect(await matches(incident.job as typeof target.job)).toBe(true);
    expect((await db.query(`select to_jsonb(t) data from ${table} t where job_id<>$1 order by to_jsonb(t)::text`, [target.job])).rows).toEqual(before[table]);
    expect(await paused()).toEqual({ owner: false, global: false });
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_B])).rows).toEqual([{ reserved_microusd: 47452538 }]);
  });
  it.each([
    ["job", "update public.jobs set attempts=2 where id=$1", target.job],
    ["step", "update public.job_steps set output=output||'{\"changed\":true}' where id=$1", target.step],
    ["reservation", "update public.usage_reservations set captured_microusd=0 where job_id=$1", target.job],
    ["dispatch", "update fluid_private.api_text_dispatches set published_message_id='changed' where job_id=$1", target.job],
    ["admission", "update fluid_private.api_text_allowance_admissions set created_at=clock_timestamp() where job_id=$1", target.job],
    ["testing marker", "update fluid_private.api_text_testing_admissions set created_at=clock_timestamp() where job_id=$1", target.job],
    ["ledger", "update public.usage_accounts set spent_microusd=spent_microusd+1 where owner_id=$1", OWNER_B],
  ])("rejects changed %s before writing a receipt", async (_name, sql, key) => {
    const immutableGuards: Partial<Record<string, { relation: string; trigger: string; error: string }>> = {
      dispatch: { relation: "fluid_private.api_text_dispatches", trigger: "api_text_dispatch_immutable", error: "immutable_dispatch" },
      admission: { relation: "fluid_private.api_text_allowance_admissions", trigger: "api_text_allowance_admission_immutable", error: "immutable_allowance_admission" },
      "testing marker": { relation: "fluid_private.api_text_testing_admissions", trigger: "api_text_testing_admission_immutable", error: "immutable_allowance_admission" },
    };
    const immutable = immutableGuards[_name];
    if (immutable) {
      const protectedRows = await snapshot();
      await rejected(sql, [key], immutable.error); expect(await snapshot()).toEqual(protectedRows);
      // Deliberate privileged corruption in disposable fixture only. First prove
      // the ordinary guard rejects it, then restore that guard before testing
      // the recovery packet's independent exact-row evidence check.
      await db.exec(`alter table ${immutable.relation} disable trigger ${immutable.trigger}`);
      try { await db.query(sql, [key]); }
      finally { await db.exec(`alter table ${immutable.relation} enable trigger ${immutable.trigger}`); }
      expect((await db.query("select tgenabled from pg_trigger where tgrelid=$1::regclass and tgname=$2", [immutable.relation, immutable.trigger])).rows)
        .toEqual([{ tgenabled: "O" }]);
    } else await db.query(sql, [key]);
    const before = await snapshot(); await rejected(insert); expect(await snapshot()).toEqual(before);
  });
  it("rejects mixed tuples, source claims and unsupported incidents", async () => {
    const before = await snapshot();
    for (const [from, to] of [[target.job, crypto.randomUUID()], [OWNER_B, OWNER_A], [targetProject, otherProject], [target.step, incidents[1].step],
      ["retained_completed_diagnostics_bounded_semantic_rejection", "reviewed_source_branch_order_provider_unexpected_output_after_completed"],
      ["source-snapshot-sha256:61ae3050a5bf5cc75986a4a5c39dae1834cd35b0128c87fe41b1b5f824a3e5c5", "unverified-source"],
      ["15892880,70038,15822842", "15892880,81399,15811481"]]) await rejected(insert.replaceAll(from!, to!));
    expect(await snapshot()).toEqual(before);
  });
  it("retains immutability and restores the pause if evidence, deletion state or the hold changes later", async () => {
    await db.query(insert); const before = await snapshot();
    await rejected(`delete from ${table}`, [], "immutable_operator_adjudication"); await rejected(`truncate ${table}`, [], "immutable_operator_adjudication"); await rejected(insert);
    expect(await snapshot()).toEqual(before);
    await db.query("update public.jobs set project_deletion_requested_at=clock_timestamp() where id=$1", [target.job]);
    expect(await matches()).toBe(false); expect(await paused()).toEqual({ owner: true, global: true });
  });
  it("leaves retries explicit and keeps ordinary access and the one-active-request limit", async () => {
    await db.query(insert);
    expect((await availability(db, OWNER_B, targetProject)).status).toBe("available");
    expect((await availability(db, OWNER_A, otherProject)).status).toBe("unavailable");
    const next = await asRole(db, "authenticated", OWNER_B, async () => (await db.query<{ value: { id: string } }>("select public.enqueue_strategy_job($1,$2,'strategy.competitors','explicit-synthetic-retry',15892880) value", [targetProject, target.revision])).rows[0]!.value);
    expect(next.id).not.toBe(target.job);
    await asRole(db, "authenticated", OWNER_B, () => rejected("select public.enqueue_strategy_job($1,$2,'strategy.competitors','blocked-second-active',15892880)", [targetProject, target.revision]));
    expect((await db.query("select reserved_microusd,actual_microusd,captured_microusd,state from public.usage_reservations where job_id=$1", [target.job])).rows)
      .toEqual([{ reserved_microusd: 15892880, actual_microusd: 70038, captured_microusd: 70038, state: "active" }]);
  });
  it("rejects changed predecessor security without changing any source or receipt", async () => {
    expect(hostilePredecessorError).toContain("unexpected_research_adjudication_extension_predecessor: fluid_private.api_text_paid_paused(uuid)");
    expect(securityAfterHostileAttempt).toEqual(beforeSecurity);
    expect(dataAfterHostileAttempt).toEqual(beforeInstallation);
  });
});
