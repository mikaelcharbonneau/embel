import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { createNamingBrainPolicy, createNamingRolePolicy, NAMING_GAP_ENVELOPE } from "../../src/server/ai/naming-brain/policy";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { namingBrainJobInputSchema, namingStageKeySchema } from "../../src/domain/naming-brain";
import type { NamingSavedStage } from "../../worker/naming-brain-store";
import { id, receipt, snapshot } from "../domain/naming-brain-fixtures";
const input = () => namingBrainJobInputSchema.parse({ version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api", runId: id(3), jobId: id(4), batchId: id(5), snapshot: snapshot(), acceptedPolicyIdentity: "a".repeat(64), policy: createNamingBrainPolicy("fixture-selected-model") });
const row = () => ({ id: id(4), owner_id: id(1), project_id: id(2), operation: "naming.generate", input: input(), input_revision: 1, lease_token: id(9), state: "running", reserved_cost_microusd: 5_000_000, actual_cost_microusd: 0, billing_mode: "openai_api" });
describe("Naming scoped worker store", () => {
  it("claims only V2 and never uses generic finish/settlement", async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const store = new NamingBrainJobStore({ query: async (sql, values = []) => { calls.push({ sql, values }); return { rows: [{ result: sql.includes("claim_naming") ? { mode: "execute", job: row() } : values[2] === "heartbeat" ? { ...row(), recoveryMode: "execute", observationDeadlineAt: null } : { state: "succeeded" } }] }; } }, "deployment-fixture");
    const job = await store.claim("worker-fixture", 120); expect(job?.id).toBe(id(4)); await store.finish(job!, "succeeded");
    expect(calls[2]!.sql).toContain("naming_brain_worker_action"); expect(calls[2]!.values[2]).toBe("finish");
    expect(calls.every(call => !call.sql.includes("public.finish_job") && !call.sql.includes("settle_reservation"))).toBe(true);
  });
  it("refuses another operation despite an apparently successful claim", async () => {
    const store = new NamingBrainJobStore({ query: async () => ({ rows: [{ result: { mode: "execute", job: { ...row(), operation: "strategy.reformulate" } } }] }) }, "deployment-fixture");
    await expect(store.claim("worker-fixture", 120)).rejects.toThrow();
  });
  it("does not pass the numeric runner subtotal as expense certification", async () => {
    const calls: unknown[][] = [];
    const store = new NamingBrainJobStore({ query: async (_sql, values = []) => { calls.push(values); return { rows: [{ result: calls.length === 1 ? { mode: "execute", job: row() } : {} }] }; } }, "deployment-fixture");
    const job = await store.claim("worker-fixture", 120);
    await store.completeStep(job!, "research", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } });
    expect(calls[1]).toHaveLength(5); expect(JSON.parse(calls[1]![4] as string)).toEqual({ artifactIds: [] });
  });
  it("honors a refused resume gate even when the prior durable mode is still execute", async () => {
    const store = new NamingBrainJobStore({ query: async (sql) => ({ rows: [{ result: sql.includes("claim_naming") ? { mode: "execute", job: row() } : { recoveryMode: "execute", resumed: false } }] }) }, "deployment-fixture");
    const job = (await store.claim("fixture", 120))!;
    expect(await store.resumeExecution(job, "creation")).toBe(false);
  });
  it.each([false, true])("keeps the receipt reader bound to the immutable progressive profile (%s)", async progressive => {
    const savedInput = namingBrainJobInputSchema.parse({ ...input(), ...(progressive ? { localTimingVersion: 2, localPipelineVersion: 2 } : {}) });
    const savedRow = { ...row(), input: savedInput };
    const observed = { ...receipt("creation", "creator"), ...(progressive ? { budgetControl: "local_unlimited_v1", localPipelineVersion: 2 } : {}) };
    const stage = { stageKey: "creation", state: "in_flight", requestKey: null, startedAt: new Date().toISOString(), maximumCostMicrousd: savedInput.policy.stageLimits.creation.maximumCostMicrousd,
      recoveryMode: "observe_only", observationDeadlineAt: new Date(Date.now() + 60_000).toISOString(), stageResults: [], preparation: null, artifacts: [],
      receipts: Array.from({ length: progressive ? 5000 : 500 }, (_, index) => ({ ...observed, recordedAt: new Date(Date.UTC(2026, 9, 18) + index).toISOString() })),
      requests: [], authorizations: [], providerItems: [], providerTurns: [], toolResults: [], callPlans: [], gapEnvelope: NAMING_GAP_ENVELOPE, gapPlanIdentity: "b".repeat(64) };
    const store = new NamingBrainJobStore({ query: async sql => ({ rows: [{ result: sql.includes("claim_naming") ? { mode: "observe_only", executionAuthority: progressive ? "local_owner_v1" : null, job: savedRow } : stage }] }) }, "deployment-fixture");
    const job = (await store.claim("fixture", 120))!;
    const loaded = await store.loadStage(job, "creation");
    expect(loaded.receipts).toEqual(stage.receipts);
    expect(loaded.recoveryMode).toBe("observe_only");
    stage.receipts.push({ ...observed, recordedAt: new Date(Date.UTC(2026, 9, 19)).toISOString() });
    await expect(store.loadStage(job, "creation")).rejects.toThrow();
  });
  it("conveys durable observe-only mode to the managed adapter before the original stage deadline", async () => {
    const store = new NamingBrainJobStore({ query: async () => ({ rows: [{ result: { mode: "execute", job: row() } }] }) }, "deployment-fixture");
    const job = (await store.claim("fixture", 120))!;
    const stages: NamingSavedStage[] = namingStageKeySchema.options.map(stageKey => ({ stageKey, state: "pending", requestKey: null, startedAt: new Date().toISOString(), maximumCostMicrousd: input().policy.stageLimits[stageKey].maximumCostMicrousd,
      recoveryMode: "observe_only", observationDeadlineAt: new Date(Date.now() + 60_000).toISOString(), stageResults: [], preparation: null, artifacts: [], receipts: [], requests: [], providerItems: [], providerTurns: [], toolResults: [], callPlans: [], gapEnvelope: { version: 1, phases: NAMING_GAP_ENVELOPE.phases.map(phase => ({ ...phase })) }, gapPlanIdentity: "b".repeat(64) }));
    vi.spyOn(store, "loadStages").mockResolvedValue(stages);
    expect(await store.runtimePersistence(job).load({ runId: input().runId, stageKey: "research", providerCallKey: "synthetic-research", requestHash: "b".repeat(64) })).toMatchObject({ recoveryMode: "observe_only", startedAt: stages[0]!.startedAt });
  });
  it("binds a local call clock to its committed authorization and refuses missing or foreign timing metadata", async () => {
    const store = new NamingBrainJobStore({ query: async () => ({ rows: [{ result: { mode: "execute", job: row() } }] }) }, "deployment-fixture");
    const job = (await store.claim("fixture", 120))!, saved = input();
    const request = createNamingRoleRequest({ runId: saved.runId, stageKey: "research", providerCallKey: "synthetic-research", dependencyArtifactIds: [], input: { role: "researcher", snapshot: saved.snapshot }, policy: createNamingRolePolicy(saved.policy, "research", "researcher", undefined, undefined, true) });
    const startedAt = new Date(Date.now() - 300_000).toISOString(), authorizedAt = new Date().toISOString();
    const stage: NamingSavedStage = { stageKey: "research", state: "in_flight", requestKey: null, startedAt, maximumCostMicrousd: saved.policy.stageLimits.research.maximumCostMicrousd, recoveryMode: "execute", observationDeadlineAt: null,
      stageResults: [], preparation: null, artifacts: [], receipts: [], requests: [request], authorizations: [{ providerCallKey: request.providerCallKey, requestHash: request.requestHash, authorizedAt }], providerItems: [], providerTurns: [], toolResults: [], callPlans: [], gapEnvelope: { version: 1, phases: NAMING_GAP_ENVELOPE.phases.map(phase => ({ ...phase })) }, gapPlanIdentity: "b".repeat(64) };
    vi.spyOn(store, "loadStages").mockImplementation(async () => [stage]);
    expect(await store.runtimePersistence(job).load(request)).toMatchObject({ startedAt, authorizedAt });
    stage.authorizations = [];
    await expect(store.runtimePersistence(job).load(request)).rejects.toThrow("naming_authorization_timestamp_missing");
    stage.authorizations = [{ providerCallKey: request.providerCallKey, requestHash: "b".repeat(64), authorizedAt }];
    await expect(store.runtimePersistence(job).load(request)).rejects.toThrow("naming_authorization_timestamp_missing");
  });
  it("keeps three concurrent full-stage reads fair to heartbeat acquisition in a three-connection pool", async () => {
    vi.useFakeTimers();
    try {
      let inUse = 0, maxInUse = 0, maxQueued = 0, timeouts = 0, heartbeatAt = Infinity;
      const waiters: (() => void)[] = []; let jobLock = Promise.resolve(); const began = Date.now();
      const release = () => { const next = waiters.shift(); if (next) next(); else inUse--; };
      const acquire = () => new Promise<() => void>((resolve, reject) => {
        if (inUse < 3) { maxInUse = Math.max(maxInUse, ++inUse); resolve(release); return; }
        const ready = () => { clearTimeout(timer); resolve(release); };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(ready), 1); timeouts++; reject(new Error("synthetic_connection_acquire_timeout")); }, 100);
        waiters.push(ready); maxQueued = Math.max(maxQueued, waiters.length);
      });
      const store = new NamingBrainJobStore({ query: async (sql, values = []) => {
        if (sql.includes("claim_naming")) return { rows: [{ result: { mode: "execute", job: row() } }] };
        const free = await acquire(), previous = jobLock;
        let unlock!: () => void; jobLock = new Promise<void>(resolve => { unlock = resolve; });
        await previous;
        try {
          // Each scoped SQL action locks the same job; connection wait and row
          // wait are distinct, just as in the real pool.
          await new Promise(resolve => setTimeout(resolve, 20));
          if (values[2] === "heartbeat") { heartbeatAt = Date.now() - began; return { rows: [{ result: { ...row(), recoveryMode: "execute", observationDeadlineAt: null } }] }; }
          const { stageKey } = JSON.parse(String(values[3])) as { stageKey: (typeof namingStageKeySchema.options)[number] };
          return { rows: [{ result: { stageKey, state: "pending", requestKey: null, startedAt: new Date().toISOString(), maximumCostMicrousd: input().policy.stageLimits[stageKey].maximumCostMicrousd,
            recoveryMode: "execute", observationDeadlineAt: null, stageResults: [], preparation: null, artifacts: [], receipts: [], requests: [], authorizations: [], providerItems: [], providerTurns: [], toolResults: [], callPlans: [],
            gapEnvelope: { version: 1, phases: NAMING_GAP_ENVELOPE.phases.map(phase => ({ ...phase })) }, gapPlanIdentity: "b".repeat(64) } }] };
        } finally { unlock(); free(); }
      } }, "deployment-fixture");
      const job = (await store.claim("fixture", 120))!;
      const work = Promise.all([store.loadStages(job), store.loadStages(job), store.loadStages(job), store.heartbeat(job, 120)]);
      await vi.runAllTimersAsync(); const [first, second, third, heartbeat] = await work;
      for (const stages of [first, second, third]) expect(stages.map(stage => stage.stageKey)).toEqual(namingStageKeySchema.options);
      expect(heartbeat).toEqual({ cancelled: false }); expect(maxInUse).toBe(3); expect(maxQueued).toBeLessThanOrEqual(1);
      expect(timeouts).toBe(0); expect(heartbeatAt).toBeLessThan(100);
    } finally { vi.useRealTimers(); }
  });
  it.each(["execute", "observe_only"] as const)("refreshes recovered completion from the authoritative %s heartbeat without another resume mutation", async recoveryMode => {
    const actions: string[] = [];
    const store = new NamingBrainJobStore({ query: async (sql, values = []) => {
      if (sql.includes("claim_naming")) return { rows: [{ result: { mode: "observe_only", job: row() } }] };
      if (sql.includes("complete_naming")) return { rows: [{ result: { state: "succeeded" } }] };
      actions.push(String(values[2]));
      return { rows: [{ result: { ...row(), recoveryMode, observationDeadlineAt: null } }] };
    } }, "deployment-fixture");
    const job = (await store.claim("fixture", 120))!;
    await store.completeStep(job, "direction", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } });
    if (recoveryMode === "execute") await expect(store.assertContinuation(job)).resolves.toBeUndefined();
    else await expect(store.assertContinuation(job)).rejects.toThrow("naming_observe_only");
    expect(actions).toEqual(["heartbeat", "heartbeat"]);
  });
});


it("observes a stopped known session while conveying durable Stop to the adapter and final finish", async () => {
  const writes: unknown[][] = [];
  const store = new NamingBrainJobStore({ query: async (sql, values = []) => {
    writes.push(values);
    return { rows: [{ result: sql.includes("claim_naming") ? { mode: "observe_only", job: { ...row(), state: "cancel_requested" } } : values[2] === "heartbeat" ? { ...row(), state: "cancel_requested", recoveryMode: "observe_only", observationDeadlineAt: null } : {} }] };
  } }, "deployment-fixture");
  const job = (await store.claim("fixture", 120))!;
  let cancellations = 0; const detach = store.onCancellation(job, () => { cancellations++; });
  expect(cancellations).toBe(1);
  expect(await store.heartbeat(job, 120)).toEqual({ cancelled: false });
  await expect(store.assertContinuation(job)).rejects.toThrow("naming_observe_only");
  detach(); await store.finish(job, "succeeded");
  expect(JSON.parse(String(writes.at(-1)![3]))).toEqual({ state: "cancelled", errorCode: null });
});
