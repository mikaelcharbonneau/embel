import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingProviderReceiptSchema, type NamingAgentRuntime } from "../../src/domain/naming-brain";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { runOneJob } from "../../worker/runner";
import { createTestDatabase, type TestDatabase } from "../database/local-supabase";
import { brainRpc, brainWorker, installBrainFixture } from "../database/naming-brain-fixture";
import { progressiveRequest, seedProgressiveFixture } from "../database/naming-brain-progressive-fixture";

describe("cancelled Naming recovery through the actual runner, store and SQL", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 60_000);
  afterAll(async () => { await db?.close(); });

  it.each(["cancelled", "unknown"] as const)("observes an issued %s call without paid dispatch or invented settlement", async (terminal) => {
    const f = await seedProgressiveFixture(db);
    const request = progressiveRequest(f, "context.research", { role: "researcher", snapshot: f.input.snapshot });
    await brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "context.research", [request]));
    await brainWorker(db, () => f.store.authorizeDispatch(f.job, request));
    const receipt = namingProviderReceiptSchema.parse({
      version: 1, provider: "openai", protocol: "openai_agents", billingMode: "openai_api", budgetControl: "local_unlimited_v1", localPipelineVersion: 2,
      runId: f.input.runId, stageKey: "creation", role: "researcher", snapshotHash: f.input.snapshot.snapshotHash,
      providerCallKey: request.providerCallKey, assignmentKey: null, requestKey: request.requestKey, requestHash: request.requestHash,
      sessionLimitCents: request.policy.sessionLimitCents, dispatchState: "dispatched", requestId: "req_synthetic_cancel",
      sessionId: "sess_synthetic_cancel", turnId: "turn_synthetic_cancel", agentId: "agent_synthetic_cancel", responseId: null,
      callIds: [], observedModel: f.input.policy.model, toolCalls: [], artifactItemIds: [], usageObservations: [], providerCostCounters: [],
      estimatedCostMicrousd: null, accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: new Date().toISOString(),
    });
    await brainWorker(db, () => f.store.recordReceipt(f.job, receipt));
    await brainRpc(db, "request_job_cancel", [f.job.id]);
    await brainWorker(db, () => f.store.completeStep(f.job, "creation", {
      status: "needs_reconciliation", code: "observation_cancelled", costMicrousd: 0, providerRequestId: receipt.requestId, result: { artifactIds: [] },
    }));
    await db.query("update fluid_private.naming_brain_runs set next_observation_at=clock_timestamp()-interval '1 second' where id=$1", [f.input.runId]);
    const before = (await db.query("select * from fluid_private.naming_brain_calls where run_id=$1", [f.input.runId])).rows;
    const held = (await db.query("select * from public.usage_reservations where job_id=$1", [f.job.id])).rows;
    const noDispatch = vi.fn(async () => { throw new Error("unexpected_new_provider_dispatch"); });
    const observe = vi.fn< NamingAgentRuntime["resumeStage"] >(async (saved, hooks) => {
      expect(saved).toEqual(receipt);
      if (terminal === "unknown") return { status: "unresolved", code: "synthetic_still_running", receipt: saved, partialArtifacts: [] };
      await hooks.onArtifact({ kind: "provider_turn", providerCallKey: saved.providerCallKey, sessionId: saved.sessionId, turnId: saved.turnId,
        turn: { id: saved.turnId, session_id: saved.sessionId, agent_id: saved.agentId, subagent_id: null, object: "agent.session.turn", status: "cancelled", created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null } });
      return { status: "cancelled", code: "provider_turn_cancelled", receipt: saved, partialArtifacts: [] };
    });
    const handlers = createNamingBrainHandlers({ store: f.store, assertReady: noDispatch,
      runtime: () => ({ runStage: noDispatch, resumeStage: observe, cancelStage: noDispatch }) });
    const result = await brainWorker(db, () => runOneJob({ store: f.store, handlers, workerId: "fixture-worker" }));
    expect(result).toBe(terminal === "cancelled" ? "failed" : "needs_reconciliation");
    expect(observe).toHaveBeenCalledTimes(1);
    expect(noDispatch).not.toHaveBeenCalled();
    expect((await db.query("select * from fluid_private.naming_brain_calls where run_id=$1", [f.input.runId])).rows).toEqual(before);
    expect((await db.query("select * from public.usage_reservations where job_id=$1", [f.job.id])).rows).toEqual(held);
    expect((await db.query("select state from public.jobs where id=$1", [f.job.id])).rows).toEqual([{ state: terminal === "cancelled" ? "cancelled" : "needs_reconciliation" }]);
    expect(await brainRpc(db, "get_naming_brain_job_accounting", [f.job.id])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
  }, 30_000);
});
