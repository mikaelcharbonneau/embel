import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedWorkerFixture, OWNER_A, OWNER_B } from "./shared-worker-fixture";
import { brainPolicy, brainPreferences, brainReadinessFingerprint, brainRpc, initialIntent } from "./naming-brain-fixture";
import { sharedSlotLeaseSchema, type SharedExecution } from "../../worker/shared-pool/contracts";

const read = (name: string) => readFile(new URL(`../../supabase/candidates/${name}`, import.meta.url), "utf8");

/** Actual restricted SQL in disposable PostgreSQL. No provider is called. */
async function fixture() {
  const f = await createSharedWorkerFixture({ probe: false }), db = f.db;
  await f.seedUser(OWNER_A); await f.seedUser(OWNER_B);
  // The production order. The event-capacity repair uses its shipped local
  // target, adapted to this PGlite (PG18) exactly as the brainstorm runtime test.
  for (const name of ["shared_worker_naming.sql", "shared_naming_brainstorm.sql"]) await db.exec(await read(name));
  const schemaModule = new URL("../../scripts/development/shared-schema.mjs", import.meta.url).href;
  const { developmentEventCapacity } = await import(schemaModule) as { developmentEventCapacity(sql: string): string };
  await db.exec("create table fluid_private.shared_http_target(singleton boolean, mode text, origin text); insert into fluid_private.shared_http_target values(true,'development','http://127.0.0.1:54321'); set embel.portable_origin='http://127.0.0.1:54321'; set embel.portable_development='true';");
  await db.exec(developmentEventCapacity(await read("shared_naming_brainstorm_event_capacity.sql"))
    .replace("current_setting('server_version_num')::integer<>170011", "current_setting('server_version_num')::integer<>180003")
    .replaceAll("count(*)FROM pg_constraint WHERE conrelid=t)", "count(*)FROM pg_constraint WHERE conrelid=t AND contype<>'n')"));
  for (const name of ["shared_naming_brainstorm_delivery_recovery.sql", "shared_naming_lease_expiry.sql"]) await db.exec(await read(name));
  const policy = { ...brainPolicy, model: "gpt-6-luna" };
  const policyIdentity = (await db.query<{ h: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h", [JSON.stringify(policy)])).rows[0]!.h;
  const slot = await f.seedSlot({ lane: "naming", policies: [{ operation: "naming.generate", policyIdentity, policy }] });
  await db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  await db.query("insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)", [slot.slotId, JSON.stringify(brainReadinessFingerprint)]);
  const lease = sharedSlotLeaseSchema.parse(await f.lease(slot));
  const action = async (name: string, args: unknown, execution: SharedExecution | null = null) => f.asSlot(slot, async () => (await db.query<{ v: { execution: SharedExecution | null; result: unknown } }>(
    "select public.shared_naming_worker_action($1,$2,$3,$4) v", [lease, execution, name, JSON.stringify(args)])).rows[0]!.v);
  await action("qualify", [policy, brainReadinessFingerprint]);
  // One admitted, claimed brainstorm run per call; its worker then "stops".
  async function claimed(key: string) {
    const project = (await brainRpc<{ id: string }>(db, "create_project", ["naming_only", `Expiry ${key}`, { description: "Synthetic brief" }, "a".repeat(64)])).id;
    await brainRpc(db, "save_naming_preferences", [project, 0, brainPreferences]);
    await brainRpc(db, "ensure_shared_naming_brainstorm_run", [project, initialIntent(`lease-expiry-${key}`)]);
    const work = (await action("preference_work", [20])).result as { projectId: string; preferencesVersion: number; preferencesHash: string }[];
    const row = work.find(r => r.projectId === project)!;
    await action("attest_preferences", [project, row.preferencesVersion, row.preferencesHash, brainReadinessFingerprint, { ready: true, missing: [] }]);
    await brainRpc(db, "ensure_shared_naming_brainstorm_run", [project, initialIntent(`lease-expiry-${key}`)]);
    const claim = await action("claim", [`worker-${key}`, slot.deploymentId, 120]);
    const job = (claim.result as { job: { id: string; input: { runId: string } } }).job;
    return { project, jobId: job.id, runId: job.input.runId, worker: `worker-${key}`, execution: claim.execution! };
  }
  const expire = async () => (await action("expire", ["expiry-worker", slot.deploymentId])).result;
  const stopWorker = (jobId: string) => db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [jobId]);
  const job = async (jobId: string) => (await db.query<{ state: string; error_code: string | null; lease_token: string | null; attempts: number }>(
    "select state,error_code,lease_token,attempts from public.jobs where id=$1", [jobId])).rows[0]!;
  const hold = async (jobId: string) => (await db.query<{ state: string; actual_microusd: string | null }>("select state,actual_microusd from public.usage_reservations where job_id=$1", [jobId])).rows[0]!;
  const executionState = async (jobId: string) => (await db.query<{ state: string }>("select state from fluid_private.shared_worker_executions where job_id=$1 order by created_at", [jobId])).rows.map(r => r.state);
  return { f, db, slot, policy, action, claimed, expire, stopWorker, job, hold, executionState };
}

const request = (model: string, jobId: string, runId: string) => ({ model, store: true, stream: true, reasoning: { effort: "low" }, max_output_tokens: 16000, input: "Synthetic source fixture",
  text: { verbosity: "low", format: { type: "json_schema", name: "naming_brainstorm_v1", strict: true, schema: { type: "object" } } },
  metadata: { embel_generation_profile: "brainstorm_v1", embel_job_id: jobId, embel_run_id: runId, embel_call_index: "1" } });

describe("shared Naming lease expiry", () => {
  it("leaves a live lease alone and accepts only the slot-level form", async () => {
    const x = await fixture();
    try {
      const { jobId, execution } = await x.claimed("live");
      expect(await x.expire()).toBe(0);
      expect((await x.job(jobId)).state).toBe("running");
      await expect(x.action("expire", ["expiry-worker", x.slot.deploymentId], execution)).rejects.toThrow(/invalid_shared_naming_expiry/u);
      await expect(x.action("expire", ["expiry-worker", "embel-other-deployment"])).rejects.toThrow(/shared_lane_mismatch/u);
      await expect(x.action("expire", [""])).rejects.toThrow(/invalid_shared_naming_expiry/u);
    } finally { await x.f.close(); }
  });

  it("marks a call that may have reached the provider unconfirmed and never requests it again", async () => {
    const x = await fixture();
    try {
      const { jobId, runId, worker, execution } = await x.claimed("dispatched");
      const begun = (await x.action("brainstorm_begin", { callIndex: 1, candidateTarget: 120, request: request(x.policy.model, jobId, runId), expectedHistoryEpoch: 0, historyIdentities: [] }, execution)).result as { dispatch: string };
      expect(begun.dispatch).toBe("create");
      await x.stopWorker(jobId);
      expect(await x.expire()).toBe(1);
      expect(await x.job(jobId)).toMatchObject({ state: "needs_reconciliation", error_code: "provider_outcome_unknown", lease_token: null });
      expect((await x.hold(jobId)).state).toBe("active");
      expect(await x.executionState(jobId)).toEqual(["observing"]);
      expect((await x.db.query<{ m: string }>("select recovery_mode m from fluid_private.naming_brain_runs where job_id=$1", [jobId])).rows[0]!.m).toBe("observe_only");
      // Idempotent, and no claim may start another provider request for it.
      expect(await x.expire()).toBe(0);
      expect((await x.action("claim", [worker, x.slot.deploymentId, 120])).result).toBeNull();
    } finally { await x.f.close(); }
  });

  it("returns a job that never reached the provider to the queue for the next claim", async () => {
    const x = await fixture();
    try {
      const { jobId, worker } = await x.claimed("undispatched");
      await x.stopWorker(jobId);
      expect(await x.expire()).toBe(1);
      expect(await x.job(jobId)).toMatchObject({ state: "queued", lease_token: null, attempts: 1 });
      expect(await x.executionState(jobId)).toEqual(["closed"]);
      expect((await x.hold(jobId)).state).toBe("active");
      const again = await x.action("claim", [worker, x.slot.deploymentId, 120]);
      expect((again.result as { job: { id: string } }).job.id).toBe(jobId);
      expect(await x.job(jobId)).toMatchObject({ state: "running", attempts: 2 });
    } finally { await x.f.close(); }
  });

  it("ends a stopped job that never reached the provider and releases its hold as zero spend", async () => {
    const x = await fixture();
    try {
      const { jobId } = await x.claimed("cancelled");
      await x.db.query("update public.jobs set state='cancel_requested',cancel_requested_at=clock_timestamp() where id=$1", [jobId]);
      await x.stopWorker(jobId);
      expect(await x.expire()).toBe(1);
      expect(await x.job(jobId)).toMatchObject({ state: "cancelled", error_code: "lease_expired", lease_token: null });
      expect(await x.hold(jobId)).toMatchObject({ state: "settled" });
      expect(Number((await x.hold(jobId)).actual_microusd ?? 0)).toBe(0);
      expect(await x.executionState(jobId)).toEqual(["closed"]);
    } finally { await x.f.close(); }
  });
});
