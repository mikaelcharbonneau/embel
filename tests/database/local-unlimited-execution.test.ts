import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { PostgresJobStore } from "../../worker/postgres-store";
import { runOneJob, type HandlerRegistry } from "../../worker/runner";
import { asRole, createTestDatabase, HASH, OWNER_A, type TestDatabase } from "./local-supabase";
import { attestBrainPreferences, beginBrainStage, brainAction, brainGapEnvelope, brainManifest, brainPreferences, brainRpc, brainWorker, claimBrain, initialIntent, installBrainFixture, planBrainCall, seedBrainFixture, startBrainFixture } from "./naming-brain-fixture";

const policy = guidedStrategyPolicy("strategy.reformulate");
// These cases deliberately admit historical seven-stage jobs. The progressive
// suite separately verifies their unchanged execution after the forward upgrade.
describe("explicit local unlimited execution (synthetic database)", () => {
 let db: TestDatabase; let project: string;
 beforeAll(async () => {
  db = await createTestDatabase({ before: "20261017170000_local_progressive_naming.sql" }); await installBrainFixture(db);
  await db.exec("grant execute on function public.claim_job(text,integer),public.local_strategy_job_action(uuid,text,jsonb),public.read_local_strategy_steps(uuid,uuid,uuid,text) to fixture_naming_brain_a");
 }, 60_000);
 beforeEach(async () => {
  project = await seedBrainFixture(db);
  await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
  await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
 });
 afterAll(async () => { await db?.close(); });
 const owner = <T>(run: () => Promise<T>) => asRole(db, "authenticated", OWNER_A, run);
 const strategyProject = () => brainRpc<{ id: string }>(db, "create_project", ["complete_brand", "Synthetic unlimited Strategy", contextSnapshotSchema.parse({ description: "Synthetic local brief", intake: { conversation: [{ kind: "user_message", id: "synthetic-prompt", text: "Synthetic coffee workshops", createdAt: "2026-10-17T12:00:00Z" }], guidedInterview: { version: 1, stage: "competitors", turns: [{ id: "synthetic-turn", userMessageId: "synthetic-prompt", inputRevision: 1, stage: "competitors", purpose: "message" }], answers: [] } } }), HASH]);
 const strategyEnqueue = (id: string, key: string) => owner(async () => (await db.query<{ value: { id: string } }>("select public.enqueue_local_strategy_job($1,1,'strategy.reformulate',$2,$3) value", [id, key, policy.maximumCostMicrousd])).rows[0]!.value);
 async function namingProject(key: string) {
  const p = await brainRpc<{ id: string }>(db, "create_project", ["naming_only", "Synthetic unlimited Naming", { description: "Synthetic Naming brief" }, HASH]);
  await brainRpc(db, "save_naming_preferences", [p.id, 0, brainPreferences]); await attestBrainPreferences(db);
  return brainRpc<{ status: string; run: { jobId: string; runId: string } }>(db, "ensure_local_naming_brain_run", [p.id, initialIntent(key)]);
 }

 it("admits and completes local Strategy beyond account and step money limits while retaining unknown-outcome fencing", async () => {
  await db.exec("update public.usage_accounts set limit_microusd=0,spent_microusd=100,provider_actual_microusd=100");
  expect((await owner(() => db.query<{ value: { status: string } }>("select public.get_local_strategy_availability(null) value"))).rows[0]!.value.status).toBe("available");
  const p = await strategyProject();
  await expect(asRole(db, "service_role", null, () => db.query("select public.enqueue_job($1,$2,'strategy',1,$3,'{}','synthetic-hosted-zero-headroom',1,3)", [OWNER_A, p.id, HASH]))).rejects.toThrow("budget_exceeded");
  const admitted = await strategyEnqueue(p.id, "synthetic-unlimited-first");
  const store = new PostgresJobStore(db, { localPrototype: true });
  const handlers: HandlerRegistry = new Map([["strategy.reformulate", { steps: () => [{ key: "guided", maximumCostMicrousd: policy.maximumCostMicrousd,
   execute: async () => ({ status: "failed", costMicrousd: policy.maximumCostMicrousd + 100, code: "synthetic_known_failure", providerRequestId: "req_synthetic_confirmed" }) }] }]]);
  expect(await brainWorker(db, () => runOneJob({ store, handlers, workerId: "fixture-local-worker", localPrototype: true }))).toBe("failed");
  expect((await db.query("select state,actual_cost_microusd from public.jobs where id=$1", [admitted.id])).rows).toEqual([{ state: "failed", actual_cost_microusd: policy.maximumCostMicrousd + 100 }]);
  expect((await db.query("select actual_microusd,state from public.usage_reservations where job_id=$1", [admitted.id])).rows).toEqual([{ actual_microusd: policy.maximumCostMicrousd + 100, state: "settled" }]);
  const second = await strategyEnqueue(p.id, "synthetic-unlimited-second");
  await brainWorker(db, async () => {
   const job = (await store.claim("fixture-local-worker", 60))!; expect(job.id).toBe(second.id);
   await store.registerPlan(job, [{ key: "guided", maximumCostMicrousd: policy.maximumCostMicrousd }]); await store.beginStep(job, "guided", policy.maximumCostMicrousd);
   await store.completeStep(job, "guided", { status: "needs_reconciliation", code: "synthetic_unknown_outcome", costMicrousd: 0, providerRequestId: null });
  });
  await expect(strategyEnqueue(p.id, "synthetic-unknown-stays-fenced")).rejects.toThrow("paid_outcome_unresolved");
  expect((await strategyEnqueue((await strategyProject()).id, "synthetic-unrelated-still-works")).id).toBeTruthy();
  expect((await db.query("select * from fluid_private.local_prototype_admission_context")).rows).toEqual([]);
 });

 it("allows local Naming past aggregate/account commitments and binds unlimited receipts to immutable requests", async () => {
  await db.exec("update public.usage_accounts set limit_microusd=0");
  expect(await brainRpc(db, "ensure_naming_brain_run", [project, initialIntent("synthetic-hosted-still-capped")])).toMatchObject({ status: "blocked", code: "account_allowance_unavailable" });
  const admitted = [];
  for (let index = 0; index < 6; index++) admitted.push(await namingProject(`synthetic-unlimited-naming-${index}`));
  expect(admitted.every(row => row.status === "pending")).toBe(true);
  expect((await db.query("select reserved_microusd,limit_microusd,spent_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ reserved_microusd: 30_000_000, limit_microusd: 0, spent_microusd: 0 }]);
  const claimed = await claimBrain(db); expect(claimed.job.id).toBe(admitted[0]!.run.jobId);
  await brainAction(db, claimed.job, "plan", { manifest: brainManifest, gapEnvelope: brainGapEnvelope }); await beginBrainStage(db, claimed.job, "research");
  const { request, allocation, snapshot } = await planBrainCall(db, claimed.job, "research");
  const localRequest = { ...request, policy: { ...request.policy, budgetControl: "local_unlimited_v1" } };
  expect((await brainWorker(db, () => db.query<{ value: boolean }>("select public.authorize_naming_brain_dispatch($1,$2,$3) value", [claimed.job.id, claimed.job.lease_token, localRequest]))).rows[0]!.value).toBe(true);
  const receipt = { version: 1, provider: "openai", billingMode: "openai_api", runId: claimed.job.input.runId, stageKey: "research", role: allocation.role, snapshotHash: snapshot.snapshotHash, protocol: "openai_agents", providerCallKey: allocation.providerCallKey, assignmentKey: null, requestKey: allocation.requestKey, requestHash: allocation.requestHash, sessionLimitCents: allocation.sessionLimitCents, dispatchState: "dispatched", requestId: "req_synthetic_local", sessionId: "synthetic-session", turnId: "synthetic-turn", agentId: null, responseId: null, callIds: [], observedModel: request.policy.model, toolCalls: [], artifactItemIds: [], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [{ kind: "consumed_usd_cents", value: 9999 }], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-17T12:00:00Z" };
  const record = (value: unknown) => brainWorker(db, () => db.query("select public.record_naming_brain_provider_receipt($1,$2,$3)", [claimed.job.id, claimed.job.lease_token, value]));
  await expect(record(receipt)).rejects.toThrow("receipt_mismatch");
  await record({ ...receipt, budgetControl: "local_unlimited_v1" });
  expect((await db.query("select observed_overrun from fluid_private.naming_brain_runs where job_id=$1", [claimed.job.id])).rows).toEqual([{ observed_overrun: false }]);
  await db.query("update fluid_private.naming_brain_runs set observed_overrun=true where job_id=$1", [claimed.job.id]);
  expect(await brainAction(db, claimed.job, "heartbeat", { leaseSeconds: 60 })).toMatchObject({ recoveryMode: "execute" });
  expect((await db.query("select state,reserved_microusd,actual_microusd from public.usage_reservations where job_id=$1", [claimed.job.id])).rows).toEqual([{ state: "active", reserved_microusd: 5_000_000, actual_microusd: 0 }]);
 });

 it("rejects an unlimited marker on an ordinary saved run and cannot upgrade its native receipt mode", async () => {
  const job = await startBrainFixture(db, project); await beginBrainStage(db, job, "research");
  const { request } = await planBrainCall(db, job, "research");
  await expect(brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [job.id, job.lease_token, { ...request, policy: { ...request.policy, budgetControl: "local_unlimited_v1" } }]))).rejects.toThrow("invalid_local_execution_mode");
  expect((await brainWorker(db, () => db.query<{ value: boolean }>("select public.authorize_naming_brain_dispatch($1,$2,$3) value", [job.id, job.lease_token, request]))).rows[0]!.value).toBe(true);
  expect((await db.query("select request#>>'{policy,budgetControl}' mode from fluid_private.naming_brain_calls where run_id=$1", [job.input.runId])).rows).toEqual([{ mode: null }]);
 });

 it("closes a quarantined known cancelled tool-limit attempt and admits only an explicit same-project Resume", async () => {
  await db.exec("update public.usage_accounts set limit_microusd=0");
  const admitted = await brainRpc<{ run: { jobId: string; runId: string } }>(db, "ensure_local_naming_brain_run", [project, initialIntent("synthetic-tool-limit-original")]);
  const claimed = await claimBrain(db), job = claimed.job;
  await brainAction(db, job, "plan", { manifest: brainManifest, gapEnvelope: brainGapEnvelope }); await beginBrainStage(db, job, "research");
  const { request, snapshot, allocation } = await planBrainCall(db, job, "research");
  const savedRequest = { ...request, policy: { ...request.policy, budgetControl: "local_unlimited_v1" } };
  await brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [job.id, job.lease_token, savedRequest]));
  const sessionId = "synthetic-tool-limit-session", turnId = "synthetic-tool-limit-turn", agentId = "synthetic-tool-limit-agent";
  const receipt = { version: 1, provider: "openai", billingMode: "openai_api", runId: job.input.runId, stageKey: "research", role: allocation.role, snapshotHash: snapshot.snapshotHash, protocol: "openai_agents", budgetControl: "local_unlimited_v1", providerCallKey: allocation.providerCallKey, assignmentKey: null, requestKey: allocation.requestKey, requestHash: allocation.requestHash, sessionLimitCents: allocation.sessionLimitCents, dispatchState: "unknown", requestId: "req_synthetic_known_session", sessionId, turnId, agentId, responseId: null,
   callIds: Array.from({ length: 5 }, (_, index) => `synthetic-search-${index}`), observedModel: request.policy.model, toolCalls: Array.from({ length: 5 }, (_, index) => ({ callId: `synthetic-search-${index}`, type: "web_search", providerItemId: `synthetic-search-${index}`, status: "completed" })), artifactItemIds: [], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-17T12:00:00Z" };
  await brainWorker(db, () => db.query("select public.record_naming_brain_provider_receipt($1,$2,$3)", [job.id, job.lease_token, receipt]));
  const ambiguous = { artifactIds: [], errorCode: "provider_tool_limit" };
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'research','ambiguous',$3)", [job.id, job.lease_token, ambiguous]));
  const originalHistory = (await db.query("select * from fluid_private.naming_brain_stage_results where run_id=$1", [job.input.runId])).rows;
  const observer = await claimBrain(db); expect(observer.mode).toBe("observe_only"); expect(observer.job.id).toBe(admitted.run.jobId);
  const observed = observer.job;
  await brainAction(db, observed, "provider_turn", { providerCallKey: allocation.providerCallKey, sessionId, turnId, turn: { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: "cancelled", created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null } });
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'research','failed',$3)", [observed.id, observed.lease_token, { artifactIds: [], errorCode: "provider_turn_cancelled" }]));
  await brainAction(db, observed, "finish", { state: "failed", errorCode: "provider_tool_limit" });
  expect((await db.query("select * from fluid_private.naming_brain_stage_results where run_id=$1 and state='ambiguous'", [job.input.runId])).rows).toEqual(originalHistory);
  expect((await db.query("select request from fluid_private.naming_brain_calls where run_id=$1", [job.input.runId])).rows).toEqual([{ request: savedRequest }]);
  expect(await brainRpc(db, "get_naming_brain_job_accounting", [job.id])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
  const terminal = await brainRpc<{ revision: number; canResume: boolean }>(db, "get_naming_brain_run", [project, job.input.runId]); expect(terminal.canResume).toBe(true);
  expect((await brainRpc<{ run: { runId: string } }>(db, "ensure_local_naming_brain_run", [project, initialIntent("synthetic-no-automatic-retry")])).run.runId).toBe(job.input.runId);
  const intent = { ...initialIntent("synthetic-explicit-known-resume"), reason: "resume", resumeOfRunId: job.input.runId, expectedRunRevision: terminal.revision };
  const resumed = await brainRpc<{ status: string; run: { runId: string; resumedFromRunId: string } }>(db, "ensure_local_naming_brain_run", [project, intent]);
  expect(resumed.status).toBe("pending"); expect(resumed.run.resumedFromRunId).toBe(job.input.runId); expect(resumed.run.runId).not.toBe(job.input.runId);
  expect(await brainRpc(db, "ensure_local_naming_brain_run", [project, intent])).toEqual({ ...resumed, reused: true });
  expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_calls")).rows).toEqual([{ count: 1 }]);
  expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_runs")).rows).toEqual([{ count: 2 }]);
 });

 it("repairs only the current evidenced rejected attempt and preserves unrelated cancelled work, history and holds", async () => {
  const admitted = [await namingProject("synthetic-repair-first"), await namingProject("synthetic-repair-second")];
  const identities: { runId: string; jobId: string; projectId: string }[] = [];
  for (const admission of admitted) {
   const claimed = await claimBrain(db); expect(claimed.job.id).toBe(admission.run.jobId);
   await brainAction(db, claimed.job, "plan", { manifest: brainManifest, gapEnvelope: brainGapEnvelope }); await beginBrainStage(db, claimed.job, "research");
   const { request, snapshot, allocation } = await planBrainCall(db, claimed.job, "research");
   await brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [claimed.job.id, claimed.job.lease_token, request]));
   const receipt = { version: 1, provider: "openai", billingMode: "openai_api", runId: claimed.job.input.runId, stageKey: "research", role: allocation.role, snapshotHash: snapshot.snapshotHash, protocol: "openai_agents", providerCallKey: allocation.providerCallKey, assignmentKey: null, requestKey: allocation.requestKey, requestHash: allocation.requestHash, sessionLimitCents: allocation.sessionLimitCents, dispatchState: "not_dispatched", requestId: "req_synthetic_repair", sessionId: null, turnId: null, agentId: null, responseId: null, callIds: [], observedModel: null, toolCalls: [], artifactItemIds: [], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-17T12:00:00Z" };
   await brainWorker(db, () => db.query("select public.record_naming_brain_provider_receipt($1,$2,$3)", [claimed.job.id, claimed.job.lease_token, receipt]));
   await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'research','ambiguous',$3)", [claimed.job.id, claimed.job.lease_token, { artifactIds: [], errorCode: "provider_request_rejected" }]));
   identities.push({ runId: admission.run.runId, jobId: admission.run.jobId, projectId: snapshot.projectId as string });
  }
  await db.query("update public.jobs set cancel_requested_at=clock_timestamp() where id=$1", [identities[0]!.jobId]);
  const snapshot = () => db.query("select (select jsonb_agg(to_jsonb(a) order by owner_id) from public.usage_accounts a) accounts,(select jsonb_agg(to_jsonb(r) order by job_id) from public.usage_reservations r) holds,(select jsonb_agg(to_jsonb(c) order by run_id,call_key) from fluid_private.naming_brain_calls c) calls,(select jsonb_agg(to_jsonb(p) order by id) from fluid_private.naming_brain_receipts p) receipts,(select jsonb_agg(to_jsonb(p) order by id) from public.projects p) projects");
  const before = (await snapshot()).rows;
  const prior = (await db.query("select * from fluid_private.naming_brain_stage_results order by id")).rows;
  let repair = await readFile(new URL("../../supabase/activation/naming_brain_11_close_known_rejections.sql", import.meta.url), "utf8");
  const originalIds = ["e839cccb-89be-4c6c-9be8-5199b417dda4", "90d3fda3-de0b-48c2-946e-2200b67a883a", "b3b82fa9-36a6-437e-9826-9afaf0d796a1"];
  const syntheticIds = [identities[1]!.runId, identities[1]!.projectId, identities[1]!.jobId];
  repair = repair.replaceAll("6840f4c2-15a6-45a7-97be-41e7e5e37f42", OWNER_A);
  for (let index = 0; index < originalIds.length; index++) repair = repair.replaceAll(originalIds[index]!, syntheticIds[index]!);
  await db.exec(repair);
  expect((await snapshot()).rows).toEqual(before);
  expect((await db.query("select * from fluid_private.naming_brain_stage_results where state='ambiguous' order by id")).rows).toEqual(prior);
  expect((await db.query("select state,count(*)::integer count from fluid_private.naming_brain_stage_results group by state order by state")).rows).toEqual([{ state: "ambiguous", count: 2 }, { state: "failed", count: 1 }]);
  expect((await db.query("select state,error_code from public.jobs order by state")).rows).toEqual([{ state: "failed", error_code: "provider_request_rejected" }, { state: "needs_reconciliation", error_code: "provider_request_rejected" }]);
  expect((await db.query("select cancel_requested_at is not null cancelled from public.jobs where id=$1", [identities[0]!.jobId])).rows).toEqual([{ cancelled: true }]);
  await expect(db.exec(repair)).rejects.toThrow("known_rejection_repair_evidence_mismatch"); await db.exec("rollback");
  expect((await snapshot()).rows).toEqual(before);
 });

 it("composes all local migrations with the historical guarded vector candidate", async () => {
  await db.exec(await readFile(new URL("../../supabase/candidates/logo-vector-proposals.sql", import.meta.url), "utf8"));
  await db.exec("update public.usage_accounts set limit_microusd=0");
  const admitted = await strategyEnqueue((await strategyProject()).id, "synthetic-unlimited-composition");
  const store = new PostgresJobStore(db, { localPrototype: true });
  await brainWorker(db, async () => {
   const job = (await store.claim("fixture-composed-local", 60))!; expect(job.id).toBe(admitted.id);
   await store.registerPlan(job, [{ key: "guided", maximumCostMicrousd: policy.maximumCostMicrousd }]); expect(await store.beginStep(job, "guided", policy.maximumCostMicrousd)).toBe("started");
   await store.completeStep(job, "guided", { status: "failed", code: "synthetic_known_failure", costMicrousd: policy.maximumCostMicrousd + 1, providerRequestId: null }); await store.finish(job, "failed");
  });
 });
});
