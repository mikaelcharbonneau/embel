import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createOpenAIStrategyHandlers } from "../../worker/handlers/openai-strategy";
import { runOneJob, type JobStore } from "../../worker/runner";
import { strategyPolicy } from "../../src/server/ai/config";
import type { StepOutcome } from "../../src/domain/jobs";
import { jobFixture, responseFixture, transportFixture } from "../server/openai-fixtures";

function fixture() {
  const job = jobFixture(); const outcomes: StepOutcome[] = [];
  const transport = transportFixture();
  const handlers = createOpenAIStrategyHandlers({ apiKey: "synthetic-test-credential", policies: new Map([["strategy.reformulate", strategyPolicy("strategy.reformulate")]]) }, transport);
  const store: JobStore = { claim: vi.fn(async () => job), registerPlan: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => ({ cancelled: false })), beginStep: vi.fn(async () => "started" as const),
    completeStep: vi.fn(async (_, __, output) => { outcomes.push(output); }), finish: vi.fn(async () => {}) };
  return { job, transport, outcomes, store, handlers, run: () => runOneJob({ store, handlers, workerId: "synthetic-fixture-worker" }) };
}

describe("durable OpenAI strategy handler (mock transport only)", () => {
  it("does not register any handler while setup remains unavailable", () => {
    expect(createOpenAIStrategyHandlers(null).size).toBe(0);
  });

  it("registers an immutable priced plan and persists dispatch intent before inference", async () => {
    const f = fixture(); expect(await f.run()).toBe("succeeded");
    expect(f.store.registerPlan).toHaveBeenCalledWith(f.job, [{ key: expect.stringMatching(/^strategy-openai-v1:strategy.reformulate:[a-f0-9]{24}$/), maximumCostMicrousd: 122880 }]);
    expect(vi.mocked(f.store.beginStep).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.transport.createResponse).mock.invocationCallOrder[0]!);
    expect(f.outcomes[0]).toMatchObject({ status: "succeeded", providerRequestId: "resp_synthetic_fixture", costMicrousd: 691 });
  });

  it("never redispatches a previously persisted successful step", async () => {
    const f = fixture(); vi.mocked(f.store.beginStep).mockResolvedValue("already_succeeded");
    expect(await f.run()).toBe("succeeded");
    expect(f.transport.countInputTokens).not.toHaveBeenCalled();
    expect(f.transport.createResponse).not.toHaveBeenCalled();
  });

  it("refuses changed frozen policy, unapproved model and insufficient reservation before dispatch", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { (f.job.input as ReturnType<typeof import("../server/openai-fixtures").inputFixture>).policy.model = "other-model"; },
      (f: ReturnType<typeof fixture>) => { (f.job.input as ReturnType<typeof import("../server/openai-fixtures").inputFixture>).policy.inputMicrousdPerMillionTokens = 0; },
      (f: ReturnType<typeof fixture>) => { f.job.reservedCostMicrousd = 100; },
    ]) {
      const f = fixture(); mutate(f);
      expect(await f.run()).toBe("failed");
      expect(f.transport.createResponse).not.toHaveBeenCalled();
    }
  });

  it("preserves cancellation and lost-lease fencing before an OpenAI call", async () => {
    const f = fixture(); vi.mocked(f.store.heartbeat).mockResolvedValue({ cancelled: true });
    expect(await f.run()).toBe("cancelled"); expect(f.transport.createResponse).not.toHaveBeenCalled();
    const lost = fixture(); vi.mocked(lost.store.heartbeat).mockRejectedValue(new Error("lost"));
    expect(await lost.run()).toBe("lease_lost"); expect(lost.transport.createResponse).not.toHaveBeenCalled();
  });

  it("persists partial model content and stops uncertain generation without retry", async () => {
    const f = fixture(); vi.mocked(f.transport.createResponse).mockResolvedValue({ requestId: "req_fixture", body: { ...responseFixture(), status: "incomplete" } });
    expect(await f.run()).toBe("needs_reconciliation");
    expect(f.outcomes[0]).toMatchObject({ status: "needs_reconciliation", code: "provider_incomplete", result: { partialText: expect.any(String) } });
    expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
    expect(f.store.finish).not.toHaveBeenCalled();
  });
});
