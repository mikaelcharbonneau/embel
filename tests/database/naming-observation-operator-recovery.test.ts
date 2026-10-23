import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingProviderReceiptSchema } from "../../src/domain/naming-brain";
import { createProgressiveNamingAssignment } from "../../src/server/ai/naming-brain/progressive-assignments";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { brainRpc, brainWorker, installBrainFixture } from "./naming-brain-fixture";
import { progressiveRequest, seedProgressiveFixture } from "./naming-brain-progressive-fixture";

const sql = await readFile(new URL("../../scripts/operator/reopen-cancelled-naming-observation.sql", import.meta.url), "utf8");
describe("one-shot cancelled Naming observation with retained operator audit", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 60_000);
  afterAll(async () => { await db?.close(); });
  async function prepare() {
    const f = await seedProgressiveFixture(db);
    const requests = [progressiveRequest(f, "context.research", { role: "researcher", snapshot: f.input.snapshot }),
      ...[1, 2, 3].map(index => progressiveRequest(f, `part00${index}.creation`, { role: "creator", snapshot: f.input.snapshot,
        assignment: createProgressiveNamingAssignment({ runId: f.input.runId, snapshot: f.input.snapshot, partIndex: index, approach: "invented", targetCount: 6 }) }))];
    for (const request of requests) {
      const phase = request.providerCallKey.slice(0, request.providerCallKey.lastIndexOf("."));
      await brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, phase, [request]));
      await brainWorker(db, () => f.store.authorizeDispatch(f.job, request));
      const receipt = namingProviderReceiptSchema.parse({ version: 1, provider: "openai", protocol: "openai_agents", billingMode: "openai_api", budgetControl: "local_unlimited_v1", localPipelineVersion: 2,
        runId: f.input.runId, stageKey: "creation", role: request.role, snapshotHash: f.input.snapshot.snapshotHash,
        providerCallKey: request.providerCallKey, assignmentKey: request.assignmentKey, requestKey: request.requestKey, requestHash: request.requestHash,
        sessionLimitCents: request.policy.sessionLimitCents, dispatchState: "dispatched", requestId: "req_synthetic", sessionId: `sess_${request.providerCallKey.replaceAll(".", "_")}`,
        turnId: null, agentId: null, responseId: null, callIds: [], observedModel: f.input.policy.model, toolCalls: [], artifactItemIds: [], usageObservations: [], providerCostCounters: [],
        estimatedCostMicrousd: null, accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: new Date().toISOString() });
      await brainWorker(db, () => f.store.recordReceipt(f.job, receipt));
    }
    await brainRpc(db, "request_job_cancel", [f.job.id]);
    await brainWorker(db, () => f.store.completeStep(f.job, "creation", { status: "needs_reconciliation", code: "synthetic_unknown", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }));
    await db.query("update fluid_private.naming_brain_runs set observation_attempts=12,observation_deadline_at=clock_timestamp()-interval '1 hour' where id=$1", [f.input.runId]);
    const digest = (await db.query<{ digest: string }>("select encode(sha256(convert_to(jsonb_agg(to_jsonb(c) order by c.stage_key,c.call_key)::text,'UTF8')),'hex') digest from fluid_private.naming_brain_calls c where c.run_id=$1", [f.input.runId])).rows[0]!.digest;
    return { ...f, recovery: { runId: f.input.runId, jobId: f.job.id, ownerId: OWNER_A, projectId: f.project, expectedCallsSha256: digest, decisionReference: "synthetic-explicit-operator-approval" } };
  }
  async function apply(request: unknown) {
    await db.exec("begin");
    try { await db.query("select set_config('embel.recovery_request',$1,true)", [JSON.stringify(request)]); await db.exec(sql); await db.exec("commit"); }
    catch (error) { await db.exec("rollback"); throw error; }
  }
  it("preserves history and money, admits exactly one observation claim and cannot be repeated", async () => {
    const f = await prepare();
    const rows = async () => ({ calls: (await db.query("select * from fluid_private.naming_brain_calls where run_id=$1 order by call_key", [f.input.runId])).rows,
      receipts: (await db.query("select * from fluid_private.naming_brain_receipts where run_id=$1 order by id", [f.input.runId])).rows,
      reservation: (await db.query("select * from public.usage_reservations where job_id=$1", [f.job.id])).rows,
      job: (await db.query("select * from public.jobs where id=$1", [f.job.id])).rows });
    const before = await rows();
    await apply(f.recovery);
    expect(await rows()).toEqual(before);
    const audit = (await db.query<{ prior_observation: { attempts: number }; issued_call_count: number }>("select prior_observation,issued_call_count from fluid_private.naming_observation_recovery_audit where run_id=$1", [f.input.runId])).rows[0]!;
    expect(audit.prior_observation.attempts).toBe(12); expect(audit.issued_call_count).toBe(4);
    await expect(apply(f.recovery)).rejects.toThrow(/recovery_target_changed|recovery_already_recorded/);
    const observer = await brainWorker(db, () => f.store.claim("fixture-worker", 120));
    expect(observer?.status).toBe("cancel_requested");
    if (!observer) throw new Error("missing_synthetic_observer");
    await brainWorker(db, () => f.store.registerPlan(observer, [{ key: "creation", maximumCostMicrousd: 1_500_000 }, { key: "prepare", maximumCostMicrousd: 0 }]));
    await expect(brainWorker(db, () => f.store.assertContinuation(observer))).rejects.toThrow(/naming_observe_only/);
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [observer.id]);
    await brainWorker(db, () => f.store.expireLeases("fixture-worker"));
    expect(await brainWorker(db, () => f.store.claim("fixture-worker", 120))).toBeNull();
    await expect(apply(f.recovery)).rejects.toThrow(/recovery_already_recorded/);
    expect(await brainRpc(db, "get_naming_brain_job_accounting", [observer.id])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
    await expect(db.query("delete from fluid_private.naming_observation_recovery_audit where run_id=$1", [f.input.runId])).rejects.toThrow();
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await expect(asRole(db, role, OWNER_A, () => db.query("select * from fluid_private.naming_observation_recovery_audit"))).rejects.toThrow(/permission denied/);
    }
  }, 30_000);
  it("refuses changed calls, wrong ownership and uncancelled work without recording an audit or modifying the run", async () => {
    const f = await prepare();
    const before = (await db.query("select * from fluid_private.naming_brain_runs where id=$1", [f.input.runId])).rows;
    await expect(apply({ ...f.recovery, expectedCallsSha256: "0".repeat(64) })).rejects.toThrow(/recovery_calls_changed/);
    await expect(apply({ ...f.recovery, ownerId: OWNER_B })).rejects.toThrow(/recovery_target_changed/);
    expect((await db.query("select * from fluid_private.naming_brain_runs where id=$1", [f.input.runId])).rows).toEqual(before);
    expect((await db.query("select * from fluid_private.naming_observation_recovery_audit")).rows).toEqual([]);
    await db.query("update public.jobs set cancel_requested_at=null where id=$1", [f.job.id]);
    await expect(apply(f.recovery)).rejects.toThrow(/recovery_target_changed/);
  }, 30_000);
});
