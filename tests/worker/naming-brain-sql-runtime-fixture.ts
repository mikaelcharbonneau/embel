import { isDeepStrictEqual } from "node:util";
import type { NamingRoleOutput, NamingStageRequest } from "../../src/domain/naming-brain";
import { buildNamingManagedRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol, type ManagedCreateRequest } from "../../src/server/ai/naming-brain/protocol";
import { createNamingReferenceReader, type ReferencePageRequest } from "../../src/server/ai/naming-brain/source-reader";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import type { TestDatabase } from "../database/local-supabase";
import { syntheticNamingOutput } from "./naming-brain-handler-fixture";

export const syntheticReferenceUrl = "https://www.merriam-webster.com/dictionary/ember";
export const syntheticReferenceText = "Synthetic reference text supporting fixture claims.";
export const fixtureWorkerId = "fixture-worker";
export const fixtureDeploymentId = "fixture-deployment";

type Session = {
  request: NamingStageRequest;
  body: ManagedCreateRequest;
  sessionId: string;
  turnId: string;
  agentId: string;
  terminal: boolean;
  failed: boolean;
  items: Record<string, unknown>[];
  finalSessionReads: number;
  controller?: ReadableStreamDefaultController<Uint8Array>;
};
export type SqlNamingCall = { name: string; action?: string; payload?: Record<string, unknown> };
type Options = {
  initialCount?: number;
  gapTerminal?: "failed" | "invalid_json";
  losePrepareAcknowledgement?: boolean;
  beforeArtifact?: (args: unknown[], artifact: NamingRoleOutput) => Promise<void>;
};

/** No query is mocked. Only the provider HTTP/DNS/page transports and a discarded
 * post-COMMIT response are synthetic. All store RPCs execute migrated local SQL. */
