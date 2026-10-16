import "server-only";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AgentSession, AgentSessionEvent, AgentSessionItem, TokenUsage } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns/turns";
import { namingEvidenceSourceSchema, namingProviderReceiptSchema, namingStageOutcomeSchema, namingStageRequestSchema, type NamingAgentRuntime, type NamingEvidenceSource, type NamingProviderReceipt, type NamingRoleOutput, type NamingStageHooks, type NamingStageOutcome, type NamingStageRequest } from "../../../domain/naming-brain";
import { buildNamingManagedRequest, namingRequestHash } from "./prompts";
import { extractManagedFinalOutput, readManagedTurnHistory } from "./history";
import { namingHash } from "./identity";
import { createNamingManagedProtocol, NamingManagedProtocolError, type ManagedEventStream, type ManagedToolResult, type NamingManagedProtocol } from "./protocol";
import { createNamingReferenceReader, NAMING_REFERENCE_HOSTS, type ReferenceObservation } from "./source-reader";
import { validateNamingRoleOutput } from "./outputs";

export type NamingProviderItemRecord = { providerCallKey: string; sessionId: string; turnId: string; itemId: string; item: AgentSessionItem };
export type NamingToolResultRecord = { providerCallKey: string; sessionId: string; turnId: string; callId: string; requestHash: string; result: { argumentsHash: string; reply: ManagedToolResult }; sourceEvidence: NamingEvidenceSource | null };
export type NamingRuntimeState = { startedAt: string; request: NamingStageRequest | null; dependencies: NamingRoleOutput[]; providerItems: NamingProviderItemRecord[]; toolResults: NamingToolResultRecord[] };
export type NamingRuntimePersistence = { load(identity: Pick<NamingStageRequest, "runId" | "stageKey" | "providerCallKey" | "requestHash">): Promise<NamingRuntimeState>; saveToolResult(record: NamingToolResultRecord): Promise<void> };
type Options = { model: string; apiKey?: string; protocol?: NamingManagedProtocol; persistence: NamingRuntimePersistence; now?: () => number; referenceReader?: ReturnType<typeof createNamingReferenceReader> };
type ManagedReceipt = Extract<NamingProviderReceipt, { protocol: "openai_agents" }>;
function managedReceipt(value: unknown): ManagedReceipt { const receipt = namingProviderReceiptSchema.parse(value); if (receipt.protocol !== "openai_agents") throw new Error("protocol_mismatch"); return receipt; }
const usageShape = z.object({ input_tokens: z.number().int().nonnegative().safe(), output_tokens: z.number().int().nonnegative().safe(), total_tokens: z.number().int().nonnegative().safe() });
const safeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 300;
const reason = (error: unknown) => error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/u.test(error.message) ? error.message : "provider_outcome_unknown";
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("observation_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function baseReceipt(request: NamingStageRequest, now: () => number): ManagedReceipt {
  return managedReceipt({ version: 1, provider: "openai", protocol: "openai_agents", billingMode: "openai_api", runId: request.runId, stageKey: request.stageKey, role: request.role, snapshotHash: request.snapshotHash,
    requestKey: request.requestKey, providerCallKey: request.providerCallKey, assignmentKey: request.assignmentKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents,
    dispatchState: "not_dispatched", requestId: null, sessionId: null, turnId: null, agentId: null, responseId: null, callIds: [], observedModel: null, toolCalls: [], artifactItemIds: [], usageObservations: [], providerCostCounters: [], estimatedCostMicrousd: null, accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: new Date(now()).toISOString() });
}

