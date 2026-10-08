import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createNamingSubscriptionHandlers } from "../../worker/handlers/chatgpt-naming";
vi.mock("server-only", () => ({}));
import { contextSnapshotSchema } from "../../src/domain/projects";
import { DEFAULT_SUBSCRIPTION_LIMITS } from "../../src/domain/strategy-jobs";
import { chatGPTNamingJobInputSchema, type ChatGPTNamingJobInput } from "../../src/domain/naming-jobs";
import { namingStrategyBasis, namingStrategyKey } from "../../src/domain/project-naming";
import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";
import type { ChatGPTTransport } from "../../src/server/ai/chatgpt-transport";
import { createNamingJobStore } from "../../worker/naming-store";
import { runOneJob, type JobStore } from "../../worker/runner";

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

// Local synthetic fixtures only. No credential, provider or database connections.
const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const registrationId = "a".repeat(64);
const context = contextSnapshotSchema.parse({ description: "Synthetic workshop" });
function fixture(targetCount: 100 | 250 = 100) {
  const input = structuredClone(chatGPTNamingJobInputSchema.parse({ version: 1, billingMode: "chatgpt_subscription", context,
    policy: { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "naming-chatgpt-v1", registrationId, model: "fixture-selected-model",
      limits: { ...DEFAULT_SUBSCRIPTION_LIMITS, maxObservedWebSearchCalls: 0 } },
    batch: { id: "44444444-4444-4444-8444-444444444444", ownerId, projectId, jobId, contextRevision: 2, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context),
      preferencesVersion: 1, preferences: { version: 1, creativeLocale: "en-US", notes: "", minimumGraphemes: null, maximumGraphemes: null },
      favoritesSnapshot: [], acceptedPolicyIdentity: "b".repeat(64), targetCount, sequence: 1, createdAt: "2026-10-04T10:00:00Z" }, exclusionSnapshot: [], exclusionKeys: [] })) as Mutable<ChatGPTNamingJobInput>;
  const job: ClaimedJob = { id: jobId, ownerId, projectId, operation: "naming.generate", inputRevision: 2, input,
    leaseToken: "55555555-5555-4555-8555-555555555555", status: "running", reservedCostMicrousd: 0, actualCostMicrousd: 0 };
  const text = JSON.stringify({ candidates: targetCount === 250
    ? Array.from({ length: 250 }, (_, index) => ({ value: `Synthetic Form ${index}`, rationale: `Synthetic explanation ${index}.`, caution: null }))
    : [{ value: "Synthetic Form", rationale: "A fixture association.", caution: null }] });
  const assertReady = vi.fn(async () => {});
  const appendPartial = vi.fn(async () => {});
  const onQuotaUnavailable = vi.fn(async () => {});
  const session = new AbortController();
  const transport: ChatGPTTransport = { listModels: vi.fn(), streamResponse: vi.fn(async (_request, options) => {
    await options.beforeDispatch?.();
    await options.onTextDelta?.(text.slice(0, 20));
    await options.onTextDelta?.(text.slice(20));
    return { status: "completed" as const, accountId: registrationId, responseId: "resp_naming_fixture", requestId: "req_naming_fixture", partialText: text,
      response: { id: "resp_naming_fixture", status: "completed", model: input.policy.model, usage: null,
        output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] } };
  }) };
  const handlers = createNamingSubscriptionHandlers({ ownerId, policy: input.policy, transport, assertReady, appendPartial, onQuotaUnavailable, sessionSignal: session.signal });
  const base: JobStore = { claim: vi.fn(async () => job), registerPlan: vi.fn(async () => {}), heartbeat: vi.fn(async () => ({ cancelled: false })),
    beginStep: vi.fn(async () => "started" as const), completeStep: vi.fn(async () => {}), finish: vi.fn(async () => {}) };
  const query = vi.fn(async () => ({ rows: [] }));
  const database = { query } as unknown as Pick<Pool, "query">;
  const store = createNamingJobStore(base, database);
  const step = () => handlers.get("naming.generate")!.steps(job)[0]!;
  return { input, job, text, transport, assertReady, appendPartial, onQuotaUnavailable, session, handlers, step, base, query, store,
    execute: () => step().execute({ job, signal: new AbortController().signal }),
    run: () => runOneJob({ store, handlers, workerId: "fixture-worker", heartbeatMs: 1000 }) };
}

