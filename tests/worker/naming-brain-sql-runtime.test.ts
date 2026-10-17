import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createTestDatabase, type TestDatabase } from "../database/local-supabase";
import { installBrainFixture, seedBrainFixture, brainRpc, initialIntent, brainWorker } from "../database/naming-brain-fixture";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { namingRoleOutputSchema, namingPreparedSetSchema, type NamingStageRequest } from "../../src/domain/naming-brain";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { createNamingManagedProtocol, type ManagedCreateRequest } from "../../src/server/ai/naming-brain/protocol";
import { createNamingReferenceReader } from "../../src/server/ai/naming-brain/source-reader";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { runOneJob } from "../../worker/runner";
import { syntheticNamingOutput } from "./naming-brain-handler-fixture";

describe("Naming actual SDK/store/SQL boundary (inert HTTP, local database)", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 30_000);
  afterAll(async () => { await db?.close(); });
  it("binds canonical full requests, retained reference text and Creator items through restricted SQL to 100 prepared names", async () => {
    const project = await seedBrainFixture(db);
    await brainRpc(db, "save_naming_preferences", [project, 1, { version: 2, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null, approaches: ["real_words", "invented"], directness: "open_ended", sourceLanguages: [], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [] }]);
    const store = new NamingBrainJobStore({ query: (sql, values) => db.query(sql, values) }, "fixture-deployment");
    await brainWorker(db, () => store.attestPendingPreferences());
    await brainRpc(db, "ensure_naming_brain_run", [project, { ...initialIntent(), expectedPreferencesVersion: 2 }]);
    const requests = new Map<string, NamingStageRequest>();
    const sessions = new Map<string, { request: NamingStageRequest; body: ManagedCreateRequest; sessionId: string; turnId: string; agentId: string; done: boolean; items: unknown[]; controller?: ReadableStreamDefaultController<Uint8Array> }>();
    const encoder = new TextEncoder(); let creates = 0, referenceReads = 0, counter = 0;
    const sessionBody = (s: (typeof sessions extends Map<string, infer S> ? S : never)) => ({ id: s.sessionId, agent: { ...s.body.agent, id: s.agentId }, environment: s.body.environment, metadata: s.body.metadata, status: s.done ? "idle" : s.request.role === "researcher" ? "requires_action" : "running", usage: null, spend_control: { limit: s.body.spend_control!.limit, consumed: 0 }, required_actions: s.done || s.request.role !== "researcher" ? [] : [{ type: "function_call", name: "read_reference", call_id: "reference-call", turn_id: s.turnId, arguments: JSON.stringify({ url: "https://www.merriam-webster.com/dictionary/ember" }) }] });
    const turnBody = (s: (typeof sessions extends Map<string, infer S> ? S : never)) => ({ id: s.turnId, session_id: s.sessionId, agent_id: s.agentId, subagent_id: null, status: s.done ? "completed" : "in_progress", usage: null, error: null, object: "agent.session.turn", created_at: 1, started_at: 1, completed_at: s.done ? 2 : null });
    const emit = (s: (typeof sessions extends Map<string, infer S> ? S : never), event: unknown) => s.controller!.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const complete = (s: (typeof sessions extends Map<string, infer S> ? S : never), sourceKey?: string) => {
      let output = syntheticNamingOutput(s.request);
      if (output.role === "researcher" && sourceKey) output = { ...output, territories: output.territories.map(row => ({ ...row, sourceKeys: row.sourceKeys.map(() => sourceKey) })), facts: output.facts.map(row => ({ ...row, sourceKeys: [sourceKey] })) };
      const item = { id: "final-item", turn_id: s.turnId, type: "message", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output) }] }; s.items.push(item); s.done = true;
      emit(s, { type: "agent.session.turn.item.done", event_id: `event-${counter++}`, session_id: s.sessionId, turn_id: s.turnId, output_index: 0, item });
      emit(s, { type: "agent.session.turn.completed", event_id: `event-${counter++}`, session_id: s.sessionId, turn_id: s.turnId, turn: turnBody(s), usage: null }); s.controller!.close();
    };
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-inert-key", fetch: async (input, init) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/v1/agents/sessions") {
        const body = await request.json() as ManagedCreateRequest, bound = requests.get(body.metadata!.embel_request_hash!)!;
        if (!bound) throw Error("Actual provider body was not bound to the request");
        const sessionId = `session-${++creates}`, turnId = `turn-${creates}`, s = { request: bound, body, sessionId, turnId, agentId: `agent-${creates}`, done: false, items: [] as unknown[], controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined }; sessions.set(sessionId, s);
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          s.controller = controller; emit(s, { type: "agent.session.created", event_id: `event-${counter++}`, session: sessionBody(s) }); emit(s, { type: "agent.session.turn.created", event_id: `event-${counter++}`, session_id: sessionId, turn_id: turnId, turn: turnBody(s) });
          if (bound.role !== "researcher") { complete(s); return; }
          const web = { id: "web-item", turn_id: turnId, type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://www.merriam-webster.com/dictionary/ember" } }; s.items.push(web);
          emit(s, { type: "agent.session.turn.item.done", event_id: `event-${counter++}`, session_id: sessionId, turn_id: turnId, output_index: 0, item: web });
          emit(s, { type: "agent.session.requires_action", event_id: `event-${counter++}`, session: sessionBody(s) });
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      const s = sessions.get(path.split("/")[4]!)!; if (!s) throw Error("Unexpected synthetic session");
      if (request.method === "POST") { const body = await request.json(); if (body.events[0].type === "agent.session.input.tool_result") complete(s, JSON.parse(body.events[0].output).sourceKey); return new Response(null, { status: 202 }); }
      const result = path.endsWith("/items") ? { data: s.items, has_more: false, last_id: "web-item" } : path.endsWith("/turns") ? { data: [turnBody(s)], has_more: false } : path.includes("/turns/") ? turnBody(s) : sessionBody(s);
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    } });
    const referenceReader = createNamingReferenceReader({ resolveHost: async () => [{ address: "93.184.216.34", family: 4 }], requestPage: async () => { referenceReads++; return new Response("Synthetic reference text supporting fixture claims.", { headers: { "content-type": "text/plain; charset=utf-8" } }); } });
    const handlers = createNamingBrainHandlers({ store, assertReady: async () => {}, runtime: (job, input) => {
      const real = createNamingAgentRuntime({ model: input.policy.model, protocol, referenceReader, persistence: store.runtimePersistence(job) });
      return { ...real, runStage: (request, hooks) => { requests.set(request.requestHash, request); return real.runStage(request, hooks); } };
    } });
    expect(await brainWorker(db, () => runOneJob({ store, handlers, workerId: "fixture-worker" }))).toBe("succeeded");
    expect(creates).toBe(6); expect(referenceReads).toBe(1);
    const rows = (await db.query<{ artifact: unknown }>("select artifact from fluid_private.naming_brain_artifacts order by created_at")).rows.map(row => namingRoleOutputSchema.parse(row.artifact));
    const creator = rows.find(row => "creatorAttribution" in row)!; if (!("creatorAttribution" in creator)) throw Error("Missing actual Creator artifact");
    expect(creator.creatorAttribution.assignmentInputHash).toBe(creator.providerReceipt.requestHash);
    const saved = (await db.query<{ prepared: unknown }>("select prepared from fluid_private.naming_brain_prepared_sets")).rows[0]!;
    expect(namingPreparedSetSchema.parse(saved.prepared).candidateIds).toHaveLength(100);
    const research = rows.find(row => row.output.role === "researcher")!; if (!("sources" in research)) throw Error("Missing source");
    expect(research.sources[0]!.contentHash).toBe(namingTextHash(research.sources[0]!.excerpt!));
    const held = (await db.query<{ actual_cost_microusd: number; reserved_cost_microusd: number }>("select actual_cost_microusd,reserved_cost_microusd from public.jobs where operation='naming.generate' and input->>'version'='2'")).rows[0]!;
    expect(Number(held.actual_cost_microusd)).toBe(0); expect(Number(held.reserved_cost_microusd)).toBe(5_000_000);
  }, 30_000);
});
