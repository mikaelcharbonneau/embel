import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { runApiTextDelivery } from "../../worker/api-text-runtime";
import { apiTextDispatchMessageSchema, apiTextDispatchDescriptorSchema } from "../../src/domain/api-text-dispatch";
import { jobFixture, responseFixture, transportFixture } from "../server/openai-fixtures";
import { strategyPolicy } from "../../src/server/ai/config";
import { OpenAITransportError } from "../../src/server/ai/openai-transport";

const message = { version: 1 as const, jobId: jobFixture().id, policyIdentity: "a".repeat(64), deploymentId: "dpl_synthetic", dispatchIdentity: "b".repeat(64) };
const configuration = { apiKey: "synthetic-test-credential", policies: new Map([["strategy.reformulate" as const, strategyPolicy("strategy.reformulate")]]) };
/** Adapter fixture only. Actual role, lease and money fences are tested against PGlite separately. */
function databaseFixture() {
  const job = jobFixture();
  const state = { status: "queued", busy: false, found: true, enabled: true, authorized: true, expiredInFlight: false,
    step: null as null | { state: string; request_key: string; reserved_cost_microusd: number },
    outcomes: [] as unknown[][], claimCalls: 0, policyChecks: 0, authorizationChecks: 0, rowMode: "openai_api", rowId: job.id };
  const descriptor = () => ({ ...message, operation: "strategy.reformulate", state: state.status, retryable: state.status === "queued",
    publicationGeneration: 0, publishedMessageId: null, publishedAt: null });
  const row = () => ({ id: state.rowId, owner_id: job.ownerId, project_id: job.projectId, operation: job.operation,
    input: job.input, input_revision: job.inputRevision, lease_token: job.leaseToken, state: state.status,
    billing_mode: state.rowMode, reserved_cost_microusd: job.reservedCostMicrousd, actual_cost_microusd: 0 });
  const queries: string[] = [];
  const database = { async query(sql: string, values: unknown[] = []) {
    queries.push(sql);
    if (sql.includes("get_api_text_dispatch")) return { rows: [{ dispatch: state.found ? descriptor() : null }] };
    if (sql.includes("expire_api_text_job")) {
      if (state.expiredInFlight) { state.status = "needs_reconciliation"; return { rows: [{ result: { disposition: "terminal", state: state.status } }] }; }
      return { rows: [{ result: { disposition: state.busy ? "busy" : state.status === "queued" ? "available" : "terminal", state: state.busy ? "running" : state.status } }] };
    }
    if (sql.includes("check_api_text_runtime")) { state.policyChecks++; return { rows: [{ ready: state.enabled }] }; }
    if (sql.includes("claim_api_text_job")) {
      state.claimCalls++;
      if (state.busy) return { rows: [{ result: { disposition: "busy", state: "running" } }] };
      if (state.status !== "queued") return { rows: [{ result: { disposition: "terminal", state: state.status } }] };
      state.status = "running"; return { rows: [{ result: { disposition: "claimed", state: "running", job: row() } }] };
    }
    if (sql.includes("heartbeat_job")) return { rows: [row()] };
    if (sql.includes("register_job_plan")) return { rows: [] };
    if (sql.includes("select state, request_key")) return { rows: state.step ? [state.step] : [] };
    if (sql.includes("begin_job_step")) { state.step = { state: "running", request_key: values[3] as string, reserved_cost_microusd: values[4] as number }; return { rows: [] }; }
    if (sql.includes("authorize_api_text_dispatch")) { state.authorizationChecks++; return { rows: [{ authorized: state.authorized && state.enabled }] }; }
    if (sql.includes("complete_job_step")) {
      state.outcomes.push(values);
      state.step!.state = values[3] as string;
      if (values[3] === "ambiguous") state.status = "needs_reconciliation";
      return { rows: [] };
    }
    if (sql.includes("finish_job")) { state.status = values[2] as string; return { rows: [] }; }
    throw new Error(`Unexpected test SQL: ${sql}`);
  } };
  return { database, state, queries, descriptor };
}
function delivery(fixture = databaseFixture(), transport = transportFixture(), extra: Record<string, unknown> = {}) {
  return runApiTextDelivery({ message, database: fixture.database, configuration, deploymentId: message.deploymentId, transport, ...extra });
}
afterEach(() => vi.useRealTimers());

