import { API_TEXT_MULTI_ACCOUNT_MIGRATION } from "./fixture-migrations";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { DEFAULT_SUBSCRIPTION_LIMITS } from "../../src/domain/strategy-jobs";
import { createTestDatabase, installApiTextRuntimeCandidate, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";

type Evidence = { subscriptionUnknownSha256: string; subscriptionPolicySha256: string; subscriptionRegistrationSha256: string };
const directory = new URL("../../supabase/activation/", import.meta.url);
const subscriptionPolicy = { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "strategy-chatgpt-v1", registrationId: "activation-fixture", model: "unchanged-fixture-model", limits: DEFAULT_SUBSCRIPTION_LIMITS };

describe("review-only API activation templates in disposable PostgreSQL", () => {
  let db: TestDatabase;
  let project: string;
  let secondProject: string;
  let replacements: Record<string, string>;
  beforeAll(async () => {
    db = await createTestDatabase({ before: API_TEXT_MULTI_ACCOUNT_MIGRATION });
    await installApiTextRuntimeCandidate(db);
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    if ((await db.query("select 1 from pg_roles where rolname='fluid_api_text_worker'")).rows.length) {
      await db.exec("drop owned by fluid_api_text_worker; drop role fluid_api_text_worker");
    }
    await resetFixture(db);
    await db.exec("delete from fluid_private.strategy_runtime_policy");
    project = (await seedProject(db)).id;
    secondProject = (await seedProject(db)).id;
    await db.query("insert into fluid_private.subscription_registrations values('activation-fixture',$1)", [OWNER_A]);
    await db.query("insert into fluid_private.subscription_runtime_policy(owner_id,operation,registration_id,policy,enabled) values($1,'strategy.reformulate','activation-fixture',$2,false)", [OWNER_A, JSON.stringify(subscriptionPolicy)]);
    for (const [index, operation] of ["strategy.reformulate", "strategy.competitors", "strategy.audience"].entries()) {
      await db.query("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,billing_mode,policy_identity,max_attempts,reserved_cost_microusd) values($1,$2,$3,1,repeat('a',64),$4::jsonb,$5,'needs_reconciliation','chatgpt_subscription',encode(sha256(convert_to($6::jsonb::text,'UTF8')),'hex'),1,0)", [OWNER_A, project, operation, JSON.stringify({ version: 1, billingMode: "chatgpt_subscription", policy: subscriptionPolicy }), `activation-history-${index}`, JSON.stringify(subscriptionPolicy)]);
    }
    await db.query("delete from public.usage_accounts where owner_id=$1", [OWNER_A]);
    replacements = {
      "17dd910a-a9cb-4999-aa0e-2b5aa141bb29": project,
      "850dba6b-6811-41a2-ab26-cd3248039574": secondProject,
      REPLACE_REVIEWED_EXTERNAL_CHARGE_FLOOR_MICROUSD: "0",
      REPLACE_EXTERNAL_USAGE_RECONCILIATION_STATUS: "REVIEWED_COMPLETE",
      REPLACE_RECONCILIATION_EVIDENCE_REFERENCE: "synthetic-no-provider-calls",
      REPLACE_QUALIFIED_IMMUTABLE_DEPLOYMENT_ID: "dpl_qualified_fixture",
      REPLACE_OBSERVED_ROUTE_REVISION: "0",
    };
    const results = await run("00_preflight");
    const evidence = results.flatMap(result => result.rows).find(row => "activation_preflight" in row)?.activation_preflight as Evidence;
    replacements.REPLACE_THREE_SUBSCRIPTION_UNKNOWN_SHA256 = evidence.subscriptionUnknownSha256;
    replacements.REPLACE_SUBSCRIPTION_POLICY_SHA256 = evidence.subscriptionPolicySha256;
    replacements.REPLACE_SUBSCRIPTION_REGISTRATION_SHA256 = evidence.subscriptionRegistrationSha256;
  });
  async function run(phase: string) {
    let sql = await readFile(new URL(`api_text_${phase}.sql`, directory), "utf8");
    for (const [key, value] of Object.entries(replacements)) sql = sql.replaceAll(key, value);
    try { return await db.exec(sql); }
    catch (error) { await db.exec("rollback"); throw error; }
  }
  async function loginAndGrants() {
    await run("10_create_login");
    replacements.REPLACE_FRESH_ROLE_OID = String((await db.query<{ oid: number }>("select oid from pg_roles where rolname='fluid_api_text_worker'")).rows[0]!.oid);
    await run("20_grants");
  }
  async function activate() { await loginAndGrants(); await run("30_budget"); await run("40_activate_reformulate"); }
  const history = () => db.query("select to_jsonb(j) as data from public.jobs j order by id");
  const budget = () => db.query("select * from public.usage_accounts where owner_id=$1", [OWNER_A]);

  it("derives the owner, creates only the absent ledger, enables reformulate and disables without changing history", async () => {
    const before = await history();
    await activate(); await run("60_readback");
    expect((await budget()).rows[0]).toMatchObject({ owner_id: OWNER_A, limit_microusd: 5_000_000, spent_microusd: 0, reserved_microusd: 0, provider_actual_microusd: 0 });
    expect((await db.query("select operation,enabled from fluid_private.api_strategy_bindings")).rows).toEqual([{ operation: "strategy.reformulate", enabled: true }]);
    await db.exec("set session authorization fluid_api_text_worker");
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_B]);
      expect((await db.query("select public.api_text_worker_owner() as owner")).rows[0]).toEqual({ owner: OWNER_A });
      await expect(db.query("select * from public.jobs")).rejects.toMatchObject({ code: "42501" });
    } finally { await db.exec("set session authorization postgres"); }
    await run("50_disable");
    expect((await db.query("select enabled from fluid_private.api_strategy_bindings")).rows).toEqual([{ enabled: false }]);
    expect((await db.query("select billing_mode from fluid_private.strategy_billing_routes")).rows).toEqual([{ billing_mode: "openai_api" }]);
    expect((await history()).rows).toEqual(before.rows);
  });
  it("grants exactly the reviewed thirteen RPCs and seven recovery columns without grant options", async () => {
    await loginAndGrants();
    const expectedFunctions = [
      "public.claim_api_text_job(uuid,text,integer,text,text)",
      "public.check_api_text_runtime(text,jsonb,text)",
      "public.authorize_api_text_dispatch(uuid,uuid,text,text,text)",
      "public.heartbeat_job(uuid,uuid,integer)",
      "public.register_job_plan(uuid,uuid,jsonb)",
      "public.begin_job_step(uuid,uuid,text,text,bigint)",
      "public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text)",
      "public.finish_job(uuid,uuid,text,text)",
      "public.expire_api_text_job(uuid)",
      "public.get_api_text_dispatch(uuid)",
      "public.mark_api_text_published(uuid,text,integer,text)",
      "public.list_pending_api_text_dispatches(integer)",
      "public.prepare_api_text_redrive(uuid,text,integer)",
    ];
    const functions = (await db.query<{ signature: string; privilege_type: string; is_grantable: boolean }>("select n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' as signature,a.privilege_type,a.is_grantable from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(p.proacl) a where a.grantee=(select oid from pg_roles where rolname='fluid_api_text_worker')")).rows;
    expect(functions.map(row => ({ ...row, signature: row.signature.replaceAll(', ', ',') }))).toEqual(expect.arrayContaining(expectedFunctions.map(signature => ({ signature, privilege_type: "EXECUTE", is_grantable: false }))));
    expect(functions).toHaveLength(13);
    const columns = (await db.query("select n.nspname as schema,c.relname as relation,p.attname as column,a.privilege_type,a.is_grantable from pg_attribute p join pg_class c on c.oid=p.attrelid join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(p.attacl) a where a.grantee=(select oid from pg_roles where rolname='fluid_api_text_worker') order by p.attname")).rows;
    expect(columns).toEqual(["job_id", "owner_id", "project_id", "request_key", "reserved_cost_microusd", "state", "step_key"].map(column => ({ schema: "public", relation: "job_steps", column, privilege_type: "SELECT", is_grantable: false })));
    expect((await db.query("select rolpassword is null as passwordless from pg_authid where rolname='fluid_api_text_worker'")).rows).toEqual([{ passwordless: true }]);
  });
  it("returns bounded preflight and activation evidence without owner or account identity fields", async () => {
    const preflight = await run("00_preflight");
    await activate();
    const readback = await run("60_readback");
    for (const results of [preflight, readback]) {
      const evidence = JSON.stringify(results.flatMap(result => result.rows));
      expect(evidence).not.toContain(OWNER_A);
      expect(evidence).not.toMatch(/derivedOwnerId|owner_id|email|title/);
      expect(evidence).toContain("subscriptionUnknownSha256");
    }
  });
  it.each(["missing", "other-owner", "duplicate"])("rejects a %s second verified anchor without creating a role", async kind => {
    replacements["850dba6b-6811-41a2-ab26-cd3248039574"] = kind === "missing" ? "99999999-9999-4999-8999-999999999999" : kind === "duplicate" ? project : (await seedProject(db, OWNER_B)).id;
    await expect(run("10_create_login")).rejects.toThrow("verified_owner_project_anchor_mismatch");
    expect((await db.query("select 1 from pg_roles where rolname='fluid_api_text_worker'")).rows).toEqual([]);
  });
  it("stops on role collision and stale OID rather than reusing or resetting a login", async () => {
    await run("10_create_login");
    await expect(run("10_create_login")).rejects.toThrow("role_or_owner_mapping_collision_stop");
    replacements.REPLACE_FRESH_ROLE_OID = "1";
    await expect(run("20_grants")).rejects.toThrow("fresh_restricted_role_required");
    expect((await db.query("select * from fluid_private.api_text_worker_principals")).rows).toEqual([]);
  });
  it("leaves a matching existing account byte-for-byte unchanged on repeated budget checks", async () => {
    await db.query("insert into public.usage_accounts(owner_id,limit_microusd) values($1,5000000)", [OWNER_A]);
    const before = await budget(); await run("30_budget"); await run("30_budget");
    expect((await budget()).rows).toEqual(before.rows);
  });
  it.each(["limit_microusd=1000", "spent_microusd=10,provider_actual_microusd=10", "reserved_microusd=10"])("fails ledger mismatch without overwriting %s", async changes => {
    await db.query("insert into public.usage_accounts(owner_id,limit_microusd) values($1,5000000)", [OWNER_A]);
    await db.query(`update public.usage_accounts set ${changes} where owner_id=$1`, [OWNER_A]);
    const before = await budget();
    await expect(run("30_budget")).rejects.toThrow("shared_ledger_requires_reviewed_reconciliation");
    expect((await budget()).rows).toEqual(before.rows);
  });
  it.each(["REPLACE_EXTERNAL_USAGE_RECONCILIATION_STATUS", "REPLACE_REVIEWED_EXTERNAL_CHARGE_FLOOR_MICROUSD"])("refuses absent account initialization with unknown or prior external exposure %s", async key => {
    replacements[key] = key.includes("STATUS") ? "UNKNOWN" : "1";
    await expect(run("30_budget")).rejects.toThrow("missing_account_has_prior_or_unknown_paid_exposure");
    expect((await budget()).rows).toEqual([]);
  });
  it("refuses absent account initialization when a monetary API job already exists", async () => {
    await db.query("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,state) values($1,$2,'strategy.reformulate',1,repeat('b',64),'{}','prior-api-exposure',100,'needs_reconciliation')", [OWNER_A, project]);
    await expect(run("30_budget")).rejects.toThrow("missing_account_has_prior_or_unknown_paid_exposure");
    expect((await budget()).rows).toEqual([]);
  });
  it("fails activation atomically if historical subscription fingerprints changed", async () => {
    await loginAndGrants(); await run("30_budget");
    await db.query("update fluid_private.subscription_runtime_policy set worker_ready_until=clock_timestamp() where owner_id=$1", [OWNER_A]);
    await expect(run("40_activate_reformulate")).rejects.toThrow("preserved_subscription_evidence_changed");
    expect((await db.query("select * from fluid_private.strategy_runtime_policy")).rows).toEqual([]);
    expect((await db.query("select * from fluid_private.api_strategy_bindings")).rows).toEqual([]);
  });
  it("fails a route CAS without leaving a policy or binding partially activated", async () => {
    await loginAndGrants(); await run("30_budget"); replacements.REPLACE_OBSERVED_ROUTE_REVISION = "7";
    await expect(run("40_activate_reformulate")).rejects.toThrow("route_revision_conflict");
    expect((await db.query("select * from fluid_private.strategy_runtime_policy")).rows).toEqual([]);
    expect((await db.query("select * from fluid_private.api_strategy_bindings")).rows).toEqual([]);
  });
  it("detects inherited PUBLIC privileged RPCs without revoking global privileges", async () => {
    await activate(); await db.exec("grant execute on function public.expire_job_leases() to public");
    try { await expect(run("60_readback")).rejects.toThrow("unexpected_effective_privileged_rpc"); }
    finally { await db.exec("revoke execute on function public.expire_job_leases() from public"); }
  });
  it.each([
    ["connect grant option", "grant connect on database postgres to fluid_api_text_worker with grant option", "unexpected_direct_database_grant"],
    ["extra database privilege", "grant temporary on database postgres to fluid_api_text_worker", "unexpected_direct_database_grant"],
    ["schema usage grant option", "grant usage on schema public to fluid_api_text_worker with grant option", "unexpected_direct_schema_grant"],
  ])("rejects %s in readback", async (_label, sql, error) => {
    await activate();
    await db.exec(sql!);
    await expect(run("60_readback")).rejects.toThrow(error!);
  });
  it.each(["20_grants", "40_activate_reformulate", "60_readback"])("rejects inherited table access in another usable schema during %s", async phase => {
    if (phase === "20_grants") {
      await run("10_create_login");
      replacements.REPLACE_FRESH_ROLE_OID = String((await db.query<{ oid: number }>("select oid from pg_roles where rolname='fluid_api_text_worker'")).rows[0]!.oid);
    } else if (phase === "40_activate_reformulate") { await loginAndGrants(); await run("30_budget"); }
    else await activate();
    await db.exec("create schema fixture_extra; grant usage on schema fixture_extra to public; create table fixture_extra.private_fixture(id integer); grant select on fixture_extra.private_fixture to public");
    try {
      await expect(run(phase)).rejects.toThrow("unexpected_table_access");
      if (phase === "20_grants") expect((await db.query("select * from fluid_private.api_text_worker_principals")).rows).toEqual([]);
      if (phase === "40_activate_reformulate") expect((await db.query("select * from fluid_private.api_strategy_bindings")).rows).toEqual([]);
    } finally { await db.exec("drop schema fixture_extra cascade"); }
  });
  it.each([
    ["connect grant option", "grant connect on database postgres to fluid_api_text_worker with grant option", "unexpected_direct_database_grant"],
    ["schema usage grant option", "grant usage on schema public to fluid_api_text_worker with grant option", "unexpected_direct_schema_grant"],
    ["extra function", "grant execute on function public.expire_job_leases() to fluid_api_text_worker", "unexpected_effective_privileged_rpc"],
  ])("rejects drifted %s before any activation write", async (_label, sql, error) => {
    await loginAndGrants(); await run("30_budget");
    await db.exec(sql!);
    await expect(run("40_activate_reformulate")).rejects.toThrow(error!);
    expect((await db.query("select * from fluid_private.strategy_runtime_policy")).rows).toEqual([]);
    expect((await db.query("select * from fluid_private.api_strategy_bindings")).rows).toEqual([]);
    expect((await db.query("select * from fluid_private.strategy_billing_routes")).rows).toEqual([]);
  });
  for (const phase of ["40_activate_reformulate", "60_readback"]) {
    it.each([
      ["table", "grant select on fluid_private.api_text_worker_principals to fluid_api_text_worker", "unexpected_direct_relation_grant"],
      ["column", "grant select(role_oid) on fluid_private.api_text_worker_principals to fluid_api_text_worker", "unexpected_direct_column_grant"],
    ])(`rejects direct %s access in an inaccessible schema during ${phase}`, async (_label, sql, error) => {
      await loginAndGrants(); await run("30_budget");
      if (phase === "60_readback") await run("40_activate_reformulate");
      expect((await db.query("select has_schema_privilege('fluid_api_text_worker','fluid_private','USAGE') as allowed")).rows).toEqual([{ allowed: false }]);
      await db.exec(sql!);
      await expect(run(phase)).rejects.toThrow(error!);
      if (phase === "40_activate_reformulate") expect((await db.query("select * from fluid_private.api_strategy_bindings")).rows).toEqual([]);
    });
  }
  it.each(["binding-hash", "disabled-policy", "changed-policy-and-binding"])("rejects %s during activation readback", async change => {
    await activate();
    if (change === "binding-hash") await db.exec("update fluid_private.api_strategy_bindings set policy_identity=repeat('f',64)");
    else if (change === "disabled-policy") await db.exec("update fluid_private.strategy_runtime_policy set enabled=false");
    else await db.exec("update fluid_private.strategy_runtime_policy set policy=jsonb_set(policy,'{model}','\"fixture-unreviewed-model\"'::jsonb); update fluid_private.api_strategy_bindings set policy_identity=(select encode(sha256(convert_to(policy::text,'UTF8')),'hex') from fluid_private.strategy_runtime_policy where operation='strategy.reformulate')");
    await expect(run("60_readback")).rejects.toThrow("exact_reformulate_only_activation_required");
  });
  it("rejects grant options on the otherwise approved recovery columns", async () => {
    await activate();
    await db.exec("grant select(job_id) on public.job_steps to fluid_api_text_worker with grant option");
    await expect(run("60_readback")).rejects.toThrow("unexpected_column_grant_option");
  });
  it("detects inherited PUBLIC schema creation and unapproved column reads", async () => {
    await activate(); await db.exec("grant create on schema public to public");
    try { await expect(run("60_readback")).rejects.toThrow("unexpected_schema_create"); }
    finally { await db.exec("revoke create on schema public from public"); }
    await db.exec("grant select(output) on public.job_steps to public");
    try { await expect(run("60_readback")).rejects.toThrow("unexpected_column_read"); }
    finally { await db.exec("revoke select(output) on public.job_steps from public"); }
  });
  it("does not reuse or re-enable an existing identical global policy", async () => {
    await activate(); await run("50_disable");
    await db.exec("delete from fluid_private.api_strategy_bindings");
    replacements.REPLACE_OBSERVED_ROUTE_REVISION = "1";
    const before = (await db.query("select * from fluid_private.strategy_runtime_policy")).rows;
    await expect(run("40_activate_reformulate")).rejects.toThrow("existing_global_policy_collision_stop");
    expect((await db.query("select * from fluid_private.strategy_runtime_policy")).rows).toEqual(before);
    expect((await db.query("select * from fluid_private.api_strategy_bindings")).rows).toEqual([]);
  });

});