export function createNamingAgentRuntime(options: Options): NamingAgentRuntime {
  if (!options.protocol && !options.apiKey) throw new Error("naming_runtime_unavailable");
  const protocol = options.protocol ?? createNamingManagedProtocol({ apiKey: options.apiKey! });
  const now = options.now ?? Date.now;
  const cancel = async (receipt: NamingProviderReceipt) => {
    if (receipt.protocol !== "openai_agents" || !receipt.sessionId) throw new Error("session_identity_unknown");
    await protocol.cancelSession(receipt.sessionId, AbortSignal.timeout(5_000));
  };
  async function execute(rawRequest: NamingStageRequest, hooks: NamingStageHooks, prior: NamingProviderReceipt | null): Promise<NamingStageOutcome> {
    let request: NamingStageRequest;
    try { request = namingStageRequestSchema.parse(rawRequest); buildNamingManagedRequest(request); if (request.policy.model !== options.model || namingRequestHash(request) !== request.requestHash || request.policy.referenceHosts.some(host => !NAMING_REFERENCE_HOSTS.some(allowed => allowed === host))) throw new Error("runtime_policy_mismatch"); }
    catch { return { status: "rejected_before_dispatch", code: "request_invalid" }; }
    let receipt = prior ? managedReceipt(prior) : baseReceipt(request, now);
    if (prior && (prior.requestHash !== request.requestHash || prior.providerCallKey !== request.providerCallKey || prior.runId !== request.runId || prior.stageKey !== request.stageKey || prior.requestKey !== request.requestKey || prior.protocol !== "openai_agents")) return { status: "unresolved", code: "receipt_mismatch", receipt, partialArtifacts: [] };
    if (prior && !receipt.sessionId) return { status: "unresolved", code: "session_identity_unknown", receipt, partialArtifacts: [] };
    const state = await options.persistence.load(request);
    if (state.request && !isDeepStrictEqual(namingStageRequestSchema.parse(state.request), request)) return { status: "unresolved", code: "saved_request_mismatch", receipt, partialArtifacts: [] };
    if (!prior && state.request) return { status: "unresolved", code: "dispatch_already_authorized", receipt: { ...receipt, dispatchState: "unknown" }, partialArtifacts: [] };
    const deadlineAt = Date.parse(state.startedAt) + request.policy.deadlineMs;
    if (!Number.isFinite(deadlineAt)) return { status: "rejected_before_dispatch", code: "stage_deadline_missing" };
    const expiredOnEntry = now() >= deadlineAt;
    if (!prior && (hooks.signal.aborted || expiredOnEntry)) return { status: "rejected_before_dispatch", code: "cancelled_before_dispatch" };
    const controller = new AbortController(), readonlyRecovery = !!prior && (expiredOnEntry || hooks.signal.aborted);
    const abort = () => controller.abort();
    if (!readonlyRecovery) hooks.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, readonlyRecovery ? 5_000 : Math.max(1, deadlineAt - now())); timer.unref();
    let stream: ManagedEventStream | undefined, dispatched = !!prior, session: AgentSession | null = null, turn: Turn | null = null;
    const items = new Map<string, AgentSessionItem>(), toolResults = new Map(state.toolResults.filter(row => row.providerCallKey === request.providerCallKey).map(row => [row.callId, row]));
    const newSources = () => [...toolResults.values()].flatMap(row => row.sourceEvidence ? [row.sourceEvidence] : []);
    const partials = () => [...items.values()].filter(item => item.type !== "reasoning").slice(-3).map(item => ({ providerItemId: item.id, type: item.type, content: JSON.stringify(item).slice(0, 100_000) }));
    const emit = async () => { receipt = managedReceipt({ ...receipt, recordedAt: new Date(now()).toISOString() }); await hooks.onReceipt(receipt); };
    const usage = (value: TokenUsage | null, scope: "session" | "turn", scopeId: string) => {
      const parsed = usageShape.safeParse(value); if (!parsed.success) return;
      const entry = { scope, scopeId, inputTokens: parsed.data.input_tokens, outputTokens: parsed.data.output_tokens, totalTokens: parsed.data.total_tokens, observedAt: new Date(now()).toISOString() };
      if (!receipt.usageObservations.some(old => old.scope === scope && old.scopeId === scopeId && old.inputTokens === entry.inputTokens && old.outputTokens === entry.outputTokens && old.totalTokens === entry.totalTokens)) receipt = { ...receipt, usageObservations: [...receipt.usageObservations, entry] };
    };
    const acceptSession = async (value: AgentSession) => {
      if (!safeId(value?.id) || receipt.sessionId && value.id !== receipt.sessionId || !safeId(value.agent?.id) || value.agent.model !== request.policy.model || value.environment?.type !== "none" || value.agent.multi_agent?.enabled !== false || value.spend_control?.limit !== request.policy.sessionLimitCents || value.metadata?.embel_request_hash !== request.requestHash || value.metadata?.embel_call !== request.providerCallKey || value.metadata?.embel_run !== request.runId) throw new Error("provider_configuration_mismatch");
      const expected = request.policy.allowedTools;
      if (!Array.isArray(value.agent.tools) || value.agent.tools.length !== expected.length || value.agent.tools.some(tool => tool.type === "web_search" ? !expected.includes("web_search") : tool.type !== "function" || tool.name !== "read_reference" || !expected.includes("read_reference"))) throw new Error("provider_tools_mismatch");
      session = value; receipt = { ...receipt, sessionId: value.id, agentId: value.agent.id, observedModel: value.agent.model, dispatchState: "dispatched" };
      usage(value.usage, "session", value.id);
      const consumed = value.spend_control.consumed;
      if (typeof consumed === "number" && Number.isSafeInteger(consumed) && consumed >= 0 && !receipt.providerCostCounters.some(counter => counter.scopeId === value.id && counter.value === consumed)) receipt = { ...receipt, providerCostCounters: [...receipt.providerCostCounters, { scope: "session", scopeId: value.id, kind: "consumed_usd_cents", value: consumed, observedAt: new Date(now()).toISOString() }] };
      await emit();
      if (typeof consumed === "number" && consumed > request.policy.sessionLimitCents) throw new Error("provider_cost_exceeded");
    };
    const acceptTurn = async (value: Turn) => {
      if (!safeId(value?.id) || value.session_id !== receipt.sessionId || receipt.turnId && value.id !== receipt.turnId || value.subagent_id !== null || value.agent_id !== receipt.agentId) throw new Error("provider_turn_mismatch");
      turn = value; receipt = { ...receipt, turnId: value.id }; usage(value.usage, "turn", value.id); await emit();
    };
    const acceptItem = async (item: AgentSessionItem, completed: boolean) => {
      if (item.type === "message" && item.role === "user") return;
      if (!safeId(item.id) || item.turn_id !== receipt.turnId) throw new Error("provider_item_mismatch");
      if (!["message", "reasoning", "web_search_call", "function_call", "function_call_output"].includes(item.type)) throw new Error("provider_tool_refused");
      if (item.type === "reasoning") return;
      const previous = items.get(item.id);
      if (previous && "status" in previous && previous.status === "completed" && !isDeepStrictEqual(previous, item)) throw new Error("provider_item_changed");
      if (item.type === "web_search_call" || item.type === "function_call") {
        if (item.type === "web_search_call" && !request.policy.allowedTools.includes("web_search") || item.type === "function_call" && (item.name !== "read_reference" || !request.policy.allowedTools.includes("read_reference"))) throw new Error("provider_tool_refused");
        const callId = item.type === "function_call" ? item.call_id : item.id;
        const status = item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : item.status === "in_progress" ? "started" : "unknown";
        receipt = { ...receipt, callIds: [...new Set([...receipt.callIds, callId])], toolCalls: [...receipt.toolCalls.filter(call => call.callId !== callId), { callId, providerItemId: item.id, type: item.type === "web_search_call" ? "web_search" : "function", status }] };
        await emit();
        if (receipt.toolCalls.filter(call => call.type === "web_search").length > request.policy.maxWebSearchCalls || receipt.toolCalls.filter(call => call.type === "function").length > request.policy.maxWebSearchCalls) throw new Error("provider_tool_limit");
      }
      items.set(item.id, item);
      if (items.size > 200 || Buffer.byteLength(JSON.stringify([...items.values()])) > 1_048_576) throw new Error("provider_item_limit");
      if (completed && (!previous || !isDeepStrictEqual(previous, item) || !receipt.artifactItemIds.includes(item.id))) {
        await hooks.onArtifact({ providerCallKey: request.providerCallKey, sessionId: receipt.sessionId!, turnId: receipt.turnId!, itemId: item.id, item } satisfies NamingProviderItemRecord);
        receipt = { ...receipt, artifactItemIds: [...new Set([...receipt.artifactItemIds, item.id])] }; await emit();
      }
    };
    const reconcile = async () => {
      if (!receipt.sessionId) throw new Error("session_identity_unknown");
      const history = await readManagedTurnHistory(protocol, receipt.sessionId, receipt.turnId, controller.signal);
      await acceptSession(history.session); if (history.turn) await acceptTurn(history.turn);
      for (const item of history.items) await acceptItem(item, !("status" in item) || item.status === "completed" || item.status === "failed");
    };
    const finish = (): NamingStageOutcome | null => {
      if (!turn || !session) return null;
      const terminal = turn as Turn;
      if (terminal.status === "failed" || terminal.status === "cancelled") return namingStageOutcomeSchema.parse({ status: terminal.status, code: terminal.status === "failed" ? "provider_turn_failed" : "provider_turn_cancelled", receipt, partialArtifacts: partials() });
      if (terminal.status !== "completed") return null;
      try {
        const final = extractManagedFinalOutput({ session, turn: terminal, items: [...items.values()] }, request.policy.maxOutputBytes);
        const output = validateNamingRoleOutput({ request, receipt, final, dependencies: state.dependencies, sources: newSources() });
        return namingStageOutcomeSchema.parse({ status: "completed", receipt, output });
      } catch { return namingStageOutcomeSchema.parse({ status: "failed", code: "provider_output_invalid", receipt, partialArtifacts: partials() }); }
    };
    const answerRequired = async () => {
      if (!receipt.sessionId || readonlyRecovery || now() >= deadlineAt || controller.signal.aborted) throw new Error("stage_deadline_exceeded");
      await reconcile();
      for (const action of (session as AgentSession | null)?.required_actions ?? []) {
        if (action.type !== "function_call" || action.name !== "read_reference" || action.turn_id !== receipt.turnId || !request.policy.allowedTools.includes("read_reference")) throw new Error("provider_tool_refused");
        const argumentsHash = namingHash(action.arguments), saved = toolResults.get(action.call_id);
        let record: NamingToolResultRecord;
        if (saved) {
          if (saved.sessionId !== receipt.sessionId || saved.turnId !== receipt.turnId || saved.requestHash !== request.requestHash || saved.result.argumentsHash !== argumentsHash) throw new Error("tool_result_mismatch");
          record = saved;
        } else {
          if (toolResults.size >= request.policy.maxWebSearchCalls) throw new Error("reference_limit_exceeded");
          const args = z.strictObject({ url: z.string().min(1).max(2000) }).parse(typeof action.arguments === "string" ? JSON.parse(action.arguments) : action.arguments);
          const canonical = (value: string) => { try { const u = new URL(value); u.hash = ""; return u.href; } catch { return null; } };
          const observed = [...items.values()].find(item => item.type === "web_search_call" && item.status === "completed" && (item.action?.type === "open_page" || item.action?.type === "find_in_page") && typeof item.action.url === "string" && canonical(item.action.url) === canonical(args.url));
          const sourceKey = `ref_${namingHash([receipt.sessionId, receipt.turnId, action.call_id]).slice(0, 24)}`;
          let sourceEvidence: NamingEvidenceSource | null = null, output: unknown = { sourceKey, status: "unavailable", code: "source_unobserved" };
          if (observed?.type === "web_search_call" && (observed.action?.type === "open_page" || observed.action?.type === "find_in_page") && observed.action.url) {
            const observation: ReferenceObservation = { sessionId: receipt.sessionId, turnId: receipt.turnId!, itemId: observed.id, url: observed.action.url, action: observed.action.type, status: "completed" };
            const result = await (options.referenceReader ?? createNamingReferenceReader({ allowedHosts: request.policy.referenceHosts })).read({ requestedUrl: args.url, observation, signal: controller.signal });
            const retrievedAt = result.status === "retrieved" ? result.retrievedAt : new Date(now()).toISOString();
            sourceEvidence = namingEvidenceSourceSchema.parse({ sourceKey, url: observation.url, title: result.status === "retrieved" ? result.title : new URL(observation.url).hostname, retrievedAt, providerItemId: observed.id,
              provenance: { protocol: "openai_agents", sessionId: receipt.sessionId, turnId: receipt.turnId, responseId: null, itemId: observed.id, observedUrl: observation.url }, evidenceStatus: result.status === "retrieved" ? "retrieved" : "unretrieved",
              excerpt: result.status === "retrieved" ? result.excerpt : null, contentHash: result.status === "retrieved" ? result.contentHash : null, retrieval: result.status === "retrieved" ? { retrievedAt, responseHash: result.responseHash, extractorVersion: result.extractorVersion, truncated: result.truncated } : null });
            output = result.status === "retrieved" ? { sourceKey, status: "retrieved", url: observation.url, title: result.title, excerpt: result.excerpt, truncated: result.truncated } : { sourceKey, status: "unavailable", code: result.code };
          }
          if (Buffer.byteLength(JSON.stringify([...newSources(), ...(sourceEvidence ? [sourceEvidence] : [])])) > 262_144) throw new Error("source_evidence_limit");
          record = { providerCallKey: request.providerCallKey, sessionId: receipt.sessionId, turnId: receipt.turnId!, callId: action.call_id, requestHash: request.requestHash,
            result: { argumentsHash, reply: { type: "agent.session.input.tool_result", turn_id: receipt.turnId!, call_id: action.call_id, success: true, output: JSON.stringify(output) } }, sourceEvidence };
          await options.persistence.saveToolResult(record); toolResults.set(action.call_id, record);
        }
        if (controller.signal.aborted || now() >= deadlineAt) throw new Error("stage_deadline_exceeded");
        await protocol.submitToolResult(receipt.sessionId, record.result.reply, `tool-${namingHash([request.requestKey, action.call_id]).slice(0, 48)}`, controller.signal);
      }
    };
    try {
      if (!prior) {
        await hooks.beforeDispatch();
        if (controller.signal.aborted) return { status: "rejected_before_dispatch", code: "cancelled_before_dispatch" };
        await emit(); dispatched = true;
        stream = await protocol.createSession(buildNamingManagedRequest(request), controller.signal);
        receipt = { ...receipt, requestId: stream.requestId, dispatchState: "dispatched" }; await emit();
      } else stream = await protocol.streamSession(receipt.sessionId!, controller.signal);
      const iterator = stream.events[Symbol.asyncIterator]();
      let pending = iterator.next(); void pending.catch(() => {});
      if (prior) { await reconcile(); const result = finish(); if (result) return result; if (readonlyRecovery) throw new Error("stage_deadline_exceeded"); if ((session as AgentSession | null)?.status === "requires_action") await answerRequired(); }
      for (let eventCount = 0; eventCount < 2_000; eventCount++) {
        const next = await abortable(pending, controller.signal);
        if (next.done) { await reconcile(); return finish() ?? { status: "unresolved", code: "stream_ended_before_turn", receipt, partialArtifacts: partials() }; }
        pending = iterator.next(); void pending.catch(() => {});
        const event: AgentSessionEvent = next.value;
        if ("session" in event) await acceptSession(event.session);
        if ("session_id" in event && event.session_id !== receipt.sessionId) throw new Error("provider_session_mismatch");
        if ("turn" in event) { if (!session && receipt.sessionId) await acceptSession(await protocol.retrieveSession(receipt.sessionId, controller.signal)); await acceptTurn(event.turn); }
        if (event.type === "agent.session.turn.item.added" || event.type === "agent.session.turn.item.done") await acceptItem(event.item, event.type.endsWith(".done"));
        if (event.type === "agent.session.requires_action") await answerRequired();
        if (event.type === "agent.session.failed" || event.type === "error" || event.type.startsWith("agent.session.subagent.")) throw new Error("provider_session_failed");
        if (event.type === "agent.session.idle") { await reconcile(); }
        const result = finish(); if (result) return result;
      }
      throw new Error("provider_event_limit");
    } catch (error) {
      if (!dispatched) return { status: "rejected_before_dispatch", code: "dispatch_not_authorized" };
      if (error instanceof NamingManagedProtocolError && error.code === "request_rejected" && receipt.sessionId === null) { receipt = { ...receipt, dispatchState: "not_dispatched", requestId: error.requestId }; try { await emit(); } catch {} return { status: "rejected_before_dispatch", code: "provider_request_rejected" }; }
      if (receipt.sessionId) { try { await cancel(receipt); } catch {} }
      receipt = managedReceipt({ ...receipt, dispatchState: "unknown", recordedAt: new Date(now()).toISOString() });
      try { await hooks.onReceipt(receipt); } catch {}
      return namingStageOutcomeSchema.parse({ status: "unresolved", code: controller.signal.aborted ? "observation_cancelled" : reason(error), receipt, partialArtifacts: partials() });
    } finally { clearTimeout(timer); hooks.signal.removeEventListener("abort", abort); stream?.close(); controller.abort(); }
  }
  return { runStage: (request, hooks) => execute(request, hooks, null), async resumeStage(receipt, hooks) {
    if (receipt.protocol !== "openai_agents" || !receipt.sessionId) return { status: "unresolved", code: "session_identity_unknown", receipt, partialArtifacts: [] };
    const state = await options.persistence.load(receipt);
    if (!state.request) return { status: "unresolved", code: "saved_request_missing", receipt, partialArtifacts: [] };
    return execute(state.request, hooks, receipt);
  }, cancelStage: cancel };
}
