import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedIdentityFixture, hash, OWNER_B, type SharedIdentityFixture } from "../database/shared-identity-generation-fixture";
import { identityBatchStateSchema } from "../../src/domain/identity-jobs";
import { asRole } from "../database/local-supabase";
import { specification, textPolicy } from "../worker/identity-generation-fixture";

describe("Independent Identity SQL terminalization and publication atomicity", () => {
  let f: SharedIdentityFixture;
  beforeEach(async () => { f = await createSharedIdentityFixture(); }, 60_000);
  afterEach(async () => { await f?.db.close(); });

  async function failWithoutDispatch(started: Awaited<ReturnType<SharedIdentityFixture["admit"]>>, ordinal: number) {
    const { job, execution } = started, step = `identity-system-v1:${ordinal}`;
    await f.action("begin", [job.id, job.leaseToken, step, `independent-no-dispatch-${ordinal}`, 0], execution);
    await f.action("complete", [job.id, job.leaseToken, step, "failed", 0, { error: "not_dispatched" }, null], execution);
  }

  it("finishes a proven first-step non-dispatch without inventing the two unissued steps", async () => {
    const started = await f.admit(await f.project());
    await failWithoutDispatch(started, 1);
    await f.action("finish", [started.job.id, started.job.leaseToken, "failed"], started.execution);
    const state = identityBatchStateSchema.parse(await f.rpc(started.owner, "get_shared_identity_batch", [started.projectId, started.batch.batchId, null]));
    expect(state).toMatchObject({ status: "failed", terminal: true, fulfillment: { acceptedCount: 0, status: "none" } });
    expect((await f.db.query<{ n: number }>("select count(*)::int n from public.job_steps where job_id=$1", [started.job.id])).rows[0]!.n).toBe(1);
    expect((await f.db.query<{ n: number }>("select count(*)::int n from fluid_private.shared_identity_calls where job_id=$1", [started.job.id])).rows[0]!.n).toBe(0);
  });

  it("preserves the accepted system and closes partial after the next proven failure", async () => {
    const started = await f.admit(await f.project());
    await f.system(started, 1);
    await failWithoutDispatch(started, 2);
    await f.action("finish", [started.job.id, started.job.leaseToken, "partial"], started.execution);
    const state = identityBatchStateSchema.parse(await f.rpc(started.owner, "get_shared_identity_batch", [started.projectId, started.batch.batchId, null]));
    expect(state).toMatchObject({ status: "partial", terminal: true, fulfillment: { acceptedCount: 1, status: "partial" } });
    expect(state.systems.map(system => system.id)).toEqual([started.input.systemIds[0]]);
    expect((await f.db.query<{ n: number }>("select count(*)::int n from public.job_steps where job_id=$1", [started.job.id])).rows[0]!.n).toBe(2);
    expect((await f.db.query<{ n: number }>("select count(*)::int n from fluid_private.shared_identity_calls where job_id=$1", [started.job.id])).rows[0]!.n).toBe(2);
  });

  it("rolls back every publication write when the final provenance insertion fails", async () => {
    const started = await f.admit(await f.project()), prepared = await f.system(started, 1, false);
    const readState = async () => (await f.db.query<{ value: unknown }>(`select jsonb_build_object(
      'system',(select count(*) from public.identity_system_versions where id=$1),
      'files',(select count(*) from public.identity_system_files where system_id=$1),
      'roots',(select count(*) from public.identity_generated_roots where system_id=$1),
      'asset',(select count(*) from public.assets where id=$2),
      'version',(select count(*) from public.asset_versions where id=$3),
      'publication',(select to_jsonb(p) from public.logo_asset_publications p where id=$4),
      'step',(select to_jsonb(s) from public.job_steps s where job_id=$5 and step_key=$6)) value`,
    [started.input.systemIds[0], prepared.reservation.reference.assetId, prepared.reservation.reference.versionId, prepared.reservation.id, started.job.id, prepared.key])).rows[0]!.value;
    const before = await readState();
    await f.db.exec(`create function public.independent_identity_atomicity_fault() returns trigger language plpgsql set search_path='' as $$
      begin raise exception 'independent_atomicity_fault';end$$;
      revoke all on function public.independent_identity_atomicity_fault() from public;
      create trigger independent_identity_atomicity_fault after insert on public.identity_generated_roots
      for each row execute function public.independent_identity_atomicity_fault();`);
    try {
      await expect(f.action("complete", [started.job.id, started.job.leaseToken, prepared.key, "succeeded", prepared.cost, prepared.output, prepared.image.providerRequestId], started.execution)).rejects.toThrow("independent_atomicity_fault");
      expect(await readState()).toEqual(before);
    } finally {
      await f.db.exec("drop trigger independent_identity_atomicity_fault on public.identity_generated_roots;drop function public.independent_identity_atomicity_fault();");
    }
    await f.action("complete", [started.job.id, started.job.leaseToken, prepared.key, "succeeded", prepared.cost, prepared.output, prepared.image.providerRequestId], started.execution);
    const state = identityBatchStateSchema.parse(await f.rpc(started.owner, "get_shared_identity_batch", [started.projectId, started.batch.batchId, null]));
    expect(state.systems).toHaveLength(1);
  });

  it("durably closes only the exact unadmitted original intent without creating a job", async () => {
    const project = await f.project(), intent = f.intent();
    const expected = { status: "not_admitted", ownerId: project.owner, projectId: project.projectId, intent };
    expect(await f.rpc(project.owner, "close_shared_identity_generation_intent", [project.projectId, intent])).toEqual(expected);
    expect(await f.rpc(project.owner, "close_shared_identity_generation_intent", [project.projectId, intent])).toEqual(expected);
    await expect(f.rpc(project.owner, "ensure_shared_identity_batch", [project.projectId, intent])).rejects.toThrow("intent_closed");
    await expect(f.rpc(project.owner, "close_shared_identity_generation_intent", [project.projectId, { ...intent, expectedProjectRevision: 2 }])).rejects.toThrow("conflict");
    await expect(f.rpc(OWNER_B, "close_shared_identity_generation_intent", [project.projectId, intent])).rejects.toThrow("project_missing");
    expect((await f.db.query<{ n: number }>("select count(*)::int n from public.jobs where owner_id=$1 and project_id=$2 and operation='identity.image'", [project.owner, project.projectId])).rows[0]!.n).toBe(0);
  });

  it("denies admission after readiness expiry and never borrows an older generation's marker", async () => {
    const project = await f.project();
    await f.db.query("update fluid_private.shared_logo_slot_runtime_readiness set expires_at=clock_timestamp()-interval '1 second' where slot_id=$1", [f.slotId]);
    expect(await f.rpc(project.owner, "get_shared_identity_availability", [project.projectId])).toMatchObject({ status: "unavailable", reason: "runtime_unavailable" });
    await expect(f.rpc(project.owner, "ensure_shared_identity_batch", [project.projectId, f.intent()])).rejects.toThrow("unavailable");
    await f.ready();
    const old = (await f.db.query<{ instance_id: string; generation: number; lease_token: string }>("select instance_id,generation,lease_token from fluid_private.shared_logo_slot_runtime_readiness where slot_id=$1", [f.slotId])).rows[0]!;
    await f.takeover();
    await f.db.query("update fluid_private.shared_logo_slot_runtime_readiness set instance_id=$2,generation=$3,lease_token=$4 where slot_id=$1", [f.slotId, old.instance_id, old.generation, old.lease_token]);
    expect(await f.rpc(project.owner, "get_shared_identity_availability", [project.projectId])).toMatchObject({ status: "unavailable", reason: "runtime_unavailable" });
    await expect(f.rpc(project.owner, "ensure_shared_identity_batch", [project.projectId, f.intent()])).rejects.toThrow("unavailable");
    expect((await f.db.query<{ n: number }>("select count(*)::int n from public.jobs where project_id=$1 and operation='identity.image'", [project.projectId])).rows[0]!.n).toBe(0);
    await f.ready();
    expect(await f.rpc(project.owner, "get_shared_identity_availability", [project.projectId])).toMatchObject({ status: "available" });
  });

  it("preserves historical generic Identity work while excluding shared admissions from generic claim and expiry", async () => {
    const project = await f.project(), intent = f.intent();
    const batch = identityBatchStateSchema.parse(await f.rpc(project.owner, "ensure_shared_identity_batch", [project.projectId, intent]));
    const historicalProject = await f.project(OWNER_B);
    const historical = (await f.db.query<{ id: string }>("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd) values($1,$2,'identity.image',1,$3,'{}','independent-historical-identity',0) returning id", [OWNER_B, historicalProject.projectId, "a".repeat(64)])).rows[0]!.id;
    const generic = await asRole(f.db, "service_role", null, () => f.db.query<{ id: string }>("select id from public.claim_job('independent-generic-worker',120)"));
    expect(generic.rows.map(row => row.id)).toEqual([historical]);
    const started = await f.admit(project, intent);
    expect(started.job.id).toBe(batch.jobId);
    await f.db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id in($1,$2)", [historical, started.job.id]);
    const sharedBefore = (await f.db.query<{ value: unknown }>("select jsonb_build_object('state',state,'leaseToken',lease_token,'leaseExpiry',lease_expires_at,'attempts',attempts) value from public.jobs where id=$1", [started.job.id])).rows[0]!.value;
    await asRole(f.db, "service_role", null, () => f.db.query("select public.expire_job_leases()"));
    expect((await f.db.query<{ value: unknown }>("select jsonb_build_object('state',state,'leaseToken',lease_token,'leaseExpiry',lease_expires_at,'attempts',attempts) value from public.jobs where id=$1", [started.job.id])).rows[0]!.value).toEqual(sharedBefore);
    expect((await f.db.query<{ state: string; lease_token: string | null }>("select state,lease_token from public.jobs where id=$1", [historical])).rows[0]).toEqual({ state: "queued", lease_token: null });
  });

  it("can finish Stop after the only issued text phase completed, without authorizing a board", async () => {
    const started = await f.admit(await f.project()), step = "identity-system-v1:1", e = started.execution;
    await f.action("begin", [e.jobId, e.leaseToken, step, "independent-stop-after-text", 0], e);
    const requestKey = hash(`${e.jobId}:${step}:specifications`), requestHash = hash("synthetic-frozen-specification-request");
    const call = (await f.action("identity_authorize", [e.jobId, e.leaseToken, step, "specifications", requestKey, requestHash], e)).result as { callId: string };
    await f.action("identity_receipt", [e.jobId, e.leaseToken, call.callId, {
      version: 1, phase: "specifications", provider: "openai", model: textPolicy.model, requestKey, requestHash,
      responseId: "resp_independent_known_text", providerRequestId: null, responseHash: hash("synthetic-completed-text"),
      observedAt: new Date().toISOString(), responseComplete: true, serviceTier: "default",
      usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10 },
      billing: { status: "recorded", confirmedMicrousd: 120 }, specification: specification(), artifactHash: null,
    }], e);
    await f.rpc(started.owner, "close_shared_identity_generation_intent", [started.projectId, started.intent]);
    await f.action("complete", [e.jobId, e.leaseToken, step, "ambiguous", 120, { error: "identity_board_unconfirmed" }, null], e);
    const result = await f.action("finish_known", [], e);
    expect(result.result).toEqual({ status: "terminal", state: "cancelled" });
    const batch = identityBatchStateSchema.parse(await f.rpc(started.owner, "get_shared_identity_batch", [started.projectId, started.batch.batchId, null]));
    expect(batch).toMatchObject({ status: "cancelled", terminal: true, fulfillment: { acceptedCount: 0, status: "none" } });
    expect((await f.db.query<{ phase: string }>("select phase from fluid_private.shared_identity_calls where job_id=$1", [e.jobId])).rows).toEqual([{ phase: "specifications" }]);
    expect((await f.db.query<{ actual_cost_microusd: number }>("select actual_cost_microusd::int actual_cost_microusd from public.jobs where id=$1", [e.jobId])).rows[0]!.actual_cost_microusd).toBe(120);
    const witness = (await f.db.query<{ mode: string; original_step: { state: string }; known_cost_microusd: number }>("select mode,original_step,known_cost_microusd::int from fluid_private.shared_identity_specification_cancellations where job_id=$1", [e.jobId])).rows[0]!;
    expect(witness).toMatchObject({ mode: "specifications_only", original_step: { state: "ambiguous" }, known_cost_microusd: 120 });
  });

  it("can finish Stop before any provider authorization without fabricating a receipt", async () => {
    const started = await f.admit(await f.project()), e = started.execution;
    await f.action("begin", [e.jobId, e.leaseToken, "identity-system-v1:1", "independent-stop-before-provider", 0], e);
    await f.rpc(started.owner, "close_shared_identity_generation_intent", [started.projectId, started.intent]);
    expect((await f.action("finish_known", [], e)).result).toEqual({ status: "terminal", state: "cancelled" });
    const witness = (await f.db.query<{ mode: string; receipt_id: string | null; original_step: { state: string }; known_cost_microusd: number }>("select mode,receipt_id,original_step,known_cost_microusd::int from fluid_private.shared_identity_specification_cancellations where job_id=$1", [e.jobId])).rows[0]!;
    expect(witness).toMatchObject({ mode: "no_provider_authorized", receipt_id: null, original_step: { state: "in_flight" }, known_cost_microusd: 0 });
    expect((await f.db.query<{ n: number }>("select count(*)::int n from fluid_private.shared_identity_calls where job_id=$1", [e.jobId])).rows[0]!.n).toBe(0);
    await expect(f.db.query("update fluid_private.shared_identity_specification_cancellations set known_cost_microusd=1 where job_id=$1", [e.jobId])).rejects.toThrow();
    expect((await f.db.query<{ known_cost_microusd: number }>("select known_cost_microusd::int from fluid_private.shared_identity_specification_cancellations where job_id=$1", [e.jobId])).rows[0]!.known_cost_microusd).toBe(0);
  });

  it("keeps an issued text phase with no final receipt unresolved after Stop", async () => {
    const started = await f.admit(await f.project()), e = started.execution, step = "identity-system-v1:1";
    await f.action("begin", [e.jobId, e.leaseToken, step, "independent-unknown-text", 0], e);
    await f.action("identity_authorize", [e.jobId, e.leaseToken, step, "specifications", hash("independent-unknown-key"), hash("independent-unknown-body")], e);
    await f.rpc(started.owner, "close_shared_identity_generation_intent", [started.projectId, started.intent]);
    await f.action("complete", [e.jobId, e.leaseToken, step, "ambiguous", 0, { error: "identity_specification_unconfirmed" }, null], e);
    expect((await f.action("finish_known", [], e)).result).toEqual({ status: "retained_unknown" });
    const batch = identityBatchStateSchema.parse(await f.rpc(started.owner, "get_shared_identity_batch", [started.projectId, started.batch.batchId, null]));
    expect(batch).toMatchObject({ status: "needs_reconciliation", terminal: false });
    expect((await f.db.query<{ n: number }>("select count(*)::int n from fluid_private.shared_identity_specification_cancellations where job_id=$1", [e.jobId])).rows[0]!.n).toBe(0);
  });
});
