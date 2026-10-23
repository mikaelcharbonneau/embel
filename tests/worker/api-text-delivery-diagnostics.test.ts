import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { jobFixture, transportFixture } from "../server/openai-fixtures";
import { observeDeliveryHandlers, observeDeliveryStore, observeProviderTransport } from "../../worker/hosting/delivery-diagnostics";
import type { DiagnosticSink } from "../../worker/hosting/diagnostics";
import type { JobStep, JobStore } from "../../worker/runner";
import { stepOutcomeSchema, type StepOutcome } from "../../src/domain/jobs";

const secret = "SYNTHETIC_PRIVATE_DIAGNOSTIC_CONTEXT";
const job = jobFixture();
const input = { job, signal: new AbortController().signal };
const outcome: StepOutcome = stepOutcomeSchema.parse({ status: "succeeded", costMicrousd: 0, result: { private: secret } });
function observation(throws = false) {
  const error = Object.assign(new Error(secret, { cause: { password: secret } }), {
    headers: { authorization: secret }, client: { connectionParameters: { password: secret } }, prompt: secret,
  });
  const events: Parameters<DiagnosticSink>[0][] = [];
  const sink: DiagnosticSink = event => { events.push(event); if (throws) throw error; };
  return { error, events, sink };
}
function assertSafe(events: Parameters<DiagnosticSink>[0][]) {
  expect(events.length).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain(secret);
  for (const event of events) {
    expect(Object.keys(event).sort()).toEqual(["durationMs", "errorClass", "event", "outcome", "phase"]);
    expect(Object.isFrozen(event)).toBe(true);
  }
}
function storeFixture() {
  return {
    claim: vi.fn<JobStore["claim"]>().mockResolvedValue(job),
    registerPlan: vi.fn<JobStore["registerPlan"]>().mockResolvedValue(undefined),
    heartbeat: vi.fn<JobStore["heartbeat"]>().mockResolvedValue({ cancelled: false }),
    beginStep: vi.fn<JobStore["beginStep"]>().mockResolvedValue("started"),
    completeStep: vi.fn<JobStore["completeStep"]>().mockResolvedValue(undefined),
    finish: vi.fn<JobStore["finish"]>().mockResolvedValue(undefined),
  };
}
const cases = [
  { method: "claim", phase: "claim", call: (store: JobStore) => store.claim(secret, 120) },
  { method: "registerPlan", phase: "plan_write", call: (store: JobStore) => store.registerPlan(job, [{ key: secret, maximumCostMicrousd: 0 }]) },
  { method: "heartbeat", phase: "heartbeat", call: (store: JobStore) => store.heartbeat(job, 120) },
  { method: "beginStep", phase: "step_begin", call: (store: JobStore) => store.beginStep(job, secret, 0) },
  { method: "completeStep", phase: "step_write", call: (store: JobStore) => store.completeStep(job, secret, outcome) },
  { method: "finish", phase: "job_finish", call: (store: JobStore) => store.finish(job, "succeeded") },
] as const;
afterEach(() => vi.restoreAllMocks());

