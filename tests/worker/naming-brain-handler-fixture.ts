import { namingBrainJobInputSchema, namingRoleOutputSchema, namingStageKeySchema, namingProviderReceiptSchema, type NamingAgentRuntime, type NamingStageRequest, type NamingModelOutput, type NamingEvidenceSource, type NamingStageOutcome } from "../../src/domain/naming-brain";
import { createNamingBrainPolicy, NAMING_GAP_ENVELOPE } from "../../src/server/ai/naming-brain/policy";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { validateNamingRoleOutput } from "../../src/server/ai/naming-brain/outputs";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { parseClaimedJob } from "../../worker/postgres-store";
import { NamingBrainJobStore, type NamingSavedStage } from "../../worker/naming-brain-store";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { id, snapshot, source, research, assignment, proposal, receipt } from "../domain/naming-brain-fixtures";

/** Synthetic provider outputs, but real request rendering/hashing, output validation and scoped-store codec. */
export function createInertNamingHarness(options: { initialCount?: number; failGap?: boolean; lostCreator?: boolean; invalidGap?: { role: "director" | "verifier"; kind: "json" | "schema"; recover?: boolean }; lateCreatorOverrun?: boolean; unknownGap?: boolean; inflightGap?: boolean; lateGapOverrun?: boolean } = {}) {
  const brief = snapshot(); brief.preferences.approaches = ["real_words", "invented"];
  const input = namingBrainJobInputSchema.parse({ version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api", runId: id(3), jobId: id(4), batchId: id(5), snapshot: brief, acceptedPolicyIdentity: "a".repeat(64), policy: createNamingBrainPolicy("fixture-selected-model") });
  const jobRow = { id: id(4), owner_id: id(1), project_id: id(2), operation: "naming.generate", input, input_revision: 1, lease_token: id(9), state: "running", reserved_cost_microusd: 5_000_000, actual_cost_microusd: 0, billing_mode: "openai_api" };
  const stages = new Map(namingStageKeySchema.options.map(stageKey => [stageKey, { stageKey, state: "pending", requestKey: null, startedAt: null, maximumCostMicrousd: input.policy.stageLimits[stageKey].maximumCostMicrousd, recoveryMode: "execute", observationDeadlineAt: null, stageResults: [], artifacts: [], receipts: [], requests: [], providerItems: [], providerTurns: [], toolResults: [], callPlans: [], gapEnvelope: JSON.parse(JSON.stringify(NAMING_GAP_ENVELOPE)), gapPlanIdentity: "b".repeat(64) } as NamingSavedStage]));
  const stageResults = new Map<string, { artifactIds: string[]; errorCode?: string; partialArtifacts?: unknown[] }>();
  const log: { name: string; action?: string; payload?: unknown }[] = [], dispatched: NamingStageRequest[] = [], observed: string[] = [];
  let prepared: Record<string, unknown> | null = null, finished: unknown = null, claimed = false, mode: "execute" | "observe_only" = "execute", ready = true;
  const store = new NamingBrainJobStore({ query: async (sql, args = []) => {
    const name = sql.match(/public\.(\w+)\(/u)![1]!, action = name === "naming_brain_worker_action" ? String(args[2]) : undefined, payload = action ? JSON.parse(String(args[3])) : undefined;
    log.push({ name, action, payload }); let result: unknown = true;
    if (name === "claim_naming_brain_job") { result = claimed ? null : { mode, job: jobRow }; claimed = true; }
    else if (name === "authorize_naming_brain_dispatch") {
      const request = JSON.parse(String(args[2])) as NamingStageRequest, stage = stages.get(request.stageKey)!;
      if (mode !== "execute" || !ready || stage.requests.some(row => row.providerCallKey === request.providerCallKey) || !stage.callPlans.some(plan => plan.calls.some(call => call.requestHash === request.requestHash))) result = false;
      else stage.requests.push(request);
    } else if (name === "record_naming_brain_provider_receipt") { const value = namingProviderReceiptSchema.parse(JSON.parse(String(args[2]))); stages.get(value.stageKey)!.receipts.push(value); result = value; }
    else if (name === "complete_naming_brain_stage") { const stage = stages.get(args[2] as NamingSavedStage["stageKey"])!; stage.state = args[3] as NamingSavedStage["state"]; stageResults.set(stage.stageKey, JSON.parse(String(args[4]))); result = {}; }
    else if (action === "heartbeat") result = { ...jobRow, recoveryMode: mode, observationDeadlineAt: null };
    else if (action === "plan") result = payload.manifest;
    else if (action === "begin") {
      if (payload.stageKey === "prepare" && (jobRow.state === "cancel_requested" || namingStageKeySchema.options.filter(key => key !== "prepare").some(key => stages.get(key)!.state !== "succeeded"))) throw Error("Unsafe synthetic prepare boundary");
      const stage = stages.get(payload.stageKey)!; if (!stage.startedAt) stage.startedAt = new Date().toISOString(); stage.requestKey = payload.requestKey; result = { disposition: stage.state === "succeeded" ? "already_succeeded" : mode === "observe_only" ? "resume_observation" : "started" }; if (stage.state !== "succeeded") stage.state = "in_flight"; }
    else if (action === "stage") result = { ...stages.get(payload.stageKey), recoveryMode: mode };
    else if (action === "call_plan") { const stage = stages.get(payload.stageKey)!, phase = payload.phase ?? "main", existing = stage.callPlans.find(row => row.phase === phase); if (existing && JSON.stringify(existing.calls) !== JSON.stringify(payload.calls)) throw new Error("call_plan_changed"); if (!existing) stage.callPlans.push({ phase, calls: payload.calls }); result = payload.calls; }
    else if (action === "resume_execution") { const stage = stages.get(payload.stageKey)!; const resumed = ready && stage.requests.every(request => stage.artifacts.some(artifact => artifact.providerReceipt.providerCallKey === request.providerCallKey)); if (resumed) mode = "execute"; result = { recoveryMode: mode, resumed }; }
    else if (action === "provider_turn") { const stage = [...stages.values()].find(stage => stage.requests.some(request => request.providerCallKey === payload.providerCallKey))!; stage.providerTurns.push(payload); }
    else if (action === "provider_item") { const stage = [...stages.values()].find(stage => stage.requests.some(request => request.providerCallKey === payload.providerCallKey))!; stage.providerItems.push(payload); }
    else if (action === "artifact") { const artifact = namingRoleOutputSchema.parse(payload.artifact); stages.get(artifact.stageKey)!.artifacts.push(artifact); result = artifact; }
    else if (action === "index_page") result = { epoch: 1, entries: [] };
    else if (action === "index_finalize") result = true;
    else if (action === "identities") result = [];
    else if (action === "prepare") { prepared = payload; result = {}; }
    else if (action === "finish") { finished = payload; result = {}; }
    else throw new Error(`unexpected_fixture_rpc_${name}_${action}`);
    // A JSONB-like round trip deliberately loses JS object identity and key order.
    const jsonb = (value: unknown): unknown => Array.isArray(value) ? value.map(jsonb) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, jsonb(child)])) : value;
    return { rows: [{ result: jsonb(result) }] };
  } }, "fixture-deployment");

  const realCalls = new Map<string, NamingAgentRuntime>();
  function terminalRuntime(request: NamingStageRequest): NamingAgentRuntime {
    const overrun = !!options.lateCreatorOverrun && request.role === "creator" || !!options.lateGapOverrun && request.stageKey === "gap", inflight = !!options.inflightGap && request.stageKey === "gap", invalid = !!options.invalidGap && request.stageKey === "gap";
    const sessionId = `session-${request.providerCallKey}`, turnId = `turn-${request.providerCallKey}`, agentId = "synthetic-agent";
    let body: Record<string, unknown>;
    const turn = { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, status: inflight ? "in_progress" : "completed", object: "agent.session.turn", usage: null, error: null, created_at: 1, started_at: 1, completed_at: 2 };
    const text = invalid ? options.invalidGap!.kind === "json" ? "{malformed JSON" : JSON.stringify({ role: request.role, invalid: true }) : JSON.stringify(syntheticNamingOutput(request, options));
    const item = { id: "actual-final-item", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId, content: [{ type: "output_text", text }] };
    const session = (final: boolean) => ({ ...body, id: sessionId, status: inflight ? "in_progress" : "idle", required_actions: [], usage: final ? { input_tokens: 12, output_tokens: 6, total_tokens: 18 } : null, spend_control: { limit: request.policy.sessionLimitCents, consumed: final && overrun ? request.policy.sessionLimitCents + 1 : 0 } });
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-inert-key", fetch: async (input, init) => {
      const outgoing = new Request(input, init), path = new URL(outgoing.url).pathname;
      if (outgoing.method === "POST" && path === "/v1/agents/sessions") {
        dispatched.push(request); if (options.unknownGap && request.stageKey === "gap") throw Error("Synthetic lost acknowledgement");
        const sent = await outgoing.json(); body = { environment: sent.environment, metadata: sent.metadata, agent: { ...sent.agent, id: agentId } };
        return new Response([
          { type: "agent.session.created", event_id: "created", session: session(false) },
          { type: "agent.session.turn.created", event_id: "turn-created", session_id: sessionId, turn_id: turnId, turn: { ...turn, status: "in_progress", completed_at: null } },
          { type: "agent.session.turn.item.done", event_id: "item", session_id: sessionId, turn_id: turnId, output_index: 0, item },
          { type: "agent.session.turn.completed", event_id: "turn", session_id: sessionId, turn_id: turnId, turn, usage: null },
          { type: "agent.session.idle", event_id: "idle", session: session(true) },
        ].filter(event => !inflight || !["agent.session.turn.item.done", "agent.session.turn.completed", "agent.session.idle"].includes(event.type)).map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }
      if (outgoing.method === "POST") return new Response(null, { status: 202 });
      if (path.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
      const value = path.endsWith("/items") ? { data: inflight ? [] : [item], has_more: false, last_id: inflight ? null : item.id } : path.endsWith(`/${turnId}`) ? turn : session(true);
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    } });
    return createNamingAgentRuntime({ model: request.policy.model, protocol, persistence: store.runtimePersistence(parseClaimedJob(jobRow)) });
  }
  const runtime: NamingAgentRuntime = {
    async runStage(request, hooks): Promise<NamingStageOutcome> {
      if (options.invalidGap && request.stageKey === "gap" && request.role === options.invalidGap.role || options.lateCreatorOverrun && request.role === "creator" || (options.unknownGap || options.inflightGap || options.lateGapOverrun) && request.stageKey === "gap") {
        const actual = terminalRuntime(request); realCalls.set(request.providerCallKey, actual);
        const outcome = await actual.runStage(request, hooks);
        return options.invalidGap?.recover && outcome.status === "failed" ? { status: "unresolved", code: "synthetic_process_interruption", receipt: outcome.receipt, partialArtifacts: [] } : outcome;
      }
      await hooks.beforeDispatch(); dispatched.push(request);
      const observedReceipt = namingProviderReceiptSchema.parse({ ...receipt(request.stageKey, request.role), ...Object.fromEntries(["runId", "stageKey", "role", "snapshotHash", "requestKey", "providerCallKey", "assignmentKey", "requestHash"].map(key => [key, request[key as keyof NamingStageRequest]])), sessionLimitCents: request.policy.sessionLimitCents, observedModel: request.policy.model, sessionId: `session-${request.providerCallKey}`, turnId: `turn-${request.providerCallKey}` });
      await hooks.onReceipt(observedReceipt);
      if (options.lostCreator && request.role === "creator") return { status: "unresolved", code: "synthetic_lost", receipt: observedReceipt, partialArtifacts: [] };
      await hooks.onArtifact({ kind: "provider_turn", providerCallKey: request.providerCallKey, sessionId: observedReceipt.sessionId, turnId: observedReceipt.turnId, turn: { id: observedReceipt.turnId, session_id: observedReceipt.sessionId, agent_id: observedReceipt.agentId, subagent_id: null, status: options.failGap && request.stageKey === "gap" ? "failed" : "completed" } });
      if (options.failGap && request.stageKey === "gap") return { status: "failed", code: "provider_turn_failed", receipt: observedReceipt, partialArtifacts: [] };
      const text = JSON.stringify(syntheticNamingOutput(request, options)), itemId = "fixture-creator-item";
      const evidence: NamingEvidenceSource = { ...source(), contentHash: namingTextHash(source().excerpt!), provenance: { ...source().provenance, sessionId: observedReceipt.sessionId!, turnId: observedReceipt.turnId! } };
      await hooks.onArtifact({ providerCallKey: request.providerCallKey, sessionId: observedReceipt.sessionId, turnId: observedReceipt.turnId, itemId, item: { type: "message", role: "assistant", status: "completed", phase: "final_answer", turn_id: observedReceipt.turnId, id: itemId, content: [{ type: "output_text", text }] } });
      const output = validateNamingRoleOutput({ request, receipt: observedReceipt, final: { itemId, itemContentHash: namingTextHash(text), text, value: JSON.parse(text) }, dependencies: [...stages.values()].flatMap(stage => stage.artifacts).filter(artifact => request.dependencyArtifactIds.includes(artifact.artifactId)), sources: request.role === "researcher" ? [evidence] : [] });
      return { status: "completed", receipt: observedReceipt, output };
    },
    async resumeStage(receipt, hooks) { observed.push(receipt.providerCallKey); const actual = realCalls.get(receipt.providerCallKey); if (actual) return actual.resumeStage(receipt, hooks); return { status: "unresolved", code: "synthetic_pending", receipt, partialArtifacts: [] }; },
    async cancelStage() {},
  };
  const handlers = createNamingBrainHandlers({ store, assertReady: async () => { if (!ready) throw new Error("naming_readiness_unavailable"); }, runtime: () => runtime });
  return { store, input, jobRow, stages, stageResults, handlers, log, dispatched, observed, prepared: () => prepared, finished: () => finished, setReady: (value: boolean) => { ready = value; }, reclaim: () => { claimed = false; mode = "observe_only"; }, runtime };
}

