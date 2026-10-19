import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { createTestDatabase, OWNER_A, type TestDatabase } from "./local-supabase";
import { beginBrainStage, brainAction, brainGapEnvelope, brainManifest, brainRpc, brainWorker, claimBrain, initialIntent, installBrainFixture, planBrainCall, prepareBrainFixture, saveBrainArtifact, seedBrainFixture } from "./naming-brain-fixture";

const migration = "20261017160000_local_naming_generous_timing.sql";
// These cases deliberately admit historical seven-stage jobs. The progressive
// suite separately verifies their unchanged execution after the forward upgrade.
describe("future-only generous local Naming timing (synthetic SQL)", () => {
 let db: TestDatabase, oldDb: TestDatabase, project: string;
 let oldProof: { before: unknown; after: unknown; job: Awaited<ReturnType<typeof claimBrain>>["job"]; request: Record<string, unknown> };
 async function seed(database: TestDatabase) {
  const projectId = await seedBrainFixture(database), policy = guidedStrategyPolicy("strategy.reformulate");
  await database.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
  await database.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
  return projectId;
 }
 async function start(database: TestDatabase, projectId: string, local: boolean) {
  await brainRpc(database, local ? "ensure_local_naming_brain_run" : "ensure_naming_brain_run", [projectId, initialIntent("synthetic-generous-timing")]);
  const { job } = await claimBrain(database); await brainAction(database, job, "plan", { manifest: brainManifest, gapEnvelope: brainGapEnvelope }); return job;
 }
 const preserved = (database: TestDatabase, jobId: string) => database.query("select input, (select jsonb_agg(to_jsonb(c) order by call_key) from fluid_private.naming_brain_calls c where c.run_id=(j.input->>'runId')::uuid) calls from public.jobs j where id=$1", [jobId]);
 async function completedResearch(job: Awaited<ReturnType<typeof claimBrain>>["job"]) {
  await beginBrainStage(db, job, "research"); const { request, snapshot, allocation } = await planBrainCall(db, job, "research");
  const submitted = { ...request, policy: { ...request.policy, deadlineMs: 900000, budgetControl: "local_unlimited_v1" } };
  await brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [job.id, job.lease_token, submitted]));
  const sessionId = "synthetic-generous-session", turnId = "synthetic-generous-turn", agentId = "synthetic-generous-agent", itemId = "synthetic-generous-item";
  const receipt = { version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents", budgetControl: "local_unlimited_v1", runId: job.input.runId, stageKey: "research", role: "researcher", snapshotHash: snapshot.snapshotHash,
   providerCallKey: allocation.providerCallKey, assignmentKey: null, requestKey: allocation.requestKey, requestHash: allocation.requestHash, sessionLimitCents: allocation.sessionLimitCents,
   dispatchState: "dispatched", requestId: null, sessionId, turnId, agentId, responseId: null, callIds: [], observedModel: "synthetic-fixture-model", toolCalls: [], artifactItemIds: [itemId], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-18T05:00:00Z" };
  await brainWorker(db, () => db.query("select public.record_naming_brain_provider_receipt($1,$2,$3)", [job.id, job.lease_token, receipt]));
  const output = { role: "researcher", territories: [{ territoryId: "nature", title: "Synthetic nature", direction: "Explore nature.", sourceKeys: [] }, { territoryId: "sound", title: "Synthetic sound", direction: "Explore sound.", sourceKeys: [] }], facts: [], interpretations: [], uncertainties: [] };
  await brainAction(db, job, "provider_item", { providerCallKey: allocation.providerCallKey, sessionId, turnId, itemId, item: { id: itemId, type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId, content: [{ type: "output_text", text: JSON.stringify(output) }] } });
  await brainAction(db, job, "provider_turn", { providerCallKey: allocation.providerCallKey, sessionId, turnId, turn: { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: "completed", created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null } });
  await brainAction(db, job, "artifact", { artifact: { artifactId: crypto.randomUUID(), runId: job.input.runId, stageKey: "research", snapshotHash: snapshot.snapshotHash, schemaVersion: 1, promptVersion: "naming-brain-v1", providerReceipt: receipt, readiness: "partial", sources: [], output } });
 }
 beforeAll(async () => {
  oldDb = await createTestDatabase({ before: migration }); await installBrainFixture(oldDb);
  const oldProject = await seed(oldDb), job = await start(oldDb, oldProject, true);
  await beginBrainStage(oldDb, job, "research"); const { request } = await planBrainCall(oldDb, job, "research");
  const saved = { ...request, policy: { ...request.policy, budgetControl: "local_unlimited_v1" } };
  await brainWorker(oldDb, () => oldDb.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [job.id, job.lease_token, saved]));
  const before = (await preserved(oldDb, job.id)).rows;
  await oldDb.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  oldProof = { before, after: (await preserved(oldDb, job.id)).rows, job, request: saved };
  db = await createTestDatabase({ before: "20261017170000_local_progressive_naming.sql" }); await installBrainFixture(db);
 }, 60_000);
 beforeEach(async () => { project = await seed(db); });
 afterAll(async () => { await Promise.all([db?.close(), oldDb?.close()]); });

 it("leaves a previously authorized local240s input and request byte-for-byte unchanged", async () => {
  expect(oldProof.after).toEqual(oldProof.before);
  const input = (await oldDb.query<{ input: { localTimingVersion?: number } }>("select input from public.jobs where id=$1", [oldProof.job.id])).rows[0]!.input;
  expect(input.localTimingVersion).toBeUndefined();
  await oldDb.query("update public.job_steps set created_at=clock_timestamp()-interval '5 minutes' where job_id=$1 and step_key='research'", [oldProof.job.id]);
  const longer = { ...oldProof.request, policy: { ...(oldProof.request.policy as Record<string, unknown>), deadlineMs: 900000 } };
  await expect(brainWorker(oldDb, () => oldDb.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [oldProof.job.id, oldProof.job.lease_token, longer]))).rejects.toThrow("invalid_local_timing");
  await expect(brainWorker(oldDb, () => oldDb.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [oldProof.job.id, oldProof.job.lease_token, oldProof.request]))).rejects.toThrow("stage_not_started");
 });

 it.each([true, false])("derives the new immutable timing witness only from trusted local admission (%s)", async local => {
  const job = await start(db, project, local);
  const input = (await db.query<{ input: { localTimingVersion?: number; policy: { stageDeadlineMs: number } } }>("select input from public.jobs where id=$1", [job.id])).rows[0]!.input;
  expect(input.localTimingVersion).toBe(local ? 2 : undefined); expect(input.policy.stageDeadlineMs).toBe(240000);
 });

 it.each([[true, true, 900000], [true, true, 240000], [false, false, 240000], [false, false, 900000], [true, false, 900000]] as const)("keeps authorization within its exact job/request timing mode (%s/%s/%s)", async (localJob, localRequest, deadlineMs) => {
  const job = await start(db, project, localJob); await beginBrainStage(db, job, "research");
  const { request } = await planBrainCall(db, job, "research");
  const submitted = { ...request, policy: { ...request.policy, deadlineMs, ...(localRequest ? { budgetControl: "local_unlimited_v1" } : {}) } };
  await db.query("update public.job_steps set created_at=clock_timestamp()-interval '5 minutes' where job_id=$1 and step_key='research'", [job.id]);
  const authorize = () => brainWorker(db, () => db.query<{ value: boolean }>("select public.authorize_naming_brain_dispatch($1,$2,$3) value", [job.id, job.lease_token, submitted]));
  if (deadlineMs === 900000 && !(localJob && localRequest)) { await expect(authorize()).rejects.toThrow("invalid_local_timing"); return; }
  if (deadlineMs === 240000) { await expect(authorize()).rejects.toThrow("stage_not_started"); return; }
  expect((await authorize()).rows[0]!.value).toBe(true);
  await db.query("update public.job_steps set created_at=clock_timestamp()-interval '21 minutes' where job_id=$1 and step_key='research'", [job.id]);
  await expect(authorize()).rejects.toThrow("stage_not_started");
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1", [job.input.runId])).rows).toEqual([{ count: 1 }]);
 });

 it("resumes a genuinely completed local call within20min but retains the finite boundary and cancellation fence", async () => {
  const job = await start(db, project, true); await completedResearch(job);
  await db.query("update public.job_steps set created_at=clock_timestamp()-interval '19 minutes' where job_id=$1 and step_key='research'", [job.id]);
  expect(await brainAction(db, job, "resume_execution", { stageKey: "research" })).toMatchObject({ resumed: true });
  await db.query("update public.job_steps set created_at=clock_timestamp()-interval '21 minutes' where job_id=$1 and step_key='research'", [job.id]);
  expect(await brainAction(db, job, "resume_execution", { stageKey: "research" })).toMatchObject({ resumed: false });
  await db.query("update public.job_steps set created_at=clock_timestamp()-interval '19 minutes' where job_id=$1 and step_key='research'", [job.id]);
  await brainRpc(db, "request_job_cancel", [job.id]);
  expect(await brainAction(db, job, "resume_execution", { stageKey: "research" })).toMatchObject({ resumed: false });
 });

 it("retains the one-hour envelope for new900s Creator waves", async () => {
  const job = await start(db, project, true);
  await saveBrainArtifact(db, job, "research", { role: "researcher", facts: [], interpretations: [], uncertainties: [] }, { readiness: "sourced", sources: [] });
  await saveBrainArtifact(db, job, "direction", { role: "director", round: "initial", assignments: [], feedbackHypotheses: [] });
  await beginBrainStage(db, job, "creation"); const { request } = await planBrainCall(db, job, "creation");
  const submitted = { ...request, policy: { ...request.policy, deadlineMs: 900000, budgetControl: "local_unlimited_v1" } };
  await db.query("update public.job_steps set created_at=clock_timestamp()-interval '55 minutes' where job_id=$1 and step_key='creation'", [job.id]);
  const authorize = () => brainWorker(db, () => db.query<{ value: boolean }>("select public.authorize_naming_brain_dispatch($1,$2,$3) value", [job.id, job.lease_token, submitted]));
  expect((await authorize()).rows[0]!.value).toBe(true);
  await db.query("update public.job_steps set created_at=clock_timestamp()-interval '61 minutes' where job_id=$1 and step_key='creation'", [job.id]);
  await expect(authorize()).rejects.toThrow("stage_not_started");
 });

 it("retains the one-hour envelope for a new900s phased Gap call", async () => {
  const job = await start(db, project, true), done = new Error("Synthetic Gap envelope probe finished");
  await expect(prepareBrainFixture(db, project, 60, job, async current => {
   const snapshot = (await db.query<{ snapshot: Record<string, unknown> }>("select snapshot from fluid_private.naming_brain_runs where id=$1", [job.input.runId])).rows[0]!.snapshot;
   const allocation = { providerCallKey: "synthetic-generous-gap", assignmentKey: null, requestKey: "synthetic-generous-gap-request", requestHash: "e".repeat(64), sessionLimitCents: 10, maxWebSearchCalls: 0, role: "director" };
   await brainAction(db, current, "call_plan", { stageKey: "gap", phase: "direction", calls: [allocation] });
   const request = { ...allocation, runId: job.input.runId, stageKey: "gap", snapshotHash: snapshot.snapshotHash, input: { role: "director", snapshot }, dependencyArtifactIds: [], policy: { model: "synthetic-fixture-model", protocol: "openai_agents", nativeDelegation: false, maximumCostMicrousd: 100000, sessionLimitCents: 10, maxWebSearchCalls: 0, deadlineMs: 900000, budgetControl: "local_unlimited_v1" } };
   await db.query("update public.job_steps set created_at=clock_timestamp()-interval '55 minutes' where job_id=$1 and step_key='gap'", [job.id]);
   const authorize = () => brainWorker(db, () => db.query<{ value: boolean }>("select public.authorize_naming_brain_dispatch($1,$2,$3) value", [job.id, current.lease_token, request]));
   expect((await authorize()).rows[0]!.value).toBe(true);
   await db.query("update public.job_steps set created_at=clock_timestamp()-interval '61 minutes' where job_id=$1 and step_key='gap'", [job.id]);
   await expect(authorize()).rejects.toThrow("stage_not_started");
   throw done;
  })).rejects.toBe(done);
 });
});
