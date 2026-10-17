import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingRoleOutputSchema, validateNamingAssignmentPlan } from "../../src/domain/naming-brain";
import { id, snapshot, research, plan, proposal } from "../domain/naming-brain-fixtures";
import { createNamingBrainPolicy, createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime, type NamingRuntimeState } from "../../src/server/ai/naming-brain/transport";

function fixture(mode: "complete" | "lost" | "failed" | "no_session_event" | "abort_cancelled" | "overrun" = "complete") {
  const brief = namingBriefSnapshotSchema.parse(snapshot()), assignment = validateNamingAssignmentPlan(brief, research(), plan())[0]!;
  const request = createNamingRoleRequest({ runId: id(3), stageKey: "creation", providerCallKey: "creation.real", input: { role: "creator", snapshot: brief, assignment }, dependencyArtifactIds: [assignment.planArtifactId], policy: createNamingRolePolicy(createNamingBrainPolicy("fixture-selected-model"), "creation", "creator", 90) });
  let creates = 0, cancellations = 0; const abort = new AbortController(); const order: string[] = [], receipts: unknown[] = [];
  const body = () => ({ id: "sess_fixture", agent: { id: "agent_fixture", model: request.policy.model, multi_agent: { enabled: false }, tools: [] }, environment: { type: "none" }, metadata: { embel_run: request.runId, embel_call: request.providerCallKey, embel_request: request.requestKey, embel_request_hash: request.requestHash, embel_snapshot: request.snapshotHash }, status: "idle", required_actions: [], usage: null, spend_control: { limit: 90, consumed: mode === "overrun" ? 91 : 0 } });
  const turn = { id: "turn_fixture", session_id: "sess_fixture", agent_id: "agent_fixture", subagent_id: null, status: mode === "failed" ? "failed" : mode === "abort_cancelled" ? "cancelled" : "completed", error: mode === "failed" ? { code: "session_budget_exceeded", message: "Fixture" } : null, usage: null, created_at: 1, started_at: 1, completed_at: 2, object: "agent.session.turn" };
  const item = { id: "item_fixture", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: "turn_fixture", content: [{ type: "output_text", text: JSON.stringify({ role: "creator", assignmentKey: "real", candidates: [proposal()] }) }] };
  const state: NamingRuntimeState = { startedAt: new Date(1000).toISOString(), request: null, dependencies: [namingRoleOutputSchema.parse(plan())], providerItems: [], toolResults: [] };
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic", fetch: async (input, init) => {
    const outgoing = new Request(input, init), url = new URL(outgoing.url);
    if (outgoing.method === "POST" && url.pathname === "/v1/agents/sessions") {
      creates++; order.push("provider"); if (mode === "lost") throw new Error("Lost synthetic acknowledgement");
      return new Response([
        { type: "agent.session.created", event_id: "event1", session: body() },
        { type: "agent.session.turn.created", event_id: "event2", session_id: "sess_fixture", turn_id: "turn_fixture", turn: { ...turn, status: "in_progress" } },
        { type: "agent.session.turn.item.done", event_id: "event3", session_id: "sess_fixture", turn_id: "turn_fixture", output_index: 0, item },
        { type: mode === "failed" ? "agent.session.turn.failed" : "agent.session.turn.completed", event_id: "event4", session_id: "sess_fixture", turn_id: "turn_fixture", turn, usage: null },
      ].filter(event => mode !== "no_session_event" || event.type !== "agent.session.created").map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (outgoing.method === "POST") { cancellations++; return new Response(null, { status: 202 }); }
    if (url.pathname.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
    const value = url.pathname.endsWith("/items") ? { data: [item], has_more: false, last_id: item.id } : url.pathname.endsWith("/turns") ? { data: [turn], has_more: false } : url.pathname.endsWith("/turn_fixture") ? turn : body();
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  } });
  const runtime = createNamingAgentRuntime({ model: request.policy.model, protocol, now: () => 1000, persistence: { load: async () => state, saveToolResult: async () => {} } });
  const hooks = { signal: abort.signal, beforeDispatch: async () => { order.push("intent"); state.request = request; }, onReceipt: async (value: unknown) => { receipts.push(value); if (mode === "abort_cancelled" && value && typeof value === "object" && "turnId" in value && value.turnId) abort.abort(); }, onArtifact: async () => { order.push("artifact"); } };
  return { runtime, request, hooks, state, order, receipts, creates: () => creates, cancellations: () => cancellations };
}
describe("Managed Naming runtime (inert SDK HTTP)", () => {
  it("awaits dispatch intent and artifact persistence; completes with provisional nullable expense", async () => {
    const value = fixture(), result = await value.runtime.runStage(value.request, value.hooks);
    expect(value.order[0]).toBe("intent"); expect(value.order[1]).toBe("provider");
    expect(result.status).toBe("completed");
    expect(result).toMatchObject({ receipt: { accountingStatus: "provisional", confirmedActualCostMicrousd: null }, output: { output: { candidates: [{ value: "Quorv" }] } } });
    expect(value.order).toContain("artifact"); expect(value.creates()).toBe(1);
  });
  it("retains an unknown create and never replaces it on resume", async () => {
    const value = fixture("lost"), result = await value.runtime.runStage(value.request, value.hooks);
    expect(result).toMatchObject({ status: "unresolved", receipt: { sessionId: null, dispatchState: "unknown", confirmedActualCostMicrousd: null } });
    if (result.status !== "unresolved" || !result.receipt) throw new Error("fixture");
    expect((await value.runtime.resumeStage(result.receipt, value.hooks)).status).toBe("unresolved");
    expect(value.creates()).toBe(1);
  });
  it("observes a known session with missing turn ID without creating again", async () => {
    const value = fixture(), first = await value.runtime.runStage(value.request, value.hooks);
    if (first.status !== "completed") throw new Error("fixture");
    expect((await value.runtime.resumeStage({ ...first.receipt, turnId: null }, value.hooks)).status).toBe("completed");
    expect(value.creates()).toBe(1);
  });
  it("does not confuse idle session and completed text with failed intended turn", async () => {
    const value = fixture("failed");
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "failed", code: "provider_turn_failed" });
  });
});


describe("Managed terminal and acknowledgement recovery", () => {
  it("retains a genuine session ID from an event when the create event was missed", async () => {
    const value = fixture("no_session_event");
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "completed", receipt: { sessionId: "sess_fixture", turnId: "turn_fixture" } });
    expect(value.creates()).toBe(1);
  });
  it("confirms cancellation from actual root history, not cancellation acceptance", async () => {
    const value = fixture("abort_cancelled");
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "cancelled", code: "provider_turn_cancelled" });
    expect(value.cancellations()).toBe(1); expect(value.creates()).toBe(1);
  });
  it("retains observed overrun as unresolved and never publishes completed text", async () => {
    const value = fixture("overrun");
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "provider_cost_exceeded", receipt: { confirmedActualCostMicrousd: null } });
    expect(value.cancellations()).toBe(1);
  });
});
