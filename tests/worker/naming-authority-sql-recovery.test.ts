import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { createTestDatabase, type TestDatabase } from "../database/local-supabase";
import { brainManifest, brainPolicy, brainRpc, brainWorker, initialIntent, seedBrainFixture } from "../database/naming-brain-fixture";
import { installAuthorityFixture } from "../database/naming-worker-authority-fixture";
import { createReceiptNativeFixture, receiptNativeConfigPath } from "../database/naming-receipt-native-fixture";
import type { JobDatabase } from "../../worker/postgres-store";
import { namingBrainJobInputSchema, namingProviderReceiptSchema } from "../../src/domain/naming-brain";
import { createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { buildNamingManagedRequest, createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { NamingContinuationUnavailableError } from "../../src/server/ai/naming-brain/continuation";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";

/** Both modes execute actual migrations/store/SDK/handler persistence. HTTP is
 * wholly synthetic. Native mode requires the reviewer's explicit exclusive slot
 * and qualified private config; preserve fixtures via the phase-one harness. */
describe(`Naming generation fences and known-session recovery (${receiptNativeConfigPath ? "native PostgreSQL18" : "PGlite"}, inert SDK HTTP)`, () => {
  let db: TestDatabase, native: Awaited<ReturnType<typeof createReceiptNativeFixture>> | undefined;
  let database: JobDatabase;
  let f: Awaited<ReturnType<typeof seed>>;
  beforeAll(async () => {
    native = receiptNativeConfigPath ? await createReceiptNativeFixture() : undefined;
    db = native?.db ?? await createTestDatabase();
    await installAuthorityFixture(db);
    database = native ? await native.connectWorker() : { query: (sql, values) => brainWorker(db, () => db.query(sql, values)) };
  }, 120_000);
  afterAll(async () => { if (native) await native.close(); else await db?.close(); }, 30_000);
  async function seed() {
    const project = await seedBrainFixture(db);
    let generation = 0;
    let beforeContinuationGateway: (() => Promise<void>) | undefined;
    const storeDatabase: JobDatabase = { async query(sql, values) {
      if (sql.includes("naming_brain_worker_maintenance_v2") && values?.[3] === "assert_continue") await beforeContinuationGateway?.();
      return database.query(sql, values);
    } };
    const store = new NamingBrainJobStore(storeDatabase, "fixture-deployment", () => generation ? { workerId: "fixture-worker", generation } : null);
    const acquired = await store.reportWorkerStatus(brainPolicy, "fixture-worker", null);
    expect(acquired.leader).toBe(true); expect(acquired.ready).toBe(true); generation = acquired.generation!;
    await store.attestPendingPreferences();
    await brainRpc(db, "ensure_naming_brain_run", [project, initialIntent()]);
    const job = await store.claim("fixture-worker", 120); if (!job) throw new Error("synthetic_versioned_claim_missing");
    const input = namingBrainJobInputSchema.parse(job.input);
    await store.registerPlan(job, brainManifest); await store.beginStep(job, "research", brainPolicy.stageLimits.research.maximumCostMicrousd);
    const request = createNamingRoleRequest({ runId: input.runId, stageKey: "research", providerCallKey: "research.runtime-authority", dependencyArtifactIds: [],
      input: { role: "researcher", snapshot: input.snapshot }, policy: createNamingRolePolicy(input.policy, "research", "researcher") });
    await store.saveCallPlan(job, "research", [request]); await store.authorizeDispatch(job, request);
    const prior = namingProviderReceiptSchema.parse({ version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents",
      runId: input.runId, stageKey: "research", role: "researcher", snapshotHash: input.snapshot.snapshotHash, providerCallKey: request.providerCallKey,
      requestKey: request.requestKey, requestHash: request.requestHash, assignmentKey: null, sessionLimitCents: request.policy.sessionLimitCents,
      dispatchState: "dispatched", requestId: null, sessionId: "sess_runtime_authority", turnId: "turn_runtime_authority", agentId: "agent_runtime_authority", responseId: null,
      callIds: [], observedModel: request.policy.model, toolCalls: [], artifactItemIds: [], usageObservations: [], estimatedCostMicrousd: null,
      providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: new Date().toISOString() });
    await store.recordReceipt(job, prior);
    const takeover = async () => {
      await db.exec("update fluid_private.naming_worker_leadership set expires_at=clock_timestamp()-interval '1 second'");
      const next = await store.reportWorkerStatus(brainPolicy, "fixture-worker", null);
      expect(next.generation).toBeGreaterThan(generation); generation = next.generation!;
    };
    return { project, store, job, input, request, prior, takeover, generation: () => generation,
      beforeContinuation: (callback: () => Promise<void>) => { beforeContinuationGateway = callback; } };
  }
  beforeEach(async () => { f = await seed(); }, 30_000);

  it("keeps the old claim sidecar fenced after same-worker reacquisition, heartbeat and resume", async () => {
    await expect(f.store.assertContinuation(f.job)).resolves.toBeUndefined();
    const old = (await db.query("select generation::text,lease_token::text from fluid_private.naming_worker_job_authority where job_id=$1", [f.job.id])).rows[0];
    await f.takeover(); await expect(f.store.assertContinuation(f.job)).rejects.toThrow("naming_continuation_unavailable");
    await f.store.heartbeat(f.job, 120); expect(await f.store.resumeExecution(f.job, "research")).toBe(false);
    await expect(f.store.assertContinuation(f.job)).rejects.toThrow("naming_continuation_unavailable");
    expect((await db.query("select generation::text,lease_token::text from fluid_private.naming_worker_job_authority where job_id=$1", [f.job.id])).rows[0]).toEqual(old);
  });

  it.skipIf(!receiptNativeConfigPath)("drains heartbeat, maintenance, renewal and stage reads through two real pooled backends under contention", async () => {
    if (!native || !receiptNativeConfigPath) throw new Error("explicit_native_fixture_required");
    const configuration = JSON.parse(await readFile(receiptNativeConfigPath, "utf8"));
    if (configuration.disposableCluster !== true || configuration.host !== "127.0.0.1") throw new Error("disposable_loopback_required");
    const pool = new Pool({ host: configuration.host, port: configuration.port, user: configuration.user, password: configuration.password,
      database: native.database, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 15_000, query_timeout: 15_000, idleTimeoutMillis: 1000 });
    const initialized = new WeakSet<object>(), pids = new Set<number>(); let maximumWaiting = 0, maximumClients = 0;
    const sample = () => { maximumWaiting = Math.max(maximumWaiting, pool.waitingCount); maximumClients = Math.max(maximumClients, pool.totalCount); };
    const pooled: JobDatabase = { async query(sql, values) {
      const acquiring = pool.connect(); sample(); const client = await acquiring;
      try {
        if (!initialized.has(client)) {
          const identity = (await client.query(`select pg_backend_pid() pid,host(inet_server_addr()) host,inet_server_port() port,
            current_setting('data_directory') directory,current_setting('cluster_name') cluster,
            current_setting('fsync') fsync,current_setting('full_page_writes') full_page_writes,current_setting('synchronous_commit') synchronous_commit,current_setting('wal_level') wal_level`)).rows[0];
          expect(identity).toMatchObject({ host: configuration.host, port: configuration.port, directory: configuration.expectedDataDirectory,
            cluster: configuration.expectedClusterName, fsync: "on", full_page_writes: "on", synchronous_commit: "on", wal_level: "replica" });
          pids.add(identity.pid); await client.query(`set session authorization ${native!.database}_a`); initialized.add(client);
        }
        sample(); return await client.query(sql, values);
      } finally { client.release(); sample(); }
    } };
    const store = new NamingBrainJobStore(pooled, "fixture-deployment", () => ({ workerId: "fixture-worker", generation: f.generation() }));
    let release: ReturnType<typeof setTimeout> | undefined;
    let releasing: Promise<void> | undefined, releaseFailed = false;
    try {
      await native.setup.query("begin"); await native.setup.query("select fluid_private.lock_strategy_owner($1)", [f.job.ownerId]);
      const requests = Promise.all([store.heartbeat(f.job, 120), store.loadStage(f.job, "research"), store.attestPendingPreferences(),
        store.expireLeases("fixture-worker"), store.reportWorkerStatus(brainPolicy, "fixture-worker", f.generation())]);
      // A real owner lock occupies both query backends before release; status /
      // maintenance requests must stay in the bounded two-connection pool.
      release = setTimeout(() => { releasing = native!.setup.query("commit").then(() => {}, () => { releaseFailed = true; }); }, 150);
      const [heartbeat, stage, attested, expired, status] = await requests;
      await releasing; expect(releaseFailed).toBe(false);
      expect(heartbeat.cancelled).toBe(false); expect(stage.requests).toContainEqual(f.request);
      expect(attested).toBe(0); expect(expired).toBe(0); expect(status.ready).toBe(true);
      expect(pids.size).toBe(2); expect(maximumClients).toBe(2); expect(maximumWaiting).toBeGreaterThan(0); expect(pool.waitingCount).toBe(0);
      const directory = new URL("../../.tmp/", import.meta.url); await mkdir(directory, { recursive: true });
      await writeFile(new URL(`naming-runtime-pool-${native.database}.json`, directory), JSON.stringify({
        event: "synthetic_naming_pool_pressure", fixtureDatabase: native.database, backendPids: [...pids], maximumClients, maximumWaiting,
        remainingWaiters: pool.waitingCount, ownerLockHeldMs: 150, scope: "real store RPC burst/owner-lock contention; not a steady-state throughput measurement",
      }, null, 2), { mode: 0o600 });
    } finally { clearTimeout(release); await releasing; await native.setup.query("rollback"); await pool.end(); }
  }, 30_000);

  it.each(["requires_action", "completed", "cancelled", "stop_before_guard", "stop_during_guard", "deadline"] as const)("preserves paid fences, historical hashes and correct cancellation for %s", async mode => {
    const terminal = ["completed", "cancelled"].includes(mode) ? mode : "requires_action";
    const explicitCancellation = mode.startsWith("stop_") || mode === "deadline";
    if (!explicitCancellation) await f.takeover();
    let stopped = false;
    const stop = async () => {
      if (stopped) return; stopped = true;
      await brainRpc(db, "stop_naming_feed", [f.project, { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: `runtime-${mode}-stop` }]);
    };
    if (mode === "stop_during_guard") f.beforeContinuation(stop);
    const before = (await db.query<{ id: string; content_hash: string }>("select id,content_hash from fluid_private.naming_brain_receipts where run_id=$1 order by id", [f.input.runId])).rows;
    const methods: string[] = [], posts: string[] = [], wire = buildNamingManagedRequest(f.request), sessionId = f.prior.sessionId!, turnId = f.prior.turnId!;
    const item = { id: "item_runtime_function", type: "function_call", status: "completed", turn_id: turnId, name: "read_reference", call_id: "call_runtime_function",
      arguments: JSON.stringify({ url: "https://en.wikipedia.org/wiki/Trail_blazing" }) };
    const final = { id: "item_runtime_final", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId,
      content: [{ type: "output_text", text: JSON.stringify({ role: "researcher", territories: [{ territoryId: "nature", title: "Nature", direction: "Synthetic nature", sourceKeys: [] },
        { territoryId: "rhythm", title: "Rhythm", direction: "Synthetic sound", sourceKeys: [] }], facts: [], interpretations: [], uncertainties: ["Synthetic offline fixture."] }) }] };
    const turn = { id: turnId, session_id: sessionId, agent_id: f.prior.agentId, subagent_id: null, object: "agent.session.turn", status: terminal === "requires_action" ? "waiting" : terminal,
      created_at: 1, started_at: 1, completed_at: terminal === "requires_action" ? null : 2, error: null, usage: null };
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-authority-only", fetch: async (incoming, init) => {
      const outgoing = new Request(incoming, init), path = new URL(outgoing.url).pathname; methods.push(outgoing.method);
      if (outgoing.method !== "GET") {
        const body = await outgoing.json() as { events: { type: string }[] };
        posts.push(...body.events.map(event => event.type));
        if (!explicitCancellation || body.events.some(event => event.type !== "agent.session.input.cancel")) throw new Error("synthetic_paid_post_forbidden");
        return new Response(null, { status: 202 });
      }
      if (path.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
      const value = path.endsWith("/items") ? { data: terminal === "requires_action" ? [item] : terminal === "completed" ? [final] : [], has_more: false }
        : path.endsWith("/turns") ? { data: [turn], has_more: false }
          : path.endsWith(`/turns/${turnId}`) ? turn
            : { id: sessionId, object: "agent.session", agent: { ...wire.agent, id: f.prior.agentId }, environment: wire.environment, metadata: wire.metadata,
              status: terminal === "requires_action" ? "requires_action" : "idle", required_actions: terminal === "requires_action"
                ? [{ type: "function_call", name: "read_reference", call_id: item.call_id, turn_id: turnId, arguments: { url: "https://en.wikipedia.org/wiki/Trail_blazing" } }] : [],
              spend_control: { limit: f.request.policy.sessionLimitCents, consumed: 0 }, usage: null };
      return Response.json(value);
    } });
    let runtimeNow = Date.now(); const cancellation = new AbortController(), detach = f.store.onCancellation(f.job, () => cancellation.abort());
    const runtime = createNamingAgentRuntime({ model: f.request.policy.model, protocol, persistence: f.store.runtimePersistence(f.job), now: () => runtimeNow, assertContinuation: async () => {
      if (mode === "stop_before_guard") await stop();
      if (mode === "deadline") { runtimeNow += f.request.policy.deadlineMs + 60_000; throw new NamingContinuationUnavailableError(); }
      await f.store.assertContinuation(f.job);
    } });
    let outcome;
    try { outcome = await runtime.resumeStage(f.prior, { signal: cancellation.signal, beforeDispatch: async () => { throw new Error("synthetic_new_create_forbidden"); },
      onReceipt: receipt => f.store.recordReceipt(f.job, receipt), onArtifact: artifact => f.store.saveProviderItem(f.job, artifact) }); }
    finally { detach(); }
    expect(outcome.status).toBe(terminal === "requires_action" ? "unresolved" : terminal);
    expect(methods.length).toBeGreaterThan(0);
    if (explicitCancellation) expect(posts).toEqual(["agent.session.input.cancel"]);
    else { expect(methods.every(method => method === "GET")).toBe(true); expect(posts).toEqual([]); }
    const after = (await db.query<{ id: string; content_hash: string }>("select id,content_hash from fluid_private.naming_brain_receipts where run_id=$1 order by id", [f.input.runId])).rows;
    for (const row of before) expect(after).toContainEqual(row);
    expect((await db.query<{ count: number }>("select count(*)::integer count from fluid_private.naming_brain_financial_evidence where run_id=$1", [f.input.runId])).rows[0]!.count).toBe(0);
  });
});