describe("delivery diagnostic adapters preserve execution and redact private context", () => {
  it.each(cases)("classifies $method failure without serializing inputs or errors", async ({ method, phase, call }) => {
    const store = storeFixture(), observed = observation(true);
    store[method].mockRejectedValue(observed.error);
    await expect(call(observeDeliveryStore(store, observed.sink))).rejects.toBe(observed.error);
    expect(store[method]).toHaveBeenCalledTimes(1);
    expect(observed.events).toEqual([expect.objectContaining({ phase, outcome: "error", errorClass: "database" })]);
    assertSafe(observed.events);
  });
  it.each(cases)("keeps $method results and arguments unchanged when logging throws", async ({ method, phase, call }) => {
    const store = storeFixture(), observed = observation(true);
    const wrapped = observeDeliveryStore(store, observed.sink);
    const actual = await call(wrapped);
    const args = [...store[method].mock.calls[0]!];
    const expected = await call(store);
    expect(actual).toBe(expected);
    expect(store[method]).toHaveBeenCalledTimes(2);
    expect(store[method].mock.calls[1]).toEqual(args);
    expect(observed.events).toEqual([expect.objectContaining({ phase, outcome: "ok", errorClass: "none" })]);
    assertSafe(observed.events);
  });
  it.each([true, false])("does not alter optional per-job execution authority (%s)", authority => {
    const authorize = vi.fn(() => authority);
    const observed = observeDeliveryStore({ ...storeFixture(), hasUnmeteredExecutionAuthority: authorize }, () => { throw new Error(secret); });
    expect(observed.hasUnmeteredExecutionAuthority?.(job)).toBe(authority);
    expect(authorize).toHaveBeenCalledExactlyOnceWith(job);
    expect(observeDeliveryStore(storeFixture()).hasUnmeteredExecutionAuthority).toBeUndefined();
  });
  it("preserves a synchronous planning failure despite a throwing sink", () => {
    const observed = observation(true), steps = vi.fn((): readonly JobStep[] => { throw observed.error; });
    const registry = observeDeliveryHandlers(new Map([["synthetic", { steps }]]), observed.sink);
    expect(() => registry.get("synthetic")!.steps(job)).toThrow(observed.error);
    expect(steps).toHaveBeenCalledExactlyOnceWith(job);
    expect(observed.events).toEqual([expect.objectContaining({ phase: "plan", outcome: "error", errorClass: "handler" })]);
    assertSafe(observed.events);
  });
  it.each(["succeeded", "failed", "needs_reconciliation"] as const)("preserves provider execution result %s and step metadata", async status => {
    const observed = observation(true);
    const result = stepOutcomeSchema.parse({ status, costMicrousd: 0, result: { private: secret }, ...(status === "succeeded" ? {} : { code: secret }) });
    const execute = vi.fn<JobStep["execute"]>().mockResolvedValue(result);
    const step: JobStep = { key: secret, maximumCostMicrousd: 15, timeoutMs: 1000, execute };
    const steps = vi.fn(() => [step]);
    const wrapped = observeDeliveryHandlers(new Map([["synthetic", { steps }]]), observed.sink).get("synthetic")!.steps(job)[0]!;
    expect(wrapped).toMatchObject({ key: secret, maximumCostMicrousd: 15, timeoutMs: 1000 });
    expect(await wrapped.execute(input)).toBe(result);
    expect(execute).toHaveBeenCalledExactlyOnceWith(input);
    expect(steps).toHaveBeenCalledExactlyOnceWith(job);
    expect(observed.events.map(event => [event.phase, event.outcome])).toEqual([["plan", "ok"], ["provider_execution", status === "succeeded" ? "ok" : status]]);
    assertSafe(observed.events);
  });
  it("preserves a provider execution rejection and does not retry it", async () => {
    const observed = observation(true), execute = vi.fn<JobStep["execute"]>().mockRejectedValue(observed.error);
    const wrapped = observeDeliveryHandlers(new Map([["synthetic", { steps: () => [{ key: secret, maximumCostMicrousd: 0, execute }] }]]), observed.sink).get("synthetic")!.steps(job)[0]!;
    await expect(wrapped.execute(input)).rejects.toBe(observed.error);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(observed.events.at(-1)).toMatchObject({ phase: "provider_execution", outcome: "error", errorClass: "provider" });
    assertSafe(observed.events);
  });
  it.each([false, true])("preserves provider transport results/errors with throwing sink (failure: %s)", async fail => {
    const observed = observation(true), transport = transportFixture();
    const request = { input: secret }, signal = input.signal;
    if (fail) { vi.mocked(transport.countInputTokens).mockRejectedValue(observed.error); vi.mocked(transport.createResponse).mockRejectedValue(observed.error); }
    const wrapped = observeProviderTransport(transport, observed.sink);
    if (fail) {
      await expect(wrapped.countInputTokens(request, signal)).rejects.toBe(observed.error);
      await expect(wrapped.createResponse(request, secret, signal)).rejects.toBe(observed.error);
    } else {
      await expect(wrapped.countInputTokens(request, signal)).resolves.toBe(200);
      const result = await wrapped.createResponse(request, secret, signal);
      expect(result).toBe(await vi.mocked(transport.createResponse).mock.results[0]!.value);
    }
    expect(transport.countInputTokens).toHaveBeenCalledExactlyOnceWith(request, signal);
    expect(transport.createResponse).toHaveBeenCalledExactlyOnceWith(request, secret, signal);
    expect(observed.events.map(event => [event.phase, event.outcome, event.errorClass])).toEqual([
      ["token_count", fail ? "error" : "ok", fail ? "provider" : "none"],
      ["provider_request", fail ? "error" : "ok", fail ? "provider" : "none"],
    ]);
    assertSafe(observed.events);
  });
});