export function syntheticNamingOutput(request: NamingStageRequest, options: { initialCount?: number } = {}): NamingModelOutput {
    const key = request.input;
    if (key.role === "researcher") return research().output;
    if (key.role === "director") return { role: "director", round: request.stageKey === "gap" ? "gap" : "initial", assignments: (request.stageKey === "gap" ? [assignment("invented", "gap-extra", 50, "rhythm")] : [assignment("real_words", "real", 90), assignment("invented", "invented", 60, "rhythm")]).map(value => ({ ...value, sourceKeys: key.research.sources.map(source => source.sourceKey) })), feedbackHypotheses: [] } as NamingModelOutput;
    if (key.role === "creator") {
      const count = request.stageKey === "gap" ? key.assignment.targetCount : options.initialCount ? Math.min(key.assignment.targetCount, options.initialCount / 2) : key.assignment.targetCount;
      return { role: "creator", assignmentKey: key.assignment.assignmentKey, candidates: Array.from({ length: count }, (_, index) => ({ ...proposal(`${key.assignment.assignmentKey}word${index}`, `c${index}`, key.assignment.primaryApproach, key.assignment.territoryId), claims: index === 0 ? [{ claimKey: "claim", statement: "Synthetic reference text", sourceKeys: [key.assignment.sources[0]!.sourceKey], requirement: "optional" as const, status: "unverified" as const }] : [] })) } as NamingModelOutput;
    }
    if (key.role === "curator") return { role: "curator", annotations: [], gaps: [] };
    const assignments = new Map(key.review.artifacts.map(artifact => [artifact.artifactKey, artifact.assignmentKey]));
    return { role: "verifier", findings: key.review.candidates.flatMap(candidate => candidate.claims.map(claim => ({ assignmentKey: assignments.get(candidate.artifactKey)!, candidateKey: candidate.candidateKey, claimKey: claim.claimKey, status: "supported" as const, supportedWording: "Synthetic reference text", sourceKeys: claim.sourceKeys, evidence: [{ sourceKey: claim.sourceKeys[0]!, start: 0, end: 24, quote: "Synthetic reference text" }], supportsPrimaryApproach: false, explanation: "The retained fixture span supports this optional claim." }))) };
  }
