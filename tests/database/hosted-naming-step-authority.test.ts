import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainJobInputSchema } from "../../src/domain/naming-brain";
import { NamingBrainJobStore, normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { beginBrainStage, brainRpc, brainWorker, initialIntent, installBrainFixture, seedBrainFixture, startBrainFixture } from "./naming-brain-fixture";
import { enableHostedNamingFixture } from "./hosted-naming-fixture";
import { progressiveRequest, saveProgressivePart, saveProgressiveResearch } from "./naming-brain-progressive-fixture";

const migration = "20261019032503_hosted_naming_step_authority.sql";
const manifest = [{ key: "creation", maximumCostMicrousd: 1_500_000 }, { key: "prepare", maximumCostMicrousd: 0 }];
const success = { status: "succeeded" as const, costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } };

async function admitHosted(db: TestDatabase, project: string) {
 await enableHostedNamingFixture(db);
 const intent = initialIntent("synthetic-hosted-step-authority");
 const admission = await brainRpc(db, "ensure_hosted_naming_brain_run", [project, intent]);
 const store = new NamingBrainJobStore(db, "fixture-deployment");
 const job = await brainWorker(db, () => store.claim("fixture-worker", 120));
 if (!job) throw Error("synthetic_hosted_step_job_missing");
 const input = namingBrainJobInputSchema.parse(normalizeNamingStoredJson(job.input));
 await brainWorker(db, () => store.registerPlan(job, manifest));
 expect(await brainWorker(db, () => store.heartbeat(job, 120))).toEqual({ cancelled: false });
 return { db, project, store, job, input, intent, admission };
}

/** Synthetic historical unknown job, deliberately outside the Naming claim queue. */
async function unknownJob(db: TestDatabase, project?: string) {
 const id = project ?? (await brainRpc<{ id: string }>(db, "create_project", ["complete_brand", "Synthetic prior unknown", { description: "Synthetic historical unknown outcome" }, "b".repeat(64)])).id;
 return (await db.query<{ id: string }>(`insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd,error_code)
 values($1,$2,'strategy',1,repeat('b',64),'{}','synthetic-prior-unknown','needs_reconciliation',100,'provider_outcome_unknown') returning id`, [OWNER_A, id])).rows[0]!.id;
}

async function exhaustedAccount(db: TestDatabase) {
 await db.query("update public.usage_accounts set limit_microusd=0,reserved_microusd=137452538,spent_microusd=1219914,provider_actual_microusd=1219914 where owner_id=$1", [OWNER_A]);
}

