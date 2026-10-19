import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { createTestDatabase, OWNER_A, type TestDatabase } from "./local-supabase";
import { beginBrainStage, brainAction, brainGapEnvelope, brainManifest, brainPolicy, brainRpc, brainWorker, claimBrain, initialIntent, installBrainFixture, planBrainCall, saveBrainArtifact, seedBrainFixture } from "./naming-brain-fixture";

// These cases deliberately admit historical seven-stage jobs. The progressive
// suite separately verifies their unchanged execution after the forward upgrade.
describe("trusted local pre-create failure evidence (synthetic SQL)", () => {
 let db: TestDatabase, project: string;
 beforeAll(async () => { db = await createTestDatabase({ before: "20261017170000_local_progressive_naming.sql" }); await installBrainFixture(db); }, 60_000);
 beforeEach(async () => {
  project = await seedBrainFixture(db); const policy = guidedStrategyPolicy("strategy.reformulate");
  await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
  await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
 });
 afterAll(async () => { await db?.close(); });
 async function start(local = true) {
  await brainRpc(db, local ? "ensure_local_naming_brain_run" : "ensure_naming_brain_run", [project, initialIntent("synthetic-pre-create")]);
  const { job } = await claimBrain(db); await brainAction(db, job, "plan", { manifest: brainManifest, gapEnvelope: brainGapEnvelope }); return job;
 }
 type Job = Awaited<ReturnType<typeof start>>;
 const record = (job: Job, receipt: unknown) => brainWorker(db, () => db.query("select public.record_naming_brain_provider_receipt($1,$2,$3)", [job.id, job.lease_token, receipt]));
 const output = (receipt: Record<string, unknown>) => ({ artifactIds: [], errorCode: "local_dispatch_not_attempted", partialArtifacts: [{ providerCallKey: receipt.providerCallKey, status: "rejected_before_dispatch", code: "local_dispatch_not_attempted", receipt }] });
 const emptyReceipt = (job: Job, request: Record<string, unknown>, mode = true) => ({ version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents", ...(mode ? { budgetControl: "local_unlimited_v1" } : {}), runId: job.input.runId, stageKey: request.stageKey, role: request.role, snapshotHash: request.snapshotHash,
  providerCallKey: request.providerCallKey, assignmentKey: request.assignmentKey, requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: (request.policy as { sessionLimitCents: number }).sessionLimitCents,
  dispatchState: "not_dispatched", requestId: null, sessionId: null, turnId: null, agentId: null, responseId: null, callIds: [], observedModel: null, toolCalls: [], artifactItemIds: [], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-17T12:00:00Z" });
 async function research(local = true) {
  const job = await start(local); await beginBrainStage(db, job, "research");
  const { request } = await planBrainCall(db, job, "research"); const saved = { ...request, policy: { ...request.policy, ...(local ? { budgetControl: "local_unlimited_v1" } : {}) } };
  await brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [job.id, job.lease_token, saved]));
  return { job, request: saved, receipt: emptyReceipt(job, saved, local) };
 }
 const qualifies = async (runId: string, proof: unknown) => (await db.query<{ value: boolean }>("select fluid_private.naming_brain_local_not_dispatched(c,$2) value from fluid_private.naming_brain_calls c where run_id=$1", [runId, proof])).rows[0]!.value;

 it("requires an explicit exact failure proof, then closes normally without settling the held allowance", async () => {
  const { job, receipt } = await research(); await record(job, receipt);
  expect(await qualifies(job.input.runId, { artifactIds: [], errorCode: "local_dispatch_not_attempted" })).toBe(false);
  await db.exec("begin");
  const unproven = await brainWorker(db, () => db.query<{ value: { state: string } }>("select public.complete_naming_brain_stage($1,$2,'research','failed',$3) value", [job.id, job.lease_token, { artifactIds: [], errorCode: "local_dispatch_not_attempted" }]));
  expect(unproven.rows[0]!.value.state).toBe("ambiguous"); await db.exec("rollback");
  const proof = output(receipt); expect(await qualifies(job.input.runId, proof)).toBe(true);
  const before = (await db.query("select * from public.usage_reservations where job_id=$1", [job.id])).rows;
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'research','failed',$3)", [job.id, job.lease_token, proof]));
  await brainAction(db, job, "finish", { state: "failed", errorCode: "local_dispatch_not_attempted" });
  expect((await db.query("select fluid_private.naming_brain_call_terminal(c) terminal from fluid_private.naming_brain_calls c where run_id=$1", [job.input.runId])).rows).toEqual([{ terminal: true }]);
  expect((await db.query("select * from public.usage_reservations where job_id=$1", [job.id])).rows).toEqual(before);
  expect(await brainRpc(db, "get_naming_brain_job_accounting", [job.id])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
  expect(await brainRpc(db, "get_naming_brain_run", [project, job.input.runId])).toMatchObject({ canResume: true });
 });

 it("does not reinterpret a bare base receipt, later unknown dispatch, or a native run as proof", async () => {
  const { job, receipt } = await research(); await record(job, receipt);
  await record(job, { ...receipt, dispatchState: "unknown", recordedAt: "2026-10-17T12:00:01Z" });
  expect(await qualifies(job.input.runId, output(receipt))).toBe(false);
  expect((await db.query("select fluid_private.naming_brain_call_terminal(c) terminal from fluid_private.naming_brain_calls c where run_id=$1", [job.input.runId])).rows).toEqual([{ terminal: false }]);
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'research','ambiguous',$3)", [job.id, job.lease_token, { artifactIds: [], errorCode: "synthetic_unknown" }]));
  project = await seedBrainFixture(db); const native = await research(false); await record(native.job, native.receipt);
  expect(await qualifies(native.job.input.runId, output(native.receipt))).toBe(false);
 });

 it.each(["callIds", "toolCalls", "artifactItemIds", "usageObservations", "providerCostCounters", "dispatchState"])("does not treat a missing %s field as proof of no dispatch", async key => {
  const { job, receipt } = await research(); const malformed: Record<string, unknown> = { ...receipt }; delete malformed[key];
  await record(job, malformed); expect(await qualifies(job.input.runId, output(malformed))).toBe(false);
 });

 it("applies the exact packet once with synthetic identity/hash bindings, appends evidence only, and uses normal closure", async () => {
  const job = await start();
  await saveBrainArtifact(db, job, "research", { role: "researcher", facts: [], interpretations: [], uncertainties: [] }, { readiness: "sourced", sources: [] });
  await saveBrainArtifact(db, job, "direction", { role: "director", round: "initial", assignments: [], feedbackHypotheses: [] });
  await beginBrainStage(db, job, "creation");
  const snapshot = (await db.query<{ snapshot: Record<string, unknown> }>("select snapshot from fluid_private.naming_brain_runs where id=$1", [job.input.runId])).rows[0]!.snapshot;
  const allocations = Array.from({ length: 7 }, (_, i) => ({ providerCallKey: `creation-creator-a${i + 1}`, assignmentKey: `a${i + 1}`, requestKey: `synthetic-packet-a${i + 1}-request`, requestHash: createHash("sha256").update(`synthetic-packet-a${i + 1}`).digest("hex"), sessionLimitCents: 10, maxWebSearchCalls: 0, role: "creator" }));
  await brainAction(db, job, "call_plan", { stageKey: "creation", calls: allocations });
  for (const [i, allocation] of allocations.entries()) {
   const request = { ...allocation, runId: job.input.runId, stageKey: "creation", snapshotHash: snapshot.snapshotHash, input: { role: "creator", snapshot }, dependencyArtifactIds: [], policy: { model: brainPolicy.model, protocol: "openai_agents", nativeDelegation: false, maximumCostMicrousd: 100_000, sessionLimitCents: 10, maxWebSearchCalls: 0, budgetControl: "local_unlimited_v1" } };
   await brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3)", [job.id, job.lease_token, request]));
   const receipt = emptyReceipt(job, request);
   if (i === 6) { await record(job, { ...receipt, dispatchState: "unknown" }); continue; }
   const sessionId = `synthetic-packet-session-${i}`, turnId = `synthetic-packet-turn-${i}`;
   await record(job, { ...receipt, dispatchState: "dispatched", sessionId, turnId });
   await brainAction(db, job, "provider_turn", { providerCallKey: allocation.providerCallKey, sessionId, turnId, turn: { id: turnId, session_id: sessionId, agent_id: "synthetic-agent", subagent_id: null, object: "agent.session.turn", status: "cancelled", created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null } });
  }
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'creation','ambiguous',$3)", [job.id, job.lease_token, { artifactIds: [], errorCode: "observation_cancelled" }]));
  const bindings = (await db.query<{ snapshot_hash: string; policy_identity: string; admitted_role_oid: number; call_hash: string; request_hash: string; request_key: string; receipt_id: string; receipt_hash: string; content_hash: string }>("select r.snapshot_hash,r.policy_identity,r.admitted_role_oid,md5(to_jsonb(c)::text) call_hash,c.request->>'requestHash' request_hash,c.request->>'requestKey' request_key,q.id receipt_id,md5(to_jsonb(q)::text) receipt_hash,q.content_hash from fluid_private.naming_brain_runs r join fluid_private.naming_brain_calls c on c.run_id=r.id and c.call_key='creation-creator-a7' join fluid_private.naming_brain_receipts q on q.run_id=c.run_id and q.call_key=c.call_key where r.id=$1", [job.input.runId])).rows[0]!;
  let packet = await readFile(new URL("../../supabase/activation/naming_brain_12_close_pre_dispatch_a7.sql", import.meta.url), "utf8");
  // Only exact fixture identities, hashes and scalar bindings change. Every
  // production predicate and append-only statement executes without alteration.
  const substitutions = [
   ["6840f4c2-15a6-45a7-97be-41e7e5e37f42", OWNER_A], ["91ef5c13-bb82-44a3-945d-f896d7a4642f", job.input.runId], ["68fd2858-0469-4638-abfc-b48de580f729", job.id], ["90d3fda3-de0b-48c2-946e-2200b67a883a", project],
   ["bf545c3a7d9278a9c012f9a74382475ee4e83e36c3d27f9047369a965847fe71", bindings.snapshot_hash], ["274ab21a826621e20109af32c3afd006285cd36a94ebeb35578d1147997e8381", bindings.policy_identity],
   ["046689f3cd721cbdee9c4a1bede19594", bindings.call_hash], ["9af8577fb94525a6b580fb4e13c2dad896276eb7e8fc2f2f59d313a0b0c456d9", bindings.request_hash], ["naming-7a46bc2d76d4bd749b9d8982130128c9760e740e713519ea", bindings.request_key],
   ["91da4683-adbc-46e9-bdfc-4c1e19895b62", bindings.receipt_id], ["dfb4abdcbbbdd95f862917cf72268846", bindings.receipt_hash], ["5ff3e5d29c9468be373b044d7c513afd09f38791527b6e6d730adc336ea979a3", bindings.content_hash],
   ["r.admitted_role_oid<>23033", `r.admitted_role_oid<>${bindings.admitted_role_oid}`], ["p.current_revision<>5", "p.current_revision<>1"],
  ];
  for (const [real, synthetic] of substitutions) { expect(packet).toContain(real); packet = packet.replaceAll(real!, synthetic!); }
  const unchanged = () => db.query("select (select jsonb_agg(to_jsonb(j) order by id) from public.jobs j) jobs,(select jsonb_agg(to_jsonb(r) order by id) from fluid_private.naming_brain_runs r) runs,(select jsonb_agg(to_jsonb(s) order by id) from public.job_steps s) steps,(select jsonb_agg(to_jsonb(a) order by id) from fluid_private.naming_brain_artifacts a) artifacts,(select jsonb_agg(to_jsonb(c) order by run_id,call_key) from fluid_private.naming_brain_calls c) calls,(select jsonb_agg(to_jsonb(a) order by owner_id) from public.usage_accounts a) ledger,(select jsonb_agg(to_jsonb(r) order by job_id) from public.usage_reservations r) holds,(select jsonb_agg(to_jsonb(p) order by id) from public.projects p) projects");
  const before = (await unchanged()).rows, receipts = (await db.query<{ id: string }>("select * from fluid_private.naming_brain_receipts order by id")).rows, verdicts = (await db.query<{ id: string }>("select * from fluid_private.naming_brain_stage_results order by id")).rows;
  await db.exec(packet); expect((await unchanged()).rows).toEqual(before);
  expect((await db.query("select * from fluid_private.naming_brain_receipts where id=any($1::uuid[]) order by id", [receipts.map(row => row.id)])).rows).toEqual(receipts);
  expect((await db.query("select * from fluid_private.naming_brain_stage_results where id=any($1::uuid[]) order by id", [verdicts.map(row => row.id)])).rows).toEqual(verdicts);
  expect((await db.query<{ n: number }>("select count(*)::int n from fluid_private.naming_brain_receipts")).rows[0]!.n).toBe(receipts.length + 1);
  expect((await db.query<{ n: number }>("select count(*)::int n from fluid_private.naming_brain_stage_results")).rows[0]!.n).toBe(verdicts.length + 1);
  await expect(db.exec(packet)).rejects.toThrow(); await db.exec("rollback");
  const observer = await claimBrain(db); expect(observer.mode).toBe("observe_only");
  const proof = (await db.query<{ output: unknown }>("select output from fluid_private.naming_brain_stage_results where run_id=$1 and stage_key='creation' and state='failed'", [job.input.runId])).rows[0]!.output;
  await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'creation','failed',$3)", [observer.job.id, observer.job.lease_token, proof]));
  await brainAction(db, observer.job, "finish", { state: "partial", errorCode: "local_dispatch_not_attempted" });
  expect(await brainRpc(db, "get_naming_brain_run", [project, job.input.runId])).toMatchObject({ canResume: true });
 });
});
