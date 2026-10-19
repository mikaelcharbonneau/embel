import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingProviderReceiptSchema, type NamingProviderReceipt } from "../../src/domain/naming-brain";
import { id, receipt, snapshot } from "../domain/naming-brain-fixtures";
import { createNamingBrainPolicy, createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { buildNamingManagedRequest, createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime, type NamingRuntimeState, type NamingToolResultRecord } from "../../src/server/ai/naming-brain/transport";
import { createNamingReferenceReader } from "../../src/server/ai/naming-brain/source-reader";

// Synthetic HTTP through the installed SDK. Mirrors the real five-web/four-read
// cancelled history without retaining live IDs, inputs, URLs or provider output.
function fixture(options: { local?: boolean; observeOnly?: boolean; terminal?: "completed" | "cancelled" | "waiting"; referenceActions?: boolean; forbiddenTool?: boolean; mismatchedArguments?: boolean; incompleteFunction?: boolean } = {}) {
  const local = options.local ?? true, terminal = options.terminal ?? "completed";
  const request = createNamingRoleRequest({ runId: id(3), stageKey: "research", providerCallKey: "research-researcher", dependencyArtifactIds: [],
    input: { role: "researcher", snapshot: namingBriefSnapshotSchema.parse(snapshot()) },
    policy: createNamingRolePolicy(createNamingBrainPolicy("gpt-6.1-sol"), "research", "researcher", undefined, undefined, local) });
  const wire = buildNamingManagedRequest(request), sessionId = "sess_local_tools", turnId = "turn_local_tools", agentId = "agent_local_tools";
  const calls = { creates: 0, inputs: 0, cancellations: 0, saves: 0 }, methods: string[] = [], artifacts: unknown[] = [], receipts: NamingProviderReceipt[] = [], replies = new Set<string>(), toolRecords: NamingToolResultRecord[] = [], sourceReads: string[] = [];
  const functionCount = options.referenceActions ? 5 : terminal === "cancelled" ? 4 : 0;
  const web = Array.from({ length: 5 }, (_, index) => ({ id: `web_${index}`, type: "web_search_call", status: "completed", turn_id: turnId, action: { type: "search", queries: ["synthetic fixture only"] } }));
  const functions = Array.from({ length: functionCount }, (_, index) => ({ id: `reference_${index}`, type: "function_call", status: options.incompleteFunction ? "in_progress" : "completed", turn_id: turnId,
    name: options.forbiddenTool ? "unapproved_tool" : "read_reference", call_id: `reference_call_${index}`, arguments: JSON.stringify({ url: "https://www.merriam-webster.com/dictionary/fixture" }) }));
  const outputs = terminal === "cancelled" ? functions.map(item => ({ id: `${item.id}_output`, type: "function_call_output", status: "completed", turn_id: turnId, call_id: item.call_id, output: "Synthetic unavailable reference", error: null })) : [];
  const reasoning = terminal === "cancelled" ? Array.from({ length: 7 }, (_, index) => ({ id: `reasoning_${index}`, type: "reasoning", status: "completed", turn_id: turnId })) : [];
  const final = { id: "research_final", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId,
    content: [{ type: "output_text", text: JSON.stringify({ role: "researcher", territories: [{ territoryId: "nature", title: "Nature", direction: "Synthetic direction", sourceKeys: [] }, { territoryId: "rhythm", title: "Rhythm", direction: "Synthetic sounds", sourceKeys: [] }], facts: [], interpretations: [], uncertainties: ["Synthetic fixture only"] }) }] };
  const finished = () => terminal !== "waiting" && (!options.referenceActions || replies.size === functionCount);
  const turn = () => ({ id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: finished() ? terminal : "waiting", error: null, usage: null, created_at: 1, started_at: 1, completed_at: finished() ? 2 : null });
  const body = () => ({ id: sessionId, object: "agent.session", agent: { id: agentId, ...wire.agent }, environment: { type: "none" }, metadata: wire.metadata,
    status: finished() ? "idle" : "requires_action", required_actions: options.referenceActions && !finished() ? functions.filter(item => !replies.has(item.call_id)).map(item => ({ type: "function_call", name: item.name, call_id: item.call_id, turn_id: turnId, arguments: options.mismatchedArguments ? JSON.stringify({ url: "https://www.merriam-webster.com/dictionary/another-fixture" }) : item.arguments })) : [],
    usage: null, ...(!local ? { spend_control: { limit: request.policy.sessionLimitCents, consumed: 0 } } : {}) });
  const historyItems = () => [...web, ...functions, ...outputs, ...reasoning, ...(terminal === "cancelled" ? [{ id: null, type: "message", role: "user", status: "completed", turn_id: turnId, content: [] }] : finished() ? [final] : [])];
  const state: NamingRuntimeState = { startedAt: new Date(1_000).toISOString(), authorizedAt: options.observeOnly ? new Date(1_000).toISOString() : null, recoveryMode: options.observeOnly ? "observe_only" : "execute", observationDeadlineAt: new Date(301_000).toISOString(), request: options.observeOnly ? request : null, dependencies: [], providerItems: [], toolResults: [] };
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: local, fetch: async (input, init) => {
    const outgoing = new Request(input, init), path = new URL(outgoing.url).pathname;
    methods.push(outgoing.method);
    if (outgoing.method === "POST" && path === "/v1/agents/sessions") {
      calls.creates++;
      const events = [
        { type: "agent.session.created", event_id: "event_session", session: body() },
        { type: "agent.session.turn.created", event_id: "event_turn", session_id: sessionId, turn_id: turnId, turn: { ...turn(), status: "in_progress", completed_at: null } },
        ...[...web, ...functions].map((item, index) => ({ type: "agent.session.turn.item.done", event_id: `event_item_${index}`, session_id: sessionId, turn_id: turnId, output_index: index, item })),
        ...(options.referenceActions ? [{ type: "agent.session.requires_action", event_id: "event_actions", session: body() }] : []),
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (outgoing.method === "POST") {
      const input = await outgoing.json() as { events: { type: string; call_id?: string }[] };
      for (const event of input.events) { if (event.type === "agent.session.input.cancel") calls.cancellations++; else { calls.inputs++; replies.add(event.call_id!); } }
      return new Response(null, { status: 202 });
    }
    if (path.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
    const value = path.endsWith("/items") ? { data: historyItems(), has_more: false, last_id: "fixture_last" } : path.endsWith(`/${turnId}`) ? turn() : body();
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  } });
  const referenceReader = createNamingReferenceReader({ localPrototype: local, now: () => 1_000, resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    requestPage: async page => { sourceReads.push(page.url); return new Response("Synthetic reference text.", { headers: { "content-type": "text/plain; charset=utf-8" } }); } });
  const runtime = createNamingAgentRuntime({ model: request.policy.model, localPrototype: local, protocol, now: () => 1_000,
    referenceReader, persistence: { load: async () => state, saveToolResult: async record => { calls.saves++; toolRecords.push(record); } } });
  const prior = namingProviderReceiptSchema.parse({ ...receipt(), ...Object.fromEntries(["runId", "stageKey", "role", "snapshotHash", "requestKey", "providerCallKey", "assignmentKey", "requestHash"].map(key => [key, request[key as keyof typeof request]])),
    ...(local ? { budgetControl: "local_unlimited_v1" } : {}), sessionId, turnId, agentId, sessionLimitCents: request.policy.sessionLimitCents, observedModel: request.policy.model, callIds: web.map(item => item.id), toolCalls: web.map((item, index) => ({ callId: item.id, providerItemId: item.id, type: "web_search", status: index === 4 ? "started" : "completed" })), artifactItemIds: [] });
  const hooks = { signal: new AbortController().signal, beforeDispatch: async () => { state.request = request; state.authorizedAt = new Date(1_000).toISOString(); }, onReceipt: async (value: NamingProviderReceipt) => { receipts.push(value); }, onArtifact: async (value: unknown) => { artifacts.push(value); } };
  return { request, prior, runtime, hooks, calls, methods, artifacts, receipts, toolRecords, sourceReads };
}

describe("Local tool execution and known-session observation (synthetic SDK HTTP)", () => {
  it("allows more than four native web actions only in the trusted local unlimited mode", async () => {
    const local = fixture();
    expect(await local.runtime.runStage(local.request, local.hooks)).toMatchObject({ status: "completed", receipt: { budgetControl: "local_unlimited_v1", toolCalls: expect.arrayContaining([expect.objectContaining({ callId: "web_4", status: "completed" })]) } });
    expect(local.calls).toEqual({ creates: 1, inputs: 0, cancellations: 0, saves: 0 });
    const native = fixture({ local: false });
    expect(await native.runtime.runStage(native.request, native.hooks)).toMatchObject({ status: "unresolved", code: "provider_tool_limit" });
    expect(native.calls).toEqual({ creates: 1, inputs: 0, cancellations: 1, saves: 0 });
  });

  it("persists and submits a fifth reference result during authorized local execution", async () => {
    const value = fixture({ referenceActions: true });
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "completed" });
    expect(value.calls).toEqual({ creates: 1, inputs: 5, cancellations: 0, saves: 5 });
    expect(value.sourceReads).toHaveLength(5);
    expect(value.toolRecords.map(record => record.sourceEvidence)).toEqual(Array.from({ length: 5 }, (_, index) => expect.objectContaining({
      providerItemId: `reference_${index}`, evidenceStatus: "retrieved", excerpt: "Synthetic reference text.",
      provenance: expect.objectContaining({ itemId: `reference_${index}`, protocol: "openai_agents" }), retrieval: expect.objectContaining({ extractorVersion: "embel-reference-text-v1" }),
    })));
  });

  it.each([{ mismatchedArguments: true }, { incompleteFunction: true }])("requires the completed retained function to match the exact reference URL: %j", async options => {
    const value = fixture({ referenceActions: true, ...options });
    await value.runtime.runStage(value.request, value.hooks);
    expect(value.sourceReads).toEqual([]);
    expect(value.toolRecords.every(record => record.sourceEvidence === null)).toBe(true);
  });

  it.each([true, false])("retains cancelled terminal history past an earlier quota breach (local=%s)", async local => {
    const value = fixture({ local, observeOnly: true, terminal: "cancelled" });
    const result = await value.runtime.resumeStage(value.prior, value.hooks);
    expect(result).toMatchObject({ status: "cancelled", code: "provider_turn_cancelled", receipt: { dispatchState: "dispatched", confirmedActualCostMicrousd: null,
      toolCalls: expect.arrayContaining([expect.objectContaining({ callId: "web_4", status: "completed" })]) } });
    expect(value.artifacts).toContainEqual(expect.objectContaining({ kind: "provider_turn", turn: expect.objectContaining({ status: "cancelled" }) }));
    expect(value.artifacts).toContainEqual(expect.objectContaining({ itemId: "web_4" }));
    expect(value.methods.length).toBeGreaterThan(0); expect(value.methods.every(method => method === "GET")).toBe(true);
    expect(value.calls).toEqual({ creates: 0, inputs: 0, cancellations: 0, saves: 0 });
  });

  it("does no tool work or cancellation in observe_only before the execution deadline", async () => {
    const value = fixture({ observeOnly: true, terminal: "waiting", referenceActions: true });
    expect(await value.runtime.resumeStage(value.prior, value.hooks)).toMatchObject({ status: "unresolved" });
    expect(value.methods.every(method => method === "GET")).toBe(true);
    expect(value.calls).toEqual({ creates: 0, inputs: 0, cancellations: 0, saves: 0 });
  });

  it("never publishes a completed native over-quota session during observation", async () => {
    const value = fixture({ local: false, observeOnly: true });
    expect(await value.runtime.resumeStage(value.prior, value.hooks)).toMatchObject({ status: "unresolved", code: "provider_tool_limit" });
    expect(value.artifacts).toContainEqual(expect.objectContaining({ kind: "provider_turn", turn: expect.objectContaining({ status: "completed" }) }));
    expect(value.calls).toEqual({ creates: 0, inputs: 0, cancellations: 0, saves: 0 });
  });

  it("still refuses an unapproved tool in local mode", async () => {
    const value = fixture({ referenceActions: true, forbiddenTool: true });
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "provider_tool_refused" });
    expect(value.calls.inputs).toBe(0); expect(value.calls.saves).toBe(0);
  });
});
