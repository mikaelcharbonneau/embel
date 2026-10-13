import { API_TEXT_MULTI_ACCOUNT_MIGRATION } from "../database/fixture-migrations";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { strategyPolicy, type OpenAIStrategyConfiguration } from "../../src/server/ai/config";
import { readApiTextWorkerReadiness } from "../../worker/hosting/readiness";
import { asApiTextWorker, asRole, createTestDatabase, installApiTextRuntimeCandidate, installApiTextWorkerFixture,
  OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "../database/local-supabase";

describe("read-only readiness against the restricted database boundary", () => {
  let db: TestDatabase;
  const deploymentId = "dpl_qualified";
  const policy = strategyPolicy("strategy.reformulate");
  const configuration: OpenAIStrategyConfiguration = { apiKey: "synthetic-never-used", policies: new Map([
    ["strategy.reformulate", policy], ["strategy.audience", strategyPolicy("strategy.audience")],
  ]) };
  beforeAll(async () => {
    db = await createTestDatabase({ before: API_TEXT_MULTI_ACCOUNT_MIGRATION }); await installApiTextRuntimeCandidate(db); await installApiTextWorkerFixture(db);
  }, 30_000);
  beforeEach(async () => {
    await resetFixture(db);
    await db.exec("delete from fluid_private.strategy_runtime_policy; update public.usage_accounts set limit_microusd=5000000");
    await db.query("insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_api_text_a'", [OWNER_A]);
    await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1::jsonb)", [JSON.stringify(policy)]);
    await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,'strategy.reformulate',role_oid,encode(sha256(convert_to($2::jsonb::text,'UTF8')),'hex'),$3,true from fluid_private.api_text_worker_principals where owner_id=$1", [OWNER_A, JSON.stringify(policy), deploymentId]);
    await db.query("insert into fluid_private.strategy_billing_routes values($1,'openai_api',1)", [OWNER_A]);
  });
  afterAll(async () => { await db?.close(); });
  const probe = (deployment = deploymentId) => asApiTextWorker(db, OWNER_A, () => readApiTextWorkerReadiness({
    deploymentId: deployment, configuration, database: () => db, signal: new AbortController().signal,
  }));
  async function snapshot() {
    const state: Record<string, unknown> = {};
    for (const table of ["public.usage_accounts", "public.usage_reservations", "public.jobs", "public.job_steps",
      "fluid_private.api_text_dispatches", "fluid_private.api_strategy_bindings", "fluid_private.strategy_billing_routes",
      "fluid_private.api_text_worker_principals", "fluid_private.strategy_runtime_policy"]) {
      state[table] = (await db.query(`select to_jsonb(t) data from ${table} t order by to_jsonb(t)::text`)).rows;
    }
    return state;
  }
  it("uses only already-granted functions and leaves jobs, budgets, outbox and policies unchanged", async () => {
    const before = await snapshot();
    expect(await probe()).toEqual({ version: 1, deploymentId, operations: ["strategy.reformulate"] });
    expect(await snapshot()).toEqual(before);
  });
  it("rejects a different immutable worker deployment without changing state", async () => {
    const before = await snapshot();
    expect((await probe("dpl_other")).operations).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
  it("does not mistake a funded new account for an eligible runtime owner", async () => {
    const before = await snapshot();
    const result = await asRole(db, "authenticated", OWNER_B, () => db.query<{ availability: unknown }>("select public.get_strategy_availability(null) availability"));
    expect(result.rows[0]?.availability).toEqual({ status: "unavailable", operations: [], reason: "runtime_disabled" });
    await expect(asApiTextWorker(db, OWNER_B, () => readApiTextWorkerReadiness({
      deploymentId, configuration, database: () => db, signal: new AbortController().signal,
    }))).rejects.toThrow("worker_owner_mismatch");
    expect(await snapshot()).toEqual(before);
  });
  it("withdraws readiness when the existing binding is disabled", async () => {
    await db.exec("update fluid_private.api_strategy_bindings set enabled=false");
    const before = await snapshot();
    expect((await probe()).operations).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
});
