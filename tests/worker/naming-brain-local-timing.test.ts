import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// The global HTTP transport below is synthetic; this exercises historical
// timing/recovery contracts rather than real provider budget support.
vi.mock("@/server/ai/naming-brain/budget-availability", () => ({ isNamingProviderBudgetAvailable: () => true }));
import { namingAssignmentPlanSchema, namingBrainJobInputSchema, namingProviderReceiptSchema, namingResearchPackSchema, validateNamingAssignmentPlan, type NamingStageRequest } from "../../src/domain/naming-brain";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { buildNamingManagedRequest, createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { NamingBrainJobStore, normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { createTestDatabase, OWNER_A, type TestDatabase } from "../database/local-supabase";
import { brainRpc, brainWorker, initialIntent, installBrainFixture, seedBrainFixture } from "../database/naming-brain-fixture";
import { historicalNamingClaimDatabase } from "../database/naming-brain-historical-claim";

const targets = [18, 18, 19, 17, 17, 16, 15, 15, 15];
type SessionStatus = "completed" | "cancelled" | "in_progress";

// The SDK parses synthetic HTTP. Persistence, scoped worker permissions, leases,
// admission, artifacts and terminal classification use the real migrated SQL.
describe("local Naming call clocks and issued-sibling recovery (synthetic SDK HTTP)", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase({ before: "20261017170000_local_progressive_naming.sql" }); await installBrainFixture(db); }, 30_000);
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => { await db?.close(); });

  it("keeps105 saved candidates, observes all three siblings and admits only an explicit terminal Resume", async () => {
    const project = await seedBrainFixture(db), strategyPolicy = guidedStrategyPolicy("strategy.reformulate");
    await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [strategyPolicy]);
    await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, strategyPolicy]);
    const admitted = await brainRpc<{ run: { jobId: string; runId: string } }>(db, "ensure_local_naming_brain_run", [project, initialIntent("synthetic-late-wave")]);
    const historical = (await db.query<{ input: { localPipelineVersion?: number } }>("select input from public.jobs where id=$1", [admitted.run.jobId])).rows;
    expect(historical[0]!.input.localPipelineVersion).toBeUndefined();
    await db.exec(await readFile(new URL("../../supabase/migrations/20261017170000_local_progressive_naming.sql", import.meta.url), "utf8"));
    expect((await db.query("select input from public.jobs where id=$1", [admitted.run.jobId])).rows).toEqual(historical);
    const requests: { method: string; path: string }[] = [];
    const sessions = new Map<string, { request: NamingStageRequest; status: SessionStatus }>();
    const sessionId = (key: string) => `sess_${key.replaceAll("-", "_")}`;
    const turnId = (key: string) => `turn_${key.replaceAll("-", "_")}`;
    const agentId = (key: string) => `agent_${key.replaceAll("-", "_")}`;
    const output = (request: NamingStageRequest) => {
      if (request.input.role === "researcher") return { role: "researcher", territories: [
        { territoryId: "nature", title: "Synthetic nature", direction: "Explore synthetic natural associations.", sourceKeys: [] },
        { territoryId: "sound", title: "Synthetic sound", direction: "Explore synthetic sound associations.", sourceKeys: [] },
      ], facts: [], interpretations: [], uncertainties: ["Synthetic fixture makes no verified factual claims."] };
      if (request.input.role === "director") return { role: "director", round: "initial", assignments: targets.map((targetCount, index) => ({
        assignmentKey: `assignment-${index.toString().padStart(2, "0")}`, primaryApproach: "real_words", additionalApproaches: [], territoryId: "nature", constructionKey: `construction-${index}`,
        direction: `Explore synthetic assignment ${index}.`, targetCount, sourceKeys: [], avoidPatterns: [], freshTerritory: true,
      })), feedbackHypotheses: [] };
      if (request.input.role !== "creator") throw new Error("unexpected_synthetic_role");
      const assignment = request.input.assignment, index = Number(assignment.assignmentKey.slice(-2));
      return { role: "creator", assignmentKey: assignment.assignmentKey, candidates: Array.from({ length: assignment.targetCount }, (_, item) => ({
        candidateKey: `candidate-${item}`, value: `Synthetic${String.fromCharCode(65 + index)}${String.fromCharCode(65 + item)}`, primaryApproach: "real_words", additionalApproaches: [],
        territoryId: assignment.territoryId, constructionKey: assignment.constructionKey, rationale: "A synthetic creative association.", caution: null, claims: [],
      })) };
    };
    const session = (entry: { request: NamingStageRequest; status: SessionStatus }) => {
      const wire = buildNamingManagedRequest(entry.request), key = entry.request.providerCallKey;
      return { id: sessionId(key), object: "agent.session", agent: { ...wire.agent, id: agentId(key) }, environment: wire.environment, metadata: wire.metadata,
        status: entry.status === "in_progress" ? "running" : "idle", required_actions: [], usage: null };
    };
    const turn = (entry: { request: NamingStageRequest; status: SessionStatus }) => {
      const key = entry.request.providerCallKey;
      return { id: turnId(key), session_id: sessionId(key), agent_id: agentId(key), subagent_id: null, object: "agent.session.turn", status: entry.status,
        created_at: 1, started_at: 1, completed_at: entry.status === "in_progress" ? null : 2, error: null, usage: null };
    };
    const item = (entry: { request: NamingStageRequest; status: SessionStatus }) => ({ id: `item_${entry.request.providerCallKey}`, type: "message", role: "assistant", phase: "final_answer", status: "completed",
      turn_id: turnId(entry.request.providerCallKey), content: [{ type: "output_text", text: JSON.stringify(output(entry.request)) }] });
    vi.stubGlobal("fetch", (async (incoming, init) => {
      const outgoing = new Request(incoming, init), url = new URL(outgoing.url);
      expect(url.origin).toBe("https://api.openai.com"); requests.push({ method: outgoing.method, path: url.pathname });
      if (outgoing.method === "POST") {
        expect(url.pathname).toBe("/v1/agents/sessions");
        const wire = await outgoing.json() as ReturnType<typeof buildNamingManagedRequest>;
        const entry = sessions.get(wire.metadata!.embel_call!);
        if (!entry) throw new Error("unplanned_synthetic_create");
        expect(wire).toEqual(buildNamingManagedRequest(entry.request));
        const key = entry.request.providerCallKey;
        const events = [
          { type: "agent.session.created", session: session(entry) },
          { type: "agent.session.turn.created", session_id: sessionId(key), turn_id: turnId(key), turn: { ...turn(entry), status: "in_progress", completed_at: null } },
          { type: "agent.session.turn.item.done", session_id: sessionId(key), turn_id: turnId(key), output_index: 0, item: item(entry) },
          { type: "agent.session.turn.completed", session_id: sessionId(key), turn_id: turnId(key), turn: turn(entry), usage: null },
        ].map((event, index) => `data: ${JSON.stringify({ ...event, event_id: `${key}-${index}` })}\n\n`).join("");
        return new Response(events, { headers: { "content-type": "text/event-stream", "x-request-id": `req_${key}` } });
      }
      expect(outgoing.method).toBe("GET");
      const entry = [...sessions.values()].find(value => url.pathname.startsWith(`/v1/agents/sessions/${sessionId(value.request.providerCallKey)}`));
      if (!entry) throw new Error("unknown_synthetic_session");
      const base = `/v1/agents/sessions/${sessionId(entry.request.providerCallKey)}`;
      if (url.pathname === `${base}/events`) return new Response("", { headers: { "content-type": "text/event-stream" } });
      const value = url.pathname === base ? session(entry) : url.pathname === `${base}/turns` ? { data: [turn(entry)], has_more: false }
        : url.pathname === `${base}/turns/${turnId(entry.request.providerCallKey)}` ? turn(entry)
          : url.pathname.endsWith("/items") ? { data: entry.status === "completed" ? [item(entry)] : [], has_more: false, last_id: entry.status === "completed" ? item(entry).id : null } : null;
      if (!value) throw new Error("unexpected_synthetic_read");
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    }) satisfies typeof fetch);

    const workerDatabase = await historicalNamingClaimDatabase(db);
    const store = new NamingBrainJobStore(workerDatabase, "fixture-deployment");
    const job = await brainWorker(db, async () => {
      const job = await store.claim("fixture-worker", 120);
      if (!job) throw new Error("synthetic_local_job_missing");
      const input = namingBrainJobInputSchema.parse(normalizeNamingStoredJson(job.input));
      const handlers = createNamingBrainHandlers({ store, apiKey: "synthetic-only", localPrototype: true, assertReady: async () => {} });
      const steps = handlers.get(job.operation)!.steps(job);
      await store.registerPlan(job, steps.map(({ key, maximumCostMicrousd }) => ({ key, maximumCostMicrousd })));
      for (const key of ["research", "direction"] as const) {
        const stage = steps.find(row => row.key === key)!;
        expect(await store.beginStep(job, key, stage.maximumCostMicrousd)).toBe("started");
        const previous = await store.loadStages(job), research = previous.find(row => row.stageKey === "research")!.artifacts[0];
        const request = createNamingRoleRequest({ runId: input.runId, stageKey: key, providerCallKey: `${key}-${key === "research" ? "researcher" : "director"}`,
          dependencyArtifactIds: research ? [research.artifactId] : [], input: key === "research" ? { role: "researcher", snapshot: input.snapshot }
            : { role: "director", snapshot: input.snapshot, research: namingResearchPackSchema.parse(research) },
          policy: createNamingRolePolicy(input.policy, key, key === "research" ? "researcher" : "director", undefined, undefined, true, input.localTimingVersion === 2 ? 900_000 : 240_000) });
        sessions.set(request.providerCallKey, { request, status: "completed" });
        const outcome = await stage.execute({ job, signal: new AbortController().signal });
        expect(outcome.status).toBe("succeeded"); await store.completeStep(job, key, outcome);
      }
      expect(await store.beginStep(job, "creation", input.policy.stageLimits.creation.maximumCostMicrousd)).toBe("started");
      return job;
    });
    const input = namingBrainJobInputSchema.parse(normalizeNamingStoredJson(job.input));
    const artifacts = (await db.query<{ artifact: unknown }>("select artifact from fluid_private.naming_brain_artifacts where run_id=$1", [input.runId])).rows;
    const research = namingResearchPackSchema.parse(artifacts.find(row => (row.artifact as { stageKey: string }).stageKey === "research")!.artifact);
    const plan = namingAssignmentPlanSchema.parse(artifacts.find(row => (row.artifact as { stageKey: string }).stageKey === "direction")!.artifact);
    const assignments = validateNamingAssignmentPlan(input.snapshot, research, plan);
    const creatorRequests = assignments.map(assignment => createNamingRoleRequest({ runId: input.runId, stageKey: "creation", providerCallKey: `creation-creator-${assignment.assignmentKey}`,
      dependencyArtifactIds: [research.artifactId, plan.artifactId], input: { role: "creator", snapshot: input.snapshot, assignment },
      policy: createNamingRolePolicy(input.policy, "creation", "creator", assignment.targetCount, 0, true, input.localTimingVersion === 2 ? 900_000 : 240_000) }));
    await brainWorker(db, () => store.saveCallPlan(job, "creation", creatorRequests));
    // Only the disposable stage clock is moved. Every call authorization retains
    // its genuine server time, so these represent later queued Creator waves.
    await db.query("update public.job_steps set created_at=clock_timestamp()-interval '5 minutes' where job_id=$1 and step_key='creation'", [job.id]);
    for (const request of creatorRequests.slice(0, 6)) {
      sessions.set(request.providerCallKey, { request, status: "completed" });
      await brainWorker(db, async () => {
        const runtime = createNamingAgentRuntime({ apiKey: "synthetic-only", model: input.policy.model, localPrototype: true, persistence: store.runtimePersistence(job), assertContinuation: () => store.assertContinuation(job) });
        const outcome = await runtime.runStage(request, { signal: new AbortController().signal, beforeDispatch: async () => { await store.assertContinuation(job); await store.authorizeDispatch(job, request); },
          onReceipt: receipt => store.recordReceipt(job, receipt), onArtifact: value => store.saveProviderItem(job, value) });
        expect(outcome.status).toBe("completed");
        if (outcome.status !== "completed") throw new Error("synthetic_late_wave_failed");
        await store.saveArtifact(job, outcome.output);
        const authority = await store.runtimePersistence(job).load(request);
        expect(authority.request?.requestHash).toBe(request.requestHash);
        expect(Date.parse(authority.authorizedAt ?? "")).toBeGreaterThan(Date.parse(authority.startedAt) + 240_000);
      });
    }
    const saved = (await db.query<{ artifact: unknown }>("select artifact from fluid_private.naming_brain_artifacts where run_id=$1 and stage_key='creation' order by id", [input.runId])).rows;
    expect(saved).toHaveLength(6);
    expect(saved.reduce((sum, row) => sum + (row.artifact as { output: { candidates: unknown[] } }).output.candidates.length, 0)).toBe(105);
    const posted = requests.filter(row => row.method === "POST").length;
    expect(posted).toBe(8); // Research, Director and six later-wave Creators.
    const stopped = new AbortController(); stopped.abort();
    await brainWorker(db, async () => {
      const runtime = createNamingAgentRuntime({ apiKey: "synthetic-only", model: input.policy.model, localPrototype: true, persistence: store.runtimePersistence(job) });
      expect(await runtime.runStage(creatorRequests[6]!, { signal: stopped.signal, beforeDispatch: async () => { throw new Error("cancelled_call_must_not_authorize"); }, onReceipt: async () => {}, onArtifact: async () => {} })).toMatchObject({ status: "rejected_before_dispatch" });
    });
    expect(requests.filter(row => row.method === "POST")).toHaveLength(posted);
    for (const [index, request] of creatorRequests.slice(6).entries()) {
      const state = { request, status: (index === 2 ? "in_progress" : "cancelled") as SessionStatus };
      sessions.set(request.providerCallKey, state);
      const priorReceipt = namingProviderReceiptSchema.parse({ ...research.providerReceipt, stageKey: "creation", role: "creator", providerCallKey: request.providerCallKey,
        assignmentKey: request.assignmentKey, requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents, dispatchState: "unknown",
        sessionId: sessionId(request.providerCallKey), turnId: turnId(request.providerCallKey), agentId: agentId(request.providerCallKey), requestId: `req_${request.providerCallKey}`,
        callIds: [], toolCalls: [], artifactItemIds: [], usageObservations: [] });
      await brainWorker(db, async () => { await store.authorizeDispatch(job, request); await store.recordReceipt(job, priorReceipt); });
    }
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    const observer = new NamingBrainJobStore(workerDatabase, "fixture-deployment"), observationStart = requests.length;
    await brainWorker(db, async () => {
      expect(await observer.expireLeases("fixture-worker")).toBe(1);
      const recovered = await observer.claim("fixture-worker", 120);
      if (!recovered) throw new Error("synthetic_sibling_recovery_missing");
      const handler = createNamingBrainHandlers({ store: observer, apiKey: "synthetic-only", localPrototype: true, assertReady: async () => {} }).get(recovered.operation)!;
      const creation = handler.steps(recovered).find(row => row.key === "creation")!;
      expect(await observer.beginStep(recovered, creation.key, creation.maximumCostMicrousd)).toBe("started");
      const outcome = await creation.execute({ job: recovered, signal: new AbortController().signal });
      expect(outcome.status).toBe("needs_reconciliation"); await observer.completeStep(recovered, "creation", outcome);
    });
    const observedReads = requests.slice(observationStart);
    expect(observedReads.every(row => row.method === "GET")).toBe(true);
    for (const request of creatorRequests.slice(6)) expect(observedReads.map(row => row.path)).toContain(`/v1/agents/sessions/${sessionId(request.providerCallKey)}`);
    expect((await db.query("select artifact from fluid_private.naming_brain_artifacts where run_id=$1 and stage_key='creation' order by id", [input.runId])).rows).toEqual(saved);
    expect((await db.query("select recovery_mode from fluid_private.naming_brain_runs where id=$1", [input.runId])).rows).toEqual([{ recovery_mode: "observe_only" }]);
    sessions.get(creatorRequests[8]!.providerCallKey)!.status = "cancelled";
    await db.query("update fluid_private.naming_brain_runs set next_observation_at=clock_timestamp()-interval '1 second' where id=$1", [input.runId]);
    const terminalObserver = new NamingBrainJobStore(workerDatabase, "fixture-deployment");
    await brainWorker(db, async () => {
      const recovered = await terminalObserver.claim("fixture-worker", 120);
      if (!recovered) throw new Error("synthetic_terminal_sibling_recovery_missing");
      const handler = createNamingBrainHandlers({ store: terminalObserver, apiKey: "synthetic-only", localPrototype: true, assertReady: async () => {} }).get(recovered.operation)!;
      const creation = handler.steps(recovered).find(row => row.key === "creation")!;
      expect(await terminalObserver.beginStep(recovered, creation.key, creation.maximumCostMicrousd)).toBe("started");
      const outcome = await creation.execute({ job: recovered, signal: new AbortController().signal });
      expect(outcome.status).toBe("failed"); await terminalObserver.completeStep(recovered, "creation", outcome); await terminalObserver.finish(recovered, "partial");
    });
    expect(requests.slice(observationStart).every(row => row.method === "GET")).toBe(true);
    expect(requests.filter(row => row.method === "POST")).toHaveLength(posted);
    expect((await db.query("select artifact from fluid_private.naming_brain_artifacts where run_id=$1 and stage_key='creation' order by id", [input.runId])).rows).toEqual(saved);
    const terminal = await brainRpc<{ revision: number; canResume: boolean }>(db, "get_naming_brain_run", [project, input.runId]);
    expect(terminal.canResume).toBe(true);
    expect((await brainRpc<{ run: { runId: string } }>(db, "ensure_local_naming_brain_run", [project, initialIntent("synthetic-no-sibling-auto-retry")])).run.runId).toBe(input.runId);
    const intent = { ...initialIntent("synthetic-explicit-sibling-resume"), reason: "resume", resumeOfRunId: input.runId, expectedRunRevision: terminal.revision };
    const resumed = await brainRpc<{ status: string; run: { runId: string; resumedFromRunId: string } }>(db, "ensure_local_naming_brain_run", [project, intent]);
    expect(resumed.status).toBe("pending"); expect(resumed.run.resumedFromRunId).toBe(input.runId);
    expect(resumed.run.runId).not.toBe(input.runId);
    expect(requests.filter(row => row.method === "POST")).toHaveLength(posted);
    expect(admitted.run.runId).toBe(input.runId);
  // This case executes a complete migrated-database/SDK recovery scenario.
  // Its harness budget is separate from the provider and job clocks asserted above.
  }, 60_000);
});
