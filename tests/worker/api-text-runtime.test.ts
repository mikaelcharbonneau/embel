import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { runApiTextDelivery } from "../../worker/api-text-runtime";
import { apiTextDispatchMessageSchema, apiTextDispatchDescriptorSchema } from "../../src/domain/api-text-dispatch";
import { jobFixture, responseFixture, transportFixture } from "../server/openai-fixtures";
import { guidedStrategyPolicy, strategyPolicy } from "../../src/server/ai/config";
import { OpenAITransportError } from "../../src/server/ai/openai-transport";
import { guidedJobFixture, guidedResearchResponse } from "./guided-strategy-fixtures";

import { message, configuration, databaseFixture, delivery } from "./api-text-runtime-fixture";
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
  it("dispatches qualified guided research once with the complete reservation and bounded built-in calls", async () => {
    const job = guidedJobFixture(); const fixture = databaseFixture(job); const transport = transportFixture(guidedResearchResponse());
    const guidedConfiguration = { ...configuration, policies: new Map([["strategy.competitors" as const, guidedStrategyPolicy("strategy.competitors")]]) };
    expect(await delivery(fixture, transport, { configuration: guidedConfiguration })).toEqual({ disposition: "ack", state: "succeeded" });
    expect(await delivery(fixture, transport, { configuration: guidedConfiguration })).toEqual({ disposition: "ack", state: "succeeded" });
    expect(fixture.state.step?.reserved_cost_microusd).toBe(15_892_880);
    expect(fixture.state.authorizationChecks).toBe(2);
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport.createResponse).mock.calls[0]?.[0]).toMatchObject({ model: "gpt-6.1-sol", max_output_tokens: 8192, max_tool_calls: 2,
      parallel_tool_calls: false, tool_choice: "required", tools: [{ type: "web_search" }], service_tier: "default", truncation: "disabled", store: false, background: false });
    expect(JSON.parse(fixture.state.outcomes[0]?.[5] as string)).toMatchObject({ guidance: { kind: "choices", turnId: "research-turn", stage: "competitors" } });
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

describe("API delivery stage diagnostics", () => {
  it.each(["claim_api_text_job", "register_job_plan"])("reports %s failures without changing retry disposition", async failure => {
    const fixture = databaseFixture(); const events: Array<Record<string, unknown>> = [];
    const original = fixture.database.query;
    fixture.database.query = async (sql, values) => {
      if (sql.includes(failure)) throw Object.assign(new Error("SYNTHETIC_PRIVATE_MESSAGE"), { client: { password: "SYNTHETIC_PRIVATE_MESSAGE" } });
      return original(sql, values);
    };
    expect((await delivery(fixture, transportFixture(), { diagnostics: (event: Record<string, unknown>) => events.push(event) })).disposition).toBe("retry");
    expect(events).toContainEqual(expect.objectContaining({ phase: failure === "claim_api_text_job" ? "claim" : "plan_write", outcome: "error", errorClass: "database" }));
    expect(JSON.stringify(events)).not.toContain("SYNTHETIC_PRIVATE_MESSAGE");
  });
  it("distinguishes handler plan validation and provider execution from database failures", async () => {
    const planEvents: Array<Record<string, unknown>> = []; const job = jobFixture();
    const invalid = { ...job, input: { ...job.input as object, extra: "invalid" } };
    // An incompatible reserved policy reaches the handler plan, after a valid claim.
    const f = databaseFixture(invalid); const original = f.database.query;
    f.database.query = async (sql, values) => {
      const result = await original(sql, values);
      if (sql.includes("claim_api_text_job")) {
        const claim = result.rows[0] as { result: { job: { input: { policy: { model: string } } } } };
        claim.result.job.input.policy.model = "synthetic-invalid-model";
      }
      return result;
    };
    expect((await delivery(f, transportFixture(), { diagnostics: (event: Record<string, unknown>) => planEvents.push(event) })).disposition).toBe("ack");
    expect(planEvents).toContainEqual(expect.objectContaining({ phase: "plan", outcome: "error" }));
    const providerEvents: Array<Record<string, unknown>> = []; const transport = transportFixture();
    vi.mocked(transport.createResponse).mockRejectedValue(new Error("SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD"));
    expect(await delivery(databaseFixture(), transport, { diagnostics: (event: Record<string, unknown>) => providerEvents.push(event) })).toEqual({ disposition: "ack", state: "needs_reconciliation" });
    expect(providerEvents).toContainEqual(expect.objectContaining({ phase: "provider_request", outcome: "error", errorClass: "provider" }));
    expect(providerEvents).toContainEqual(expect.objectContaining({ phase: "provider_execution", outcome: "needs_reconciliation" }));
    expect(JSON.stringify(providerEvents)).not.toContain("SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD");
  });
  it("lets a healthy delivery and duplicate complete even if every diagnostic write throws", async () => {
    const fixture = databaseFixture(); const transport = transportFixture();
    const diagnostics = () => { throw new Error("synthetic logger failure"); };
    expect(await delivery(fixture, transport, { diagnostics })).toEqual({ disposition: "ack", state: "succeeded" });
    expect(await delivery(fixture, transport, { diagnostics })).toEqual({ disposition: "ack", state: "succeeded" });
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
  });
  it("does not classify malformed descriptor/handler data as a database transport failure", async () => {
    const fixture = databaseFixture(); fixture.database.query = async () => ({ rows: [{ dispatch: { malformed: true } }] }) as never;
    expect(await delivery(fixture)).toEqual({ disposition: "retry", state: "handler_unavailable" });
  });
});
