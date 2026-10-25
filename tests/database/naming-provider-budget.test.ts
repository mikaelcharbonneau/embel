import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingProviderReceiptSchema } from "../../src/domain/naming-brain";
import { receipt } from "../domain/naming-brain-fixtures";
import { createTestDatabase, type TestDatabase } from "./local-supabase";
import { brainWorker, installBrainFixture } from "./naming-brain-fixture";
import { seedHostedNamingFixture } from "./hosted-naming-fixture";
import { progressiveRequest, seedProgressiveFixture } from "./naming-brain-progressive-fixture";
import { createProgressiveNamingAssignment } from "../../src/server/ai/naming-brain/progressive-assignments";

describe("historical database-owned provider budget (no live provider)", () => {
 let db: TestDatabase;
 beforeAll(async () => { db = await createTestDatabase({ before: "20261025232300_naming_uncapped_hosted_execution.sql" }); await installBrainFixture(db); }, 60_000);
 afterAll(async () => { await db?.close(); });
 it("marks future hosted jobs, denies missing caps and reserves at most 500 cents without re-lending", async () => {
  const f = await seedHostedNamingFixture(db);
  expect(f.input.providerBudgetVersion).toBe(1);
  const make = (index: number) => progressiveRequest(f, `part${String(index).padStart(3, "0")}.creation`, { role: "creator", snapshot: f.input.snapshot,
   assignment: createProgressiveNamingAssignment({ runId: f.input.runId, snapshot: f.input.snapshot, partIndex: index % 30, approach: "real_words", targetCount: 4 }) });
  const first = make(1), bad = { ...first, policy: { ...first.policy, providerSpendCapCents: undefined } };
  await expect(brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "part001.creation", [bad]))).rejects.toThrow(/provider_budget_required/);
  for (let i = 1; i <= 50; i++) {
   const request = make(i), phase = `part${String(i).padStart(3, "0")}.creation`;
   await brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, phase, [request]));
  }
  // Exact replay does not allocate again. Planning has reserved the full envelope
  // even before dispatch, so completed/cheap/failed calls cannot replenish it.
  await brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "part001.creation", [first]));
  await expect(brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "part051.creation", [make(51)]))).rejects.toThrow(/naming_provider_budget_exhausted/);
  expect((await db.query<{ total: number }>("select sum((q#>>'{policy,providerSpendCapCents}')::int)::int total from fluid_private.naming_brain_progressive_plans p cross join lateral jsonb_array_elements(p.requests) q where run_id=$1", [f.input.runId])).rows[0]!.total).toBe(500);
  await brainWorker(db, () => f.store.authorizeDispatch(f.job, first));
  await expect(brainWorker(db, () => f.store.authorizeDispatch(f.job, first))).rejects.toThrow();
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1", [f.input.runId])).rows).toEqual([{ count: 1 }]);
  expect((await db.query("select actual_cost_microusd from fluid_private.naming_brain_runs where id=$1", [f.input.runId])).rows).toEqual([{ actual_cost_microusd: null }]);
 }, 60_000);
 it("preserves the historical local profile and refuses smuggling a new cap into it", async () => {
  const f = await seedProgressiveFixture(db);
  expect(f.input.providerBudgetVersion).toBeUndefined();
  const request = progressiveRequest(f, "context.research", { role: "researcher", snapshot: f.input.snapshot });
  await expect(brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "context.research", [{ ...request, policy: { ...request.policy, providerSpendCapCents: 75 } }]))).rejects.toThrow(/unexpected_provider_budget/);
  await brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "context.research", [request]));
  await brainWorker(db, () => f.store.authorizeDispatch(f.job, request));
  expect((await db.query("select request#>'{policy,providerSpendCapCents}' cap from fluid_private.naming_brain_calls where run_id=$1", [f.input.runId])).rows).toEqual([{ cap: null }]);
 });
 it("binds receipts to the cap and blocks further dispatch after a real observed overrun", async () => {
  const f = await seedHostedNamingFixture(db);
  const request = progressiveRequest(f, "context.research", { role: "researcher", snapshot: f.input.snapshot });
  await brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "context.research", [request]));
  await brainWorker(db, () => f.store.authorizeDispatch(f.job, request));
  const value = namingProviderReceiptSchema.parse({ ...receipt("creation", "researcher"), budgetControl: "local_unlimited_v1", localPipelineVersion: 2,
   providerSpendCapCents: 25, sessionLimitCents: 25, runId: f.input.runId, snapshotHash: request.snapshotHash, requestKey: request.requestKey,
   requestHash: request.requestHash, providerCallKey: request.providerCallKey, assignmentKey: null, observedModel: request.policy.model,
   providerCostCounters: [{ scope: "session", scopeId: "session-budget-fixture", kind: "consumed_usd_cents", value: 26, observedAt: new Date().toISOString() }] });
  await expect(brainWorker(db, () => f.store.recordReceipt(f.job, { ...value, providerSpendCapCents: undefined }))).rejects.toThrow(/receipt_mismatch/);
  await brainWorker(db, () => f.store.recordReceipt(f.job, value));
  expect((await db.query("select observed_overrun,actual_cost_microusd from fluid_private.naming_brain_runs where id=$1", [f.input.runId])).rows).toEqual([{ observed_overrun: true, actual_cost_microusd: null }]);
  await expect(brainWorker(db, () => f.store.action(f.job, "publish_microbatch", { version: 1, key: "part001", candidates: [{}], curationArtifactId: f.input.runId, verification: { kind: "not_required", reason: "no_factual_claims" } }))).rejects.toThrow(/microbatch_stopped/);
  expect((await db.query("select fluid_private.local_naming_progressive_current(r) allowed from fluid_private.naming_brain_runs r where id=$1", [f.input.runId])).rows).toEqual([{ allowed: false }]);
  await expect(brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "context.research", [request]))).rejects.toThrow(/observation_only/);
 });

 it("leaves already-admitted hosted input and saved request bytes unchanged during upgrade", async () => {
  const migration = "20261023230404_naming_provider_budget_guard.sql";
  const prior = await createTestDatabase({ before: migration });
  try {
   await installBrainFixture(prior); const f = await seedHostedNamingFixture(prior);
   const request = progressiveRequest(f, "context.research", { role: "researcher", snapshot: f.input.snapshot });
   await brainWorker(prior, () => f.store.saveProgressiveCallPlan(f.job, "context.research", [request]));
   const rows = async () => ({ job: (await prior.query("select input,input_hash from public.jobs where id=$1", [f.job.id])).rows,
    plans: (await prior.query("select requests from fluid_private.naming_brain_progressive_plans where run_id=$1", [f.input.runId])).rows,
    grants: (await prior.query("select oid,proowner,proacl,prosecdef,proconfig from pg_proc where oid in('public.ensure_naming_brain_run(uuid,jsonb)'::regprocedure,'public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)'::regprocedure) order by oid")).rows });
   const before = await rows();
   await prior.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
   expect(await rows()).toEqual(before);
   await brainWorker(prior, () => f.store.authorizeDispatch(f.job, request));
   expect(request.policy.providerSpendCapCents).toBeUndefined();
  } finally { await prior.close(); }
 }, 60_000);

});
