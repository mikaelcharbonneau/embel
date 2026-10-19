import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingProviderReceiptSchema, namingRoleOutputSchema, validateNamingAssignmentPlan } from "../../src/domain/naming-brain";
import { id, snapshot, research, plan, proposal, receipt } from "../domain/naming-brain-fixtures";
import { createNamingBrainPolicy, createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";

type TurnRace = "older_progress" | "older_queued" | "contradictory_terminal" | "changed_created_at" | "changed_started_at" | "changed_agent" | "changed_subagent" | "changed_object" | "changed_terminal_created_at";

async function recover(change: "older_empty" | "older_prefix" | "changed_final" | "changed_prefix" | "foreign_session" | "foreign_turn" | "foreign_turn_envelope" | "changed_type", turnRace?: TurnRace) {
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
  const terminalTurn = { ...turn, status: "completed", completed_at: 2, usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } };
  const bufferedTurn = { ...turn, ...(turnRace === "older_queued" ? { status: "queued", started_at: null } : {}),
    ...(turnRace === "contradictory_terminal" ? { ...terminalTurn, status: "failed", error: { code: "synthetic_failure", message: "Synthetic conflicting terminal" } } : {}),
    ...(turnRace === "changed_created_at" ? { created_at: 9 } : {}), ...(turnRace === "changed_started_at" ? { started_at: 9 } : {}),
    ...(turnRace === "changed_agent" ? { agent_id: "another-agent" } : {}), ...(turnRace === "changed_subagent" ? { subagent_id: "unexpected-child" } : {}),
    ...(turnRace === "changed_object" ? { object: "turn" } : {}), ...(turnRace === "changed_terminal_created_at" ? { ...terminalTurn, created_at: 9 } : {}) };
  let cancellations = 0, creates = 0, sessionReads = 0; const order: string[] = [], saved: unknown[] = [];
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-inert-key", fetch: async (input, init) => {
    const outgoing = new Request(input, init), path = new URL(outgoing.url).pathname;
    if (outgoing.method === "POST") { if (path === "/v1/agents/sessions") creates++; else cancellations++; return new Response(null, { status: 202 }); }
    if (path.endsWith("/events")) {
      order.push("subscribe");
      return new Response([
        ...(turnRace ? [{ type: bufferedTurn.status === "completed" ? "agent.session.turn.completed" : bufferedTurn.status === "failed" ? "agent.session.turn.failed" : "agent.session.turn.in_progress", event_id: "older-turn", session_id: sessionId, turn_id: turnId, turn: bufferedTurn }] : [{ type: change === "changed_final" ? "agent.session.turn.item.done" : "agent.session.turn.item.added", event_id: "older-event", session_id: change === "foreign_session" ? "wrong-session" : sessionId, turn_id: change === "foreign_turn_envelope" ? "wrong-turn" : turnId, output_index: 0, item: buffered }]),
        { type: "agent.session.turn.completed", event_id: "terminal-event", session_id: sessionId, turn_id: turnId, turn: turnRace ? { ...terminalTurn, usage: { input_tokens: 16, output_tokens: 8, total_tokens: 24 } } : { ...turn, status: "completed", completed_at: 2 }, usage: null },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    order.push("history");
    const value = path.endsWith("/items") ? { data: [completed], has_more: false, last_id: completed.id } : path.endsWith(`/${turnId}`) ? turnRace ? terminalTurn : turn : turnRace && ++sessionReads > 1 ? { ...body, status: "idle", usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }, spend_control: { limit: 90, consumed: 42 } } : body;
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


describe("RT4 completed history and buffered older Turn", () => {
  it.each(["older_progress", "older_queued"] as const)("retains terminal state and final session observations across %s", async race => {
    const result = await recover("older_empty", race);
    expect(result.order.slice(0, 2)).toEqual(["subscribe", "history"]);
    expect(result.outcome).toMatchObject({ status: "completed", receipt: { confirmedActualCostMicrousd: null, providerCostCounters: expect.arrayContaining([expect.objectContaining({ value: 42 })]), usageObservations: expect.arrayContaining([expect.objectContaining({ scope: "session", totalTokens: 30 }), expect.objectContaining({ scope: "turn", totalTokens: 12 }), expect.objectContaining({ scope: "turn", totalTokens: 24 })]) } });
    expect(result.creates).toBe(0); expect(result.cancellations).toBe(0);
    const turns = result.saved.filter(value => value && typeof value === "object" && "kind" in value && value.kind === "provider_turn");
    expect(turns).toHaveLength(2); expect(turns.every(value => value && typeof value === "object" && "turn" in value && value.turn && typeof value.turn === "object" && "status" in value.turn && value.turn.status === "completed")).toBe(true);
  });
  it.each(["contradictory_terminal", "changed_created_at", "changed_started_at", "changed_agent", "changed_subagent", "changed_object", "changed_terminal_created_at"] as const)("rejects %s rather than treating it as an older compatible snapshot", async race => {
    const result = await recover("older_empty", race);
    expect(result.outcome.status).toBe("unresolved"); expect(result.creates).toBe(0); expect(result.cancellations).toBe(1);
  });
});
