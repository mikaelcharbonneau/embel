import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingResearchPackSchema, namingRoleOutputSchema, type NamingProviderReceipt } from "../../src/domain/naming-brain";
import { id, plan, research, snapshot } from "../domain/naming-brain-fixtures";
import { createNamingBrainPolicy, createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { buildNamingManagedRequest, createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime, type NamingRuntimeState } from "../../src/server/ai/naming-brain/transport";

function fixture(options: { local?: boolean; deltas?: number; tailDeltas?: number; foreignDelta?: boolean; oversizedOutput?: boolean } = {}) {
  const local = options.local ?? true;
  const retained = research(), savedResearch = local ? { ...retained, readiness: "partial", sources: [], providerReceipt: { ...retained.providerReceipt, budgetControl: "local_unlimited_v1" },
    output: { ...retained.output, facts: [], territories: retained.output.territories.map(row => ({ ...row, sourceKeys: [] })) } } : retained;
  const request = createNamingRoleRequest({ runId: id(3), stageKey: "direction", providerCallKey: "direction-director", dependencyArtifactIds: [retained.artifactId],
    input: { role: "director", snapshot: namingBriefSnapshotSchema.parse(snapshot()), research: namingResearchPackSchema.parse(savedResearch) },
    policy: createNamingRolePolicy(createNamingBrainPolicy("gpt-6.1-sol"), "direction", "director", undefined, undefined, local) });
  const wire = buildNamingManagedRequest(request), sessionId = "sess_director_stream", turnId = "turn_director_stream";
  const session = { id: sessionId, agent: { id: "agent_director_stream", ...wire.agent }, environment: { type: "none" }, metadata: wire.metadata, status: "idle", required_actions: [], usage: null,
    ...(!local ? { spend_control: { limit: request.policy.sessionLimitCents, consumed: 0 } } : {}) };
  const turn = { id: turnId, session_id: sessionId, agent_id: session.agent.id, subagent_id: null, object: "agent.session.turn", status: "completed", created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null };
  const output = local ? { ...plan().output, assignments: plan().output.assignments.map(row => ({ ...row, sourceKeys: [] })) } : plan().output;
  const item = { id: "item_director_final", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId,
    content: [{ type: "output_text", text: options.oversizedOutput ? " ".repeat(524_289) : JSON.stringify(output) }] };
  const delta = (index: number) => ({ type: "agent.session.turn.reasoning_summary_text.delta", event_id: `event_delta_${index}`, item_id: "item_reasoning", output_index: 0, summary_index: 0,
    session_id: options.foreignDelta && index === 2_100 ? "foreign_session" : sessionId, turn_id: turnId, delta: "x" });
  const encode = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
  const deltas = (count: number) => Array.from({ length: count }, (_, index) => encode(delta(index))).join("");
  const streamed = encode({ type: "agent.session.created", event_id: "event_created", session })
    + encode({ type: "agent.session.turn.created", event_id: "event_turn", session_id: sessionId, turn_id: turnId, turn: { ...turn, status: "in_progress", completed_at: null } })
    + deltas(options.deltas ?? 0)
    + encode({ type: "agent.session.turn.item.done", event_id: "event_output", session_id: sessionId, turn_id: turnId, output_index: 0, item })
    + encode({ type: "agent.session.turn.completed", event_id: "event_completed", session_id: sessionId, turn_id: turnId, turn, usage: null });
  let creates = 0, cancellations = 0;
  const receipts: NamingProviderReceipt[] = [], artifacts: unknown[] = [];
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: local, fetch: async (input, init) => {
    const outgoing = new Request(input, init), path = new URL(outgoing.url).pathname;
    if (outgoing.method === "POST") {
      if (path === "/v1/agents/sessions") { creates++; return new Response(streamed, { headers: { "content-type": "text/event-stream" } }); }
      cancellations++; return new Response(null, { status: 202 });
    }
    if (path.endsWith("/events")) return new Response(deltas(options.tailDeltas ?? 0), { headers: { "content-type": "text/event-stream" } });
    const value = path.endsWith("/items") ? { data: [item], has_more: false, last_id: item.id } : path.endsWith(`/${turnId}`) ? turn : session;
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  } });
  const state: NamingRuntimeState = { startedAt: new Date(1_000).toISOString(), request: null, dependencies: [namingRoleOutputSchema.parse(savedResearch)], providerItems: [], toolResults: [] };
  const runtime = createNamingAgentRuntime({ model: request.policy.model, localPrototype: local, protocol, now: () => 1_000, persistence: { load: async () => state, saveToolResult: async () => {} } });
  const hooks = { signal: new AbortController().signal, beforeDispatch: async () => { state.request = request; state.authorizedAt = new Date(1_000).toISOString(); }, onReceipt: async (value: NamingProviderReceipt) => { receipts.push(value); }, onArtifact: async (value: unknown) => { artifacts.push(value); } };
  return { request, runtime, hooks, state, receipts, artifacts, streamBytes: Buffer.byteLength(streamed), creates: () => creates, cancellations: () => cancellations };
}