describe("naming subscription handler", () => {
  it("registers one zero-cost bounded step tied to the entire frozen batch", () => {
    const f = fixture();
    expect([...f.handlers.keys()]).toEqual(["naming.generate"]);
    const steps = f.handlers.get("naming.generate")!.steps(f.job);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ key: expect.stringMatching(/^naming-chatgpt-v1:naming.generate:[a-f0-9]{24}$/), maximumCostMicrousd: 0, timeoutMs: f.input.policy.limits.deadlineMs });
    const original = steps[0]!.key;
    f.input.batch.preferences.notes = "Changed frozen notes";
    expect(f.step().key).not.toBe(original);
    f.input.batch.preferences.notes = "";
    f.input.exclusionKeys.push("historic");
    f.input.exclusionSnapshot.push({ candidateId: "66666666-6666-4666-8666-666666666666", value: "Historic", identityKey: "historic" });
    expect(f.step().key).not.toBe(original);
  });

  it.each(["owner", "project", "job", "revision", "operation", "reservation", "spend", "policy"])("rejects a mismatched %s binding before dispatch", async binding => {
    const f = fixture();
    if (binding === "owner") f.job.ownerId = "66666666-6666-4666-8666-666666666666";
    if (binding === "project") f.job.projectId = "66666666-6666-4666-8666-666666666666";
    if (binding === "job") f.job.id = "66666666-6666-4666-8666-666666666666";
    if (binding === "revision") f.job.inputRevision = 9;
    if (binding === "operation") f.job.operation = "strategy.reformulate";
    if (binding === "reservation") f.job.reservedCostMicrousd = 1;
    if (binding === "spend") f.job.actualCostMicrousd = 1;
    if (binding === "policy") f.job.input = { ...f.input, policy: { ...f.input.policy, model: "fallback-model" } };
    expect(() => f.step()).toThrow();
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });

  it("persists cumulative partial JSON and publishes only the final typed result", async () => {
    const f = fixture();
    expect(await f.execute()).toMatchObject({ status: "succeeded", costMicrousd: 0, providerRequestId: "resp_naming_fixture",
      result: { accepted: [{ value: "Synthetic Form", identityKey: "syntheticform", rationale: "A fixture association." }], fulfillment: { status: "partial", acceptedCount: 1, targetCount: 100 } } });
    expect(f.appendPartial.mock.calls).toEqual([[jobId, f.job.leaseToken, f.text.slice(0, 20)], [jobId, f.job.leaseToken, f.text]]);
    expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
    expect(f.assertReady).toHaveBeenCalledWith("naming.generate", f.input.policy);
  });

  it.each(["wrong_value_key", "missing_snapshot", "omitted_key"])("rejects persisted %s before step registration or provider dispatch", async kind => {
    const f = fixture();
    f.input.exclusionSnapshot = [{ candidateId: "66666666-6666-4666-8666-666666666666", value: "Cedar", identityKey: "cedar" }];
    f.input.exclusionKeys = ["cedar"];
    if (kind === "wrong_value_key") { f.input.exclusionSnapshot[0]!.identityKey = "elm"; f.input.exclusionKeys = ["elm"]; }
    if (kind === "missing_snapshot") Reflect.deleteProperty(f.input, "exclusionSnapshot");
    if (kind === "omitted_key") f.input.exclusionKeys = [];
    expect(() => f.step()).toThrow();
    expect(await f.run()).toBe("failed");
    expect(f.base.registerPlan).not.toHaveBeenCalled();
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.appendPartial).not.toHaveBeenCalled();
  });

  it("keeps an entirely repeated completed slate at zero with one request", async () => {
    const f = fixture();
    f.input.exclusionSnapshot = [{ candidateId: "66666666-6666-4666-8666-666666666666", value: "Synthetic-form", identityKey: "syntheticform" }];
    f.input.exclusionKeys = ["syntheticform"];
    expect(await f.execute()).toMatchObject({ status: "succeeded", result: { accepted: [], fulfillment: { status: "none", acceptedCount: 0, rejections: { duplicate_history: 1 } } } });
    expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a cancelled session or a failed readiness check", async () => {
    const cancelled = fixture(); cancelled.session.abort();
    expect(await cancelled.execute()).toMatchObject({ status: "failed", code: "session_unavailable" });
    expect(cancelled.transport.streamResponse).not.toHaveBeenCalled();
    const unavailable = fixture(); unavailable.assertReady.mockRejectedValue(new Error("Synthetic stale readiness"));
    expect(await unavailable.execute()).toMatchObject({ status: "failed", code: "runtime_policy_unavailable" });
    expect(unavailable.transport.streamResponse).not.toHaveBeenCalled();
  });

  it("prevents success after session loss at the final readiness check", async () => {
    const f = fixture();
    let checks = 0;
    f.assertReady.mockImplementation(async () => { if (++checks === 5) f.session.abort(); });
    const outcome = await f.execute();
    expect(outcome).toMatchObject({ status: "needs_reconciliation", result: { partialText: f.text } });
    expect(outcome).not.toHaveProperty("result.accepted");
  });

  it("retains cumulative text and prevents candidate publication when persistence fails", async () => {
    const f = fixture();
    f.appendPartial.mockRejectedValueOnce(new Error("Synthetic lost lease"));
    expect(await f.execute()).toMatchObject({ status: "needs_reconciliation", result: { partialText: expect.stringContaining('{"candidates":') } });
    expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
  });

  it("retains actual completed provider text when a no-delta response loses readiness", async () => {
    const f = fixture();
    vi.mocked(f.transport.streamResponse).mockImplementation(async (_request, options) => {
      await options.beforeDispatch?.();
      return { status: "completed", accountId: registrationId, responseId: "resp_naming_fixture", requestId: "req_naming_fixture", partialText: "",
        response: { id: "resp_naming_fixture", status: "completed", model: f.input.policy.model, usage: null,
          output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: f.text }] }] } };
    });
    f.assertReady.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error("Synthetic readiness loss"));
    expect(await f.execute()).toMatchObject({ status: "needs_reconciliation", result: { partialText: f.text } });
  });

  it("preserves ambiguous outcomes and quota recovery with no fallback", async () => {
    const f = fixture();
    vi.mocked(f.transport.streamResponse).mockResolvedValue({ status: "unavailable", partialText: "", failure: { code: "subscription_quota_exceeded", providerCode: null,
      providerParam: null, httpStatus: 429, bodyShape: "error", responseId: null, requestId: "req_quota", dispatched: false, recovery: "view_usage" } });
    expect(await f.execute()).toMatchObject({ status: "failed", code: "subscription_quota_exceeded", providerRequestId: "req_quota" });
    expect(f.onQuotaUnavailable).toHaveBeenCalledTimes(1);
    expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
  });

  it.each(["refusal", "failure", "failure_without_deltas"])("keeps a known %s terminal while retaining its partial text", async kind => {
    const f = fixture();
    vi.mocked(f.transport.streamResponse).mockImplementation(async (_request, options) => {
      await options.beforeDispatch?.();
      if (kind !== "failure_without_deltas") await options.onTextDelta?.(f.text);
      if (kind !== "refusal") return { status: "failed", partialText: f.text, failure: { code: "provider_failed", providerCode: null, providerParam: null,
        httpStatus: null, bodyShape: "error", responseId: "resp_naming_fixture", requestId: "req_naming_fixture", dispatched: true, recovery: "manual_review" } };
      return { status: "completed", accountId: registrationId, responseId: "resp_naming_fixture", requestId: "req_naming_fixture", partialText: f.text,
        response: { id: "resp_naming_fixture", status: "completed", model: f.input.policy.model, usage: null,
          output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: f.text }, { type: "refusal", refusal: "Synthetic refusal" }] }] } };
    });
    expect(await f.execute()).toMatchObject({ status: "failed", code: kind === "refusal" ? "provider_refusal" : "provider_failed" });
    expect(f.appendPartial).toHaveBeenLastCalledWith(jobId, f.job.leaseToken, f.text);
    expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
  });
});

