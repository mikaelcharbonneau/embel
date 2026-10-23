import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingRoleOutputSchema, namingRolePolicySchema, validateNamingAssignmentPlan, type NamingProviderReceipt } from "../../src/domain/naming-brain";
import { id, snapshot, research, plan, proposal } from "../domain/naming-brain-fixtures";
import { createNamingBrainPolicy, createNamingRolePolicy, createProgressiveNamingRolePolicy, createBudgetedProgressiveNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createProgressiveNamingAssignment } from "../../src/server/ai/naming-brain/progressive-assignments";
import { buildNamingManagedRequest, createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime, type NamingRuntimeState } from "../../src/server/ai/naming-brain/transport";

function roleRequest(localPrototype: boolean, stageKey: "creation" | "gap" | "direction" = "creation", deadlineMs: 240000 | 900000 = 240_000, progressive = false, model = "gpt-6.1-sol", capped = false) {
  const brief = namingBriefSnapshotSchema.parse(snapshot()), assignment = validateNamingAssignmentPlan(brief, research(), plan())[0]!;
  if (progressive) return createNamingRoleRequest({ runId: id(3), stageKey: "creation", providerCallKey: "part001.creator", input: { role: "creator", snapshot: brief,
    assignment: createProgressiveNamingAssignment({ runId: id(3), snapshot: brief, partIndex: 0, approach: "real_words", targetCount: 4 }) }, dependencyArtifactIds: [],
    policy: capped ? createBudgetedProgressiveNamingRolePolicy(createNamingBrainPolicy(model), "creator") : createProgressiveNamingRolePolicy(createNamingBrainPolicy(model), "creator", 4, undefined, localPrototype) });
  if (stageKey === "direction") {
    const pack = namingRoleOutputSchema.parse(research());
    if (!("readiness" in pack)) throw new Error("Synthetic Research missing");
    return createNamingRoleRequest({ runId: id(3), stageKey, providerCallKey: "direction.director", input: { role: "director", snapshot: brief, research: pack }, dependencyArtifactIds: [pack.artifactId],
      policy: createNamingRolePolicy(createNamingBrainPolicy("gpt-6.1-sol"), stageKey, "director", undefined, undefined, localPrototype, deadlineMs) });
  }
  return createNamingRoleRequest({ runId: id(3), stageKey, providerCallKey: `${stageKey}.real`, input: { role: "creator", snapshot: brief, assignment: stageKey === "gap" ? { ...assignment, round: "gap" } : assignment }, dependencyArtifactIds: [assignment.planArtifactId],
    policy: createNamingRolePolicy(createNamingBrainPolicy("gpt-6.1-sol"), stageKey, "creator", 90, undefined, localPrototype, deadlineMs) });
}

