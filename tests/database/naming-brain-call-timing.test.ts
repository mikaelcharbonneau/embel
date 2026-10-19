import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { createTestDatabase, OWNER_A, type TestDatabase } from "./local-supabase";
import { beginBrainStage, brainAction, brainGapEnvelope, brainManifest, brainRpc, brainWorker, claimBrain, initialIntent, installBrainFixture, planBrainCall, prepareBrainFixture, saveBrainArtifact, seedBrainFixture } from "./naming-brain-fixture";

// These cases deliberately admit historical seven-stage jobs. The progressive
// suite separately verifies their unchanged execution after the forward upgrade.
describe("durable local Naming call clocks and finite stage envelopes (synthetic SQL)", () => {
 let db: TestDatabase, project: string;
 beforeAll(async () => { db = await createTestDatabase({ before: "20261017170000_local_progressive_naming.sql" }); await installBrainFixture(db); }, 60_000);
 beforeEach(async () => {
  project = await seedBrainFixture(db); const policy = guidedStrategyPolicy("strategy.reformulate");
  await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
  await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
 });
 afterAll(async () => { await db?.close(); });
 async function start(local: boolean) {
  await brainRpc(db, local ? "ensure_local_naming_brain_run" : "ensure_naming_brain_run", [project, initialIntent("synthetic-durable-clock")]);
  const { job } = await claimBrain(db); await brainAction(db, job, "plan", { manifest: brainManifest, gapEnvelope: brainGapEnvelope }); return job;
 }

 it.each([[true, true], [false, false], [true, false]])("admits a later Creator wave only within the dual-marked local one-hour stage envelope (job:%s request:%s)", async (localJob, local) => {
  const job = await start(localJob);
  await saveBrainArtifact(db, job, "research", { role: "researcher", facts: [], interpretations: [], uncertainties: [] }, { readiness: "sourced", sources: [] });
  await saveBrainArtifact(db, job, "direction", { role: "director", round: "initial", assignments: [], feedbackHypotheses: [] });
  await beginBrainStage(db, job, "creation"); const { request, allocation } = await planBrainCall(db, job, "creation");
  const submitted = { ...request, policy: { ...request.policy, ...(local ? { budgetControl: "local_unlimited_v1" } : {}) } };
  await db.query("update public.job_steps set created_at=clock_timestamp()-interval '5 minutes' where job_id=$1 and step_key='creation'", [job.id]);
  const authorize = () => brainWorker(db, () => db.query<{ value: boolean }>("select public.authorize_naming_brain_dispatch($1,$2,$3) value", [job.id, job.lease_token, submitted]));
  if (!local) { await expect(authorize()).rejects.toThrow("stage_not_started"); return; }
  expect((await authorize()).rows[0]!.value).toBe(true);
  const stage = await brainAction(db, job, "stage", { stageKey: "creation" }) as { authorizations: { providerCallKey: string; requestHash: string; authorizedAt: string }[] };
  expect(stage.authorizations).toHaveLength(1); expect(stage.authorizations[0]).toMatchObject({ providerCallKey: allocation.providerCallKey, requestHash: allocation.requestHash });
  // The JS runtime clock is millisecond precision; PostgreSQL retains microseconds.
  const committed = (await db.query<{ same: boolean; fresh: boolean }>("select date_trunc('milliseconds',authorized_at)=date_trunc('milliseconds',$2::timestamptz) same,authorized_at>clock_timestamp()-interval '5 seconds' fresh from fluid_private.naming_brain_calls where run_id=$1 and call_key=$3", [job.input.runId, stage.authorizations[0]!.authorizedAt, allocation.providerCallKey])).rows[0]!;
  expect(committed).toEqual({ same: true, fresh: true });
  await db.query("update public.job_steps set created_at=clock_timestamp()-interval '61 minutes' where job_id=$1 and step_key='creation'", [job.id]);
  await expect(authorize()).rejects.toThrow("stage_not_started");
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1 and stage_key='creation'", [job.input.runId])).rows).toEqual([{ count: 1 }]);
 });

 it.each([[true, true], [false, false], [true, false]])("keeps all four gap phases within the same finite dual-marked local stage window (job:%s request:%s)", async (localJob, local) => {
  const job = await start(localJob), completed = new Error("Synthetic gap timing probe completed");
  const operation = prepareBrainFixture(db, project, 60, job, async current => {
   const snapshot = (await db.query<{ snapshot: Record<string, unknown> }>("select snapshot from fluid_private.naming_brain_runs where id=$1", [job.input.runId])).rows[0]!.snapshot;
   const phases = [["direction", "director", 10, 0], ["creation", "creator", 40, 0], ["curation", "curator", 5, 0], ["verification", "verifier", 20, 8]] as const;
   for (let index = 0; index < phases.length; index++) {
    const [phase, role, cents, searches] = phases[index]!, key = `synthetic-gap-${role}`, itemId = `${key}-item`, sessionId = `${key}-session`, turnId = `${key}-turn`, agentId = "synthetic-gap-agent";
    const allocation = { providerCallKey: key, assignmentKey: role === "creator" ? "real" : null, requestKey: `${key}-request`, requestHash: createHash("sha256").update(key).digest("hex"), sessionLimitCents: cents, maxWebSearchCalls: searches, role };
    await brainAction(db, current, "call_plan", { stageKey: "gap", phase, calls: [allocation] });
    await db.query("update public.job_steps set created_at=clock_timestamp()-make_interval(mins=>$2) where job_id=$1 and step_key='gap'", [job.id, 5 + index * 5]);
    const request = { ...allocation, runId: job.input.runId, stageKey: "gap", snapshotHash: snapshot.snapshotHash, input: { role, snapshot }, dependencyArtifactIds: [], policy: { model: "synthetic-fixture-model", protocol: "openai_agents", nativeDelegation: false, maximumCostMicrousd: cents * 10000, sessionLimitCents: cents, maxWebSearchCalls: searches, ...(local ? { budgetControl: "local_unlimited_v1" } : {}) } };
    const authorize = () => brainWorker(db, () => db.query<{ value: boolean }>("select public.authorize_naming_brain_dispatch($1,$2,$3) value", [job.id, current.lease_token, request]));
    if (!local) { await expect(authorize()).rejects.toThrow("stage_not_started"); throw completed; }
    expect((await authorize()).rows[0]!.value).toBe(true);
    const receipt = { version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents", budgetControl: "local_unlimited_v1", runId: job.input.runId, stageKey: "gap", snapshotHash: snapshot.snapshotHash, ...allocation, dispatchState: "dispatched", requestId: null, sessionId, turnId, agentId, responseId: null, callIds: [], observedModel: "synthetic-fixture-model", toolCalls: [], artifactItemIds: [itemId], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-17T12:00:00Z" };
    const { maxWebSearchCalls: _searches, ...savedReceipt } = receipt; void _searches;
    await brainWorker(db, () => db.query("select public.record_naming_brain_provider_receipt($1,$2,$3)", [job.id, current.lease_token, savedReceipt]));
    const output = role === "director" ? { role, round: "gap", assignments: [], feedbackHypotheses: [] } : role === "creator" ? { role, assignmentKey: "real", candidates: [] } : role === "curator" ? { role, annotations: [], gaps: [] } : { role, findings: [] };
    const text = JSON.stringify(output);
    await brainAction(db, current, "provider_item", { providerCallKey: key, sessionId, turnId, itemId, item: { id: itemId, type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId, content: [{ type: "output_text", text }] } });
    await brainAction(db, current, "provider_turn", { providerCallKey: key, sessionId, turnId, turn: { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: "completed", created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null } });
    await brainAction(db, current, "artifact", { artifact: { artifactId: crypto.randomUUID(), runId: job.input.runId, stageKey: "gap", snapshotHash: snapshot.snapshotHash, schemaVersion: 1, promptVersion: "naming-brain-v1", providerReceipt: savedReceipt, output,
     ...(role === "creator" ? { candidateIds: [], creatorAttribution: { protocol: "openai_agents", executionKind: "independent_session", assignmentKey: "real", assignmentInputHash: allocation.requestHash, sessionId, turnId, responseId: null, subagentId: null, itemId, itemContentHash: createHash("sha256").update(text).digest("hex") } } : role === "verifier" ? { sources: [], sourceDependencies: [] } : {}) } });
   }
   expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1 and stage_key='gap'", [job.input.runId])).rows).toEqual([{ count: 4 }]);
   await db.query("update public.job_steps set created_at=clock_timestamp()-interval '61 minutes' where job_id=$1 and step_key='gap'", [job.id]);
   expect(await brainAction(db, current, "resume_execution", { stageKey: "gap" })).toMatchObject({ resumed: false });
   throw completed;
  });
  await expect(operation).rejects.toBe(completed);
 });
});
