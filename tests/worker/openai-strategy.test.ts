import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createOpenAIStrategyHandlers } from "../../worker/handlers/openai-strategy";
import { runOneJob, type JobStore } from "../../worker/runner";
import { guidedStrategyPolicy, strategyPolicy } from "../../src/server/ai/config";
import type { StepOutcome } from "../../src/domain/jobs";
import { jobFixture, responseFixture, transportFixture } from "../server/openai-fixtures";
import { guidedHistoryEntry, guidedJobFixture, guidedResearchResponse } from "./guided-strategy-fixtures";

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

  it("persists terminal incomplete text and verified cost as failed without retry or accepting a proposal", async () => {
    const f = fixture(); vi.mocked(f.transport.createResponse).mockResolvedValue({ requestId: "req_fixture", body: { ...responseFixture(), status: "incomplete" } });
    // A terminal text-only response with bounded verified usage is a known
    // unsuccessful execution. Nonterminal/tool ambiguity remains quarantined.
    expect(await f.run()).toBe("failed");
    expect(f.outcomes[0]).toMatchObject({ status: "failed", code: "provider_incomplete", costMicrousd: 691, result: { partialText: expect.any(String) } });
    expect(f.outcomes[0]?.result).not.toHaveProperty("proposal");
    expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
    expect(f.store.finish).toHaveBeenCalledWith(f.job, "failed");
  });

  it("persists partial model content and stops nonterminal generation without retry", async () => {
    const f = fixture(); vi.mocked(f.transport.createResponse).mockResolvedValue({ requestId: "req_fixture", body: { ...responseFixture(), status: "in_progress" } });
    expect(await f.run()).toBe("needs_reconciliation");
    expect(f.outcomes[0]).toMatchObject({ status: "needs_reconciliation", code: "provider_not_terminal", result: { partialText: expect.any(String) } });
    expect(f.outcomes[0]?.result).not.toHaveProperty("proposal");
    expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
    expect(f.store.finish).not.toHaveBeenCalled();
  });

  it("does not settle terminal incomplete output with an unexpected tool", async () => {
    const f = fixture(), response = responseFixture(); response.status = "incomplete";
    response.output.push({ type: "image_generation_call" });
    vi.mocked(f.transport.createResponse).mockResolvedValue({ requestId: "req_fixture", body: response });
    expect(await f.run()).toBe("needs_reconciliation");
    expect(f.outcomes[0]).toMatchObject({ status: "needs_reconciliation", code: "provider_incomplete", result: { partialText: expect.any(String) } });
    expect(f.outcomes[0]?.result).not.toHaveProperty("proposal");
    expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
    expect(f.store.finish).not.toHaveBeenCalled();
  });

  it("finishes bounded unusable research as failed with private evidence and no automatic retry", async () => {
    const f = fixture(), job = guidedJobFixture(), response = guidedResearchResponse();
    response.output[0] = { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ url: "https://other.example/" }] } };
    response.output.splice(1, 0,
      { type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://other.example/" } },
      { type: "reasoning" },
      { type: "web_search_call", status: "searching", action: { type: "search", sources: [{ url: "https://example.com/" }] } });
    vi.mocked(f.store.claim).mockResolvedValue(job);
    vi.mocked(f.transport.createResponse).mockResolvedValue({ requestId: "req_fixture", body: response });
    const handlers = createOpenAIStrategyHandlers({ apiKey: "synthetic", policies: new Map([["strategy.competitors", job.input.policy]]) }, f.transport);
    expect(await runOneJob({ store: f.store, handlers, workerId: "synthetic-fixture-worker" })).toBe("failed");
    expect(f.outcomes).toHaveLength(1);
    expect(f.outcomes[0]).toMatchObject({ status: "failed", code: "provider_research_unusable", costMicrousd: 20691, result: {
      partialText: expect.any(String), outputDiagnostics: { toolCalls: 3, completedToolCalls: 2, usageExceeded: false },
    } });
    expect(f.outcomes[0]?.result).not.toHaveProperty("proposal");
    expect(f.store.finish).toHaveBeenCalledWith(job, "failed");
    expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
  });
  it("binds guided plans to the complete immutable input and checks the exact current turn", async () => {
    const policy = guidedStrategyPolicy("strategy.competitors");
    const transport = transportFixture();
    const handlers = createOpenAIStrategyHandlers({ apiKey: "synthetic", policies: new Map([["strategy.competitors", policy]]) }, transport);
    const steps = (job: ReturnType<typeof guidedJobFixture>) => handlers.get(job.operation)!.steps(job);
    const job = guidedJobFixture(); const original = await steps(job);
    job.input.context.description = "A changed immutable context";
    expect((await steps(job))[0]?.key).not.toBe(original[0]?.key);
    for (const mismatch of ["turnRevision", "stage", "operation", "answered", "owner", "project", "historyRevision", "self"] as const) {
      const invalid = guidedJobFixture(); const state = invalid.input.context.intake.guidedInterview!; const turn = state.turns.at(-1)!;
      invalid.input.assistantHistory.entries = [guidedHistoryEntry()]; const entry = invalid.input.assistantHistory.entries[0]!;
      if (mismatch === "turnRevision") turn.inputRevision = 1;
      if (mismatch === "stage") state.stage = "audience";
      if (mismatch === "operation") turn.purpose = "message";
      if (mismatch === "answered") state.answers = [{ stage: "competitors", turnId: turn.id, optionIds: [], customText: "Synthetic choice", confirmedAt: "2026-10-14T12:00:00.000Z" }];
      if (mismatch === "owner") entry.ownerId = job.projectId;
      if (mismatch === "project") entry.projectId = job.ownerId;
      if (mismatch === "historyRevision") entry.inputRevision = 2;
      if (mismatch === "self") entry.jobId = job.id;
      expect(() => steps(invalid)).toThrow();
    }
    expect(transport.countInputTokens).not.toHaveBeenCalled(); expect(transport.createResponse).not.toHaveBeenCalled();
  });
});