// Historical compatibility sessions omitted spend_control after a provider rejection.
// Exercise the actual pinned SDK, durable hooks and post-parse together using that shape.
function fixture(options: { localRequest?: boolean; trustedLocal?: boolean; missingWitness?: boolean; wrongReasoning?: boolean; largeCounter?: boolean; hanging?: boolean;
  stageKey?: "creation" | "gap" | "direction"; deadlineMs?: 240000 | 900000; stageAgeMs?: number; remainingMs?: number; clock?: () => number; missingAuthorization?: boolean; mismatchedAuthorization?: boolean; createAckLost?: boolean;
  completionDelayMs?: number; nativeSessionCap?: boolean; progressive?: boolean; model?: string; wrongTier?: boolean; wrongVerbosity?: boolean; missingPipeline?: boolean; priorityRejected?: boolean; capped?: boolean; returnedCap?: number | null; consumed?: number } = {}) {
  const request = roleRequest(options.localRequest ?? true, options.stageKey, options.deadlineMs, options.progressive, options.model, options.capped), sent: unknown[] = [], receipts: NamingProviderReceipt[] = [], order: string[] = [];
  let creates = 0, cancellations = 0;
  const wire = buildNamingManagedRequest(request), now = options.clock?.() ?? Date.now();
  const body = { id: "sess_local_fixture", object: "agent.session", agent: { id: "agent_local_fixture", ...wire.agent, reasoning: { effort: options.wrongReasoning ? "low" : "xhigh", summary: null },
    ...(options.wrongTier ? { service_tier: wire.agent!.service_tier === "default" ? "priority" : "default" } : {}), ...(options.wrongVerbosity ? { text: { ...wire.agent!.text, verbosity: "high" } } : {}) },
    environment: { type: "none" }, metadata: { ...wire.metadata, ...(options.missingWitness ? { embel_budget_control: undefined } : {}), ...(options.missingPipeline ? { embel_pipeline_version: undefined } : {}) }, status: "idle", required_actions: [], usage: null,
    ...(options.capped ? options.returnedCap === null ? {} : { spend_control: { limit: options.returnedCap ?? request.policy.providerSpendCapCents, consumed: options.consumed ?? 0 } } : options.largeCounter ? { spend_control: { limit: 1, consumed: 10_000 } } : options.nativeSessionCap ? { spend_control: { limit: request.policy.sessionLimitCents, consumed: 0 } } : {}) };
  const turn = { id: "turn_local_fixture", session_id: body.id, agent_id: body.agent.id, subagent_id: null, status: options.hanging ? "in_progress" : "completed", error: null, usage: null,
    created_at: 1, started_at: 1, completed_at: options.hanging ? null : 2, object: "agent.session.turn" };
  const candidate = request.input.role === "creator" ? { ...proposal(), primaryApproach: request.input.assignment.primaryApproach, territoryId: request.input.assignment.territoryId, constructionKey: request.input.assignment.constructionKey } : proposal();
  const item = { id: "item_local_fixture", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turn.id,
    content: [{ type: "output_text", text: JSON.stringify({ role: "creator", assignmentKey: request.assignmentKey, candidates: [candidate] }) }] };
  const state: NamingRuntimeState = { startedAt: new Date(now - (options.stageAgeMs ?? 0)).toISOString(), request: null, dependencies: request.policy.localPipelineVersion === 2 ? [] : [namingRoleOutputSchema.parse(request.role === "director" ? research() : plan())], providerItems: [], toolResults: [] };
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: options.trustedLocal ?? true, fetch: async (input, init) => {
    const outgoing = new Request(input, init), url = new URL(outgoing.url);
    if (outgoing.method === "POST" && url.pathname === "/v1/agents/sessions") {
      creates++; order.push("provider"); sent.push(await outgoing.json());
      if (options.priorityRejected) return Response.json({ error: { message: "Synthetic priority rejection", type: "invalid_request_error", code: "unsupported_value", param: "agent.service_tier" } }, { status: 400, headers: { "x-request-id": "req_synthetic_priority" } });
      if (options.createAckLost) throw new TypeError("Synthetic lost create acknowledgement");
      const events = [
        { type: "agent.session.created", event_id: "event_local1", session: body },
        { type: "agent.session.turn.created", event_id: "event_local2", session_id: body.id, turn_id: turn.id, turn: { ...turn, status: "in_progress", completed_at: null } },
        ...options.hanging ? [] : [
          { type: "agent.session.turn.item.done", event_id: "event_local3", session_id: body.id, turn_id: turn.id, output_index: 0, item },
          { type: "agent.session.turn.completed", event_id: "event_local4", session_id: body.id, turn_id: turn.id, turn, usage: null },
        ],
      ].map(event => `data: ${JSON.stringify(event)}\n\n`);
      let completion: ReturnType<typeof setTimeout> | undefined;
      return new Response(options.hanging || options.completionDelayMs ? new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(events.slice(0, 2).join("")));
        if (options.completionDelayMs) completion = setTimeout(() => { controller.enqueue(new TextEncoder().encode(events.slice(2).join(""))); controller.close(); }, options.completionDelayMs);
      }, cancel() { clearTimeout(completion); } }) : events.join(""),
        { headers: { "content-type": "text/event-stream" } });
    }
    if (outgoing.method === "POST") { cancellations++; return new Response(null, { status: 202 }); }
    if (url.pathname.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
    const value = url.pathname.endsWith("/items") ? { data: options.hanging ? [] : [item], has_more: false, last_id: item.id }
      : url.pathname.endsWith("/turns") ? { data: [turn], has_more: false } : url.pathname.endsWith(`/${turn.id}`) ? turn : body;
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  } });
  const persistence = { load: async () => state, saveToolResult: async () => {} };
  const runtime = createNamingAgentRuntime({ model: request.policy.model, localPrototype: options.trustedLocal ?? true, protocol, now: () => options.clock?.() ?? now, persistence });
  const abort = new AbortController();
  const hooks = { signal: abort.signal, beforeDispatch: async () => { order.push("intent"); state.request = options.mismatchedAuthorization ? { ...request, requestHash: "d".repeat(64) } : request;
    state.authorizedAt = options.missingAuthorization ? null : new Date((options.clock?.() ?? now) - (options.remainingMs === undefined ? 0 : request.policy.deadlineMs - options.remainingMs)).toISOString(); },
    onReceipt: async (receipt: NamingProviderReceipt) => { receipts.push(receipt); }, onArtifact: async () => { order.push("artifact"); } };
  return { request, runtime, protocol, persistence, hooks, state, abort, receipts, sent, order, creates: () => creates, cancellations: () => cancellations };
}