export function createSqlNamingHarness(db: TestDatabase, options: Options = {}) {
  const requests = new Map<string, NamingStageRequest>();
  const sessions = new Map<string, Session>();
  const sqlCalls: SqlNamingCall[] = [];
  const sqlErrors: { name: string; action?: string; message: string }[] = [];
  const networkCalls: { method: string; path: string }[] = [];
  const dnsReads: string[] = [];
  const pageReads: ReferencePageRequest[] = [];
  let eventNumber = 0, creates = 0, toolReplies = 0, cancellations = 0;
  let paidReady = true, readyChecks = 0, connectionLost = false, discardedAck: unknown = null;
  const encoder = new TextEncoder();
  const emit = (session: Session, event: Record<string, unknown>) => {
    if (!session.controller) throw new Error("synthetic_stream_missing");
    session.controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...event, event_id: `synthetic-event-${++eventNumber}` })}\n\n`));
  };
  const sessionBody = (session: Session, finalRead = false) => ({
    id: session.sessionId,
    agent: { ...session.body.agent, id: session.agentId },
    environment: session.body.environment,
    metadata: session.body.metadata,
    status: session.terminal ? "idle" : session.request.role === "researcher" ? "requires_action" : "running",
    usage: finalRead ? { input_tokens: 12, output_tokens: 6, total_tokens: 18 } : null,
    spend_control: { limit: session.body.spend_control!.limit, consumed: finalRead ? 1 : 0 },
    required_actions: session.terminal || session.request.role !== "researcher" ? [] : [{
      type: "function_call", name: "read_reference", call_id: "synthetic-reference-call", turn_id: session.turnId,
      arguments: JSON.stringify({ url: syntheticReferenceUrl }),
    }],
  });
  const turnBody = (session: Session) => ({
    id: session.turnId, session_id: session.sessionId, agent_id: session.agentId, subagent_id: null,
    status: session.terminal ? session.failed ? "failed" : "completed" : "in_progress",
    usage: null, error: session.failed ? { code: "synthetic_gap_failure" } : null,
    object: "agent.session.turn", created_at: 1, started_at: 1, completed_at: session.terminal ? 2 : null,
  });
  function complete(session: Session, sourceKey?: string) {
    const terminalGap = session.request.stageKey === "gap" && session.request.role === "director" ? options.gapTerminal : undefined;
    if (terminalGap !== "failed") {
      let output = syntheticNamingOutput(session.request, { initialCount: options.initialCount });
      if (output.role === "researcher") {
        if (!sourceKey) throw new Error("synthetic_source_reply_missing");
        output = { ...output,
          territories: output.territories.map(row => ({ ...row, sourceKeys: row.sourceKeys.map(() => sourceKey) })),
          facts: output.facts.map(row => ({ ...row, sourceKeys: [sourceKey] })),
        };
      }
      const item = { id: "synthetic-final-item", turn_id: session.turnId, type: "message", role: "assistant", phase: "final_answer", status: "completed",
        content: [{ type: "output_text", text: terminalGap === "invalid_json" ? "{synthetic invalid JSON" : JSON.stringify(output) }] };
      const outputIndex = session.items.length;
      session.items.push(item);
      emit(session, { type: "agent.session.turn.item.done", session_id: session.sessionId, turn_id: session.turnId, output_index: outputIndex, item });
    }
    session.terminal = true;
    session.failed = terminalGap === "failed";
    emit(session, { type: session.failed ? "agent.session.turn.failed" : "agent.session.turn.completed", session_id: session.sessionId, turn_id: session.turnId, turn: turnBody(session), usage: null });
    emit(session, { type: "agent.session.idle", session: sessionBody(session) });
    session.controller!.close();
  }
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-inert-key", fetch: async (input, init) => {
    const outgoing = new Request(input, init), url = new URL(outgoing.url), path = url.pathname;
    networkCalls.push({ method: outgoing.method, path });
    if (url.origin !== "https://api.openai.com") throw new Error("synthetic_unexpected_origin");
    if (outgoing.method === "POST" && path === "/v1/agents/sessions") {
      const body = await outgoing.json() as ManagedCreateRequest;
      const request = requests.get(body.metadata!.embel_request_hash!);
      if (!request || !isDeepStrictEqual(body, buildNamingManagedRequest(request))) throw new Error("synthetic_unbound_wire_request");
      const session: Session = { request, body, sessionId: `synthetic-session-${++creates}`, turnId: `synthetic-turn-${creates}`, agentId: `synthetic-agent-${creates}`,
        terminal: false, failed: false, items: [], finalSessionReads: 0 };
      sessions.set(session.sessionId, session);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        session.controller = controller;
        emit(session, { type: "agent.session.created", session: sessionBody(session) });
        emit(session, { type: "agent.session.turn.created", session_id: session.sessionId, turn_id: session.turnId, turn: turnBody(session) });
        if (request.role !== "researcher") { complete(session); return; }
        const webItem = { id: "synthetic-web-item", turn_id: session.turnId, type: "web_search_call", status: "completed", action: { type: "open_page", url: syntheticReferenceUrl } };
        session.items.push(webItem);
        emit(session, { type: "agent.session.turn.item.done", session_id: session.sessionId, turn_id: session.turnId, output_index: 0, item: webItem });
        emit(session, { type: "agent.session.requires_action", session: sessionBody(session) });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    const parts = path.split("/"), session = sessions.get(parts[4]!);
    if (!session) throw new Error("synthetic_unexpected_session");
    if (outgoing.method === "POST" && path === `/v1/agents/sessions/${session.sessionId}/events`) {
      const body = await outgoing.json() as { events: { type: string; output?: string; turn_id?: string; call_id?: string }[] };
      if (body.events.length !== 1) throw new Error("synthetic_unexpected_events");
      const event = body.events[0]!;
      if (event.type === "agent.session.input.cancel") { cancellations++; return new Response(null, { status: 202 }); }
      if (event.type !== "agent.session.input.tool_result" || event.turn_id !== session.turnId || event.call_id !== "synthetic-reference-call" || session.terminal) throw new Error("synthetic_unexpected_tool_reply");
      const reply = JSON.parse(event.output!) as { status: string; sourceKey: string; excerpt: string };
      if (reply.status !== "retrieved" || reply.excerpt !== syntheticReferenceText) throw new Error("synthetic_reference_not_retained");
      toolReplies++; complete(session, reply.sourceKey);
      return new Response(null, { status: 202 });
    }
    if (outgoing.method !== "GET") throw new Error("synthetic_unexpected_method");
    if (path === `/v1/agents/sessions/${session.sessionId}/events`) return new Response("", { headers: { "content-type": "text/event-stream" } });
    let body: unknown;
    if (path === `/v1/agents/sessions/${session.sessionId}`) { if (session.terminal) session.finalSessionReads++; body = sessionBody(session, session.terminal); }
    else if (path === `/v1/agents/sessions/${session.sessionId}/turns`) body = { data: [turnBody(session)], has_more: false };
    else if (path === `/v1/agents/sessions/${session.sessionId}/turns/${session.turnId}`) body = turnBody(session);
    else if (path === `/v1/agents/sessions/${session.sessionId}/turns/${session.turnId}/items`) body = { data: session.items, has_more: false, last_id: session.items.at(-1)?.id ?? null };
    else throw new Error("synthetic_unexpected_path");
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  } });
  const referenceReader = createNamingReferenceReader({
    resolveHost: async hostname => { dnsReads.push(hostname); return [{ address: "93.184.216.34", family: 4 }]; },
    requestPage: async input => { pageReads.push(input); return new Response(syntheticReferenceText, { headers: { "content-type": "text/plain; charset=utf-8" } }); },
  });
  function createWorker() {
    const store = new NamingBrainJobStore({ query: async (sql, args = []) => {
      if (connectionLost) throw new Error("synthetic_process_lost");
      const name = sql.match(/public\.(\w+)\(/u)?.[1];
      if (!name) throw new Error("synthetic_unscoped_query");
      const action = name === "naming_brain_worker_action" ? String(args[2]) : undefined;
      const payload = action ? JSON.parse(String(args[3])) as Record<string, unknown> : undefined;
      sqlCalls.push({ name, action, payload });
      try {
        if (action === "artifact") await options.beforeArtifact?.(args, payload!.artifact as NamingRoleOutput);
        const response = await db.query<Record<string, unknown>>(sql, args);
        if (action === "prepare" && options.losePrepareAcknowledgement && discardedAck === null) {
          discardedAck = structuredClone(response.rows[0]!.result);
          connectionLost = true;
          throw new Error("synthetic_prepare_ack_lost");
        }
        return response;
      } catch (error) { sqlErrors.push({ name, action, message: error instanceof Error ? error.message : "synthetic_unknown_error" }); throw error; }
    } }, fixtureDeploymentId);
    const handlers = createNamingBrainHandlers({ store,
      assertReady: async () => { readyChecks++; if (!paidReady) throw new Error("synthetic_paid_readiness_disabled"); },
      runtime: (job, input) => {
        const actual = createNamingAgentRuntime({ model: input.policy.model, protocol, referenceReader, persistence: store.runtimePersistence(job),
          assertContinuation: async () => { if (!paidReady) throw new Error("synthetic_paid_readiness_disabled"); await store.assertContinuation(job); } });
        return { ...actual, runStage: (request, hooks) => { requests.set(request.requestHash, request); return actual.runStage(request, hooks); } };
      },
    });
    return { store, handlers };
  }
  return { ...createWorker(), requests, sessions, sqlCalls, sqlErrors, networkCalls, dnsReads, pageReads,
    counts: () => ({ creates, toolReplies, cancellations, readyChecks }), discardedAcknowledgement: () => discardedAck,
    restart: () => { connectionLost = false; return createWorker(); }, setPaidReady: (value: boolean) => { paidReady = value; },
  };
}
