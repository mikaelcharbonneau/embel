import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { namingProviderReceiptSchema } from "../../src/domain/naming-brain";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { createTestDatabase, OWNER_A, type TestDatabase } from "./local-supabase";
import { beginBrainStage, brainAction, brainGapEnvelope, brainManifest, brainRpc, brainWorker, claimBrain, initialIntent, installBrainFixture, planBrainCall, seedBrainFixture } from "./naming-brain-fixture";
import { historicalNamingClaimDatabase } from "./naming-brain-historical-claim";

type Job = Awaited<ReturnType<typeof claimBrain>>["job"];
// These cases deliberately admit historical seven-stage jobs. The progressive
// suite separately verifies their unchanged execution after the forward upgrade.
describe("known completed Naming evidence and ordinary local continuation (synthetic SQL)", () => {
  let db: TestDatabase, project: string;
  beforeAll(async () => { db = await createTestDatabase({ before: "20261017170000_local_progressive_naming.sql" }); await installBrainFixture(db); }, 60_000);
  beforeEach(async () => {
    project = await seedBrainFixture(db);
    const policy = guidedStrategyPolicy("strategy.reformulate");
    await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
    await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
  });
  afterAll(async () => { await db?.close(); });

  async function start(local = true) {
    await brainRpc(db, local ? "ensure_local_naming_brain_run" : "ensure_naming_brain_run", [project, initialIntent("synthetic-completed-recovery")]);
    const { job } = await claimBrain(db);
    await brainAction(db, job, "plan", { manifest: brainManifest, gapEnvelope: brainGapEnvelope });
    return job;
  }
  async function evidence(job: Job, stage: "research" | "direction", local = true, invalid = false) {
    await beginBrainStage(db, job, stage);
    const { request, allocation, snapshot } = await planBrainCall(db, job, stage);
    const savedRequest = { ...request, policy: { ...request.policy, ...(local ? { budgetControl: "local_unlimited_v1" } : {}) } };
    await brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [job.id, job.lease_token, savedRequest]));
    const sessionId = `synthetic-${stage}-session`, turnId = `synthetic-${stage}-turn`, itemId = `synthetic-${stage}-item`, agentId = "synthetic-agent";
    const receipt = { version: 1, provider: "openai", billingMode: "openai_api", runId: job.input.runId, stageKey: stage, role: allocation.role, snapshotHash: snapshot.snapshotHash, protocol: "openai_agents", ...(local ? { budgetControl: "local_unlimited_v1" } : {}),
      providerCallKey: allocation.providerCallKey, assignmentKey: null, requestKey: allocation.requestKey, requestHash: allocation.requestHash, sessionLimitCents: allocation.sessionLimitCents, dispatchState: "dispatched", requestId: "req_synthetic_completed", sessionId, turnId, agentId, responseId: null, callIds: [], observedModel: request.policy.model,
      toolCalls: [], artifactItemIds: [itemId], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-17T12:00:00Z" };
    await brainWorker(db, () => db.query("select public.record_naming_brain_provider_receipt($1,$2,$3)", [job.id, job.lease_token, receipt]));
    const output = stage === "research" ? { role: "researcher", territories: [{ territoryId: "nature", title: "Synthetic nature", direction: "Synthetic first direction.", sourceKeys: [] }, { territoryId: "sound", title: "Synthetic sound", direction: "Synthetic second direction.", sourceKeys: [] }], facts: [], interpretations: [], uncertainties: [] }
      : { role: "director", round: "initial", assignments: [{ assignmentKey: "synthetic-real", primaryApproach: "real_words", additionalApproaches: [], territoryId: "nature", constructionKey: "original", direction: "Synthetic original construction.", targetCount: 150, sourceKeys: [], avoidPatterns: [], freshTerritory: false }], feedbackHypotheses: [] };
    const text = invalid ? "not JSON" : JSON.stringify(output);
    await brainAction(db, job, "provider_item", { providerCallKey: allocation.providerCallKey, sessionId, turnId, itemId, item: { id: itemId, type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId, content: [{ type: "output_text", text }] } });
    await brainAction(db, job, "provider_turn", { providerCallKey: allocation.providerCallKey, sessionId, turnId, turn: { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: "completed", created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null } });
    const artifact = { artifactId: crypto.randomUUID(), runId: job.input.runId, stageKey: stage, snapshotHash: snapshot.snapshotHash, schemaVersion: 1, promptVersion: "naming-brain-v1", providerReceipt: receipt, output, ...(stage === "research" ? { readiness: "partial", sources: [] } : {}) };
    return { receipt: namingProviderReceiptSchema.parse(receipt), artifact, allocation };
  }
  async function complete(job: Job, stage: "research" | "direction", artifact: { artifactId: string }) {
    await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,$3,'succeeded',$4)", [job.id, job.lease_token, stage, { artifactIds: [artifact.artifactId] }]));
  }
  async function recover(job: Job, stage: "research" | "direction") {
    await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,$3,'ambiguous',$4)", [job.id, job.lease_token, stage, { artifactIds: [], errorCode: "provider_output_invalid" }]));
    await db.query("update public.job_steps set created_at=clock_timestamp()-interval '10 minutes' where job_id=$1 and step_key=$2", [job.id, stage]);
    const store = new NamingBrainJobStore(await historicalNamingClaimDatabase(db), "fixture-deployment");
    const recovered = (await brainWorker(db, () => store.claim("fixture-worker", 120)))!;
    expect(recovered.id).toBe(job.id);
    return { store, recovered, raw: { id: recovered.id, lease_token: recovered.leaseToken, input: job.input } };
  }

  it("atomically commits recovered genuine output and execution mode before any completion acknowledgement", async () => {
    const job = await start(), research = await evidence(job, "research");
    await brainAction(db, job, "artifact", { artifact: research.artifact }); await complete(job, "research", research.artifact);
    const direction = await evidence(job, "direction"); const recovery = await recover(job, "direction");
    const history = (await db.query("select (select jsonb_agg(to_jsonb(c) order by call_key) from fluid_private.naming_brain_calls c) calls,(select jsonb_agg(to_jsonb(p) order by id) from fluid_private.naming_brain_receipts p) receipts,(select jsonb_agg(to_jsonb(p) order by id) from fluid_private.naming_brain_provider_records p) records")).rows;
    await brainAction(db, recovery.raw, "artifact", { artifact: direction.artifact });
    // This is the transaction whose acknowledgement may be lost. No separate
    // resume mutation may be needed to make its committed state recoverable.
    await complete(recovery.raw, "direction", direction.artifact);
    expect((await db.query("select recovery_mode from fluid_private.naming_brain_runs where job_id=$1", [job.id])).rows).toEqual([{ recovery_mode: "execute" }]);
    expect((await db.query("select state from public.job_steps where job_id=$1 and step_key='direction'", [job.id])).rows).toEqual([{ state: "succeeded" }]);
    expect((await db.query("select (select jsonb_agg(to_jsonb(c) order by call_key) from fluid_private.naming_brain_calls c) calls,(select jsonb_agg(to_jsonb(p) order by id) from fluid_private.naming_brain_receipts p) receipts,(select jsonb_agg(to_jsonb(p) order by id) from fluid_private.naming_brain_provider_records p) records")).rows).toEqual(history);
    await brainWorker(db, () => recovery.store.heartbeat(recovery.recovered, 120)); await brainWorker(db, () => recovery.store.assertContinuation(recovery.recovered));
    await beginBrainStage(db, recovery.raw, "creation");
    expect((await db.query("select created_at>clock_timestamp()-interval '5 seconds' fresh from public.job_steps where job_id=$1 and step_key='creation'", [job.id])).rows).toEqual([{ fresh: true }]);
    expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1", [job.input.runId])).rows).toEqual([{ count: 2 }]);
  });

  it.each(["cancelled", "deleted", "paused", "not_ready", "native", "unknown_authorization"] as const)("keeps the ordinary continuation gate closed for %s", async mode => {
    const local = mode !== "native", job = await start(local), research = await evidence(job, "research", local);
    const recovery = await recover(job, "research"); await brainAction(db, recovery.raw, "artifact", { artifact: research.artifact });
    if (mode === "cancelled") await db.query("update public.jobs set cancel_requested_at=clock_timestamp() where id=$1", [job.id]);
    if (mode === "deleted") {
      const lifecycle = (await db.query<{ current_revision: number; lifecycle_version: number }>("select current_revision,lifecycle_version from public.projects where id=$1", [project])).rows[0]!;
      await brainRpc(db, "request_project_deletion", [project, lifecycle.current_revision, lifecycle.lifecycle_version]);
    }
    if (mode === "paused") await db.query("update fluid_private.naming_brain_heads set paused=true where project_id=$1", [project]);
    if (mode === "not_ready") await db.exec("update fluid_private.naming_brain_pilots set ready_until=clock_timestamp()-interval '1 second'");
    if (mode === "unknown_authorization") await db.query("insert into fluid_private.naming_brain_calls(run_id,owner_id,project_id,stage_key,phase_key,call_key,request) select run_id,owner_id,project_id,stage_key,phase_key,call_key||'-unknown',request||jsonb_build_object('providerCallKey',call_key||'-unknown','requestKey','synthetic-unknown-sibling','requestHash',repeat('c',64)) from fluid_private.naming_brain_calls where run_id=$1", [job.input.runId]);
    await complete(recovery.raw, "research", research.artifact);
    expect((await db.query("select recovery_mode from fluid_private.naming_brain_runs where job_id=$1", [job.id])).rows).toEqual([{ recovery_mode: "observe_only" }]);
    expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1", [job.input.runId])).rows).toEqual([{ count: mode === "unknown_authorization" ? 2 : 1 }]);
    if (mode === "unknown_authorization") expect((await db.query("select state from public.job_steps where job_id=$1 and step_key='research'", [job.id])).rows).toEqual([{ state: "ambiguous" }]);
    else expect(await brainAction(db, recovery.raw, "resume_execution", { stageKey: "research" })).toMatchObject({ resumed: false });
  });

  it("classifies a genuinely completed invalid initial Director as failed with its exact immutable receipt", async () => {
    const job = await start(), research = await evidence(job, "research");
    await brainAction(db, job, "artifact", { artifact: research.artifact }); await complete(job, "research", research.artifact);
    const direction = await evidence(job, "direction", true, true), recovery = await recover(job, "direction");
    const exactFailure = { providerCallKey: direction.allocation.providerCallKey, status: "failed", code: "provider_output_invalid", receipt: direction.receipt };
    await brainWorker(db, () => recovery.store.completeStep(recovery.recovered, "direction", { status: "failed", code: "provider_output_invalid", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [], errorCode: "provider_output_invalid", partialArtifacts: [exactFailure] } }));
    expect((await db.query("select state from public.job_steps where job_id=$1 and step_key='direction'", [job.id])).rows).toEqual([{ state: "failed" }]);
    await brainAction(db, recovery.raw, "finish", { state: "partial", errorCode: "naming_incomplete" });
    expect(await brainRpc(db, "get_naming_brain_job_accounting", [job.id])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
    expect(await brainRpc(db, "get_naming_brain_run", [project, job.input.runId])).toMatchObject({ canResume: true });
    expect((await db.query("select count(*)::int count from fluid_private.naming_brain_stage_results where run_id=$1 and state='ambiguous'", [job.input.runId])).rows).toEqual([{ count: 1 }]);
    expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1", [job.input.runId])).rows).toEqual([{ count: 2 }]);
  });
});