afterEach(() => vi.useRealTimers());

describe("Explicit local managed-Agents compatibility (synthetic HTTP only)", () => {
  it("uses documented priority and concise output only for an explicitly versioned progressive call", async () => {
    const value = fixture({ progressive: true }), result = await value.runtime.runStage(value.request, value.hooks);
    expect(value.request).toMatchObject({ stageKey: "creation", policy: { localPipelineVersion: 2, budgetControl: "local_unlimited_v1", deadlineMs: 900_000 }, input: { assignment: { assignmentBasis: { kind: "brief_seed" } } } });
    expect(value.request.dependencyArtifactIds).toEqual([]);
    expect(value.sent[0]).toMatchObject({ agent: { model: "gpt-6.1-sol", reasoning: { effort: "xhigh" }, service_tier: "priority", text: { verbosity: "low" } }, metadata: { embel_pipeline_version: "2" } });
    expect(buildNamingManagedRequest(value.request).agent!.instructions).toContain("Names in recentExamples, likedExamples and strongSeeds already exist: avoid those exact literal values while welcoming related imagery and sound.");
    expect(result).toMatchObject({ status: "completed", receipt: { localPipelineVersion: 2 }, output: { providerReceipt: { localPipelineVersion: 2 } } });
    expect(value.receipts.every(receipt => receipt.localPipelineVersion === 2)).toBe(true);
    expect(() => createProgressiveNamingRolePolicy(createNamingBrainPolicy("gpt-6.1-sol"), "creator")).toThrow("progressive_naming_unavailable");
    expect(buildNamingManagedRequest(roleRequest(true)).agent).not.toHaveProperty("service_tier");
    expect(value.request.requestHash).toBe("6e4a7d7681aecea98f09436102978c22e1153082a741c0e624115c4335af6dd8");
  });

  it("uses verified Luna at the default tier for future local calls and preserves exact saved Sol authority", async () => {
    const value = fixture({ progressive: true, model: "gpt-6-luna" });
    const result = await value.runtime.runStage(value.request, value.hooks);
    expect(value.sent).toEqual([expect.objectContaining({ agent: expect.objectContaining({ model: "gpt-6-luna", reasoning: { effort: "xhigh" }, service_tier: "default", text: expect.objectContaining({ verbosity: "low" }) }) })]);
    expect(result).toMatchObject({ status: "completed", receipt: { observedModel: "gpt-6-luna" } });
    const sol = roleRequest(true, "creation", 240_000, true);
    expect(sol.requestHash).toBe("6e4a7d7681aecea98f09436102978c22e1153082a741c0e624115c4335af6dd8");
    expect(buildNamingManagedRequest(sol).agent!.service_tier).toBe("priority");
    expect(value.request.requestHash).not.toBe(sol.requestHash);
    if (result.status !== "completed") throw new Error("Synthetic Luna completion missing");
    expect(await value.runtime.resumeStage(result.receipt, value.hooks)).toMatchObject({ status: "completed" });
    expect(value.creates()).toBe(1);
  });

  it("refuses an unrequested priority echo or wire for Luna without a fallback create", async () => {
    const value = fixture({ progressive: true, model: "gpt-6-luna", wrongTier: true });
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "provider_configuration_mismatch" });
    const body = buildNamingManagedRequest(value.request);
    body.agent!.service_tier = "priority";
    await expect(value.protocol.createSession(body, new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    expect(value.creates()).toBe(1);
    expect(value.cancellations()).toBe(0);
  });

  it.each([{ wrongTier: true }, { wrongVerbosity: true }, { missingPipeline: true }])("requires the acknowledged progressive Session profile: %j", async mismatch => {
    const value = fixture({ progressive: true, ...mismatch });
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "provider_configuration_mismatch" });
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(0);
  });

  it.each(["gpt-6.1-sol", "gpt-6-luna"])("retains a genuine tier rejection without retrying or changing %s, effort or tier", async model => {
    const value = fixture({ progressive: true, model, priorityRejected: true });
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "rejected_before_dispatch", code: "provider_request_rejected" });
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(0);
    expect(value.sent).toEqual([expect.objectContaining({ agent: expect.objectContaining({ model, reasoning: { effort: "xhigh" }, service_tier: model === "gpt-6-luna" ? "default" : "priority" }) })]);
  });

  it("preserves the historical native request and its exact hash", () => {
    const request = roleRequest(false), wire = buildNamingManagedRequest(request);
    expect(request.requestHash).toBe("c1107e37aaf3d6214f258f192f7b2bfef1b758e01b377f6e2702766844bbff9b");
    expect(request.policy).not.toHaveProperty("budgetControl");
    expect(wire.spend_control).toEqual({ limit: 90 });
    expect(wire.metadata).not.toHaveProperty("embel_budget_control");
  });

  it("removes local monetary comparisons while preserving research tool bounds", () => {
    const policy = createNamingBrainPolicy("gpt-6.1-sol");
    expect(createNamingRolePolicy(policy, "research", "researcher", 150, 4, true)).toMatchObject({ budgetControl: "local_unlimited_v1", sessionLimitCents: 150 });
    expect(() => createNamingRolePolicy(policy, "research", "researcher", 150, 4)).toThrow("role_allocation_exceeded");
    expect(() => createNamingRolePolicy(policy, "research", "researcher", 150, 5, true)).toThrow("role_allocation_exceeded");
  });

  it("completes and resumes the current cap-free session shape with a durable honest mode", async () => {
    const value = fixture(), result = await value.runtime.runStage(value.request, value.hooks);
    expect(value.order.slice(0, 2)).toEqual(["intent", "provider"]);
    expect(result).toMatchObject({ status: "completed", receipt: { budgetControl: "local_unlimited_v1", accountingStatus: "provisional", confirmedActualCostMicrousd: null, providerCostCounters: [] } });
    expect(value.sent[0]).not.toHaveProperty("spend_control");
    expect(value.sent[0]).toMatchObject({ agent: { model: "gpt-6.1-sol", reasoning: { effort: "xhigh" }, multi_agent: { enabled: false }, tools: [], text: { format: { type: "json_schema" } } },
      metadata: { embel_budget_control: "local_unlimited_v1", embel_request_hash: value.request.requestHash }, environment: { type: "none" }, stream: true });
    expect(value.receipts.every(receipt => receipt.budgetControl === "local_unlimited_v1")).toBe(true);
    if (result.status !== "completed") throw new Error("synthetic completion missing");
    expect(await value.runtime.resumeStage(result.receipt, value.hooks)).toMatchObject({ status: "completed" });
    expect(value.creates()).toBe(1);
  });

  it("requires trusted local authority in both runtime and SDK protocol", async () => {
    const value = fixture({ trustedLocal: false });
    expect(await value.runtime.runStage(value.request, value.hooks)).toEqual({ status: "rejected_before_dispatch", code: "request_invalid" });
    await expect(value.protocol.createSession(buildNamingManagedRequest(value.request), new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    expect(value.order).toEqual([]); expect(value.creates()).toBe(0);
  });

  it("sends the first Research role with only current documented inline fields", async () => {
    const brief = namingBriefSnapshotSchema.parse(snapshot());
    const request = createNamingRoleRequest({ runId: id(3), stageKey: "research", providerCallKey: "research-researcher", input: { role: "researcher", snapshot: brief }, dependencyArtifactIds: [],
      policy: createNamingRolePolicy(createNamingBrainPolicy("gpt-6.1-sol"), "research", "researcher", undefined, undefined, true) });
    let outgoing: Record<string, unknown> | undefined;
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: true, fetch: async (input, init) => {
      outgoing = await new Request(input, init).json();
      return new Response('data: {"type":"agent.session.idle","event_id":"synthetic_only"}\n\n', { headers: { "content-type": "text/event-stream" } });
    } });
    const stream = await protocol.createSession(buildNamingManagedRequest(request), new AbortController().signal);
    for await (const _event of stream.events) { expect(_event.type).toBe("agent.session.idle"); }
    stream.close();
    expect(Object.keys(outgoing!).sort()).toEqual(["agent", "environment", "input", "metadata", "stream"]);
    expect(outgoing).toMatchObject({ agent: { model: "gpt-6.1-sol", reasoning: { effort: "xhigh" }, multi_agent: { enabled: false }, text: { format: { type: "json_schema" } },
      tools: [{ type: "web_search", mode: "live", context_size: "low", allowed_domains: request.policy.referenceHosts }, { type: "function", name: "read_reference", parameters: { required: ["url"], additionalProperties: false } }] },
      metadata: { embel_budget_control: "local_unlimited_v1" } });
  });

  it.each([{ missingWitness: true }, { wrongReasoning: true }, { localRequest: false }])("retains strict session binding for %j", async options => {
    const value = fixture(options);
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "provider_configuration_mismatch" });
    expect(value.creates()).toBe(1);
  });

  it("does not apply legacy monetary counters to the expressly unlimited local mode", async () => {
    const value = fixture({ largeCounter: true });
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "completed", receipt: { budgetControl: "local_unlimited_v1", confirmedActualCostMicrousd: null,
      providerCostCounters: [expect.objectContaining({ value: 10_000 })] } });
    expect(value.cancellations()).toBe(0);
  });

  it("rejects a receipt that silently changes a saved local mode to native", async () => {
    const value = fixture(), result = await value.runtime.runStage(value.request, value.hooks);
    if (result.status !== "completed") throw new Error("synthetic completion missing");
    const nativeReceipt = { ...result.receipt }; delete nativeReceipt.budgetControl;
    expect(await value.runtime.resumeStage(nativeReceipt, value.hooks)).toMatchObject({ status: "unresolved", code: "receipt_mismatch" });
    expect(value.creates()).toBe(1);
  });

  it("still cancels an expired local stage without inventing final accounting", async () => {
    const value = fixture({ hanging: true, remainingMs: 50 });
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "observation_cancelled", receipt: { budgetControl: "local_unlimited_v1", confirmedActualCostMicrousd: null } });
    expect(value.cancellations()).toBe(1); expect(value.creates()).toBe(1);
  });

  it.each(["creation", "gap"] as const)("gives a late %s call its full durable authorization allowance without resetting on recovery", async stageKey => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T04:00:00Z"));
    const value = fixture({ stageKey, stageAgeMs: 600_000, hanging: true, clock: Date.now });
    let settled = false;
    const pending = value.runtime.runStage(value.request, value.hooks).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(value.creates()).toBe(1);
    const authorizedAt = value.state.authorizedAt;
    expect(authorizedAt).toBe(new Date().toISOString());
    await vi.advanceTimersByTimeAsync(239_999);
    expect(settled).toBe(false); expect(value.cancellations()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ status: "unresolved", code: "observation_cancelled" });
    expect(value.cancellations()).toBe(1);
    if (result.status !== "unresolved" || !result.receipt) throw new Error("Synthetic timed call receipt missing");
    expect(await value.runtime.resumeStage(result.receipt, value.hooks)).toMatchObject({ status: "unresolved" });
    expect(value.state.authorizedAt).toBe(authorizedAt);
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(1);
  });

  it("requires the explicit future-local deadline argument while preserving historical and native policies", () => {
    const policy = createNamingBrainPolicy("gpt-6.1-sol");
    expect(createNamingRolePolicy(policy, "creation", "creator", 90, undefined, true).deadlineMs).toBe(240_000);
    expect(createNamingRolePolicy(policy, "creation", "creator", 90, undefined, true, 900_000).deadlineMs).toBe(900_000);
    expect(() => createNamingRolePolicy(policy, "creation", "creator", 90, undefined, false, 900_000)).toThrow("role_timing_unavailable");
    expect(namingRolePolicySchema.safeParse({ ...roleRequest(false).policy, deadlineMs: 900_000 }).success).toBe(false);
    expect(roleRequest(false).requestHash).toBe("c1107e37aaf3d6214f258f192f7b2bfef1b758e01b377f6e2702766844bbff9b");
  });

  it("completes an actual-SDK local Creator response after four minutes under its immutable fifteen-minute clock", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T04:00:00Z"));
    const value = fixture({ deadlineMs: 900_000, stageAgeMs: 600_000, completionDelayMs: 330_000, clock: Date.now });
    let settled = false;
    const pending = value.runtime.runStage(value.request, value.hooks).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(0); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(await pending).toMatchObject({ status: "completed", receipt: { budgetControl: "local_unlimited_v1" } });
    expect(value.request.policy.deadlineMs).toBe(900_000); expect(value.cancellations()).toBe(0);
  });

  it.each(["direction", "creation", "gap"] as const)("still bounds a future-local %s call to fifteen minutes without resetting its saved authorization", async stageKey => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T04:00:00Z"));
    const value = fixture({ stageKey, deadlineMs: 900_000, hanging: true, clock: Date.now });
    let settled = false;
    const pending = value.runtime.runStage(value.request, value.hooks).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    const authorizedAt = value.state.authorizedAt;
    await vi.advanceTimersByTimeAsync(899_999);
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(0); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ status: "unresolved", code: "observation_cancelled" });
    if (result.status !== "unresolved" || !result.receipt) throw new Error("Synthetic timed receipt missing");
    expect(await value.runtime.resumeStage(result.receipt, value.hooks)).toMatchObject({ status: "unresolved" });
    expect(value.state.authorizedAt).toBe(authorizedAt); expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(1);
  });

  it("clamps a future-local single-role call to its absolute twenty-minute stage envelope after recovery", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T04:00:00Z"));
    const value = fixture({ stageKey: "direction", deadlineMs: 900_000, stageAgeMs: 1_199_000, hanging: true, clock: Date.now });
    let settled = false;
    const pending = value.runtime.runStage(value.request, value.hooks).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(999); expect(settled).toBe(false); expect(value.cancellations()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ status: "unresolved", code: "observation_cancelled" });
    if (result.status !== "unresolved" || !result.receipt) throw new Error("Synthetic stage receipt missing");
    expect(await value.runtime.resumeStage(result.receipt, value.hooks)).toMatchObject({ status: "unresolved" });
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(1);
  });

  it("preserves the actual-SDK native four-minute cutoff", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T04:00:00Z"));
    const value = fixture({ localRequest: false, nativeSessionCap: true, hanging: true, clock: Date.now });
    let settled = false;
    const pending = value.runtime.runStage(value.request, value.hooks).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(239_999);
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(0); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: "unresolved", code: "observation_cancelled" });
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(1);
  });

  it("honors explicit cancellation during a late local allocation", async () => {
    const value = fixture({ stageAgeMs: 600_000, hanging: true });
    const initialReceipt = value.hooks.onReceipt;
    value.hooks.onReceipt = async receipt => { await initialReceipt(receipt); if (receipt.turnId) value.abort.abort(); };
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "unresolved", code: "observation_cancelled" });
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(1);
  });

  it.each(["creation", "gap"] as const)("keeps the absolute %s stage envelope when a late call is reclaimed", async stageKey => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T04:00:00Z"));
    const value = fixture({ stageKey, stageAgeMs: 3_599_000, hanging: true, clock: Date.now });
    let settled = false;
    const pending = value.runtime.runStage(value.request, value.hooks).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(value.creates()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false); expect(value.cancellations()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ status: "unresolved", code: "observation_cancelled" });
    if (result.status !== "unresolved" || !result.receipt) throw new Error("Synthetic stage-bound receipt missing");
    expect(await value.runtime.resumeStage(result.receipt, value.hooks)).toMatchObject({ status: "unresolved" });
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(1);
  });

  it.each([{ missingAuthorization: true }, { mismatchedAuthorization: true }])("never creates against missing or mismatched durable authorization: %j", async options => {
    const value = fixture(options);
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "rejected_before_dispatch", code: "local_dispatch_not_attempted", receipt: { dispatchState: "not_dispatched", sessionId: null, requestId: null } });
    expect(value.receipts).toEqual([expect.objectContaining({ budgetControl: "local_unlimited_v1", dispatchState: "not_dispatched", sessionId: null, requestId: null })]);
    expect(value.creates()).toBe(0); expect(value.cancellations()).toBe(0);
  });

  it("retains no-dispatch proof when the committed authorization clock read throws", async () => {
    const value = fixture();
    vi.spyOn(value.persistence, "load").mockResolvedValueOnce(value.state).mockRejectedValueOnce(new Error("Synthetic database acquire timeout"));
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "rejected_before_dispatch", code: "local_dispatch_not_attempted", receipt: { dispatchState: "not_dispatched", sessionId: null, requestId: null } });
    expect(value.state.request).toEqual(value.request);
    expect(value.receipts).toEqual([expect.objectContaining({ dispatchState: "not_dispatched", requestId: null, sessionId: null, turnId: null, agentId: null, usageObservations: [], providerCostCounters: [] })]);
    expect(value.creates()).toBe(0); expect(value.cancellations()).toBe(0);
  });

  it.each(["before_commit", "after_commit"] as const)("never invokes create after a base receipt %s failure", async failure => {
    const value = fixture(), retain = value.hooks.onReceipt;
    let first = true;
    value.hooks.onReceipt = async receipt => {
      if (!first) return retain(receipt);
      first = false;
      if (failure === "after_commit") await retain(receipt);
      throw new Error("Synthetic lost receipt acknowledgement");
    };
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "rejected_before_dispatch", code: "local_dispatch_not_attempted", receipt: { dispatchState: "not_dispatched", sessionId: null, requestId: null } });
    expect(value.receipts.length).toBe(failure === "after_commit" ? 2 : 1);
    expect(value.receipts.every(receipt => receipt.dispatchState === "not_dispatched" && receipt.sessionId === null && receipt.requestId === null)).toBe(true);
    expect(value.creates()).toBe(0); expect(value.cancellations()).toBe(0);
  });

  it.each(["authorization", "base_receipt"] as const)("acknowledges cancellation during %s before invoking create", async phase => {
    const value = fixture();
    if (phase === "authorization") {
      const authorize = value.hooks.beforeDispatch;
      value.hooks.beforeDispatch = async () => { await authorize(); value.abort.abort(); };
    } else {
      const retain = value.hooks.onReceipt;
      value.hooks.onReceipt = async receipt => { await retain(receipt); value.abort.abort(); };
    }
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "rejected_before_dispatch", code: "local_dispatch_not_attempted", receipt: { dispatchState: "not_dispatched", sessionId: null, requestId: null } });
    expect(value.receipts.length).toBeGreaterThan(0);
    expect(value.receipts.every(receipt => receipt.dispatchState === "not_dispatched" && receipt.sessionId === null)).toBe(true);
    expect(value.creates()).toBe(0); expect(value.cancellations()).toBe(0);
  });

  it("rechecks the durable deadline after the base receipt acknowledgement", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T04:00:00Z"));
    const value = fixture({ stageAgeMs: 600_000, clock: Date.now }), retain = value.hooks.onReceipt;
    let first = true;
    value.hooks.onReceipt = async receipt => {
      await retain(receipt);
      if (first) { first = false; await vi.advanceTimersByTimeAsync(value.request.policy.deadlineMs); }
    };
    expect(await value.runtime.runStage(value.request, value.hooks)).toMatchObject({ status: "rejected_before_dispatch", code: "local_dispatch_not_attempted", receipt: { dispatchState: "not_dispatched" } });
    expect(value.creates()).toBe(0); expect(value.cancellations()).toBe(0);
  });

  it("does not return a durable proof when no receipt persistence is acknowledged", async () => {
    const value = fixture();
    value.hooks.onReceipt = async () => { throw new Error("Synthetic unavailable receipt storage"); };
    expect(await value.runtime.runStage(value.request, value.hooks)).toEqual({ status: "rejected_before_dispatch", code: "local_dispatch_not_attempted" });
    expect(value.creates()).toBe(0); expect(value.receipts).toEqual([]);
  });

  it("keeps an invoked create with a lost acknowledgement unknown and never retries it", async () => {
    const value = fixture({ createAckLost: true });
    const result = await value.runtime.runStage(value.request, value.hooks);
    expect(result).toMatchObject({ status: "unresolved", code: "outcome_unknown", receipt: { dispatchState: "unknown", sessionId: null } });
    expect(value.receipts.map(receipt => receipt.dispatchState)).toEqual(["not_dispatched", "unknown"]);
    if (result.status !== "unresolved" || !result.receipt) throw new Error("Synthetic unknown receipt missing");
    expect(await value.runtime.resumeStage(result.receipt, value.hooks)).toMatchObject({ status: "unresolved", code: "session_identity_unknown" });
    expect(value.creates()).toBe(1); expect(value.cancellations()).toBe(0);
  });

  it("preserves native pre-dispatch receipt failure classification", async () => {
    const value = fixture({ localRequest: false });
    value.hooks.onReceipt = async () => { throw new Error("Synthetic receipt failure"); };
    expect(await value.runtime.runStage(value.request, value.hooks)).toEqual({ status: "rejected_before_dispatch", code: "dispatch_not_authorized" });
    expect(value.creates()).toBe(0); expect(value.receipts).toEqual([]);
  });

  it("retains the expired whole-stage clock for an ordinary native request", async () => {
    const value = fixture({ localRequest: false, stageAgeMs: 600_000 });
    expect(await value.runtime.runStage(value.request, value.hooks)).toEqual({ status: "rejected_before_dispatch", code: "cancelled_before_dispatch" });
    expect(value.creates()).toBe(0); expect(value.order).toEqual([]);
  });
});


