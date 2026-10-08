import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, installApiTextRuntimeCandidate, installApiTextWorkerFixture, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";

const candidateUrl = new URL("../../supabase/candidates/api_strategy_budget_status.sql", import.meta.url);
const migrationUrl = new URL("../../supabase/migrations/20261008043000_api_strategy_budget_status.sql", import.meta.url);
const signature = "public.get_api_strategy_availability(uuid)";
const policy = { version: 1, pricingVersion: "2026-10-03", handlerVersion: "strategy-openai-v1", model: "gpt-6.1-sol", maxInputTokens: 32768, maxOutputTokens: 4096, maxWebSearchCalls: 0, inputMicrousdPerMillionTokens: 2_000_000, cachedInputMicrousdPerMillionTokens: 100_000, cacheWriteMicrousdPerMillionTokens: 2_500_000, outputMicrousdPerMillionTokens: 10_000_000, webSearchMicrousdPerCall: 10_000, maximumCostMicrousd: 122_880 };
const unavailable = (reason: string) => ({ status: "unavailable", operations: [], reason });
type Snapshot = { definition: string; body: string; metadata: Record<string, unknown> };

describe("API Strategy budget status forward correction (disposable PostgreSQL only)", () => {
  let db: TestDatabase;
  let candidate: string;
  let original: Snapshot;
  let corrected: Snapshot;
  let beforeOtherFunctions: unknown[];
  let afterOtherFunctions: unknown[];
  let project: string;
  let otherProject: string;
  const snapshot = async (database: TestDatabase = db) => (await database.query<Snapshot>(
    "select pg_get_functiondef(p.oid) definition,p.prosrc body,to_jsonb(p)-'prosrc' metadata from pg_proc p where p.oid=$1::regprocedure", [signature],
  )).rows[0]!;
  const otherFunctions = async (database: TestDatabase = db) => (await database.query(
    "select to_jsonb(p) metadata from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','fluid_private') and p.oid<>$1::regprocedure order by p.oid", [signature],
  )).rows;
  beforeAll(async () => {
    // Missing candidate intentionally tests the real unmodified baseline for RED.
    candidate = await readFile(candidateUrl, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    let originalBeforeMigration: Snapshot | undefined;
    let othersBeforeMigration: unknown[] | undefined;
    db = await createTestDatabase({ beforeMigration: async (database, sql) => {
      if (candidate && sql === candidate) {
        originalBeforeMigration = await snapshot(database);
        othersBeforeMigration = await otherFunctions(database);
      }
    } });
    original = originalBeforeMigration ?? await snapshot();
    beforeOtherFunctions = othersBeforeMigration ?? await otherFunctions();
    if (candidate) await db.exec(candidate);
    corrected = await snapshot();
    afterOtherFunctions = await otherFunctions();
    await installApiTextWorkerFixture(db);
  }, 30_000);
  beforeEach(async () => {
    await resetFixture(db);
    await db.exec("delete from fluid_private.strategy_runtime_policy; update public.usage_accounts set limit_microusd=5000000");
    await db.query("insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) select rolname,oid,case rolname when 'fixture_api_text_a' then $1::uuid else $2::uuid end from pg_roles where rolname in ('fixture_api_text_a','fixture_api_text_b')", [OWNER_A, OWNER_B]);
    project = (await seedProject(db)).id;
    otherProject = (await seedProject(db, OWNER_B)).id;
  });
  afterAll(async () => { await db?.close(); });
  const queryResult = async <T = unknown>(sql: string, args: unknown[] = []) => (await db.query<{ result: T }>(`select ${sql} result`, args)).rows[0]!.result;
  const availability = (owner: string | null = OWNER_A, projectId: string | null = project) => asRole(db, "authenticated", owner,
    () => queryResult("public.get_strategy_availability($1)", [projectId]));
  async function activate(operation = "strategy.reformulate", selectedPolicy = policy, owner = OWNER_A) {
    await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2::jsonb) on conflict(operation) do update set enabled=true,policy=excluded.policy", [operation, JSON.stringify(selectedPolicy)]);
    await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,$2,role_oid,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'),'fixture-approved-deployment',true from fluid_private.api_text_worker_principals where owner_id=$1", [owner, operation, JSON.stringify(selectedPolicy)]);
    await db.query("insert into fluid_private.strategy_billing_routes values($1,'openai_api',1) on conflict(owner_id) do nothing", [owner]);
  }
  const ledger = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ["usage_accounts", "usage_reservations", "jobs", "job_steps"]) {
      result[table] = (await db.query(`select to_jsonb(t) data from public.${table} t order by to_jsonb(t)::text`)).rows;
    }
    return result;
  };
  const enqueue = (key: string) => asRole(db, "authenticated", OWNER_A,
    () => queryResult("public.enqueue_strategy_job($1,1,'strategy.reformulate',$2,122880)", [project, key]));

  it("reports budget_unavailable for a qualified but unaffordable operation through the authenticated facade", async () => {
    await activate();
    await db.query("update public.usage_accounts set limit_microusd=122879 where owner_id=$1", [OWNER_A]);
    const before = await ledger();
    expect(await availability()).toEqual(unavailable("budget_unavailable"));
    expect(await ledger()).toEqual(before);
  });
  it("reports runtime_disabled when no operation qualifies, even with a small existing budget", async () => {
    await db.query("update public.usage_accounts set limit_microusd=1 where owner_id=$1", [OWNER_A]);
    const before = await ledger();
    expect(await availability()).toEqual(unavailable("runtime_disabled"));
    expect(await ledger()).toEqual(before);
  });
  it.each([
    ["disabled policy", "update fluid_private.strategy_runtime_policy set enabled=false"],
    ["disabled binding", "update fluid_private.api_strategy_bindings set enabled=false"],
    ["wrong policy digest", "update fluid_private.api_strategy_bindings set policy_identity=repeat('0',64)"],
    ["wrong owner principal", `update fluid_private.api_strategy_bindings set role_oid=(select oid from pg_roles where rolname='fixture_api_text_b')`],
    ["wrong exact policy", `update fluid_private.strategy_runtime_policy set policy=jsonb_set(policy,'{maximumCostMicrousd}','1')`],
    ["different billing route", "update fluid_private.strategy_billing_routes set billing_mode='chatgpt_subscription'"],
  ])("keeps exact qualification fail-closed for %s", async (_label, sql) => {
    await activate(); await db.exec(sql);
    expect(await availability()).toEqual(unavailable("runtime_disabled"));
  });
  it("returns affordable qualified operations sorted and excludes an unsupported operation", async () => {
    for (const operation of ["strategy.positioning", "strategy.audience", "strategy.competitors"]) await activate(operation);
    expect(await availability()).toEqual({ status: "available", operations: [
      { operation: "strategy.audience", maximumCostMicrousd: 122880 },
      { operation: "strategy.positioning", maximumCostMicrousd: 122880 },
    ] });
  });
  it("filters mixed affordable and unaffordable qualified operations in an explicit two-tier disposable fixture", async () => {
    // Production currently pins all qualified operations to the same 122880 cap,
    // so mixed prices are impossible there. Change only this transaction's test
    // qualification helper to admit a second exact tier, preserving other checks.
    const helper = (await db.query<{ definition: string }>("select pg_get_functiondef('fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)'::regprocedure) definition")).rows[0]!.definition;
    const needle = "p_policy->'maximumCostMicrousd'='122880'::jsonb";
    expect(helper.split(needle)).toHaveLength(2);
    await db.exec("begin");
    try {
      await db.exec(helper.replace(needle, "p_policy->'maximumCostMicrousd' in ('122880'::jsonb,'245760'::jsonb)"));
      await activate("strategy.audience", { ...policy, maximumCostMicrousd: 245760 });
      await activate("strategy.positioning");
      await db.query("update public.usage_accounts set limit_microusd=200000 where owner_id=$1", [OWNER_A]);
      const before = await ledger();
      expect(await availability()).toEqual({ status: "available", operations: [{ operation: "strategy.positioning", maximumCostMicrousd: 122880 }] });
      expect(await ledger()).toEqual(before);
    } finally { await db.exec("rollback"); }
    expect((await db.query<{ definition: string }>("select pg_get_functiondef('fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)'::regprocedure) definition")).rows[0]!.definition).toBe(helper);
  });
  it("reports an exhausted real reservation without changing admission or ledger state", async () => {
    await activate();
    await db.query("update public.usage_accounts set limit_microusd=122880 where owner_id=$1", [OWNER_A]);
    await enqueue("budget-fixture-request-0001");
    const before = await ledger();
    expect(await availability()).toEqual(unavailable("budget_unavailable"));
    await expect(enqueue("budget-fixture-request-0002")).rejects.toMatchObject({ message: "budget_exceeded" });
    expect(await ledger()).toEqual(before);
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ reserved_microusd: 122880 }]);
  });
  it.each([[100000, 190000], [190000, 100000]])("accounts for reservations and max(spent=%i, provider actual=%i)", async (spent, actual) => {
    await activate();
    await db.query("update public.usage_accounts set limit_microusd=500000,reserved_microusd=300000,spent_microusd=$2,provider_actual_microusd=$3 where owner_id=$1", [OWNER_A, spent, actual]);
    const before = await ledger();
    expect(await availability()).toEqual(unavailable("budget_unavailable"));
    expect(await ledger()).toEqual(before);
  });
  it("denies signed-out and foreign-project callers before revealing availability", async () => {
    await activate();
    await expect(availability(null)).rejects.toMatchObject({ code: "42501", message: "unauthenticated" });
    await expect(availability(OWNER_B, project)).rejects.toMatchObject({ code: "P0002", message: "not_found" });
    await expect(availability(OWNER_A, otherProject)).rejects.toMatchObject({ code: "P0002", message: "not_found" });
    expect(await availability(OWNER_B, otherProject)).toEqual(unavailable("runtime_disabled"));
    expect(await availability(OWNER_B, null)).toEqual(unavailable("runtime_disabled"));
  });
  it("keeps missing budget unavailable without creating an account", async () => {
    await activate(); await db.query("delete from public.usage_accounts where owner_id=$1", [OWNER_A]);
    const before = await ledger();
    expect(await availability()).toEqual(unavailable("budget_unavailable"));
    expect(await ledger()).toEqual(before);
  });
  it("keeps an excessive budget unavailable without normalizing it", async () => {
    await activate(); await db.query("update public.usage_accounts set limit_microusd=5000001 where owner_id=$1", [OWNER_A]);
    const before = await ledger();
    expect(await availability()).toEqual(unavailable("budget_unavailable"));
    expect(await ledger()).toEqual(before);
  });
  it("preserves a paid-uncertainty pause without settling or rewriting the unresolved job", async () => {
    await activate(); await enqueue("paused-fixture-request-0001");
    await db.exec("update public.jobs set state='needs_reconciliation'");
    const before = await ledger();
    expect(await availability()).toEqual(unavailable("budget_unavailable"));
    await expect(enqueue("paused-fixture-request-0002")).rejects.toMatchObject({ message: "paid_outcome_unresolved" });
    expect(await ledger()).toEqual(before);
  });
  it("preserves all target metadata/ACLs and every other function and supplies identical forward files", async () => {
    expect(candidate).not.toBe("");
    expect(await readFile(migrationUrl, "utf8")).toBe(candidate);
    expect(corrected.metadata).toEqual(original.metadata);
    expect(corrected.body).not.toBe(original.body);
    expect(afterOtherFunctions).toEqual(beforeOtherFunctions);
  });
  it("supports replay and preserves a nondefault owner and grant option", async () => {
    expect(candidate).not.toBe("");
    await db.exec("begin");
    try {
      await db.exec(original.definition);
      await db.exec(`create role fixture_budget_patch_owner nologin; create role fixture_budget_patch_grantee nologin; alter function ${signature} owner to fixture_budget_patch_owner; grant execute on function ${signature} to fixture_budget_patch_grantee with grant option`);
      const before = await snapshot(); const others = await otherFunctions();
      await db.exec(candidate); await db.exec(candidate);
      const after = await snapshot();
      expect(after.metadata).toEqual(before.metadata);
      expect(after.body).toBe(corrected.body);
      expect(await otherFunctions()).toEqual(others);
    } finally { await db.exec("rollback"); }
  });
  it("recognizes the exact executed successor in the strict candidate loader", async () => {
    expect(candidate).not.toBe("");
    await expect(installApiTextRuntimeCandidate(db)).resolves.toBeUndefined();
  });
  it("rejects restoring the old body after the exact successor was recorded as executed", async () => {
    await db.exec("begin");
    try {
      await db.exec(original.definition);
      await expect(installApiTextRuntimeCandidate(db)).rejects.toThrow("candidate_schema_mismatch");
    } finally { await db.exec("rollback"); }
  });
  it.each([
    ["changed body", (definition: string) => definition.replace("'runtime_disabled'", "'tampered_runtime_reason'")],
    ["security invoker", (definition: string) => definition.replace("SECURITY DEFINER", "SECURITY INVOKER")],
    ["unsafe search path", (definition: string) => definition.replace("SET search_path TO ''", "SET search_path TO public")],
  ])("keeps strict successor validation for %s", async (_label, mutate) => {
    const before = await snapshot();
    const changed = mutate(before.definition);
    expect(changed).not.toBe(before.definition);
    await db.exec("begin");
    try {
      await db.exec(changed);
      await expect(installApiTextRuntimeCandidate(db)).rejects.toThrow("candidate_schema_mismatch");
    } finally { await db.exec("rollback"); }
    expect(await snapshot()).toEqual(before);
  });
  it("rejects an unexpected installed body atomically without changing any function", async () => {
    expect(candidate).not.toBe("");
    await db.exec("begin");
    try {
      await db.exec(original.definition.replace("'runtime_disabled'", "'unexpected_runtime_reason'"));
      const before = await snapshot(); const others = await otherFunctions();
      await db.exec("savepoint unknown_body");
      await expect(db.exec(candidate)).rejects.toMatchObject({ code: "P0001", message: "Unexpected API Strategy availability definition" });
      await db.exec("rollback to savepoint unknown_body");
      expect(await snapshot()).toEqual(before);
      expect(await otherFunctions()).toEqual(others);
    } finally { await db.exec("rollback"); }
  });
});
