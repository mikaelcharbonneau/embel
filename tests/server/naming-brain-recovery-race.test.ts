import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingProviderReceiptSchema, namingRoleOutputSchema, validateNamingAssignmentPlan } from "../../src/domain/naming-brain";
import { id, snapshot, research, plan, proposal, receipt } from "../domain/naming-brain-fixtures";
import { createNamingBrainPolicy, createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";

async function recover(change: "older_empty" | "older_prefix" | "changed_final" | "changed_prefix" | "foreign_session" | "foreign_turn" | "foreign_turn_envelope" | "changed_type") {
  const brief = namingBriefSnapshotSchema.parse(snapshot()), assignment = validateNamingAssignmentPlan(brief, research(), plan())[0]!;
  const request = createNamingRoleRequest({ runId: id(3), stageKey: "creation", providerCallKey: "creation.real", input: { role: "creator", snapshot: brief, assignment }, dependencyArtifactIds: [assignment.planArtifactId], policy: createNamingRolePolicy(createNamingBrainPolicy("fixture-selected-model"), "creation", "creator", 90) });
  const sessionId = "fixture-session", turnId = "fixture-turn-creation", agentId = "fixture-agent";
  const prior = namingProviderReceiptSchema.parse({ ...receipt("creation", "creator"), ...Object.fromEntries(["requestKey", "requestHash", "providerCallKey", "assignmentKey"].map(key => [key, request[key as keyof typeof request]])), sessionLimitCents: 90, observedModel: request.policy.model });
  const body = { id: sessionId, agent: { id: agentId, model: request.policy.model, multi_agent: { enabled: false }, tools: [] }, environment: { type: "none" }, metadata: { embel_run: request.runId, embel_call: request.providerCallKey, embel_request: request.requestKey, embel_request_hash: request.requestHash, embel_snapshot: request.snapshotHash }, status: "in_progress", required_actions: [], usage: null, spend_control: { limit: 90, consumed: 0 } };
  const turn = { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, status: "in_progress", error: null, usage: null, created_at: 1, started_at: 1, completed_at: null, object: "agent.session.turn" };
  const text = JSON.stringify({ role: "creator", assignmentKey: "real", candidates: [proposal()] });
  const completed = { id: "actual-final", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId, content: [{ type: "output_text", text }] };
  const buffered = change === "changed_type" ? { id: completed.id, type: "function_call", name: "read_reference", call_id: "another-call", arguments: "{}", status: "in_progress", turn_id: turnId }
    : { ...completed, turn_id: change === "foreign_turn" ? "wrong-turn" : turnId, status: change === "changed_final" ? "completed" : "in_progress", content: ["older_prefix", "changed_final", "changed_prefix"].includes(change) ? [{ type: "output_text", text: change === "older_prefix" ? text.slice(0, 25) : "conflicting output" }] : [] };
  let cancellations = 0, creates = 0; const order: string[] = [], saved: unknown[] = [];
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-inert-key", fetch: async (input, init) => {
    const outgoing = new Request(input, init), path = new URL(outgoing.url).pathname;
    if (outgoing.method === "POST") { if (path === "/v1/agents/sessions") creates++; else cancellations++; return new Response(null, { status: 202 }); }
    if (path.endsWith("/events")) {
      order.push("subscribe");
      return new Response([
        { type: change === "changed_final" ? "agent.session.turn.item.done" : "agent.session.turn.item.added", event_id: "older-event", session_id: change === "foreign_session" ? "wrong-session" : sessionId, turn_id: change === "foreign_turn_envelope" ? "wrong-turn" : turnId, output_index: 0, item: buffered },
        { type: "agent.session.turn.completed", event_id: "terminal-event", session_id: sessionId, turn_id: turnId, turn: { ...turn, status: "completed", completed_at: 2 }, usage: null },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    order.push("history");
    const value = path.endsWith("/items") ? { data: [completed], has_more: false, last_id: completed.id } : path.endsWith(`/${turnId}`) ? turn : body;
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  } });
  const runtime = createNamingAgentRuntime({ model: request.policy.model, protocol, now: () => 1000, persistence: { load: async () => ({ startedAt: new Date(1000).toISOString(), request, dependencies: [namingRoleOutputSchema.parse(plan())], providerItems: [], toolResults: [] }), saveToolResult: async () => { throw Error("Unexpected tool work"); } } });
  const outcome = await runtime.resumeStage(prior, { signal: new AbortController().signal, beforeDispatch: async () => { throw Error("Unexpected dispatch"); }, onReceipt: async () => {}, onArtifact: async item => { saved.push(item); } });
  return { outcome, creates, cancellations, order, saved, completed };
}

describe("RT2 subscribe/history overlap", () => {
  it.each(["older_empty", "older_prefix"] as const)("keeps the newer completed item when %s arrives from the subscribed buffer", async change => {
    const result = await recover(change);
    expect(result.order[0]).toBe("subscribe"); expect(result.order[1]).toBe("history");
    expect(result.outcome.status).toBe("completed"); expect(result.creates).toBe(0); expect(result.cancellations).toBe(0);
    expect(result.saved.filter(value => value && typeof value === "object" && "item" in value)).toEqual([expect.objectContaining({ item: result.completed })]);
  });
  it.each(["changed_final", "changed_prefix", "foreign_session", "foreign_turn", "foreign_turn_envelope", "changed_type"] as const)("still rejects %s without replacement inference", async change => {
    const result = await recover(change);
    expect(result.outcome).toMatchObject({ status: "unresolved", code: change === "foreign_session" ? "provider_session_mismatch" : change === "foreign_turn_envelope" ? "provider_turn_mismatch" : change === "foreign_turn" ? "provider_item_mismatch" : "provider_item_changed" }); expect(result.creates).toBe(0); expect(result.cancellations).toBe(1);
  });
});
