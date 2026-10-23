import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, type NamingProviderReceipt } from "../../src/domain/naming-brain";
import { id, snapshot } from "../domain/naming-brain-fixtures";
import { createNamingBrainPolicy, createProgressiveNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { buildNamingManagedRequest, createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { namingHash } from "../../src/server/ai/naming-brain/identity";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime, type NamingRuntimeState, type NamingToolResultRecord } from "../../src/server/ai/naming-brain/transport";
import { createNamingReferenceReader } from "../../src/server/ai/naming-brain/source-reader";

type Mode = "in_progress" | "delayed_item" | "end_history" | "missing_item" | "late_complete" | "late_prefix" | "progress_prefix" | "late_duplicate" | "different_arguments" | "different_call" | "different_turn" | "different_session" | "different_request" | "duplicate_item" | "changed_terminal" | "out_of_policy" | "private_dns" | "lost_ack" | "lost_persist_ack" | "saved_unavailable" | "observe_only";

/** Fictional content through the installed SDK's HTTP/SSE parser. No network,
 * retained account text, provider credential or database is used. */
function fixture(mode: Mode = "in_progress", contractVersion: 2 | null = 2) {
  const request = createNamingRoleRequest({ runId: id(3), stageKey: "creation", providerCallKey: "context.research.researcher", dependencyArtifactIds: [],
    input: { role: "researcher", snapshot: namingBriefSnapshotSchema.parse(snapshot()) },
    policy: createProgressiveNamingRolePolicy(createNamingBrainPolicy("gpt-6.1-sol"), "researcher", undefined, undefined, true, contractVersion ?? undefined) });
  const wire = buildNamingManagedRequest(request), sessionId = "session_reference_fixture", turnId = "turn_reference_fixture", callId = "call_reference_fixture", itemId = "item_reference_fixture";
  const url = mode === "out_of_policy" ? "https://americanhistory.si.edu/freeze-frame/cyanotypes" : "https://en.wikipedia.org/wiki/Trail_blazing";
  const args = { url }, rawArguments = JSON.stringify(args);
  const records: NamingToolResultRecord[] = [], artifacts: unknown[] = [], receipts: NamingProviderReceipt[] = [], submitted: unknown[] = [], order: string[] = [];
  const submittedKeys: (string | null)[] = [];
  const calls = { creates: 0, dns: 0, pages: 0, saves: 0, submits: 0, cancellations: 0 };
  let replied = false, itemReads = 0, loseAck = mode === "lost_ack", losePersistAck = mode === "lost_persist_ack";
  let resumeItem: Record<string, unknown> | null = null;
  let resumeAction: Record<string, unknown> | false | null = null;
  const resumeEvents: unknown[] = [];
  const item = (terminal = false) => ({ id: itemId, type: "function_call", status: terminal ? "completed" : "in_progress", turn_id: turnId, name: "read_reference", call_id: mode === "different_call" ? "wrong_call" : callId,
    arguments: mode === "different_arguments" || terminal && mode === "changed_terminal" ? JSON.stringify({ url: "https://en.wikipedia.org/wiki/Unrelated" }) : rawArguments });
  const action = { type: "function_call", name: "read_reference", call_id: callId, turn_id: mode === "different_turn" ? "wrong_turn" : turnId, arguments: args };
  const session = (required = true) => ({ id: mode === "different_session" && required ? "wrong_session" : sessionId, object: "agent.session", agent: { id: "agent_reference_fixture", ...wire.agent }, environment: wire.environment,
    metadata: mode === "different_request" && required ? { ...wire.metadata, embel_request_hash: "a".repeat(64) } : wire.metadata,
    status: replied ? "idle" : required ? "requires_action" : "running", required_actions: !replied && required && resumeAction !== false ? [{ ...action, ...resumeAction }] : [], usage: null });
  const turn = () => ({ id: turnId, session_id: sessionId, agent_id: "agent_reference_fixture", subagent_id: null, object: "agent.session.turn", status: replied ? "completed" : "waiting", error: null, usage: null, created_at: 1, started_at: 1, completed_at: replied ? 2 : null });
  const final = () => ({ id: "reference_final", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId, content: [{ type: "output_text", text: JSON.stringify({ role: "researcher",
    territories: [{ territoryId: "nature", title: "Nature", direction: "Fictional trail marker imagery", sourceKeys: [] }, { territoryId: "rhythm", title: "Rhythm", direction: "Fictional sound exploration", sourceKeys: [] }],
    facts: [], interpretations: [], uncertainties: ["Synthetic transport fixture; no factual route is claimed."] }) }] });
  const state: NamingRuntimeState = { startedAt: new Date(1000).toISOString(), authorizedAt: null, request: null, dependencies: [], providerItems: [], toolResults: records };
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: true, fetch: async (input, init) => {
    const outgoing = new Request(input, init), path = new URL(outgoing.url).pathname;
    if (outgoing.method === "POST" && path === "/v1/agents/sessions") {
      calls.creates++;
      const added = { type: "agent.session.turn.item.added", event_id: "event_item", session_id: sessionId, turn_id: turnId, output_index: 0, item: item() };
      const events = [
        { type: "agent.session.created", event_id: "event_created", session: session(false) },
        { type: "agent.session.turn.created", event_id: "event_turn", session_id: sessionId, turn_id: turnId, turn: turn() },
        ...(!["delayed_item", "end_history", "missing_item"].includes(mode) ? [added] : []),
        { type: "agent.session.requires_action", event_id: "event_action", session: session() },
        ...(mode === "delayed_item" ? [added] : []),
        ...(["late_complete", "late_prefix", "late_duplicate"].includes(mode) ? [{ ...added, type: "agent.session.turn.item.done", event_id: "event_done", item: item(true) }] : []),
        ...(["late_prefix", "progress_prefix"].includes(mode) ? [{ ...added, event_id: "event_prefix", item: { ...item(), arguments: '{"url":' } }] : []),
        ...(mode === "late_duplicate" ? [{ ...added, type: "agent.session.turn.item.done", event_id: "event_duplicate", item: { ...item(true), id: "late_duplicate_item", arguments: JSON.stringify({ url: "https://en.wikipedia.org/wiki/Unrelated" }) } }] : []),
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (outgoing.method === "POST") {
      const body = await outgoing.json() as { events: { type: string }[] };
      if (body.events[0]?.type === "agent.session.input.cancel") calls.cancellations++;
      else {
        calls.submits++; order.push("submit"); submitted.push(body.events[0]); submittedKeys.push(outgoing.headers.get("idempotency-key"));
        if (loseAck) { loseAck = false; throw new Error("Synthetic lost tool result acknowledgement"); }
        replied = true;
      }
      return new Response(null, { status: 202 });
    }
    if (path.endsWith("/events")) return new Response(resumeEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const historyItems = () => {
      itemReads++;
      if (mode === "missing_item" || ["delayed_item", "end_history"].includes(mode) && itemReads === 1) return [];
      return [{ ...item(replied), ...(!replied ? resumeItem : null) }, ...(mode === "duplicate_item" ? [{ ...item(replied), id: "duplicate_item" }] : []), ...(replied ? [final()] : [])];
    };
    const value = path.endsWith("/items") ? { data: historyItems(), has_more: false, last_id: itemId } : path.endsWith(`/${turnId}`) ? turn() : session();
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  } });
  const referenceReader = createNamingReferenceReader({ localPrototype: true, allowedHosts: request.policy.referenceHosts, now: () => 1000,
    resolveHost: async () => { calls.dns++; return [{ address: mode === "private_dns" ? "127.0.0.1" : "93.184.216.34", family: 4 }]; },
    requestPage: async () => { calls.pages++; order.push("read"); return new Response("A fictional bounded reference excerpt.", { headers: { "content-type": "text/plain; charset=utf-8" } }); } });
  const createRuntime = () => createNamingAgentRuntime({ model: request.policy.model, localPrototype: true, protocol, now: () => 1000, referenceReader,
    persistence: { load: async () => state, saveToolResult: async record => {
      calls.saves++; order.push("persist"); records.push(record);
      if (losePersistAck) { losePersistAck = false; throw new Error("Synthetic lost persistence acknowledgement"); }
    } } });
  const runtime = createRuntime();
  const hooks = { signal: new AbortController().signal, beforeDispatch: async () => { state.request = request; state.authorizedAt = new Date(1000).toISOString(); }, onReceipt: async (receipt: NamingProviderReceipt) => { receipts.push(receipt); }, onArtifact: async (artifact: unknown) => { artifacts.push(artifact); } };
  if (mode === "saved_unavailable") records.push({ providerCallKey: request.providerCallKey, sessionId, turnId, callId, requestHash: request.requestHash,
    result: { argumentsHash: namingHash(args), reply: { type: "agent.session.input.tool_result", call_id: callId, turn_id: turnId, success: true, output: JSON.stringify({ status: "unavailable", code: "source_unobserved" }) } }, sourceEvidence: null });
  return { request, runtime, createRuntime, state, hooks, calls, records, artifacts, receipts, submitted, submittedKeys, order, itemId, callId, args, rawArguments, sessionId, turnId,
    setResumeItem: (value: Record<string, unknown>) => { resumeItem = value; }, setResumeAction: (value: Record<string, unknown> | false) => { resumeAction = value; },
    setResumeItemEvent: (value: Record<string, unknown>) => { resumeEvents.push({ type: "agent.session.turn.item.added", event_id: "event_resume_item", session_id: sessionId, turn_id: turnId, output_index: 0, item: { ...item(), ...value } }); } };
}

describe("Versioned Naming required-action invocation (inert SDK HTTP)", () => {
  it("preserves the unmarked historical rule instead of reinterpreting an old request", async () => {
    // Explicitly omit the marker: same event order, old wire and witness rule.
    const value = fixture("in_progress", null);
    expect(value.request.policy).not.toHaveProperty("progressiveContractVersion");
    expect((await value.runtime.runStage(value.request, value.hooks)).status).toBe("completed");
    expect(value.calls).toMatchObject({ creates: 1, dns: 0, pages: 0, saves: 1, submits: 1 });
    expect(value.records[0]).not.toHaveProperty("invocationWitness");
    expect(JSON.parse(String(value.records[0]!.result.reply.output))).toMatchObject({ code: "source_unobserved" });
  });
  it.each(["in_progress", "delayed_item", "end_history", "late_complete", "late_prefix", "progress_prefix"] as const)("reads once from a real %s invocation without inventing completion", async mode => {
    const value = fixture(mode), result = await value.runtime.runStage(value.request, value.hooks);
    expect(result.status).toBe("completed");
    expect(value.calls).toMatchObject({ creates: 1, dns: 1, pages: 1, saves: 1, submits: 1, cancellations: 0 });
    expect(value.order).toEqual(["read", "persist", "submit"]);
    expect(value.records[0]).toMatchObject({ invocationWitness: { version: 1, kind: "required_action", requestHash: value.request.requestHash, providerCallKey: value.request.providerCallKey,
      sessionId: value.sessionId, turnId: value.turnId, callId: value.callId, itemId: value.itemId, actionArgumentsHash: namingHash(value.args), itemArgumentsHash: namingHash(value.rawArguments), parsedArgumentsHash: namingHash(value.args) },
    sourceEvidence: { evidenceStatus: "retrieved", providerItemId: value.itemId, excerpt: "A fictional bounded reference excerpt.", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), retrieval: { responseHash: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(value.receipts.some(receipt => receipt.toolCalls.some(call => call.providerItemId === value.itemId && call.status === "started"))).toBe(true);
    expect(value.artifacts).not.toContainEqual(expect.objectContaining({ item: expect.objectContaining({ id: value.itemId, status: "in_progress" }) }));
  });

  it.each(["different_arguments", "different_call", "different_turn", "different_session", "different_request", "duplicate_item", "missing_item"] as const)("does not read or persist a reply for %s", async mode => {
    const value = fixture(mode);
    expect((await value.runtime.runStage(value.request, value.hooks)).status).toBe("unresolved");
    expect(value.calls).toMatchObject({ creates: 1, dns: 0, pages: 0, saves: 0, submits: 0 });
  });

  it.each(["out_of_policy", "private_dns"] as const)("keeps source policy enforced for %s", async mode => {
    const value = fixture(mode);
    expect((await value.runtime.runStage(value.request, value.hooks)).status).toBe("completed");
    expect(value.calls).toMatchObject({ dns: mode === "out_of_policy" ? 0 : 1, pages: 0, saves: 1, submits: 1 });
    expect(JSON.parse(String(value.records[0]!.result.reply.output))).toMatchObject({ status: "unavailable", code: mode === "out_of_policy" ? "source_not_allowed" : "destination_not_public" });
    expect(value.records[0]!.sourceEvidence).toMatchObject({ evidenceStatus: "unretrieved", excerpt: null, contentHash: null });
  });

  it("reuses the identical durable tool result after a lost acknowledgement without a second fetch or create", async () => {
    const value = fixture("lost_ack"), first = await value.runtime.runStage(value.request, value.hooks);
    expect(first.status).toBe("unresolved");
    if (first.status !== "unresolved" || !first.receipt) throw new Error("Missing synthetic receipt");
    const saved = structuredClone(value.records[0]);
    expect((await value.runtime.resumeStage(first.receipt, value.hooks)).status).toBe("completed");
    expect(value.calls).toMatchObject({ creates: 1, dns: 1, pages: 1, saves: 1, submits: 2 });
    expect(value.submitted[0]).toEqual(value.submitted[1]); expect(value.records[0]).toEqual(saved);
  });

  it("reuses the saved result with a fresh runtime when resume history contains an incomplete argument prefix", async () => {
    const value = fixture("lost_ack"), first = await value.runtime.runStage(value.request, value.hooks);
    if (first.status !== "unresolved" || !first.receipt) throw new Error("Missing synthetic receipt");
    const saved = structuredClone(value.records[0]);
    expect(saved?.invocationWitness).toBeDefined(); expect(value.state.providerItems).toEqual([]);
    value.setResumeItem({ arguments: '{"url":' });
    expect((await value.createRuntime().resumeStage(first.receipt, value.hooks)).status).toBe("completed");
    expect(value.calls).toMatchObject({ creates: 1, dns: 1, pages: 1, saves: 1, submits: 2 });
    expect(value.records[0]).toEqual(saved); expect(value.submitted[0]).toEqual(value.submitted[1]);
    expect(value.submittedKeys[0]).toMatch(/^tool-[a-f0-9]{48}$/u); expect(value.submittedKeys[1]).toBe(value.submittedKeys[0]);
    expect(value.artifacts).not.toContainEqual(expect.objectContaining({ item: expect.objectContaining({ status: "in_progress", arguments: '{"url":' }) }));
  });

  it.each([
    { arguments: JSON.stringify({ url: "https://en.wikipedia.org/wiki/Unrelated" }) },
    { arguments: JSON.stringify({ url: "" }) },
    { arguments: JSON.stringify({ url: "https://en.wikipedia.org/wiki/Trail_blazing", unexpected: true }) },
    { arguments: "null" },
    { arguments: [] },
    { arguments: '{"url":', status: "completed" },
    { name: "wrong_function", arguments: '{"url":' },
    { call_id: "wrong_call", arguments: '{"url":' },
    { id: "wrong_item", arguments: '{"url":' },
    { turn_id: "wrong_turn", arguments: '{"url":' },
  ])("still refuses a conflicting resumed item without new work: %j", async resumed => {
    const value = fixture("lost_ack"), first = await value.runtime.runStage(value.request, value.hooks);
    if (first.status !== "unresolved" || !first.receipt) throw new Error("Missing synthetic receipt");
    value.setResumeItem(resumed);
    expect((await value.createRuntime().resumeStage(first.receipt, value.hooks)).status).toBe("unresolved");
    expect(value.calls).toMatchObject({ creates: 1, dns: 1, pages: 1, saves: 1, submits: 1 });
  });

  it.each([false, { arguments: { url: "https://en.wikipedia.org/wiki/Unrelated" } }] as const)("does not replay a saved result without its exact current required action: %j", async action => {
    const value = fixture("lost_ack"), first = await value.runtime.runStage(value.request, value.hooks);
    if (first.status !== "unresolved" || !first.receipt) throw new Error("Missing synthetic receipt");
    value.setResumeItem({ arguments: '{"url":' }); value.setResumeAction(action);
    expect((await value.createRuntime().resumeStage(first.receipt, value.hooks)).status).toBe("unresolved");
    expect(value.calls).toMatchObject({ creates: 1, dns: 1, pages: 1, saves: 1, submits: 1 });
  });

  it.each(["sessionId", "turnId", "requestHash", "providerCallKey"] as const)("refuses a loaded witness with a different %s before deferring a prefix", async field => {
    const value = fixture("lost_ack"), first = await value.runtime.runStage(value.request, value.hooks);
    if (first.status !== "unresolved" || !first.receipt) throw new Error("Missing synthetic receipt");
    const witness = value.records[0]!.invocationWitness!;
    witness[field] = field === "requestHash" ? "f".repeat(64) : "wrong_identity";
    value.setResumeItem({ arguments: '{"url":' });
    expect(await value.createRuntime().resumeStage(first.receipt, value.hooks)).toMatchObject({ status: "unresolved", code: "reference_invocation_changed" });
    expect(value.calls).toMatchObject({ creates: 1, dns: 1, pages: 1, saves: 1, submits: 1 });
  });

  it("does not exempt a deferred stream fragment from the existing item byte limit", async () => {
    const value = fixture("lost_ack"), first = await value.runtime.runStage(value.request, value.hooks);
    if (first.status !== "unresolved" || !first.receipt) throw new Error("Missing synthetic receipt");
    value.setResumeItem({ arguments: '{"url":' });
    value.setResumeItemEvent({ arguments: '{"url":' + " ".repeat(1_048_576) });
    expect(await value.createRuntime().resumeStage(first.receipt, value.hooks)).toMatchObject({ status: "unresolved", code: "provider_item_limit" });
    expect(value.calls).toMatchObject({ creates: 1, dns: 1, pages: 1, saves: 1, submits: 2 });
  });

  it("loads an uncertain persistence acknowledgement before attempting another read", async () => {
    const value = fixture("lost_persist_ack"), first = await value.runtime.runStage(value.request, value.hooks);
    if (first.status !== "unresolved" || !first.receipt) throw new Error("Missing synthetic receipt");
    expect(value.calls).toMatchObject({ creates: 1, pages: 1, saves: 1, submits: 0 });
    expect((await value.runtime.resumeStage(first.receipt, value.hooks)).status).toBe("completed");
    expect(value.calls).toMatchObject({ creates: 1, dns: 1, pages: 1, saves: 1, submits: 1 });
  });

  it("fails closed on conflicting retained result arguments without fetching or resubmitting", async () => {
    const value = fixture("lost_ack"), first = await value.runtime.runStage(value.request, value.hooks);
    if (first.status !== "unresolved" || !first.receipt) throw new Error("Missing synthetic receipt");
    value.records[0]!.result.argumentsHash = "f".repeat(64);
    expect(await value.runtime.resumeStage(first.receipt, value.hooks)).toMatchObject({ status: "unresolved", code: "tool_result_mismatch" });
    expect(value.calls).toMatchObject({ creates: 1, pages: 1, saves: 1, submits: 1 });
  });

  it("preserves a previously retained source_unobserved result without trying retrieval again", async () => {
    const value = fixture("saved_unavailable"), saved = structuredClone(value.records[0]);
    expect((await value.runtime.runStage(value.request, value.hooks)).status).toBe("completed");
    expect(value.calls).toMatchObject({ dns: 0, pages: 0, saves: 0, submits: 1 }); expect(value.records[0]).toEqual(saved);
  });

  it("does no tool work during observe-only recovery", async () => {
    const value = fixture("lost_ack"), first = await value.runtime.runStage(value.request, value.hooks);
    if (first.status !== "unresolved" || !first.receipt) throw new Error("Missing synthetic receipt");
    value.state.recoveryMode = "observe_only";
    const counts = { ...value.calls };
    expect((await value.runtime.resumeStage(first.receipt, value.hooks)).status).toBe("unresolved");
    expect(value.calls).toEqual(counts);
  });

  it("rejects a changed terminal invocation after retrieval", async () => {
    const value = fixture("changed_terminal");
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "reference_invocation_changed" });
    expect(value.calls).toMatchObject({ pages: 1, saves: 1, submits: 1 });
  });

  it("rejects a second item ID for a witnessed call even after the original item completed", async () => {
    const value = fixture("late_duplicate");
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "reference_invocation_changed" });
    expect(value.calls).toMatchObject({ pages: 1, saves: 1, submits: 1 });
  });
});