describe("budgeted progressive provider acknowledgement", () => {
 it("requires the returned cap, retains it on receipts and recovers without another create", async () => {
  const f = fixture({ progressive: true, capped: true });
  const result = await f.runtime.runStage(f.request, f.hooks);
  expect(result).toMatchObject({ status: "completed", receipt: { providerSpendCapCents: 10, confirmedActualCostMicrousd: null } });
  expect(f.sent[0]).toMatchObject({ spend_control: { limit: 10 } });
  if (result.status !== "completed") throw new Error("Missing synthetic completion");
  expect(await f.runtime.resumeStage(result.receipt, f.hooks)).toMatchObject({ status: "completed" });
  expect(f.creates()).toBe(1);
  expect(await f.runtime.resumeStage({ ...result.receipt, providerSpendCapCents: undefined }, f.hooks)).toMatchObject({ status: "unresolved", code: "receipt_mismatch" });
 });
 it.each([null, 9, 11])("refuses an absent or changed provider limit (%s)", async returnedCap => {
  const f = fixture({ progressive: true, capped: true, returnedCap });
  expect(await f.runtime.runStage(f.request, f.hooks)).toMatchObject({ status: "unresolved", code: "provider_configuration_mismatch", receipt: { sessionId: "sess_local_fixture" } });
  expect(f.creates()).toBe(1); expect(f.cancellations()).toBe(1);
 });
 it("quarantines an observed overrun instead of publishing or claiming final charges", async () => {
  const f = fixture({ progressive: true, capped: true, consumed: 11 });
  expect(await f.runtime.runStage(f.request, f.hooks)).toMatchObject({ status: "unresolved", code: "provider_cost_exceeded", receipt: { providerSpendCapCents: 10, confirmedActualCostMicrousd: null } });
  expect(f.creates()).toBe(1);
 });
});
