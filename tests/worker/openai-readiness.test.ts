import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createStrategyReadiness } from "../../worker/handlers/openai-readiness";
import { createOpenAIStrategyHandlers } from "../../worker/handlers/openai-strategy";
import { runOneJob, type JobStore } from "../../worker/runner";
import { strategyPolicy } from "../../src/server/ai/config";
import { jobFixture, transportFixture } from "../server/openai-fixtures";
import type { StepOutcome } from "../../src/domain/jobs";

const policy = strategyPolicy("strategy.reformulate");
const policies = new Map([["strategy.reformulate" as const, policy]]);

describe("OpenAI worker policy readiness (local fixtures only)", () => {
  it.each([false, undefined, null, "true", 1])("stops when the database does not return literal true (%s)", async (ready) => {
    const onUnavailable = vi.fn();
    const database = { query: vi.fn(async () => ({ rows: [{ ready }] })) };
    const readiness = createStrategyReadiness(database, policies, onUnavailable);
    await expect(readiness.reportReadiness()).rejects.toThrow("Strategy policy unavailable");
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("treats database errors and missing rows as unavailable without leaking diagnostics", async () => {
    const onUnavailable = vi.fn();
    const database = { query: vi.fn(async () => ({ rows: [] })) };
    const readiness = createStrategyReadiness(database, policies, onUnavailable);
    await expect(readiness.reportReadiness()).rejects.toThrow("Strategy policy unavailable");
    database.query.mockRejectedValue(new Error("synthetic private database error"));
    await expect(readiness.reportReadiness()).rejects.toThrow("Strategy policy unavailable");
    expect(onUnavailable).toHaveBeenCalledTimes(2);
  });

  it("reports the exact frozen operation policy and accepts only a current database approval", async () => {
    const onUnavailable = vi.fn();
    const database = { query: vi.fn(async () => ({ rows: [{ ready: true }] })) };
    const readiness = createStrategyReadiness(database, policies, onUnavailable);
    await readiness.reportReadiness();
    expect(database.query).toHaveBeenCalledWith("select public.report_strategy_worker_ready($1, $2, $3) as ready",
      ["strategy.reformulate", JSON.stringify(policy), 60]);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("does not infer on a queued job when policy is disabled while token counting runs", async () => {
    let enabled = true;
    const controller = new AbortController();
    const database = { query: vi.fn(async () => ({ rows: [{ ready: enabled }] })) };
    const readiness = createStrategyReadiness(database, policies, () => controller.abort());
    const transport = transportFixture();
    vi.mocked(transport.countInputTokens).mockImplementation(async () => { enabled = false; return 100; });
    const handlers = createOpenAIStrategyHandlers({ apiKey: "synthetic-test-credential", policies }, transport, readiness.assertPolicyReady);
    const outcomes: StepOutcome[] = [];
    const store: JobStore = { claim: vi.fn(async () => jobFixture()), registerPlan: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => ({ cancelled: false })), beginStep: vi.fn(async () => "started" as const),
      completeStep: vi.fn(async (_, __, outcome) => { outcomes.push(outcome); }), finish: vi.fn(async () => {}) };
    expect(await runOneJob({ store, handlers, workerId: "synthetic-fixture-worker", signal: controller.signal })).toBe("failed");
    expect(database.query).toHaveBeenCalledTimes(2);
    expect(transport.countInputTokens).toHaveBeenCalledTimes(1);
    expect(transport.createResponse).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ status: "failed", code: "runtime_policy_unavailable", costMicrousd: 0, providerRequestId: null }]);
    expect(controller.signal.aborted).toBe(true);
  });

  it("blocks both token count and inference if a queued job's policy is already disabled", async () => {
    const database = { query: vi.fn(async () => ({ rows: [{ ready: false }] })) };
    const readiness = createStrategyReadiness(database, policies, vi.fn());
    const transport = transportFixture();
    const handlers = createOpenAIStrategyHandlers({ apiKey: "synthetic-test-credential", policies }, transport, readiness.assertPolicyReady);
    const job = jobFixture();
    const step = handlers.get(job.operation)!.steps(job)[0]!;
    expect(await step.execute({ job, signal: new AbortController().signal })).toMatchObject({ status: "failed", code: "runtime_policy_unavailable", costMicrousd: 0 });
    expect(transport.countInputTokens).not.toHaveBeenCalled();
    expect(transport.createResponse).not.toHaveBeenCalled();
  });
});