describe("restricted API delivery contract", () => {
  it("rejects prompt/owner additions and malformed immutable descriptors", () => {
    expect(apiTextDispatchMessageSchema.safeParse({ ...message, ownerId: jobFixture().ownerId }).success).toBe(false);
    expect(apiTextDispatchMessageSchema.safeParse({ ...message, prompt: "never queue prompts" }).success).toBe(false);
    expect(apiTextDispatchMessageSchema.safeParse({ ...message, policyIdentity: "wrong" }).success).toBe(false);
    expect(apiTextDispatchDescriptorSchema.safeParse({ ...databaseFixture().descriptor(), publicationGeneration: -1 }).success).toBe(false);
  });
  it("executes one admitted response and acknowledges a later duplicate without a second paid request", async () => {
    const fixture = databaseFixture(); const transport = transportFixture();
    expect(await delivery(fixture, transport)).toEqual({ disposition: "ack", state: "succeeded" });
    expect(await delivery(fixture, transport)).toEqual({ disposition: "ack", state: "succeeded" });
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
    expect(fixture.state.authorizationChecks).toBe(2);
    expect(fixture.state.policyChecks).toBeGreaterThanOrEqual(2);
    expect(fixture.state.outcomes[0]?.[3]).toBe("succeeded");
    expect(fixture.queries.every(sql => !/public\.(claim_job|expire_job_leases|report_strategy_worker_ready)\(/.test(sql))).toBe(true);
  });
  it("retries a busy live lease instead of acknowledging and stranding a later crash", async () => {
    const fixture = databaseFixture(); fixture.state.busy = true;
    const transport = transportFixture();
    expect(await delivery(fixture, transport)).toEqual({ disposition: "retry", state: "running" });
    expect(transport.createResponse).not.toHaveBeenCalled();
    fixture.state.busy = false;
    expect(await delivery(fixture, transport)).toEqual({ disposition: "ack", state: "succeeded" });
  });
  it.each(["succeeded", "failed", "partial", "cancelled", "needs_reconciliation"])("acknowledges durable %s without inference", async status => {
    const fixture = databaseFixture(); fixture.state.status = status; const transport = transportFixture();
    expect(await delivery(fixture, transport)).toEqual({ disposition: "ack", state: status });
    expect(transport.countInputTokens).not.toHaveBeenCalled();
  });
  it("acknowledges an expired in-flight lease as reconciliation and never retries inference", async () => {
    const fixture = databaseFixture(); fixture.state.expiredInFlight = true; const transport = transportFixture();
    expect(await delivery(fixture, transport)).toEqual({ disposition: "ack", state: "needs_reconciliation" });
    expect(fixture.state.claimCalls).toBe(0); expect(transport.createResponse).not.toHaveBeenCalled();
  });
  it("rejects wrong deployment and unknown owner job without touching paid transport", async () => {
    const fixture = databaseFixture(); const transport = transportFixture();
    expect(await delivery(fixture, transport, { deploymentId: "dpl_other" })).toEqual({ disposition: "ack", state: "deployment_mismatch" });
    expect(fixture.queries).toHaveLength(0);
    fixture.state.found = false;
    expect(await delivery(fixture, transport)).toEqual({ disposition: "ack", state: "not_found" });
    expect(transport.countInputTokens).not.toHaveBeenCalled();
  });
  it.each(["billing_mode", "id"])("rejects a malformed claim with foreign %s before token counting", async field => {
    const fixture = databaseFixture(); if (field === "id") fixture.state.rowId = jobFixture().ownerId; else fixture.state.rowMode = "chatgpt_subscription";
    const transport = transportFixture();
    expect((await delivery(fixture, transport)).disposition).toBe("retry");
    expect(transport.countInputTokens).not.toHaveBeenCalled();
  });
  it("policy withdrawal during token count stops generation but still records the zero-cost result", async () => {
    const fixture = databaseFixture(); const transport = transportFixture();
    vi.mocked(transport.countInputTokens).mockImplementation(async () => { fixture.state.enabled = false; return 20; });
    expect(await delivery(fixture, transport)).toEqual({ disposition: "ack", state: "failed" });
    expect(transport.createResponse).not.toHaveBeenCalled();
    expect(fixture.state.outcomes[0]?.[3]).toBe("failed"); expect(fixture.state.outcomes[0]?.[4]).toBe(0);
  });
  it("a last-boundary lease/route/budget refusal prevents inference", async () => {
    const fixture = databaseFixture(); fixture.state.authorized = false; const transport = transportFixture();
    expect(await delivery(fixture, transport)).toEqual({ disposition: "ack", state: "failed" });
    expect(transport.countInputTokens).not.toHaveBeenCalled(); expect(transport.createResponse).not.toHaveBeenCalled();
  });
  it("does not enable competitors even if configuration includes the old research price card", async () => {
    const fixture = databaseFixture(); const transport = transportFixture();
    const researchConfiguration = { ...configuration, policies: new Map([["strategy.competitors" as const, strategyPolicy("strategy.competitors")]]) };
    expect(await delivery(fixture, transport, { configuration: researchConfiguration })).toEqual({ disposition: "retry", state: "runtime_unavailable" });
    expect(transport.createResponse).not.toHaveBeenCalled();
  });
  it.each(["unknown", "malformed_usage", "rejected"])("preserves terminal paid-step outcome after %s provider response", async kind => {
    const fixture = databaseFixture(); const body = responseFixture();
    const transport = transportFixture(kind === "malformed_usage" ? { ...body, usage: null } : body);
    if (kind === "unknown") vi.mocked(transport.createResponse).mockRejectedValue(new OpenAITransportError("outcome_unknown"));
    if (kind === "rejected") vi.mocked(transport.createResponse).mockRejectedValue(new OpenAITransportError("request_rejected"));
    const expected = kind === "rejected" ? "failed" : "needs_reconciliation";
    expect(await delivery(fixture, transport)).toEqual({ disposition: "ack", state: expected });
    expect(await delivery(fixture, transport)).toEqual({ disposition: "ack", state: expected });
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
  });
  it("uses a 240 second provider deadline and records ambiguity before the 270 second host limit", async () => {
    vi.useFakeTimers(); const fixture = databaseFixture(); const transport = transportFixture();
    vi.mocked(transport.createResponse).mockImplementation(() => new Promise(() => {}));
    const result = delivery(fixture, transport);
    await vi.advanceTimersByTimeAsync(240_001);
    expect(await result).toEqual({ disposition: "ack", state: "needs_reconciliation" });
    expect(fixture.state.outcomes[0]?.[3]).toBe("ambiguous");
  });
  it("bounds a stuck database operation and leaves recoverable delivery retryable", async () => {
    vi.useFakeTimers(); const transport = transportFixture();
    const database = { query: () => new Promise<never>(() => {}) };
    const result = runApiTextDelivery({ message, database, configuration, deploymentId: message.deploymentId, transport });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await result).toEqual({ disposition: "retry", state: "database_unavailable" });
    expect(transport.countInputTokens).not.toHaveBeenCalled();
  });
  it("retains predispatch work on shutdown without claiming it", async () => {
    const fixture = databaseFixture(); const controller = new AbortController(); controller.abort();
    expect(await delivery(fixture, transportFixture(), { signal: controller.signal })).toEqual({ disposition: "retry", state: "stopping" });
    expect(fixture.state.claimCalls).toBe(0);
  });
});