describe("naming completion store and durable runner", () => {
  it("routes a completed short batch through the atomic RPC and marks the transport job successful", async () => {
    const f = fixture();
    expect(await f.run()).toBe("succeeded");
    expect(f.query).toHaveBeenCalledWith("select * from public.complete_naming_job_step($1, $2, $3, $4, $5, $6, $7)",
      [jobId, f.job.leaseToken, f.step().key, "succeeded", 0, expect.any(String), "resp_naming_fixture"]);
    const values = (f.query.mock.calls as unknown as Array<[string, unknown[]]>)[0]![1];
    expect(JSON.parse(values[5] as string)).toMatchObject({ fulfillment: { status: "partial", acceptedCount: 1 } });
    expect(f.base.completeStep).not.toHaveBeenCalled();
    expect(f.base.finish).toHaveBeenCalledWith(f.job, "succeeded");
  });

  it("publishes a complete250 result through one unchanged durable step and one provider call", async () => {
    const f = fixture(250);
    const originalStep = f.step();
    expect(originalStep).toMatchObject({ maximumCostMicrousd: 0, timeoutMs: 240_000 });
    expect(await f.run()).toBe("succeeded");
    expect(f.base.registerPlan).toHaveBeenCalledTimes(1);
    expect(f.base.beginStep).toHaveBeenCalledTimes(1);
    expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.query).toHaveBeenCalledWith("select * from public.complete_naming_job_step($1, $2, $3, $4, $5, $6, $7)",
      [jobId, f.job.leaseToken, originalStep.key, "succeeded", 0, expect.any(String), "resp_naming_fixture"]);
    const values = (f.query.mock.calls as unknown as Array<[string, unknown[]]>)[0]![1];
    const output = JSON.parse(values[5] as string);
    expect(output.fulfillment).toMatchObject({ status: "complete", targetCount: 250, acceptedCount: 250 });
    expect(output.accepted).toHaveLength(250);
    expect(new Set(output.accepted.map((row: { identityKey: string }) => row.identityKey)).size).toBe(250);
    expect(f.base.completeStep).not.toHaveBeenCalled();
    expect(f.base.finish).toHaveBeenCalledWith(f.job, "succeeded");
  });

  it("skips an already completed step after restart without redispatch or republication", async () => {
    const f = fixture();
    vi.mocked(f.base.beginStep).mockResolvedValue("already_succeeded");
    expect(await f.run()).toBe("succeeded");
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  it("propagates a lost completion lease without generic fallback or success finalization", async () => {
    const f = fixture(); f.query.mockRejectedValue(new Error("lease_lost"));
    expect(await f.run()).toBe("lease_lost");
    expect(f.base.completeStep).not.toHaveBeenCalled();
    expect(f.base.finish).not.toHaveBeenCalled();
    expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
  });

  it.each<Exclude<StepOutcome, { status: "succeeded" }>>([
    { status: "failed", code: "provider_refusal", costMicrousd: 0, providerRequestId: "resp_refused" },
    { status: "needs_reconciliation", code: "interrupted", costMicrousd: 0, providerRequestId: "req_partial", result: { partialText: "Synthetic incomplete JSON" } },
  ])("retains %s handling inside the naming leased RPC", async outcome => {
    const f = fixture();
    await f.store.completeStep(f.job, "fixture-step", outcome);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("complete_naming_job_step"), [jobId, f.job.leaseToken, "fixture-step",
      outcome.status === "needs_reconciliation" ? "ambiguous" : "failed", 0,
      JSON.stringify({ error: outcome.code, ...("result" in outcome ? { result: outcome.result } : {}) }), outcome.providerRequestId]);
    expect(f.base.completeStep).not.toHaveBeenCalled();
  });

  it("leaves Strategy completion untouched", async () => {
    const f = fixture(); f.job.operation = "strategy.reformulate";
    const outcome: StepOutcome = { status: "succeeded", result: { fixture: true }, costMicrousd: 0, providerRequestId: "resp_strategy" };
    await f.store.completeStep(f.job, "strategy-step", outcome);
    expect(f.base.completeStep).toHaveBeenCalledWith(f.job, "strategy-step", outcome);
    expect(f.query).not.toHaveBeenCalled();
  });
});
