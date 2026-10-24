import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingProviderReceiptSchema, type NamingProviderReceipt } from "../../src/domain/naming-brain";
import { isNamingProviderBudgetAvailable } from "../../src/server/ai/naming-brain/budget-availability";
import { createNamingBrainPolicy, createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { buildNamingManagedRequest, createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { namingHash } from "../../src/server/ai/naming-brain/identity";
import { createNamingReferenceReader } from "../../src/server/ai/naming-brain/source-reader";
import { createNamingAgentRuntime, type NamingRuntimeState, type NamingToolResultRecord } from "../../src/server/ai/naming-brain/transport";
import { id, receipt, snapshot } from "../domain/naming-brain-fixtures";

afterEach(() => vi.unstubAllGlobals());

// Compose the actual runtime with its default SDK adapter and unavailable
// continuation boundary. Only global HTTP is intercepted; no protocol or
// capability is injected. All identities, history and retained tool data are
// synthetic, and the reference transport must never be used.
function fixture(local: boolean, mode: "execute" | "observe_only" | "expired" | "aborted" = "execute", cancelledHistory = false) {
  expect(isNamingProviderBudgetAvailable()).toBe(false);
  const request = createNamingRoleRequest({ runId: id(3), stageKey: "research", providerCallKey: "research-unavailable-recovery", dependencyArtifactIds: [],
    input: { role: "researcher", snapshot: namingBriefSnapshotSchema.parse(snapshot()) },
    policy: createNamingRolePolicy(createNamingBrainPolicy("gpt-6-luna"), "research", "researcher", undefined, undefined, local) });
  const wire = buildNamingManagedRequest(request), sessionId = "sess_unavailable_recovery", turnId = "turn_unavailable_recovery", agentId = "agent_unavailable_recovery";
  const callId = "call_pending_reference", itemId = "item_pending_reference";
  const arguments_ = JSON.stringify({ url: "https://www.merriam-webster.com/dictionary/fixture" });
  const tool: NamingToolResultRecord = { providerCallKey: request.providerCallKey, requestHash: request.requestHash, sessionId, turnId, callId,
    result: { argumentsHash: namingHash(arguments_), reply: { type: "agent.session.input.tool_result", turn_id: turnId, call_id: callId, success: true, output: "Synthetic retained reference output" } }, sourceEvidence: null };
  const originalTool = structuredClone(tool);
  let cancelled = false;
  const terminal = () => cancelled && cancelledHistory;
  const session = () => ({ id: sessionId, object: "agent.session", agent: { ...wire.agent, id: agentId }, environment: wire.environment, metadata: wire.metadata,
    ...(wire.spend_control ? { spend_control: { ...wire.spend_control, consumed: 0 } } : {}), usage: null, status: terminal() ? "idle" : "requires_action",
    required_actions: terminal() ? [] : [{ type: "function_call", name: "read_reference", call_id: callId, turn_id: turnId, arguments: arguments_ }] });
  const turn = () => ({ id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: terminal() ? "cancelled" : "waiting",
    error: null, usage: null, created_at: 1, started_at: 1, completed_at: terminal() ? 2 : null });
  const item = { id: itemId, type: "function_call", status: "completed", turn_id: turnId, name: "read_reference", call_id: callId, arguments: arguments_ };
  const http: { method: string; path: string; events?: unknown[] }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (incoming: RequestInfo | URL, init?: RequestInit) => {
    const outgoing = new Request(incoming, init), url = new URL(outgoing.url), path = url.pathname;
    expect(url.origin).toBe("https://api.openai.com");
    const row: typeof http[number] = { method: outgoing.method, path }; http.push(row);
    if (outgoing.method === "POST") {
      expect(path).toBe(`/v1/agents/sessions/${sessionId}/events`);
      const body = await outgoing.json() as { events: unknown[] }; row.events = body.events;
      expect(body).toEqual({ events: [{ type: "agent.session.input.cancel" }] });
      cancelled = true;
      return new Response(null, { status: 202 });
    }
    expect(outgoing.method).toBe("GET");
    if (path.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
    const value = path.endsWith("/items") ? { data: [item], has_more: false, last_id: itemId }
      : path.endsWith(`/turns/${turnId}`) ? turn() : session();
    return Response.json(value);
  }));
  const currentTime = mode === "expired" ? 1_001 + request.policy.deadlineMs : 1_000;
  const state: NamingRuntimeState = { request, startedAt: new Date(1_000).toISOString(), authorizedAt: new Date(1_000).toISOString(),
    observationDeadlineAt: new Date(currentTime + 300_000).toISOString(), recoveryMode: mode === "observe_only" ? "observe_only" : "execute", dependencies: [], providerItems: [], toolResults: [tool] };
  const saveToolResult = vi.fn(), referenceFetch = vi.fn(async () => { throw Error("retained_tool_must_not_refetch"); });
  const referenceReader = createNamingReferenceReader({ localPrototype: local, requestPage: referenceFetch });
  const runtime = createNamingAgentRuntime({ apiKey: "synthetic-never-sent-to-live-provider", model: request.policy.model, localPrototype: local, now: () => currentTime,
    referenceReader, persistence: { load: async () => state, saveToolResult } });
  const prior = namingProviderReceiptSchema.parse({ ...receipt(), ...Object.fromEntries(["runId", "stageKey", "role", "snapshotHash", "requestKey", "providerCallKey", "assignmentKey", "requestHash"].map(key => [key, request[key as keyof typeof request]])),
    ...(local ? { budgetControl: "local_unlimited_v1" } : {}), sessionId, turnId, agentId, sessionLimitCents: request.policy.sessionLimitCents, observedModel: request.policy.model,
    callIds: [callId], toolCalls: [{ callId, providerItemId: itemId, type: "function", status: "completed" }], artifactItemIds: [itemId] });
  const controller = new AbortController(); if (mode === "aborted") controller.abort();
  const onReceipt = vi.fn<(value: NamingProviderReceipt) => Promise<void>>(async () => {}), onArtifact = vi.fn<(value: unknown) => Promise<void>>(async () => {});
  const hooks = { signal: controller.signal, beforeDispatch: vi.fn(async () => { throw Error("recovery_must_not_authorize_create"); }), onReceipt, onArtifact };
  return { runtime, prior, hooks, http, sessionId, turnId, agentId, state, originalTool, saveToolResult, referenceFetch };
}

describe("unavailable paid continuation during issued-session recovery", () => {
  it.each([false, true])("retains the known session and cancels; an acceptance without terminal history stays unresolved (local=%s)", async local => {
    const f = fixture(local), result = await f.runtime.resumeStage(f.prior, f.hooks);
    expect(result).toMatchObject({ status: "unresolved", code: "creation_unavailable", receipt: { dispatchState: "unknown", sessionId: f.sessionId, turnId: f.turnId, agentId: f.agentId, confirmedActualCostMicrousd: null } });
    expect(f.http.filter(row => row.method === "POST")).toEqual([{ method: "POST", path: `/v1/agents/sessions/${f.sessionId}/events`, events: [{ type: "agent.session.input.cancel" }] }]);
    expect(f.http.filter(row => row.method === "GET" && row.path.endsWith(f.sessionId))).toHaveLength(3);
    expect(f.hooks.onReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ dispatchState: "unknown", sessionId: f.sessionId }));
    expect(f.hooks.beforeDispatch).not.toHaveBeenCalled(); expect(f.saveToolResult).not.toHaveBeenCalled(); expect(f.referenceFetch).not.toHaveBeenCalled();
    expect(f.state.toolResults).toEqual([f.originalTool]);
  });

  it.each([false, true])("requires observed terminal history before reporting cancellation (local=%s)", async local => {
    const f = fixture(local, "execute", true), result = await f.runtime.resumeStage(f.prior, f.hooks);
    expect(result).toMatchObject({ status: "cancelled", code: "provider_turn_cancelled", receipt: { dispatchState: "dispatched", sessionId: f.sessionId, turnId: f.turnId, confirmedActualCostMicrousd: null } });
    expect(f.hooks.onArtifact).toHaveBeenCalledWith(expect.objectContaining({ kind: "provider_turn", sessionId: f.sessionId, turn: expect.objectContaining({ status: "cancelled" }) }));
    expect(f.http.filter(row => row.method === "POST")).toHaveLength(1);
    expect(f.hooks.beforeDispatch).not.toHaveBeenCalled(); expect(f.saveToolResult).not.toHaveBeenCalled(); expect(f.referenceFetch).not.toHaveBeenCalled();
  });

  it.each(["observe_only", "expired", "aborted"] as const)("keeps %s recovery read-only with pending tool output", async mode => {
    const f = fixture(true, mode), result = await f.runtime.resumeStage(f.prior, f.hooks);
    expect(result).toMatchObject({ status: "unresolved", receipt: { sessionId: f.sessionId, turnId: f.turnId, agentId: f.agentId, confirmedActualCostMicrousd: null } });
    expect(f.http.length).toBeGreaterThan(0); expect(f.http.every(row => row.method === "GET")).toBe(true);
    expect(f.hooks.beforeDispatch).not.toHaveBeenCalled(); expect(f.saveToolResult).not.toHaveBeenCalled(); expect(f.referenceFetch).not.toHaveBeenCalled();
    expect(f.state.toolResults).toEqual([f.originalTool]);
  });
});