describe("hosted Naming shared step authority (synthetic database)", () => {
 let db: TestDatabase, project: string;
 beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 60_000);
 beforeEach(async () => { project = await seedBrainFixture(db); });
 afterAll(async () => { await db?.close(); });

 it("repairs the exact existing claim through plan, heartbeat, begin and dispatch without resetting attempts or historical unknown work", async () => {
  const prior = await createTestDatabase({ before: migration });
  try {
   await installBrainFixture(prior); const target = await seedBrainFixture(prior);
   const unknown = await unknownJob(prior); await exhaustedAccount(prior);
   const fixture = await admitHosted(prior, target);
   const history = (await prior.query("select to_jsonb(j) row from public.jobs j where id=$1", [unknown])).rows;
   const identity = (await prior.query("select input,input_hash,attempts,lease_token,plan_manifest from public.jobs where id=$1", [fixture.job.id])).rows;
   expect((await prior.query("select fluid_private.api_text_paid_paused($1) paused", [OWNER_A])).rows).toEqual([{ paused: true }]);
   await expect(brainWorker(prior, () => fixture.store.beginStep(fixture.job, "creation", 1_500_000))).rejects.toThrow("paid_outcome_unresolved");
   expect((await prior.query("select count(*)::int count from public.job_steps where job_id=$1", [fixture.job.id])).rows).toEqual([{ count: 0 }]);

   await prior.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
   await brainWorker(prior, () => fixture.store.registerPlan(fixture.job, manifest));
   expect(await brainWorker(prior, () => fixture.store.heartbeat(fixture.job, 120))).toEqual({ cancelled: false });
   expect(await brainWorker(prior, () => fixture.store.beginStep(fixture.job, "creation", 1_500_000))).toBe("started");
   const request = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
   await brainWorker(prior, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.research", [request]));
   await brainWorker(prior, () => fixture.store.authorizeDispatch(fixture.job, request));
   expect((await prior.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1", [fixture.input.runId])).rows).toEqual([{ count: 1 }]);
   expect((await prior.query("select input,input_hash,attempts,lease_token,plan_manifest from public.jobs where id=$1", [fixture.job.id])).rows).toEqual(identity);
   expect((await prior.query("select to_jsonb(j) row from public.jobs j where id=$1", [unknown])).rows).toEqual(history);
   expect((await prior.query("select count(*)::int count from fluid_private.local_prototype_jobs")).rows).toEqual([{ count: 0 }]);
  } finally { await prior.close(); }
 }, 60_000);

 it.each(["begin", "dispatch"] as const)("blocks %s when an unknown outcome belongs to the same project", async boundary => {
  const fixture = await admitHosted(db, project);
  const request = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
  if (boundary === "dispatch") {
   await brainWorker(db, () => fixture.store.beginStep(fixture.job, "creation", 1_500_000));
   await brainWorker(db, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.research", [request]));
  }
  const unknown = await unknownJob(db, project); await exhaustedAccount(db);
  const history = (await db.query("select to_jsonb(j) row from public.jobs j where id=$1", [unknown])).rows;
  await expect(brainWorker(db, async () => {
   if (boundary === "begin") await fixture.store.beginStep(fixture.job, "creation", 1_500_000);
   else await fixture.store.authorizeDispatch(fixture.job, request);
  })).rejects.toThrow();
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1", [fixture.input.runId])).rows).toEqual([{ count: 0 }]);
  expect((await db.query("select to_jsonb(j) row from public.jobs j where id=$1", [unknown])).rows).toEqual(history);
 });

 it.each(["begin", "dispatch"] as const)("requires the enabled hosted capability at the paid %s boundary", async boundary => {
  const fixture = await admitHosted(db, project);
  const request = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
  if (boundary === "dispatch") {
   await brainWorker(db, () => fixture.store.beginStep(fixture.job, "creation", 1_500_000));
   await brainWorker(db, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.research", [request]));
  }
  await unknownJob(db); await exhaustedAccount(db);
  await db.exec("update fluid_private.hosted_naming_capabilities set enabled=false");
  await expect(brainWorker(db, async () => {
   if (boundary === "begin") await fixture.store.beginStep(fixture.job, "creation", 1_500_000);
   else await fixture.store.authorizeDispatch(fixture.job, request);
  })).rejects.toThrow();
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1", [fixture.input.runId])).rows).toEqual([{ count: 0 }]);
 });

 it("completes saved zero-cost preparation after disablement despite unrelated account holds", async () => {
  const fixture = await admitHosted(db, project);
  await brainWorker(db, () => fixture.store.beginStep(fixture.job, "creation", 1_500_000));
  for (let index = 0; index < 17; index++) {
   const part = await saveProgressivePart(fixture, index, index === 16 ? 4 : 6);
   await brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, part.publication!, new AbortController().signal));
  }
  await saveProgressiveResearch(fixture);
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "creation", success));
  const calls = (await db.query("select to_jsonb(c) row from fluid_private.naming_brain_calls c where run_id=$1 order by call_key", [fixture.input.runId])).rows;
  await unknownJob(db); await exhaustedAccount(db);
  // Synthetic known expense beyond the historical reservation: even a free
  // saved step must not fail because its remaining monetary envelope is negative.
  await db.query("update public.jobs set actual_cost_microusd=reserved_cost_microusd+1 where id=$1", [fixture.job.id]);
  await db.exec("update fluid_private.hosted_naming_capabilities set enabled=false");
  await brainWorker(db, () => fixture.store.heartbeat(fixture.job, 120));
  expect(await brainWorker(db, () => fixture.store.beginStep(fixture.job, "prepare", 0))).toBe("started");
  expect(await brainWorker(db, () => fixture.store.finalizeProgressive(fixture.job))).toMatchObject({ publishedCount: 100 });
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "prepare", success));
  await brainWorker(db, () => fixture.store.finish(fixture.job, "succeeded"));
  expect((await db.query("select state from public.jobs where id=$1", [fixture.job.id])).rows).toEqual([{ state: "succeeded" }]);
  expect((await db.query("select to_jsonb(c) row from fluid_private.naming_brain_calls c where run_id=$1 order by call_key", [fixture.input.runId])).rows).toEqual(calls);
 }, 60_000);

 it("keeps ordinary Naming budget limits and generic RPC access unchanged", async () => {
  const unmarked = await startBrainFixture(db, project);
  await exhaustedAccount(db);
  await expect(beginBrainStage(db, unmarked, "research")).rejects.toThrow("budget_exceeded");
  expect((await db.query("select count(*)::int count from public.job_steps")).rows).toEqual([{ count: 0 }]);

  project = await seedBrainFixture(db);
  const fixture = await admitHosted(db, project);
  await expect(brainWorker(db, () => fixture.store.beginStep(fixture.job, "creation", 1_500_000), OWNER_B)).rejects.toThrow("worker_owner_mismatch");
  await expect(brainWorker(db, () => db.query("select public.begin_job_step($1,$2,'creation','synthetic-bypass',1500000)", [fixture.job.id, fixture.job.leaseToken]))).rejects.toMatchObject({ code: "42501" });
  await expect(asRole(db, "service_role", null, () => db.query("select public.begin_job_step($1,$2,'creation','synthetic-bypass',1500000)", [fixture.job.id, fixture.job.leaseToken]))).rejects.toThrow("worker_owner_mismatch");
 });
});
