import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingResearchPackSchema, type NamingModelOutput, type NamingStageRequest } from "../../src/domain/naming-brain";
import { buildNamingManagedRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol, type ManagedCreateRequest } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { getNamingBrainRun, getNamingFeed } from "../../src/server/data/naming-brain";
import { getNamingBatch } from "../../src/server/data/project-naming";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { createTestDatabase, OWNER_A, type TestDatabase } from "../database/local-supabase";
import { brainRpc, brainWorker, installBrainFixture } from "../database/naming-brain-fixture";
import { progressiveRequest, saveProgressivePart, saveProgressiveResearch, seedProgressiveFixture } from "../database/naming-brain-progressive-fixture";
import { seedHostedNamingFixture } from "../database/hosted-naming-fixture";

function deferred() {
  let resolve = () => {};
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

function serverReader(db: TestDatabase) {
  const readCalls: string[] = [];
  // A real Supabase client bridges only these explicit read RPCs into the
  // disposable authenticated SQL session; readers and provenance stay real.
  const client = createClient("https://synthetic-progressive.invalid", "synthetic-anon-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (incoming, init) => {
    const outgoing = new Request(incoming, init), name = new URL(outgoing.url).pathname.split("/").at(-1)!;
    const args = await outgoing.json() as Record<string, unknown>;
    const readArguments: Record<string, readonly string[]> = { get_naming_feed: ["p_project_id", "p_query"], get_naming_brain_run: ["p_project_id", "p_run_id"],
      get_naming_brain_candidate_sources: ["p_project_id", "p_candidate_ids"], get_naming_brain_candidate_source: ["p_project_id", "p_candidate_id"],
      get_naming_batch: ["p_project_id", "p_batch_id"], get_project_naming: ["p_project_id", "p_query"] };
    const keys = readArguments[name];
    if (!keys) throw new Error("unexpected_synthetic_reader_rpc");
    readCalls.push(name); return Response.json(await brainRpc(db, name, keys.map(key => args[key])));
  } } });
  return { auth: { userId: OWNER_A, client }, readCalls };
}

