import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainJobInputSchema, type NamingStageRequest } from "../../src/domain/naming-brain";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { createNamingManagedProtocol, type ManagedCreateRequest } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { NamingBrainJobStore, normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { createTestDatabase, OWNER_A, type TestDatabase } from "../database/local-supabase";
import { brainRpc, brainWorker, initialIntent, installBrainFixture, seedBrainFixture } from "../database/naming-brain-fixture";
import { historicalNamingClaimDatabase } from "../database/naming-brain-historical-claim";

const migration = "20261017160000_local_naming_generous_timing.sql";

// Provider HTTP and elapsed time are synthetic. Admission, immutable input,
// authorization clocks, receipts, provider history and artifacts use real SQL.
describe("future local clocks through the actual SDK, handler and SQL", () => {
  let db: TestDatabase, historical: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ before: "20261017170000_local_progressive_naming.sql" }); await installBrainFixture(db);
    historical = await createTestDatabase({ before: migration }); await installBrainFixture(historical);
  }, 60_000);
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await Promise.all([db?.close(), historical?.close()]); });

  async function prepare(database: TestDatabase, local: boolean) {
    const project = await seedBrainFixture(database), policy = guidedStrategyPolicy("strategy.reformulate");
    if (local) {
      await database.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
      await database.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
    }
    const admitted = await brainRpc<{ run: { runId: string; jobId: string } }>(database, local ? "ensure_local_naming_brain_run" : "ensure_naming_brain_run", [project, initialIntent("synthetic-generous-sdk")]);
    const store = new NamingBrainJobStore(await historicalNamingClaimDatabase(database), "fixture-deployment");
    const job = await brainWorker(database, async () => {
      const claimed = await store.claim("fixture-worker", 120); if (!claimed) throw new Error("synthetic_timed_job_missing");
      return claimed;
    });
    expect(job.id).toBe(admitted.run.jobId);
    return { store, job, input: namingBrainJobInputSchema.parse(normalizeNamingStoredJson(job.input)) };
  }

  async function execute(database: TestDatabase, value: Awaited<ReturnType<typeof prepare>>, local: boolean, completionDelay: number) {
    let wire: ManagedCreateRequest, request: NamingStageRequest | undefined, creates = 0, cancellations = 0, cancelled = false, completed = false;
    let clock = Date.now();
    let started!: () => void;
    const posted = new Promise<void>(resolve => { started = resolve; });
    const sessionId = "sess_synthetic_generous_sql", turnId = "turn_synthetic_generous_sql", agentId = "agent_synthetic_generous_sql";
    const output = { role: "researcher", territories: [
      { territoryId: "nature", title: "Synthetic nature", direction: "Explore synthetic natural associations.", sourceKeys: [] },
      { territoryId: "sound", title: "Synthetic sound", direction: "Explore synthetic sound associations.", sourceKeys: [] },
    ], facts: [], interpretations: [], uncertainties: ["Synthetic fixture makes no factual claims."] };
    const turn = () => ({ id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: cancelled ? "cancelled" : completed ? "completed" : "in_progress",
      created_at: 1, started_at: 1, completed_at: cancelled || completed ? 2 : null, error: null, usage: null });
    const item = { id: "item_synthetic_generous_sql", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId, content: [{ type: "output_text", text: JSON.stringify(output) }] };
    const session = () => ({ id: sessionId, object: "agent.session", agent: { ...wire.agent, id: agentId }, environment: wire.environment, metadata: wire.metadata,
      ...(wire.spend_control ? { spend_control: wire.spend_control } : {}), status: cancelled || completed ? "idle" : "running", required_actions: [], usage: null });
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: local, fetch: async (incoming, init) => {
      const outgoing = new Request(incoming, init), url = new URL(outgoing.url);
      expect(url.origin).toBe("https://api.openai.com");
      if (outgoing.method === "POST" && url.pathname === "/v1/agents/sessions") {
        creates++; wire = await outgoing.json() as ManagedCreateRequest;
        let eventId = 0;
        let closed = false;
        const stream = new ReadableStream<Uint8Array>({ start(controller) {
          const send = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event as object, event_id: `synthetic-generous-${eventId++}` })}\n\n`));
          send({ type: "agent.session.created", session: session() });
          send({ type: "agent.session.turn.created", session_id: sessionId, turn_id: turnId, turn: { ...turn(), status: "in_progress", completed_at: null } });
          const timer = setTimeout(() => {
            completed = true;
            send({ type: "agent.session.turn.item.done", session_id: sessionId, turn_id: turnId, output_index: 0, item });
            send({ type: "agent.session.turn.completed", session_id: sessionId, turn_id: turnId, turn: turn(), usage: null }); closed = true; controller.close();
          }, completionDelay);
          outgoing.signal.addEventListener("abort", () => { clearTimeout(timer); if (!closed) { closed = true; controller.close(); } }, { once: true });
        } });
        started(); return new Response(stream, { headers: { "content-type": "text/event-stream", "x-request-id": "req_synthetic_generous_sql" } });
      }
      if (outgoing.method === "POST") {
        expect(url.pathname).toBe(`/v1/agents/sessions/${sessionId}/events`);
        expect(await outgoing.json()).toEqual({ events: [{ type: "agent.session.input.cancel" }] });
        cancellations++; cancelled = true; return new Response(null, { status: 202 });
      }
      expect(outgoing.method).toBe("GET");
      const base = `/v1/agents/sessions/${sessionId}`;
      const result = url.pathname === base ? session() : url.pathname === `${base}/turns` ? { data: [turn()], has_more: false }
        : url.pathname === `${base}/turns/${turnId}` ? turn() : url.pathname.endsWith("/items") ? { data: completed ? [item] : [], has_more: false, last_id: completed ? item.id : null } : null;
      if (!result) throw new Error("unexpected_synthetic_timing_route");
      return Response.json(result);
    } });
    const handlers = createNamingBrainHandlers({ store: value.store, localPrototype: local, assertReady: async () => {}, runtime: (job, input) => {
      const runtime = createNamingAgentRuntime({ protocol, model: input.policy.model, localPrototype: local, persistence: value.store.runtimePersistence(job), now: () => clock });
      return { ...runtime, runStage: async (submitted, hooks) => { request = submitted; return runtime.runStage(submitted, hooks); } };
    } });
    await brainWorker(database, async () => {
      const steps = handlers.get(value.job.operation)!.steps(value.job), research = steps.find(row => row.key === "research")!;
      await value.store.registerPlan(value.job, steps.map(({ key, maximumCostMicrousd }) => ({ key, maximumCostMicrousd })));
      expect(await value.store.beginStep(value.job, "research", research.maximumCostMicrousd)).toBe("started");
      // Advance the provider runtime and its timers; SQL's authoritative lease
      // and authorization clock retain their actual disposable database time.
      clock = Date.now(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const advance = async (milliseconds: number) => { clock += milliseconds; await vi.advanceTimersByTimeAsync(milliseconds); };
      let settled = false;
      const pending = research.execute({ job: value.job, signal: new AbortController().signal }).finally(() => { settled = true; });
      void pending.catch(() => {});
      await posted;
      await advance(239_000); expect(settled).toBe(false); expect(cancellations).toBe(0);
      if (request!.policy.deadlineMs === 900_000) {
        await advance(1_001); expect(settled).toBe(false); expect(cancellations).toBe(0);
        await advance(completionDelay - 240_001 + 1);
      } else await advance(2_000);
      const outcome = await pending;
      vi.useRealTimers();
      expect(outcome.status).toBe(request!.policy.deadlineMs === 900_000 ? "succeeded" : "failed");
      await value.store.completeStep(value.job, "research", outcome);
    });
    return { request: request!, creates, cancellations };
  }

  it("keeps a new local SDK call alive beyond4min and persists its real330s completion", async () => {
    const value = await prepare(db, true); expect(value.input.localTimingVersion).toBe(2);
    expect(value.input.localPipelineVersion).toBeUndefined();
    const before = (await db.query("select input from public.jobs where id=$1", [value.job.id])).rows;
    await db.exec(await readFile(new URL("../../supabase/migrations/20261017170000_local_progressive_naming.sql", import.meta.url), "utf8"));
    expect((await db.query("select input from public.jobs where id=$1", [value.job.id])).rows).toEqual(before);
    const result = await execute(db, value, true, 330_000);
    expect(result.request.policy.deadlineMs).toBe(900_000); expect(result.creates).toBe(1); expect(result.cancellations).toBe(0);
    const calls = (await db.query<{ request: NamingStageRequest; authorized_at: Date }>("select request,authorized_at from fluid_private.naming_brain_calls where run_id=$1", [value.input.runId])).rows;
    expect(calls).toHaveLength(1); expect(calls[0]!.request).toEqual(result.request);
    const artifacts = (await db.query<{ artifact: { providerReceipt: { recordedAt: string } } }>("select artifact from fluid_private.naming_brain_artifacts where run_id=$1", [value.input.runId])).rows;
    expect(artifacts).toHaveLength(1);
    expect(Date.parse(artifacts[0]!.artifact.providerReceipt.recordedAt) - new Date(calls[0]!.authorized_at).getTime()).toBeGreaterThan(240_000);
    expect((await db.query("select state from public.job_steps where job_id=$1 and step_key='research'", [value.job.id])).rows).toEqual([{ state: "succeeded" }]);
  });

  it("reconstructs an already-admitted historical local input at240s after installing the new migration", async () => {
    const value = await prepare(historical, true); expect(value.input.localTimingVersion).toBeUndefined();
    const before = (await historical.query("select input from public.jobs where id=$1", [value.job.id])).rows;
    await historical.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
    await historical.exec(await readFile(new URL("../../supabase/migrations/20261017170000_local_progressive_naming.sql", import.meta.url), "utf8"));
    expect((await historical.query("select input from public.jobs where id=$1", [value.job.id])).rows).toEqual(before);
    const result = await execute(historical, value, true, 330_000);
    expect(result.request.policy.deadlineMs).toBe(240_000); expect(result.creates).toBe(1); expect(result.cancellations).toBe(1);
    expect((await historical.query("select count(*)::int count from fluid_private.naming_brain_artifacts where run_id=$1", [value.input.runId])).rows).toEqual([{ count: 0 }]);
  });

  it("retains the native SDK four-minute cutoff without the future local witness", async () => {
    const value = await prepare(db, false); expect(value.input.localTimingVersion).toBeUndefined();
    const result = await execute(db, value, false, 330_000);
    expect(result.request.policy.deadlineMs).toBe(240_000); expect(result.request.policy.budgetControl).toBeUndefined();
    expect(result.creates).toBe(1); expect(result.cancellations).toBe(1);
    expect((await db.query("select count(*)::int count from fluid_private.naming_brain_artifacts where run_id=$1", [value.input.runId])).rows).toEqual([{ count: 0 }]);
  });
});
