import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asApiTextWorker, asRole, createTestDatabase, installApiTextRuntimeCandidate, installApiTextWorkerFixture, OWNER_A, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";
import { apiTextDispatchMessageSchema } from "../../src/domain/api-text-dispatch";
import { strategyPolicy } from "../../src/server/ai/config";
import { transportFixture } from "../server/openai-fixtures";
import { runApiTextDelivery } from "../../worker/api-text-runtime";

const deploymentId = "dpl_runtime_integration_fixture";
const policy = strategyPolicy("strategy.reformulate");
const configuration = { apiKey: "synthetic-test-credential", policies: new Map([["strategy.reformulate" as const, policy]]) };
describe("API delivery and real candidate SQL integration (no external provider)", () => {
  let db: TestDatabase; let projectId: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    await installApiTextRuntimeCandidate(db);
    await installApiTextWorkerFixture(db);
  }, 30_000);
  beforeEach(async () => {
    await resetFixture(db);
    await db.exec("delete from fluid_private.strategy_runtime_policy; update public.usage_accounts set limit_microusd=5000000");
    projectId = (await seedProject(db)).id;
    await db.query("insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_api_text_a'", [OWNER_A]);
    await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1::jsonb)", [JSON.stringify(policy)]);
    await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,'strategy.reformulate',role_oid,encode(sha256(convert_to($2::jsonb::text,'UTF8')),'hex'),$3,true from fluid_private.api_text_worker_principals where owner_id=$1", [OWNER_A, JSON.stringify(policy), deploymentId]);
    await db.query("select fluid_private.set_strategy_billing_route($1,0,'openai_api')", [OWNER_A]);
  });
  afterAll(async () => { await db?.close(); });
  async function admit() {
    const response = await asRole(db, "authenticated", OWNER_A, () => db.query<{ admitted: { dispatch: unknown; id: string } }>(
      "select public.enqueue_strategy_job($1,1,'strategy.reformulate','runtime-integration-fixture',122880) as admitted", [projectId]));
    return apiTextDispatchMessageSchema.parse(response.rows[0]!.admitted.dispatch);
  }
  it("claims only the admitted job, saves exact real output/usage and replays without another request", async () => {
    const message = await admit(); const transport = transportFixture();
    const execute = () => asApiTextWorker(db, OWNER_A, () => runApiTextDelivery({ message, database: db, configuration, deploymentId, transport }));
    expect(await execute()).toEqual({ disposition: "ack", state: "succeeded" });
    expect(await execute()).toEqual({ disposition: "ack", state: "succeeded" });
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
    expect((await db.query("select state,actual_cost_microusd,billing_mode,policy_identity from public.jobs where id=$1", [message.jobId])).rows[0])
      .toEqual({ state: "succeeded", actual_cost_microusd: 691, billing_mode: "openai_api", policy_identity: null });
    expect((await db.query("select spent_microusd,provider_actual_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0])
      .toEqual({ spent_microusd: 691, provider_actual_microusd: 691, reserved_microusd: 0 });
    expect((await db.query("select state,output->>'responseId' as response_id from public.job_steps where job_id=$1", [message.jobId])).rows)
      .toEqual([{ state: "succeeded", response_id: "resp_synthetic_fixture" }]);
  });
  it("unknown paid outcome preserves money and duplicate delivery cannot make another provider request", async () => {
    const message = await admit(); const transport = transportFixture();
    vi.mocked(transport.createResponse).mockRejectedValue(new Error("Synthetic lost provider response"));
    const execute = () => asApiTextWorker(db, OWNER_A, () => runApiTextDelivery({ message, database: db, configuration, deploymentId, transport }));
    expect(await execute()).toEqual({ disposition: "ack", state: "needs_reconciliation" });
    expect(await execute()).toEqual({ disposition: "ack", state: "needs_reconciliation" });
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
    expect((await db.query("select reserved_microusd,spent_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0])
      .toEqual({ reserved_microusd: 122880, spent_microusd: 0 });
  });
});