// Provider HTTP is synthetic. The installed SDK, immutable phase plans, restricted
// worker, publication transaction and ordinary server provenance readers are real.
describe("progressive Naming through the actual SDK and migrated SQL", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 30_000);
  afterAll(async () => { await db?.close(); });

  it.each([
    { origin: "local", directorStatus: "completed" }, { origin: "local", directorStatus: "failed" },
    { origin: "hosted", directorStatus: "completed" }, { origin: "hosted", directorStatus: "failed" },
  ] as const)("publishes before context, recovers an exact plan and finalizes100 for $origin with a $directorStatus Director", async ({ origin, directorStatus }) => {
    const value = origin === "hosted" ? await seedHostedNamingFixture(db) : await seedProgressiveFixture(db);
    let canonicalAcknowledgements = 0;
    const acknowledgeStoredTimestamp = (store: NamingBrainJobStore) => {
      const record = store.recordReceipt.bind(store);
      store.recordReceipt = async (job, incoming) => {
        // Actual SQL first commits the substantive observation at an earlier
        // synthetic clock value. The retry must receive that exact stored row,
        // rather than bind artifacts to its newly supplied timestamp.
        await record(job, { ...incoming, recordedAt: new Date(Date.parse(incoming.recordedAt) - 1000).toISOString() });
        const saved = await record(job, incoming);
        expect(saved.recordedAt).not.toBe(incoming.recordedAt);
        canonicalAcknowledgements++;
        return saved;
      };
    };
    acknowledgeStoredTimestamp(value.store);
    const admissionFunction = origin === "hosted" ? "ensure_hosted_naming_brain_run" : "ensure_local_naming_brain_run";
    expect(value.input.localPipelineVersion).toBe(2);
    expect(value.input.executionAuthority).toBe(origin === "hosted" ? "hosted_owner_v1" : undefined);
    expect(value.input.providerBudgetVersion).toBe(origin === "hosted" ? 2 : undefined);
    const requests = new Map<string, NamingStageRequest>();
    const histories = new Map<string, { session: object; turn: object; items: object[] }>();
    const creates: string[] = [], firstPublished = deferred(), releasePublication = deferred(), context = deferred(), siblings = deferred(), savedUnissued = deferred(), directorSaved = deferred();
    let simulateCrash = true;
    const publications: Parameters<NamingBrainJobStore["publishMicrobatch"]>[1][] = [];
    const originalPublish = value.store.publishMicrobatch.bind(value.store);
    value.store.publishMicrobatch = async (job, publication, signal) => {
      const result = await originalPublish(job, publication, signal); publications.push(publication);
      if (publication.key === "part001") { firstPublished.resolve(); await releasePublication.promise; }
      return result;
    };
    const capturePlans = (store: NamingBrainJobStore) => {
      const save = store.saveProgressiveCallPlan.bind(store);
      store.saveProgressiveCallPlan = async (job, phase, planned) => {
        await save(job, phase, planned);
        for (const request of planned) requests.set(request.providerCallKey, request);
        if (simulateCrash && phase === "part004.creation") {
          simulateCrash = false; savedUnissued.resolve();
          throw new Error("synthetic_process_lost_after_plan_ack");
        }
      };
    };
    capturePlans(value.store);
    const modelOutput = (request: NamingStageRequest): NamingModelOutput => {
      if (request.input.role === "researcher") return { role: "researcher", territories: [
        { territoryId: "objects", title: "Synthetic objects", direction: "Explore unexpected ordinary objects.", sourceKeys: [] },
        { territoryId: "rhythm", title: "Synthetic rhythm", direction: "Explore varied sounds and movement.", sourceKeys: [] },
      ], facts: [], interpretations: [], uncertainties: ["Synthetic research attempts do not establish real factual claims."] };
      if (request.input.role === "director") {
        const future = request.policy.progressiveContractVersion !== undefined, approaches = request.input.snapshot.preferences.approaches;
        return { role: "director", round: "initial", assignments: Array.from({ length: future ? 15 : approaches.length }, (_, index) => ({
          assignmentKey: future ? `guide-${index}` : `guide-${approaches[index]}`, primaryApproach: approaches[index % approaches.length]!, additionalApproaches: [], territoryId: index % 2 ? "rhythm" : "objects", constructionKey: `guide-${index}`,
          direction: "Explore distinct imaginative associations.", targetCount: future ? 10 : 150 / approaches.length, sourceKeys: [], avoidPatterns: [], freshTerritory: false,
        })), feedbackHypotheses: [] };
      }
      if (request.input.role === "creator") {
        const assignment = request.input.assignment;
        return { role: "creator", assignmentKey: assignment.assignmentKey,
          candidates: Array.from({ length: assignment.targetCount }, (_, index) => ({ candidateKey: `candidate-${index}`, value: `Synthetic${request.providerCallKey.slice(4, 7)}Name${index}`,
            primaryApproach: assignment.primaryApproach, additionalApproaches: [], territoryId: assignment.territoryId,
            constructionKey: assignment.constructionKey, rationale: "An imaginative synthetic association.", caution: null, claims: [] })) };
      }
      if (request.input.role === "curator") return { role: "curator", annotations: [], gaps: [] };
      throw new Error("claim_free_fixture_must_not_invent_verification");
    };
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-progressive-sdk-only", localPrototype: true, fetch: async (incoming, init) => {
      const outgoing = new Request(incoming, init), url = new URL(outgoing.url);
      expect(url.origin).toBe("https://api.openai.com");
      if (outgoing.method === "GET") {
        const sessionId = url.pathname.split("/")[4]!, history = histories.get(sessionId);
        if (!history) throw new Error("synthetic_session_history_missing");
        const base = `/v1/agents/sessions/${sessionId}`;
        const result = url.pathname === base ? history.session : url.pathname === `${base}/turns` ? { data: [history.turn], has_more: false }
          : url.pathname === `${base}/turns/turn_${sessionId.slice(5)}` ? history.turn
            : url.pathname === `${base}/turns/turn_${sessionId.slice(5)}/items` ? { data: history.items, has_more: false } : null;
        if (!result) throw new Error("unexpected_synthetic_history_route");
        return Response.json(result);
      }
      expect(url.pathname).toBe("/v1/agents/sessions"); expect(outgoing.method).toBe("POST");
      const wire = await outgoing.json() as ManagedCreateRequest, key = wire.metadata?.embel_call;
      if (typeof key !== "string") throw new Error("synthetic_saved_call_missing");
      const request = requests.get(key); if (!request) throw new Error("synthetic_saved_request_missing");
      expect(wire).toEqual(buildNamingManagedRequest(request)); creates.push(key);
      // The actual native SDK path is unmetered without a mocked availability
      // escape hatch. Legacy numeric policy fields are retained bookkeeping.
      expect(wire).not.toHaveProperty("spend_control");
      expect(wire.metadata).not.toHaveProperty("embel_provider_spend_cap_cents");
      expect(request.policy.providerSpendCapCents).toBeUndefined();
      expect(wire.agent).toMatchObject({ model: value.input.policy.model, reasoning: { effort: "xhigh" } });
      if (request.role === "researcher") expect(wire.agent?.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "web_search", mode: "live" }), expect.objectContaining({ type: "function", name: "read_reference" }),
      ]));
      if (key === "context.research.researcher") await context.promise;
      if (key.endsWith(".creator") && key !== "part001.creation.creator" && !creates.includes("context.direction.director")) await siblings.promise;
      if (key === "part004.creation.creator") await directorSaved.promise;
      const sessionId = `sess_${key}`, turnId = `turn_${key}`, agentId = `agent_${key}`, itemId = `item_${key}`;
      const session = { id: sessionId, object: "agent.session", agent: { ...wire.agent, id: agentId }, environment: wire.environment, metadata: wire.metadata,
        status: "idle", required_actions: [], usage: { input_tokens: 1_000_000, output_tokens: 500_000, total_tokens: 1_500_000 }, ...(wire.spend_control ? { spend_control: { limit: wire.spend_control.limit, consumed: 0 } } : {}) };
      const failed = request.role === "director" && directorStatus === "failed";
      const turn = { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: failed ? "failed" : "completed",
        created_at: 1, started_at: 1, completed_at: 2, error: failed ? { code: "server_error", message: "Synthetic optional guidance failure." } : null, usage: null };
      const item = { id: itemId, type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId,
        content: [{ type: "output_text", text: JSON.stringify(modelOutput(request)) }] };
      const search = { id: `web_${key}`, type: "web_search_call", status: "completed", turn_id: turnId, action: { type: "search", query: "explicit synthetic fixture" } };
      histories.set(sessionId, { session, turn, items: [...(request.role === "researcher" ? [search] : []), ...(failed ? [] : [item])] });
      const events = [
        { type: "agent.session.created", session },
        { type: "agent.session.turn.created", session_id: sessionId, turn_id: turnId, turn: { ...turn, status: "in_progress", completed_at: null } },
        ...(request.role === "researcher" ? [{ type: "agent.session.turn.item.done", session_id: sessionId, turn_id: turnId, output_index: 0,
          item: search }] : []),
        ...(failed ? [] : [{ type: "agent.session.turn.item.done", session_id: sessionId, turn_id: turnId, output_index: 1, item }]),
        { type: failed ? "agent.session.turn.failed" : "agent.session.turn.completed", session_id: sessionId, turn_id: turnId, turn },
      ].map((event, index) => `data: ${JSON.stringify({ ...event, event_id: `event_${key}_${index}` })}\n\n`).join("");
      return new Response(events, { headers: { "content-type": "text/event-stream", "x-request-id": `req_${key.replaceAll(".", "_")}` } });
    } });
    const handlers = (store: NamingBrainJobStore) => createNamingBrainHandlers({ store, assertReady: async () => {},
      runtime: job => createNamingAgentRuntime({ protocol, model: value.input.policy.model, localPrototype: store.hasUnmeteredExecutionAuthority(job), persistence: store.runtimePersistence(job), assertContinuation: () => store.assertContinuation(job) }) });
    const { auth, readCalls } = serverReader(db);
    const creation = handlers(value.store).get("naming.generate")!.steps(value.job)[0]!;
    const pending = brainWorker(db, () => creation.execute({ job: value.job, signal: new AbortController().signal }));
    try {
      await Promise.race([firstPublished.promise, pending.then(result => { throw new Error(`synthetic_ended_before_publication:${result.status}`); })]);
      await db.exec("set session authorization postgres");
      const feed = await getNamingFeed(auth, value.project), run = await getNamingBrainRun(auth, value.project, value.input.runId);
      expect(feed.entries).toHaveLength(4); expect(feed.progressive).toEqual({ version: 1, targetCount: 100, publishedCount: 4 });
      expect(feed.activeRun).toMatchObject({ state: "running", progress: 4, preparedSetId: null, fulfillment: { status: "partial", acceptedCount: 4 } });
      expect(feed.activeRun?.executionAuthority).toBe(value.input.executionAuthority);
      expect(run.executionAuthority).toBe(value.input.executionAuthority);
      expect(run.stages.map(stage => [stage.stageKey, stage.state])).toEqual([["creation", "running"], ["prepare", "pending"]]);
      expect(readCalls).toContain("get_naming_brain_candidate_sources");
      expect(creates).not.toContain("context.direction.director");
      expect(publications[0]!.verification).toEqual({ kind: "not_required", reason: "no_factual_claims" });
      await db.exec("set session authorization fixture_naming_brain_a");
      expect((await originalPublish(value.job, publications[0]!, new AbortController().signal)).publishedCount).toBe(4);
      releasePublication.resolve(); await savedUnissued.promise; context.resolve(); siblings.resolve();
      // This interruption is after the plan ACK but before authorization;
      // issued siblings drain with terminal evidence, so the outcome is known.
      expect(await pending).toMatchObject({ status: "failed", code: "local_planning_failed" });
      const original = requests.get("part004.creation.creator")!;
      expect(original.input.role === "creator" && "assignmentBasis" in original.input.assignment && original.input.assignment.assignmentBasis.kind).toBe("brief_seed");
      expect(creates).not.toContain(original.providerCallKey);
      // Simulate a lost process after its saved plan ACK, then normal lease
      // expiry/reclaim. No production timestamp or attempt is changed.
      await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [value.job.id]);
      const nextStore = new NamingBrainJobStore(db, "fixture-deployment");
      acknowledgeStoredTimestamp(nextStore);
      await brainWorker(db, () => nextStore.expireLeases("fixture-worker"));
      await db.query("update fluid_private.naming_brain_runs set next_observation_at=clock_timestamp()-interval '1 second' where id=$1", [value.input.runId]);
      const reclaimed = await brainWorker(db, () => nextStore.claim("fixture-worker", 120));
      if (!reclaimed) throw new Error("synthetic_progressive_reclaim_missing");
      expect(reclaimed.id).toBe(value.job.id); expect(reclaimed.leaseToken).not.toBe(value.job.leaseToken);
      capturePlans(nextStore);
      const saveArtifact = nextStore.saveArtifact.bind(nextStore);
      nextStore.saveArtifact = async (job, artifact) => { const result = await saveArtifact(job, artifact); if (artifact.output.role === "director") directorSaved.resolve(); return result; };
      const saveRecord = nextStore.saveProviderItem.bind(nextStore);
      nextStore.saveProviderItem = async (job, record) => {
        await saveRecord(job, record);
        if (directorStatus === "failed" && record && typeof record === "object" && "kind" in record && record.kind === "provider_turn"
          && "providerCallKey" in record && record.providerCallKey === "context.direction.director") directorSaved.resolve();
      };
      const steps = handlers(nextStore).get("naming.generate")!.steps(reclaimed);
      await brainWorker(db, async () => {
        await nextStore.beginStep(reclaimed, "creation", steps[0]!.maximumCostMicrousd);
        const result = await steps[0]!.execute({ job: reclaimed, signal: new AbortController().signal });
        expect(result.status).toBe("succeeded"); await nextStore.completeStep(reclaimed, "creation", result);
        await nextStore.beginStep(reclaimed, "prepare", 0);
        const preparation = await steps[1]!.execute({ job: reclaimed, signal: new AbortController().signal });
        expect(preparation.status).toBe("succeeded");
        const first = await nextStore.finalizeProgressive(reclaimed), replay = await nextStore.finalizeProgressive(reclaimed);
        expect(replay).toEqual(first); await nextStore.completeStep(reclaimed, "prepare", preparation); await nextStore.finish(reclaimed, "succeeded");
      });
      expect(requests.get(original.providerCallKey)).toEqual(original);
      expect(canonicalAcknowledgements).toBeGreaterThan(20);
      for (const key of ["context.research.researcher", "part001.creation.creator", "part002.creation.creator", "part003.creation.creator", original.providerCallKey]) expect(creates.filter(value => value === key)).toHaveLength(1);
      const complete = await getNamingFeed(auth, value.project), final = await getNamingBrainRun(auth, value.project, value.input.runId);
      expect(complete.entries).toHaveLength(100); expect(new Set(complete.entries.map(row => row.entry.candidate.identityKey)).size).toBe(100);
      expect(complete.progressive).toEqual({ version: 1, targetCount: 100, publishedCount: 100 });
      expect(complete.activeRun).toMatchObject({ state: "succeeded", preparedSetId: null, progressiveCompletionId: expect.any(String), fulfillment: { status: "complete", coverageSatisfied: true } });
      expect(final.stages.map(stage => [stage.stageKey, stage.state])).toEqual([["creation", "succeeded"], ["prepare", "succeeded"]]);
      const batch = await getNamingBatch(auth, value.project, value.input.batchId);
      expect(batch.result?.candidateIds).toHaveLength(100);
      expect(new Set(batch.result?.candidateIds)).toEqual(new Set(complete.entries.map(row => row.entry.candidate.id)));
      const replay = await brainRpc<{ status: string; appendedEntryIds: string[] }>(db, admissionFunction, [value.project, value.intent]);
      expect(replay).toMatchObject({ status: "appended", appendedEntryIds: [] });
      const createdBeforeStop = creates.length;
      await brainRpc(db, "stop_naming_feed", [value.project, { version: 1, expectedDemandSequence: complete.demandSequence,
        pendingEnsureIdempotencyKey: null, idempotencyKey: "synthetic-progressive-stop-complete" }]);
      const stopped = await getNamingFeed(auth, value.project), savedRun = stopped.activeRun!;
      expect(stopped.paused).toBe(true); expect(savedRun).toMatchObject({ runId: value.input.runId, canResume: true, canResumeSaved: true, preparedSetId: null, progressiveCompletionId: expect.any(String) });
      const continued = await brainRpc(db, admissionFunction, [value.project, { version: 1, reason: "resume", expectedProjectRevision: stopped.projectRevision,
        expectedPreferencesVersion: stopped.preferencesVersion, expectedSteeringRevision: stopped.steeringRevision, expectedDemandSequence: stopped.demandSequence,
        resumeOfRunId: savedRun.runId, expectedRunRevision: savedRun.revision, consumedThrough: { entryId: complete.entries.at(-1)!.entryId, position: 100 }, idempotencyKey: "synthetic-progressive-continue-saved" }]);
      expect(continued).toMatchObject({ status: "appended", runId: value.input.runId, appendedEntryIds: [] });
      const restored = await getNamingFeed(auth, value.project);
      expect(restored.paused).toBe(false); expect(restored.entries.map(row => row.entryId)).toEqual(complete.entries.map(row => row.entryId));
      expect(restored.activeRun?.demandSequence).toBe(complete.activeRun!.demandSequence); expect(restored.demandSequence).toBe(complete.demandSequence + 2);
      expect(creates).toHaveLength(createdBeforeStop);
      expect((await db.query("select count(*)::integer count from public.jobs where id=$1", [value.job.id])).rows).toEqual([{ count: 1 }]);
      expect((await db.query("select jsonb_array_length(result->'candidateIds') count from fluid_private.naming_brain_progressive_results where run_id=$1", [value.input.runId])).rows).toEqual([{ count: 100 }]);
      expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_artifacts where run_id=$1 and artifact#>>'{output,role}'='director'", [value.input.runId])).rows).toEqual([{ count: directorStatus === "completed" ? 1 : 0 }]);
      expect((await db.query("select actual_cost_microusd from fluid_private.naming_brain_runs where id=$1", [value.input.runId])).rows).toEqual([{ actual_cost_microusd: null }]);
    } finally {
      releasePublication.resolve(); context.resolve(); siblings.resolve(); directorSaved.resolve();
      await pending;
    }
  }, 60_000);

  it("retains100 readable publications when an actually invoked SDK Director has an unknown identity", async () => {
    const value = await seedProgressiveFixture(db), research = namingResearchPackSchema.parse(await saveProgressiveResearch(value));
    const request = progressiveRequest(value, "context.direction", { role: "director", snapshot: value.input.snapshot, research }, [research.artifactId]);
    const invoked = deferred(), releaseUnknown = deferred();
    let posts = 0;
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-unknown-director-only", localPrototype: true, fetch: async (incoming, init) => {
      const outgoing = new Request(incoming, init);
      expect(new URL(outgoing.url).pathname).toBe("/v1/agents/sessions"); expect(outgoing.method).toBe("POST");
      posts++; invoked.resolve(); await releaseUnknown.promise; throw new TypeError("synthetic_create_ack_unknown");
    } });
    const runtime = createNamingAgentRuntime({ protocol, model: value.input.policy.model, localPrototype: true,
      persistence: value.store.runtimePersistence(value.job), assertContinuation: () => value.store.assertContinuation(value.job) });
    const pending = brainWorker(db, async () => {
      await value.store.saveProgressiveCallPlan(value.job, "context.direction", [request]);
      return runtime.runStage(request, { signal: new AbortController().signal, beforeDispatch: () => value.store.authorizeDispatch(value.job, request),
        onReceipt: receipt => value.store.recordReceipt(value.job, receipt), onArtifact: record => value.store.saveProviderItem(value.job, record) });
    });
    try {
      await invoked.promise;
      // Reviewed siblings commit while the already-invoked Director has not yet
      // returned an acknowledgement. Its later uncertainty cannot erase them.
      for (let index = 0; index < 17; index++) {
        const approach = value.input.snapshot.preferences.approaches[index % 3]!;
        const part = await saveProgressivePart(value, index, index === 16 ? 4 : 6, approach);
        await brainWorker(db, () => value.store.publishMicrobatch(value.job, part.publication!, new AbortController().signal));
      }
      await db.exec("set session authorization fixture_naming_brain_a"); releaseUnknown.resolve();
      expect(await pending).toMatchObject({ status: "unresolved", receipt: { dispatchState: "unknown", sessionId: null, turnId: null } });
    } finally { await db.exec("set session authorization fixture_naming_brain_a"); releaseUnknown.resolve(); await pending; await db.exec("set session authorization postgres"); }
    await brainWorker(db, async () => {
      const handlers = createNamingBrainHandlers({ store: value.store, localPrototype: true, assertReady: async () => {}, runtime: () => runtime });
      const result = await handlers.get("naming.generate")!.steps(value.job)[0]!.execute({ job: value.job, signal: new AbortController().signal });
      expect(result.status).toBe("needs_reconciliation"); await value.store.completeStep(value.job, "creation", result);
    });
    const { auth } = serverReader(db), feed = await getNamingFeed(auth, value.project), run = await getNamingBrainRun(auth, value.project, value.input.runId);
    expect(posts).toBe(1); expect(feed.entries).toHaveLength(100);
    expect(feed.activeRun).toMatchObject({ state: "needs_reconciliation", canResume: false, preparedSetId: null, fulfillment: { status: "complete", acceptedCount: 100 } });
    expect(run).not.toHaveProperty("progressiveCompletionId");
    const replay = await brainRpc(db, "ensure_local_naming_brain_run", [value.project, value.intent]);
    expect(replay).toMatchObject({ status: "blocked", code: "completion_unresolved", action: "resolve" });
    expect((await db.query("select count(*)::integer count from public.jobs where project_id=$1", [value.project])).rows).toEqual([{ count: 1 }]);
    expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_progressive_results where run_id=$1", [value.input.runId])).rows).toEqual([{ count: 0 }]);
  }, 60_000);

  it("closes definite priority400 rejections as failed without a fallback or automatic retry", async () => {
    const value = await seedProgressiveFixture(db), posted: string[] = [];
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-profile-rejection-only", localPrototype: true, fetch: async (incoming, init) => {
      const outgoing = new Request(incoming, init), wire = await outgoing.json() as ManagedCreateRequest;
      expect(new URL(outgoing.url).pathname).toBe("/v1/agents/sessions"); expect(outgoing.method).toBe("POST");
      expect(wire).toMatchObject({ agent: { service_tier: "priority", reasoning: { effort: "xhigh" }, text: { verbosity: "low" } }, metadata: { embel_pipeline_version: "2" } });
      expect(wire).not.toHaveProperty("spend_control");
      const key = wire.metadata?.embel_call; if (typeof key !== "string") throw new Error("synthetic_rejected_call_missing");
      posted.push(key);
      return Response.json({ error: { type: "invalid_request_error", code: "unsupported_value", param: "agent.service_tier", message: "Explicit synthetic priority rejection." } },
        { status: 400, headers: { "x-request-id": `req_priority_${key.replaceAll(".", "_")}` } });
    } });
    const handlers = createNamingBrainHandlers({ store: value.store, localPrototype: true, assertReady: async () => {},
      runtime: job => createNamingAgentRuntime({ protocol, model: value.input.policy.model, localPrototype: true,
        persistence: value.store.runtimePersistence(job), assertContinuation: () => value.store.assertContinuation(job) }) });
    await brainWorker(db, async () => {
      const result = await handlers.get("naming.generate")!.steps(value.job)[0]!.execute({ job: value.job, signal: new AbortController().signal });
      expect(result).toMatchObject({ status: "failed", code: "provider_request_rejected" });
      await value.store.completeStep(value.job, "creation", result); await value.store.finish(value.job, "failed");
    });
    expect(posted.length).toBeGreaterThan(0); expect(posted.length).toBeLessThanOrEqual(4); expect(new Set(posted).size).toBe(posted.length);
    expect((await db.query("select bool_and(fluid_private.naming_brain_call_terminal(c)) terminal from fluid_private.naming_brain_calls c where run_id=$1", [value.input.runId])).rows).toEqual([{ terminal: true }]);
    expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_receipts where run_id=$1 and(receipt->>'dispatchState'<>'not_dispatched' or receipt->'sessionId'<>'null'::jsonb or receipt->'turnId'<>'null'::jsonb)", [value.input.runId])).rows).toEqual([{ count: 0 }]);
    expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_provider_records where run_id=$1", [value.input.runId])).rows).toEqual([{ count: 0 }]);
    expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_feed_entries where run_id=$1", [value.input.runId])).rows).toEqual([{ count: 0 }]);
    const { auth } = serverReader(db), run = await getNamingBrainRun(auth, value.project, value.input.runId);
    expect(run).toMatchObject({ state: "failed", canResume: true, preparedSetId: null });
    expect(await brainRpc(db, "ensure_local_naming_brain_run", [value.project, value.intent])).toMatchObject({ status: "incomplete", canResume: true });
    expect((await db.query("select count(*)::integer count from public.jobs where project_id=$1", [value.project])).rows).toEqual([{ count: 1 }]);
    expect(new Set(posted).size).toBe(posted.length);
  }, 60_000);
});
