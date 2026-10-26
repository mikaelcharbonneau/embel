import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";
import type { NamingProviderReceipt, NamingStageOutcome } from "../../src/domain/naming-brain";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { createNamingManagedProtocol, type ManagedCreateRequest } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime, type NamingRuntimePersistence } from "../../src/server/ai/naming-brain/transport";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { runOneJob } from "../../worker/runner";
import { historicalNamingClaimDatabase } from "../database/naming-brain-historical-claim";
import { createTestDatabase, OWNER_A, type TestDatabase } from "../database/local-supabase";
import { brainRpc, brainWorker, initialIntent, installBrainFixture, seedBrainFixture } from "../database/naming-brain-fixture";

type Fault = "authorization_ack" | "clock_load" | "base_write" | "base_ack" | "all_receipts" | "cancel_after_clock" | "cancel_after_base" | "create_unknown" | "create_ack";

// Only provider HTTP is synthetic. Authorization, receipt acknowledgement,
// restricted worker permissions and failure closure use the migrated SQL.
describe("local pre-create proof through SDK transport, worker and SQL", () => {
  let db: TestDatabase;
  let project: string;
  beforeEach(async () => {
    db = await createTestDatabase({ before: "20261017170000_local_progressive_naming.sql" }); await installBrainFixture(db);
    project = await seedBrainFixture(db);
  }, 30_000);
  afterEach(async () => { await db?.close(); });

  async function run(fault: Fault, local = true, omitProof = false) {
    if (local) {
      const policy = guidedStrategyPolicy("strategy.reformulate");
      await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
      await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
    }
    const admitted = await brainRpc<{ run: { jobId: string; runId: string } }>(db, local ? "ensure_local_naming_brain_run" : "ensure_naming_brain_run", [project, initialIntent(`synthetic-pre-create-${fault}`)]);
    const historical = (await db.query<{ input: { localPipelineVersion?: number } }>("select input from public.jobs where id=$1", [admitted.run.jobId])).rows;
    expect(historical[0]!.input.localPipelineVersion).toBeUndefined();
    await db.exec(await readFile(new URL("../../supabase/migrations/20261017170000_local_progressive_naming.sql", import.meta.url), "utf8"));
    expect((await db.query("select input from public.jobs where id=$1", [admitted.run.jobId])).rows).toEqual(historical);
    const abort = new AbortController();
    let authorized = false, injected = false, posts = 0;
    let lastRuntime: ReturnType<typeof createNamingAgentRuntime> | undefined;
    const outcomes: NamingStageOutcome[] = [];
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-pre-create-only", localPrototype: local, fetch: async (incoming, init) => {
      const outgoing = new Request(incoming, init);
      expect(new URL(outgoing.url).origin).toBe("https://api.openai.com");
      expect(new URL(outgoing.url).pathname).toBe("/v1/agents/sessions");
      expect(outgoing.method).toBe("POST");
      posts++;
      if (fault === "create_unknown") throw new TypeError("synthetic_connection_ack_lost");
      if (fault !== "create_ack") throw new Error("unexpected_synthetic_create");
      const body = await outgoing.json() as ManagedCreateRequest;
      const event = { type: "agent.session.created", event_id: "synthetic-created", session: { id: "sess_synthetic_pre_create", object: "agent.session", agent: { ...body.agent, id: "agent_synthetic_pre_create" },
        environment: body.environment, metadata: body.metadata, status: "running", required_actions: [], usage: null } };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream", "x-request-id": "req_synthetic_create_ack" } });
    } });

    class FaultStore extends NamingBrainJobStore {
      override async completeStep(job: ClaimedJob, key: string, outcome: StepOutcome) {
        const submitted = omitProof && outcome.status === "failed" && outcome.code === "local_dispatch_not_attempted"
          ? { ...outcome, result: { artifactIds: [], errorCode: outcome.code, partialArtifacts: [] } } : outcome;
        await super.completeStep(job, key, submitted);
      }
      override async authorizeDispatch(job: ClaimedJob, request: Parameters<NamingBrainJobStore["authorizeDispatch"]>[1]) {
        await super.authorizeDispatch(job, request);
        authorized = true;
        if (fault === "authorization_ack" && !injected) { injected = true; throw new Error("synthetic_authorization_ack_lost"); }
      }
      override runtimePersistence(job: ClaimedJob): NamingRuntimePersistence {
        const saved = super.runtimePersistence(job);
        return { ...saved, load: async identity => {
          const value = await saved.load(identity);
          if (authorized && !injected && (fault === "clock_load" || fault === "cancel_after_clock")) {
            injected = true;
            if (fault === "clock_load") throw new Error("synthetic_clock_read_failed");
            abort.abort();
          }
          return value;
        } };
      }
      override async recordReceipt(job: ClaimedJob, receipt: NamingProviderReceipt) {
        if (fault === "all_receipts") { injected = true; throw new Error("synthetic_receipt_store_unavailable"); }
        const base = receipt.dispatchState === "not_dispatched" && receipt.requestId === null && receipt.sessionId === null;
        if (!injected && base && (fault === "base_write" || fault === "base_ack" || fault === "cancel_after_base")) {
          injected = true;
          const saved = fault !== "base_write" ? await super.recordReceipt(job, receipt) : undefined;
          if (fault === "cancel_after_base") { abort.abort(); return saved!; }
          throw new Error(fault === "base_write" ? "synthetic_receipt_write_failed" : "synthetic_receipt_ack_lost");
        }
        if (!injected && fault === "create_ack" && receipt.dispatchState === "dispatched" && receipt.requestId !== null && receipt.sessionId === null) {
          injected = true;
          await super.recordReceipt(job, receipt);
          throw new Error("synthetic_post_ack_lost");
        }
        return super.recordReceipt(job, receipt);
      }
    }
    const store = new FaultStore(await historicalNamingClaimDatabase(db), "fixture-deployment");
    const handlers = createNamingBrainHandlers({ store, localPrototype: local, assertReady: async () => {}, runtime: (job, input) => {
      const runtime = createNamingAgentRuntime({ model: input.policy.model, protocol, localPrototype: local, persistence: store.runtimePersistence(job), assertContinuation: () => store.assertContinuation(job) });
      lastRuntime = runtime;
      return { ...runtime, runStage: async (request, hooks) => {
        const outcome = await runtime.runStage(request, { ...hooks, signal: AbortSignal.any([hooks.signal, abort.signal]) });
        outcomes.push(outcome); return outcome;
      } };
    } });
    const result = await brainWorker(db, () => runOneJob({ store, handlers, workerId: "fixture-worker", localPrototype: local }));
    return { admitted, result, store, handlers, posts: () => posts, outcomes, injected: () => injected, runtime: () => lastRuntime };
  }

  it.each(["authorization_ack", "clock_load", "base_write", "base_ack", "cancel_after_clock", "cancel_after_base"] as const)("closes %s before SDK create with exact durable no-dispatch proof", async fault => {
    const test = await run(fault);
    expect(test.injected()).toBe(true); expect(test.posts()).toBe(0); expect(test.result).toBe("failed");
    expect(test.outcomes).toHaveLength(1);
    expect(test.outcomes[0]).toMatchObject({ status: "rejected_before_dispatch", code: "local_dispatch_not_attempted", receipt: { budgetControl: "local_unlimited_v1", dispatchState: "not_dispatched",
      requestId: null, sessionId: null, turnId: null, agentId: null, responseId: null, callIds: [], toolCalls: [], artifactItemIds: [], usageObservations: [], providerCostCounters: [], confirmedActualCostMicrousd: null } });
    const outcome = test.outcomes[0];
    if (outcome?.status !== "rejected_before_dispatch" || !("receipt" in outcome) || !outcome.receipt) throw new Error("synthetic_no_dispatch_receipt_missing");
    const rows = (await db.query<{ state: string; output: { errorCode: string; partialArtifacts: unknown[] } }>("select state,output from public.job_steps where job_id=$1", [test.admitted.run.jobId])).rows;
    expect(rows).toEqual([{ state: "failed", output: { artifactIds: [], errorCode: "local_dispatch_not_attempted", partialArtifacts: [
      { providerCallKey: outcome.receipt.providerCallKey, status: "rejected_before_dispatch", code: "local_dispatch_not_attempted", receipt: outcome.receipt },
    ] } }]);
    const receipts = (await db.query<{ receipt: NamingProviderReceipt }>("select receipt from fluid_private.naming_brain_receipts where run_id=$1 order by created_at,id", [test.admitted.run.runId])).rows.map(row => row.receipt);
    expect(receipts.length).toBeGreaterThan(0); expect(receipts.at(-1)).toEqual(outcome.receipt);
    expect(receipts.every(receipt => receipt.dispatchState === "not_dispatched")).toBe(true);
    expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_calls where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ count: 1 }]);
    expect((await db.query("select fluid_private.naming_brain_call_terminal(c) terminal from fluid_private.naming_brain_calls c where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ terminal: true }]);
    expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_provider_records where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ count: 0 }]);
    expect(await brainRpc(db, "get_naming_brain_job_accounting", [test.admitted.run.jobId])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
  });

  it.each(["create_unknown", "create_ack"] as const)("quarantines an invoked SDK %s and never creates again during observation", async fault => {
    const test = await run(fault);
    expect(test.posts()).toBe(1); expect(test.result).toBe("needs_reconciliation");
    expect(test.outcomes).toHaveLength(1); expect(test.outcomes[0]).toMatchObject({ status: "unresolved", receipt: { dispatchState: "unknown", sessionId: null, turnId: null } });
    const receipt = (await db.query<{ receipt: NamingProviderReceipt }>("select receipt from fluid_private.naming_brain_receipts where run_id=$1 order by created_at desc,id desc limit 1", [test.admitted.run.runId])).rows[0]!.receipt;
    expect(receipt.dispatchState).toBe("unknown");
    expect(receipt.requestId).toBe(fault === "create_ack" ? "req_synthetic_create_ack" : null);
    expect((await db.query("select fluid_private.naming_brain_call_terminal(c) terminal from fluid_private.naming_brain_calls c where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ terminal: false }]);
    await db.query("update fluid_private.naming_brain_runs set next_observation_at=clock_timestamp()-interval '1 second' where id=$1", [test.admitted.run.runId]);
    // A job with no known session cannot be claimed for provider observation.
    // The transport also refuses to reinterpret its retained receipt as a create.
    expect(await brainWorker(db, () => runOneJob({ store: test.store, handlers: test.handlers, workerId: "fixture-worker", localPrototype: true }))).toBe("idle");
    expect(await test.runtime()!.resumeStage(receipt, { signal: new AbortController().signal, beforeDispatch: async () => { throw new Error("unknown_call_must_not_authorize_again"); },
      onReceipt: async () => {}, onArtifact: async () => {} })).toMatchObject({ status: "unresolved", code: "session_identity_unknown", receipt });
    expect(test.posts()).toBe(1);
    expect((await db.query("select state from public.jobs where id=$1", [test.admitted.run.jobId])).rows).toEqual([{ state: "needs_reconciliation" }]);
    expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_calls where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ count: 1 }]);
    expect(await brainRpc(db, "get_naming_brain_job_accounting", [test.admitted.run.jobId])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
  });

  it("keeps the native pre-create failure behavior without accepting local-only proof", async () => {
    const test = await run("base_write", false);
    expect(test.posts()).toBe(0); expect(test.result).toBe("needs_reconciliation");
    expect(test.outcomes).toEqual([{ status: "rejected_before_dispatch", code: "dispatch_not_authorized" }]);
    expect((await db.query("select fluid_private.naming_brain_call_terminal(c) terminal from fluid_private.naming_brain_calls c where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ terminal: false }]);
  });

  it("does not certify a no-dispatch proof when its receipt cannot be acknowledged", async () => {
    const test = await run("all_receipts");
    expect(test.posts()).toBe(0); expect(test.result).toBe("needs_reconciliation");
    expect(test.outcomes).toEqual([{ status: "rejected_before_dispatch", code: "local_dispatch_not_attempted" }]);
    expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_receipts where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ count: 0 }]);
    expect((await db.query("select fluid_private.naming_brain_call_terminal(c) terminal from fluid_private.naming_brain_calls c where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ terminal: false }]);
  });

  it("refuses to treat an empty not-dispatched base receipt as terminal without the exact per-call proof", async () => {
    const test = await run("base_ack", true, true);
    expect(test.posts()).toBe(0);
    expect((await db.query("select state from public.jobs where id=$1", [test.admitted.run.jobId])).rows).toEqual([{ state: "needs_reconciliation" }]);
    expect((await db.query("select state,output->'partialArtifacts' proof from public.job_steps where job_id=$1", [test.admitted.run.jobId])).rows).toEqual([{ state: "ambiguous", proof: [] }]);
    expect((await db.query("select fluid_private.naming_brain_call_terminal(c) terminal from fluid_private.naming_brain_calls c where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ terminal: false }]);
    expect((await db.query<{ receipt: NamingProviderReceipt }>("select receipt from fluid_private.naming_brain_receipts where run_id=$1", [test.admitted.run.runId])).rows.every(row => row.receipt.dispatchState === "not_dispatched")).toBe(true);
  });
});