describe("Local managed stream framing (synthetic SDK HTTP)", () => {
  it("completes a real Director schema after 20,000 ordinary delta frames larger than the old wire envelope", async () => {
    const value = fixture({ deltas: 20_000 });
    expect(value.streamBytes).toBeGreaterThan(4_194_304);
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "completed", output: { output: { role: "director", assignments: expect.any(Array) } },
      receipt: { budgetControl: "local_unlimited_v1", confirmedActualCostMicrousd: null } });
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(0);
  });

  it("retains the native event-count guard", async () => {
    const value = fixture({ local: false, deltas: 3_000 });
    expect(value.streamBytes).toBeLessThan(4_194_304);
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "provider_event_limit" });
    expect(value.cancellations()).toBe(1);
  });

  it.each([true, false])("handles a buffered terminal tail with 100 deltas only in local mode (%s)", async local => {
    const value = fixture({ local, tailDeltas: 100 }), first = await value.runtime.runStage(value.request, value.hooks);
    if (first.status !== "completed") throw Error("Synthetic Director completion missing");
    value.state.recoveryMode = "observe_only";
    expect(await value.runtime.resumeStage(first.receipt, value.hooks)).toMatchObject(local ? { status: "completed" } : { status: "unresolved", code: "provider_event_limit" });
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(0);
  });

  it("still rejects a foreign delta envelope beyond the old event-count threshold", async () => {
    const value = fixture({ deltas: 2_200, foreignDelta: true });
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "provider_session_mismatch" });
    expect(value.cancellations()).toBe(1);
  });

  it("still rejects final content exceeding the independent 512-KiB output bound", async () => {
    const value = fixture({ deltas: 2_200, oversizedOutput: true });
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "failed", code: "provider_output_invalid" });
    expect(value.cancellations()).toBe(0);
  });

  it("retains the native 4-MiB stream wire bound", async () => {
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", fetch: async () => new Response("x".repeat(4_194_305), { headers: { "content-type": "text/event-stream" } }) });
    const stream = await protocol.streamSession("sess_native_wire", new AbortController().signal);
    await expect((async () => { for await (const event of stream.events) { void event; } })()).rejects.toMatchObject({ code: "protocol_limit" });
    stream.close();
  });

  it("cancels a local stream beyond its finite 128-MiB wire envelope", async () => {
    const chunk = new TextEncoder().encode(`: ${"x".repeat(65_532)}\n\n`);
    let produced = 0, cancelled = false;
    const source = new ReadableStream<Uint8Array>({ pull(controller) { produced++; controller.enqueue(chunk); }, cancel() { cancelled = true; } });
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: true, fetch: async () => new Response(source, { headers: { "content-type": "text/event-stream" } }) });
    const stream = await protocol.streamSession("sess_local_wire", AbortSignal.timeout(15_000));
    await expect((async () => { for await (const event of stream.events) { void event; } })()).rejects.toMatchObject({ code: "protocol_limit" });
    expect(produced * chunk.byteLength).toBeGreaterThan(134_217_728); expect(cancelled).toBe(true);
    stream.close();
  }, 20_000);

  it("retains the 1-MiB JSON response bound in local mode", async () => {
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: true, fetch: async () => new Response(JSON.stringify({ privateFixture: "x".repeat(1_048_576) }), { headers: { "content-type": "application/json" } }) });
    await expect(protocol.retrieveSession("sess_local_json", new AbortController().signal)).rejects.toMatchObject({ code: "protocol_limit" });
  });
});
