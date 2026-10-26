import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// This suite intercepts global HTTP and exercises historical synthetic sessions;
// it cannot establish real provider budget support.
import { namingAssignmentOutputSchema, namingAssignmentPlanSchema, namingBrainJobInputSchema, namingProviderReceiptSchema, namingResearchOutputSchema, namingResearchPackSchema, namingStageRequestSchema, validateNamingAssignmentPlan } from "../../src/domain/naming-brain";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { buildNamingManagedRequest, createNamingRoleRequest, namingRequestHash } from "../../src/server/ai/naming-brain/prompts";
import { createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import type { ManagedCreateRequest } from "../../src/server/ai/naming-brain/protocol";
import { namingHash, namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { createNamingReferenceReader } from "../../src/server/ai/naming-brain/source-reader";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { historicalNamingClaimDatabase } from "../database/naming-brain-historical-claim";
import { NamingBrainJobStore, normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { createTestDatabase, OWNER_A, type TestDatabase } from "../database/local-supabase";
import { beginBrainStage, brainRpc, brainWorker, initialIntent, installBrainFixture, saveBrainArtifact, seedBrainFixture, startBrainFixture } from "../database/naming-brain-fixture";

// Synthetic HTTP only; every SQL request uses the migrated database and the real
// restricted worker. A partial Research artifact proves persistence, not live
// research quality or a completed Naming result.
describe("local Naming SDK session through handler, worker store and migrated SQL", () => {
  let db: TestDatabase;
  beforeEach(async () => { db = await createTestDatabase({ before: "20261017170000_local_progressive_naming.sql" }); await installBrainFixture(db); }, 30_000);
  afterEach(async () => { vi.unstubAllGlobals(); await db?.close(); });

  it.each([false, true])("persists long-stream Research and reuses the retained Director through recovery (reference=%s)", async withReference => {
    const project = await seedBrainFixture(db);
    const policy = guidedStrategyPolicy("strategy.reformulate");
    await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
    await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
    await db.exec("update public.usage_accounts set limit_microusd=0");
    const admitted = await brainRpc<{ status: string; run: { jobId: string; runId: string } }>(db, "ensure_local_naming_brain_run", [project, initialIntent("synthetic-local-sdk")]);
    expect(admitted.status).toBe("pending");
    const historical = (await db.query<{ input: { localPipelineVersion?: number } }>("select input from public.jobs where id=$1", [admitted.run.jobId])).rows;
    expect(historical[0]!.input.localPipelineVersion).toBeUndefined();
    await db.exec(await readFile(new URL("../../supabase/migrations/20261017170000_local_progressive_naming.sql", import.meta.url), "utf8"));
    expect((await db.query("select input from public.jobs where id=$1", [admitted.run.jobId])).rows).toEqual(historical);

    let wire: ManagedCreateRequest | undefined;
    let creates = 0, toolSubmissions = 0, referenceReplied = !withReference;
    const reads: string[] = [];
    const sessionId = "sess_synthetic_local_sql", turnId = "turn_synthetic_local_sql", agentId = "agent_synthetic_local_sql";
    const referenceCallId = "call_synthetic_reference", referenceItemId = "item_synthetic_reference", referenceUrl = "https://www.merriam-webster.com/dictionary/fixture";
    const sourceKey = `ref_${namingHash([sessionId, turnId, referenceCallId]).slice(0, 24)}`;
    const referenceItem = { id: referenceItemId, type: "function_call", status: "completed", turn_id: turnId, name: "read_reference", call_id: referenceCallId, arguments: JSON.stringify({ url: referenceUrl }) };
    const referenceHtml = "<html><head><title>Synthetic reference</title></head><body><main>A retained synthetic dictionary passage.</main></body></html>";
    const sourceReads: string[] = [];
    const referenceReader = createNamingReferenceReader({ localPrototype: true, resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      requestPage: async request => { sourceReads.push(request.url); return new Response(referenceHtml, { headers: { "content-type": "text/html; charset=utf-8" } }); } });
    const output = namingResearchOutputSchema.parse({ role: "researcher", territories: [
      { territoryId: "nature", title: "Synthetic nature", direction: "Explore the supplied synthetic natural territory.", sourceKeys: withReference ? [sourceKey] : [] },
      { territoryId: "sound", title: "Synthetic sound", direction: "Explore the supplied synthetic sound territory.", sourceKeys: [] },
    ], facts: [], interpretations: [], uncertainties: ["Synthetic fixture makes no verified factual claims."] });
    const turn = { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: "completed",
      created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null };
    const currentTurn = () => ({ ...turn, status: referenceReplied ? "completed" : "waiting", completed_at: referenceReplied ? 2 : null });
    const item = { id: "item_synthetic_local_sql", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId,
      content: [{ type: "output_text", text: JSON.stringify(output) }] };
    const session = () => ({ id: sessionId, object: "agent.session", agent: { ...wire!.agent, id: agentId }, environment: wire!.environment,
      metadata: wire!.metadata, status: referenceReplied ? "idle" : "requires_action", required_actions: referenceReplied ? [] : [{ type: "function_call", name: "read_reference", call_id: referenceCallId, turn_id: turnId, arguments: referenceItem.arguments }],
      usage: { input_tokens: 21, output_tokens: 6, total_tokens: 27 } });
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      expect(url.origin).toBe("https://api.openai.com");
      if (request.method === "POST" && url.pathname === "/v1/agents/sessions") {
        creates++;
        wire = await request.json() as ManagedCreateRequest;
        expect(Object.keys(wire).sort()).toEqual(["agent", "environment", "input", "metadata", "stream"]);
        expect(wire).toMatchObject({ environment: { type: "none" }, agent: { reasoning: { effort: "xhigh" }, multi_agent: { enabled: false },
          tools: [{ type: "web_search", mode: "live" }, { type: "function", name: "read_reference" }] }, metadata: { embel_budget_control: "local_unlimited_v1" }, stream: true });
        const events = [
          { type: "agent.session.created", session: session() },
          { type: "agent.session.turn.created", session_id: sessionId, turn_id: turnId, turn: { ...turn, status: "in_progress", completed_at: null } },
          // Ordinary reasoning frames carry no new retained semantic item. The
          // genuine SDK parser must reach the final output beyond the old cap.
          ...Array.from({ length: 2_200 }, () => ({ type: "agent.session.turn.reasoning_summary_text.delta", session_id: sessionId, turn_id: turnId,
            item_id: "item_synthetic_reasoning", output_index: 0, summary_index: 0, delta: "x" })),
          ...(withReference ? [
            { type: "agent.session.turn.item.done", session_id: sessionId, turn_id: turnId, output_index: 0, item: referenceItem },
            { type: "agent.session.requires_action", session: session() },
          ] : [
            { type: "agent.session.turn.item.done", session_id: sessionId, turn_id: turnId, output_index: 0, item },
            { type: "agent.session.turn.completed", session_id: sessionId, turn_id: turnId, turn, usage: null },
          ]),
        ].map((event, index) => `data: ${JSON.stringify({ ...event, event_id: `synthetic-local-${index}` })}\n\n`).join("");
        return new Response(events, { headers: { "content-type": "text/event-stream", "x-request-id": "req_synthetic_local_sql" } });
      }
      if (request.method === "POST") {
        expect(withReference).toBe(true); expect(url.pathname).toBe(`/v1/agents/sessions/${sessionId}/events`);
        const body = await request.json() as { events: { type: string; call_id: string; turn_id: string; output: string }[] };
        expect(body.events).toHaveLength(1);
        expect(body.events[0]).toMatchObject({ type: "agent.session.input.tool_result", call_id: referenceCallId, turn_id: turnId, success: true });
        expect(JSON.parse(body.events[0]!.output)).toMatchObject({ status: "retrieved", sourceKey, excerpt: "A retained synthetic dictionary passage." });
        toolSubmissions++; referenceReplied = true;
        return new Response(null, { status: 202 });
      }
      expect(request.method).toBe("GET");
      reads.push(url.pathname);
      const base = `/v1/agents/sessions/${sessionId}`;
      const value = url.pathname === base ? session()
        : url.pathname === `${base}/turns` ? { data: [currentTurn()], has_more: false }
          : url.pathname === `${base}/turns/${turnId}` ? currentTurn()
            : url.pathname === `${base}/turns/${turnId}/items` ? { data: [...(withReference ? [referenceItem] : []), ...(referenceReplied ? [item] : [])], has_more: false, last_id: referenceReplied ? item.id : referenceItemId } : null;
      if (!value) throw new Error("unexpected_synthetic_provider_route");
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", fetcher);

    // The no-reference case retains the default factory wiring proof. The
    // reference case substitutes only inert DNS/page I/O; SDK and SQL stay real.
    const store = new NamingBrainJobStore(await historicalNamingClaimDatabase(db), "fixture-deployment");
    const handlers = createNamingBrainHandlers({ store, apiKey: "synthetic-local-sdk-key", localPrototype: true, assertReady: async () => {},
      ...(withReference ? { runtime: (job, input) => createNamingAgentRuntime({ apiKey: "synthetic-local-sdk-key", model: input.policy.model, localPrototype: true, persistence: store.runtimePersistence(job), referenceReader, assertContinuation: () => store.assertContinuation(job) }) } : {}),
    });
    await brainWorker(db, async () => {
      const job = await store.claim("fixture-worker", 120);
      expect(job?.id).toBe(admitted.run.jobId);
      if (!job) throw new Error("synthetic_local_job_missing");
      const steps = handlers.get(job.operation)!.steps(job), research = steps.find(step => step.key === "research")!;
      await store.registerPlan(job, steps.map(({ key, maximumCostMicrousd }) => ({ key, maximumCostMicrousd })));
      expect(await store.beginStep(job, research.key, research.maximumCostMicrousd)).toBe("started");
      const outcome = await research.execute({ job, signal: new AbortController().signal });
      expect(outcome).toMatchObject({ status: "succeeded", costMicrousd: 0 });
      await store.completeStep(job, research.key, outcome);
      expect(await new NamingBrainJobStore(db, "fixture-deployment").beginStep(job, research.key, research.maximumCostMicrousd)).toBe("already_succeeded");
    });

    expect(creates).toBe(1);
    expect(reads).toContain(`/v1/agents/sessions/${sessionId}`);
    const calls = (await db.query<{ request: unknown }>("select request from fluid_private.naming_brain_calls where run_id=$1", [admitted.run.runId])).rows;
    expect(calls).toHaveLength(1);
    const saved = namingStageRequestSchema.parse(normalizeNamingStoredJson(calls[0]!.request));
    expect(saved.policy.budgetControl).toBe("local_unlimited_v1");
    expect(saved.requestHash).toBe(namingRequestHash(saved));
    expect(wire!.metadata?.embel_request_hash).toBe(saved.requestHash);
    const receipts = (await db.query<{ receipt: { budgetControl: string; accountingStatus: string; confirmedActualCostMicrousd: null } }>("select receipt from fluid_private.naming_brain_receipts where run_id=$1", [admitted.run.runId])).rows;
    expect(receipts.length).toBeGreaterThan(1);
    expect(receipts.every(({ receipt }) => receipt.budgetControl === "local_unlimited_v1" && receipt.accountingStatus === "provisional" && receipt.confirmedActualCostMicrousd === null)).toBe(true);
    const artifacts = (await db.query<{ artifact: unknown }>("select artifact from fluid_private.naming_brain_artifacts where run_id=$1", [admitted.run.runId])).rows;
    expect(artifacts).toHaveLength(1);
    const artifact = namingResearchPackSchema.parse(artifacts[0]!.artifact);
    expect(artifact).toMatchObject({ readiness: "partial", output, providerReceipt: { budgetControl: "local_unlimited_v1", sessionId, turnId, agentId, usageObservations: [expect.objectContaining({ totalTokens: 27 })] } });
    const toolResults = (await db.query<{ payload: { sourceEvidence: unknown } }>("select payload from fluid_private.naming_brain_provider_records where run_id=$1 and kind='tool_result'", [admitted.run.runId])).rows;
    expect(toolSubmissions).toBe(withReference ? 1 : 0); expect(toolResults).toHaveLength(withReference ? 1 : 0);
    expect(sourceReads).toEqual(withReference ? [referenceUrl] : []); expect(artifact.sources).toHaveLength(withReference ? 1 : 0);
    if (withReference) {
      expect(toolResults[0]!.payload.sourceEvidence).toEqual(artifact.sources[0]);
      expect(artifact.sources[0]).toMatchObject({ sourceKey, url: referenceUrl, providerItemId: referenceItemId, evidenceStatus: "retrieved", excerpt: "A retained synthetic dictionary passage.",
        contentHash: namingTextHash("A retained synthetic dictionary passage."), provenance: { sessionId, turnId, itemId: referenceItemId, observedUrl: referenceUrl },
        retrieval: { responseHash: namingTextHash(referenceHtml), extractorVersion: "embel-reference-text-v1" } });
      expect(artifact.providerReceipt.toolCalls).toEqual([{ callId: referenceCallId, providerItemId: referenceItemId, type: "function", status: "completed" }]);
    }
    expect((await db.query("select state from public.job_steps where job_id=$1", [admitted.run.jobId])).rows).toEqual([{ state: "succeeded" }]);
    expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_feed_entries where run_id=$1", [admitted.run.runId])).rows).toEqual([{ count: 0 }]);

    // Expire only the disposable database lease, then use the same reclaim and
    // stage-admission path as a restarted worker. Immutable research stays intact.
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [admitted.run.jobId]);
    const restarted = new NamingBrainJobStore(await historicalNamingClaimDatabase(db), "fixture-deployment");
    const recovered = await brainWorker(db, async () => {
      expect(await restarted.expireLeases("fixture-worker")).toBe(1);
      const recovered = await restarted.claim("fixture-worker", 120);
      expect(recovered?.id).toBe(admitted.run.jobId);
      if (!recovered) throw new Error("synthetic_local_recovery_missing");
      const steps = createNamingBrainHandlers({ store: restarted, assertReady: async () => {} }).get(recovered.operation)!.steps(recovered);
      const research = steps.find(step => step.key === "research")!, direction = steps.find(step => step.key === "direction")!;
      expect(await restarted.beginStep(recovered, research.key, research.maximumCostMicrousd)).toBe("already_succeeded");
      expect(await restarted.beginStep(recovered, direction.key, direction.maximumCostMicrousd)).toBe("started");
      return recovered;
    });
    expect(creates).toBe(1);
    expect((await db.query("select artifact from fluid_private.naming_brain_artifacts where run_id=$1", [admitted.run.runId])).rows).toEqual(artifacts);
    expect((await db.query("select request from fluid_private.naming_brain_calls where run_id=$1", [admitted.run.runId])).rows).toEqual(calls);
    expect((await db.query("select step_key,state from public.job_steps where job_id=$1 order by step_key", [admitted.run.jobId])).rows).toEqual([
      { step_key: "direction", state: "in_flight" }, { step_key: "research", state: "succeeded" },
    ]);

    {
      // An old completed Director session has no artifact yet because its first
      // observer rejected the original all-false novelty flags. Recover the exact
      // response through SDK GETs; never create a replacement Director session.
      const input = namingBrainJobInputSchema.parse(normalizeNamingStoredJson(recovered.input));
      const request = createNamingRoleRequest({ runId: input.runId, stageKey: "direction", providerCallKey: "direction-director",
        dependencyArtifactIds: [artifact.artifactId], input: { role: "director", snapshot: input.snapshot, research: artifact },
        policy: createNamingRolePolicy(input.policy, "direction", "director", undefined, undefined, true, input.localTimingVersion === 2 ? 900_000 : 240_000) });
      const directorWire = buildNamingManagedRequest(request);
      const directorOutput = namingAssignmentOutputSchema.parse({ role: "director", round: "initial", assignments: [{ assignmentKey: "synthetic-first-territory", primaryApproach: "real_words",
        additionalApproaches: [], territoryId: "nature", constructionKey: "whole-word", direction: "Explore the retained synthetic natural territory.", targetCount: 150,
        sourceKeys: withReference ? [sourceKey] : [], avoidPatterns: [], freshTerritory: false }], feedbackHypotheses: [] });
      const originalOutput = JSON.stringify(directorOutput), directorSessionId = "sess_synthetic_old_director", directorTurnId = "turn_synthetic_old_director", directorAgentId = "agent_synthetic_old_director";
      const directorTurn = { ...turn, id: directorTurnId, session_id: directorSessionId, agent_id: directorAgentId };
      const directorItem = { ...item, id: "item_synthetic_old_director", turn_id: directorTurnId, content: [{ type: "output_text", text: originalOutput }] };
      const directorSession = { id: directorSessionId, object: "agent.session", agent: { ...directorWire.agent, id: directorAgentId }, environment: directorWire.environment,
        metadata: directorWire.metadata, status: "idle", required_actions: [], usage: { input_tokens: 17, output_tokens: 12, total_tokens: 29 } };
      const priorReceipt = namingProviderReceiptSchema.parse({ ...artifact.providerReceipt, stageKey: "direction", role: "director", providerCallKey: request.providerCallKey,
        requestKey: request.requestKey, requestHash: request.requestHash, assignmentKey: null, sessionLimitCents: request.policy.sessionLimitCents,
        sessionId: directorSessionId, turnId: directorTurnId, agentId: directorAgentId, requestId: "req_synthetic_old_director", callIds: [], toolCalls: [], artifactItemIds: [], usageObservations: [] });
      await brainWorker(db, async () => {
        await restarted.saveCallPlan(recovered, "direction", [request]);
        await restarted.authorizeDispatch(recovered, request);
        await restarted.recordReceipt(recovered, priorReceipt);
      });
      const originalCalls = (await db.query("select request from fluid_private.naming_brain_calls where run_id=$1 order by stage_key", [input.runId])).rows;
      await db.query("update public.job_steps set created_at=clock_timestamp()-interval '5 minutes' where job_id=$1 and step_key='direction'", [recovered.id]);
      await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [recovered.id]);
      if (!withReference) await db.query("update fluid_private.naming_brain_heads set paused=true where project_id=$1", [project]);
      const directorReads: string[] = [];
      vi.stubGlobal("fetch", (async (incoming, init) => {
        const outgoing = new Request(incoming, init), url = new URL(outgoing.url), base = `/v1/agents/sessions/${directorSessionId}`;
        expect(url.origin).toBe("https://api.openai.com"); expect(outgoing.method).toBe("GET"); directorReads.push(url.pathname);
        if (url.pathname === `${base}/events`) return new Response("", { headers: { "content-type": "text/event-stream" } });
        const value = url.pathname === base ? directorSession : url.pathname === `${base}/turns/${directorTurnId}` ? directorTurn
          : url.pathname === `${base}/turns/${directorTurnId}/items` ? { data: [directorItem], has_more: false, last_id: directorItem.id }
            : url.pathname === `${base}/turns` ? { data: [directorTurn], has_more: false } : null;
        if (!value) throw new Error("unexpected_synthetic_director_route");
        return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      }) satisfies typeof fetch);
      const observer = new NamingBrainJobStore(await historicalNamingClaimDatabase(db), "fixture-deployment");
      await brainWorker(db, async () => {
        expect(await observer.expireLeases("fixture-worker")).toBe(1);
        const job = await observer.claim("fixture-worker", 120);
        if (!job) throw new Error("synthetic_director_observation_missing");
        const recoveringHandlers = createNamingBrainHandlers({ store: observer, apiKey: "synthetic-local-sdk-key", assertReady: async () => {} });
        const direction = recoveringHandlers.get(job.operation)!.steps(job).find(step => step.key === "direction")!;
        expect(await observer.beginStep(job, direction.key, direction.maximumCostMicrousd)).toBe("started");
        // Use the recovering store for every persistence callback, just as a new
        // worker process does after the expired lease has been reclaimed.
        const outcome = await recoveringHandlers.get(job.operation)!.steps(job).find(step => step.key === "direction")!.execute({ job, signal: new AbortController().signal });
        expect(outcome).toMatchObject({ status: "succeeded", costMicrousd: 0 });
        // Completion commits before this deliberate acknowledgement failure. A
        // new process must recover without a succeeded/observe_only crash gap.
        if (withReference) {
          const lostAck = vi.spyOn(observer, "heartbeat").mockRejectedValueOnce(new Error("synthetic_lost_completion_ack"));
          try { await expect(observer.completeStep(job, "direction", outcome)).rejects.toThrow("synthetic_lost_completion_ack"); }
          finally { lostAck.mockRestore(); }
        } else {
          await observer.completeStep(job, "direction", outcome);
          await expect(observer.assertContinuation(job)).rejects.toThrow("naming_observe_only");
          const creation = recoveringHandlers.get(job.operation)!.steps(job).find(step => step.key === "creation")!;
          await expect(observer.beginStep(job, creation.key, creation.maximumCostMicrousd)).rejects.toMatchObject({ message: "runtime_unavailable" });
        }
      });
      expect((await db.query("select recovery_mode from fluid_private.naming_brain_runs where id=$1", [input.runId])).rows).toEqual([{ recovery_mode: withReference ? "execute" : "observe_only" }]);
      const directionArtifact = (await db.query<{ artifact: unknown }>("select artifact from fluid_private.naming_brain_artifacts where run_id=$1 and stage_key='direction'", [input.runId])).rows;
      expect(directionArtifact).toHaveLength(1);
      const savedPlan = namingAssignmentPlanSchema.parse(directionArtifact[0]!.artifact);
      expect(JSON.stringify(savedPlan.output)).toBe(originalOutput);
      expect(savedPlan.output.assignments.every(row => row.freshTerritory === false)).toBe(true);
      expect(savedPlan.output.assignments[0]!.sourceKeys).toEqual(withReference ? [sourceKey] : []);
      expect(directorReads).toContain(`/v1/agents/sessions/${directorSessionId}`);
      expect((await db.query("select request from fluid_private.naming_brain_calls where run_id=$1 order by stage_key", [input.runId])).rows).toEqual(originalCalls);
      if (withReference) {
        await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [recovered.id]);
        const afterCrash = new NamingBrainJobStore(await historicalNamingClaimDatabase(db), "fixture-deployment");
        const pendingSibling = await brainWorker(db, async () => {
          expect(await afterCrash.expireLeases("fixture-worker")).toBe(1);
          const job = await afterCrash.claim("fixture-worker", 120);
          if (!job) throw new Error("synthetic_completed_director_reclaim_missing");
          const steps = createNamingBrainHandlers({ store: afterCrash, assertReady: async () => {} }).get(job.operation)!.steps(job);
          for (const key of ["research", "direction"] as const) {
            const step = steps.find(row => row.key === key)!;
            expect(await afterCrash.beginStep(job, key, step.maximumCostMicrousd)).toBe("already_succeeded");
          }
          const creation = steps.find(row => row.key === "creation")!;
          expect(await afterCrash.beginStep(job, creation.key, creation.maximumCostMicrousd)).toBe("started");
          await afterCrash.assertContinuation(job);
          const assignment = validateNamingAssignmentPlan(input.snapshot, artifact, savedPlan)[0]!;
          const creatorRequest = createNamingRoleRequest({ runId: input.runId, stageKey: "creation", providerCallKey: `creation-creator-${assignment.assignmentKey}`,
            dependencyArtifactIds: [artifact.artifactId, savedPlan.artifactId], input: { role: "creator", snapshot: input.snapshot, assignment },
            policy: createNamingRolePolicy(input.policy, "creation", "creator", assignment.targetCount, 0, true, input.localTimingVersion === 2 ? 900_000 : 240_000) });
          await afterCrash.saveCallPlan(job, "creation", [creatorRequest]);
          await afterCrash.authorizeDispatch(job, creatorRequest);
          return { job, creatorRequest };
        });
        // A newly issued sibling has no observed outcome. An old succeeded
        // Director must never unlock execution around that unknown call.
        await db.query("update fluid_private.naming_brain_runs set recovery_mode='observe_only' where id=$1", [input.runId]);
        await brainWorker(db, async () => {
          await afterCrash.loadStage(pendingSibling.job, "direction");
          expect(await afterCrash.resumeExecution(pendingSibling.job, "direction")).toBe(false);
          await expect(afterCrash.assertContinuation(pendingSibling.job)).rejects.toThrow("naming_observe_only");
          await expect(afterCrash.authorizeDispatch(pendingSibling.job, pendingSibling.creatorRequest)).rejects.toThrow("naming_dispatch_unavailable");
        });
        expect((await db.query("select recovery_mode from fluid_private.naming_brain_runs where id=$1", [input.runId])).rows).toEqual([{ recovery_mode: "observe_only" }]);
      }
      expect(creates).toBe(1);
      expect((await db.query("select request from fluid_private.naming_brain_calls where run_id=$1 and stage_key in('research','direction') order by stage_key", [input.runId])).rows).toEqual(originalCalls);
    }
  });

  it("keeps the native SQL Direction gate closed for a partial Research artifact", async () => {
    await db.exec(await readFile(new URL("../../supabase/migrations/20261017170000_local_progressive_naming.sql", import.meta.url), "utf8"));
    const project = await seedBrainFixture(db), job = await startBrainFixture(db, project);
    const output = namingResearchOutputSchema.parse({ role: "researcher", territories: [
      { territoryId: "nature", title: "Synthetic nature", direction: "Explore a creative natural association.", sourceKeys: [] },
      { territoryId: "sound", title: "Synthetic sound", direction: "Explore a creative sound association.", sourceKeys: [] },
    ], facts: [], interpretations: [], uncertainties: ["Synthetic partial research."] });
    await saveBrainArtifact(db, job, "research", output, { readiness: "partial", sources: [] });
    await expect(beginBrainStage(db, job, "direction")).rejects.toMatchObject({ code: "55000", message: "sourced_research_required" });
    expect((await db.query("select count(*)::integer count from public.job_steps where job_id=$1 and step_key='direction'", [job.id])).rows).toEqual([{ count: 0 }]);
  });
});
