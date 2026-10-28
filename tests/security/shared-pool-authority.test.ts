import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSharedWorkerFixture, type SharedFixtureSlot, type SharedWorkerFixture } from "../database/shared-worker-fixture";

// Independent boundary tests: real candidate SQL and restricted session_user.
// The finite fixture action is an authority probe, not a provider/lane engine.
describe("shared slot authority under adversarial restricted callers", () => {
  let fixture: SharedWorkerFixture;
  let index = 0;
  beforeAll(async () => { fixture = await createSharedWorkerFixture(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  async function account() {
    const id = randomUUID();
    await fixture.seedUser(id);
    return id;
  }
  async function slot() { return fixture.seedSlot({ index: ++index }); }
  async function action(principal: SharedFixtureSlot, lease: unknown, execution: unknown, name: string, job: string | null = null) {
    return fixture.asSlot(principal, async () => (await fixture.db.query<{ value: Record<string, unknown> }>(
      "select public.shared_strategy_worker_action($1::jsonb,$2::jsonb,$3,$4::jsonb) value", [lease, execution, name, job === null ? null : JSON.stringify({ jobId: job })],
    )).rows[0]!.value);
  }
  async function contextCount() {
    return (await fixture.db.query<{ count: number }>("select count(*)::integer count from fluid_private.shared_worker_gateway_context")).rows[0]!.count;
  }

  it("ignores a forged owner GUC, denies direct rows/helpers, and derives its selected job owner", async () => {
    const principal = await slot(), owner = await account(), foreign = await account();
    const ownJob = await fixture.seedJob(owner, principal), otherJob = await fixture.seedJob(foreign, principal);
    const lease = await fixture.lease(principal);
    await fixture.asSlot(principal, async () => {
      await fixture.db.query("select set_config('request.jwt.claim.sub',$1,false)", [foreign]);
      await expect(fixture.db.query("select owner_id from public.jobs")).rejects.toThrow(/permission denied/i);
      await expect(fixture.db.query("select fluid_private.enter_shared_worker_claim_context($1,$2)", [lease, otherJob.jobId])).rejects.toThrow(/permission denied/i);
      await expect(fixture.db.exec("set role authenticated")).rejects.toThrow(/permission denied/i);
    });
    const execution = await action(principal, lease, null, "claim", ownJob.jobId);
    expect(execution.ownerId).toBe(owner);
    await expect(action(principal, lease, { ...execution, ownerId: foreign, jobId: otherJob.jobId }, "active")).rejects.toThrow(/shared_execution_denied/);
    expect((await action(principal, lease, execution, "active")).ownerId).toBe(owner);
    expect(await contextCount()).toBe(0);
    expect((await fixture.db.query<{ attempts: number }>("select attempts from public.jobs where id=$1", [otherJob.jobId])).rows[0]!.attempts).toBe(0);
  });

  it("does not let another restricted slot borrow an execution or its opaque token", async () => {
    const first = await slot(), second = await slot(), owner = await account();
    const job = await fixture.seedJob(owner, first), one = await fixture.lease(first), two = await fixture.lease(second);
    const execution = await action(first, one, null, "claim", job.jobId);
    await expect(action(second, one, execution, "observe")).rejects.toThrow(/shared_slot_denied/);
    await expect(action(second, two, { ...execution, slotId: second.slotId }, "observe")).rejects.toThrow(/shared_execution_denied/);
    expect(await contextCount()).toBe(0);
  });

  it("rejects a principal that acquired direct Auth table access", async () => {
    const principal = await slot();
    await fixture.db.exec(`grant usage on schema auth to ${principal.roleName}; grant select on auth.users to ${principal.roleName}`);
    await expect(fixture.lease(principal)).rejects.toThrow(/shared_slot_denied/);
    await fixture.db.exec(`revoke select on auth.users from ${principal.roleName}; revoke usage on schema auth from ${principal.roleName}`);
    await expect(fixture.lease(principal)).resolves.toMatchObject({ slotId: principal.slotId });
  });

  it("rejects an extra generic customer mutation RPC instead of allowing a forged-owner bypass", async () => {
    const principal = await slot();
    await fixture.db.exec(`grant execute on function public.create_project(text,text,jsonb,text) to ${principal.roleName}`);
    await expect(fixture.lease(principal)).rejects.toThrow(/shared_slot_denied/);
    await fixture.db.exec(`revoke execute on function public.create_project(text,text,jsonb,text) from ${principal.roleName}`);
    await expect(fixture.lease(principal)).resolves.toMatchObject({ slotId: principal.slotId });
  });

  it("requires the renewal token even when a live slot's instance UUID is known", async () => {
    const principal = await slot(), instance = randomUUID(), lease = await fixture.lease(principal, instance);
    await expect(fixture.lease(principal, instance)).rejects.toThrow(/shared_slot_held/);
    await fixture.asSlot(principal, async () => {
      await expect(fixture.db.query("select public.renew_shared_worker_slot($1,60)", [{ ...lease, leaseToken: randomUUID() }])).rejects.toThrow(/shared_slot_fenced/);
      await expect(fixture.db.query("select public.renew_shared_worker_slot($1,60)", [lease])).resolves.toBeDefined();
    });
  });

  it("fences active work after takeover and retains exact historical observation only", async () => {
    const principal = await slot(), owner = await account(), job = await fixture.seedJob(owner, principal);
    const original = await fixture.lease(principal), execution = await action(principal, original, null, "claim", job.jobId);
    await fixture.asSlot(principal, async () => {
      await expect(fixture.db.query("select public.release_shared_worker_slot($1)", [original])).rejects.toThrow(/shared_slot_not_drained/);
    });
    await fixture.db.query("update fluid_private.shared_worker_slots set expires_at=clock_timestamp()-interval '1 second' where slot_id=$1", [principal.slotId]);
    const replacement = await fixture.lease(principal);
    expect(replacement.generation).toBe(Number(original.generation) + 1);
    await expect(action(principal, original, execution, "active")).rejects.toThrow(/shared_slot_fenced/);
    await expect(action(principal, replacement, execution, "active")).rejects.toThrow(/shared_execution_fenced/);
    expect(await action(principal, original, execution, "observe")).toMatchObject({ ownerId: owner, mode: "observe" });
    expect(await action(principal, replacement, execution, "observe")).toMatchObject({ ownerId: owner, mode: "observe" });
    await expect(action(principal, replacement, { ...execution, generation: replacement.generation }, "observe")).rejects.toThrow(/shared_execution_denied/);
    await expect(action(principal, replacement, null, "claim", job.jobId)).rejects.toThrow(/shared_job_denied/);
    await fixture.asSlot(principal, async () => {
      expect((await fixture.db.query<{ released: boolean }>("select public.release_shared_worker_slot($1) released", [replacement])).rows[0]!.released).toBe(true);
    });
    // Releasing an empty current generation is not a claim that the old remote
    // request stopped: its historical observation record remains intact.
    expect((await fixture.db.query<{ state: string }>("select state from fluid_private.shared_worker_executions where execution_id=$1", [execution.executionId])).rows[0]!.state).toBe("observing");
    expect(await action(principal, original, execution, "observe")).toMatchObject({ ownerId: owner, mode: "observe" });
    expect((await fixture.db.query<{ attempts: number }>("select attempts from public.jobs where id=$1", [job.jobId])).rows[0]!.attempts).toBe(1);
  });

  it("rolls back private context on gateway error before reusing the physical backend", async () => {
    const principal = await slot(), owner = await account(), job = await fixture.seedJob(owner, principal), lease = await fixture.lease(principal);
    const execution = await action(principal, lease, null, "claim", job.jobId);
    await expect(action(principal, lease, execution, "fail")).rejects.toThrow(/fixture_rollback/);
    expect(await contextCount()).toBe(0);
    expect(await action(principal, lease, execution, "active")).toMatchObject({ jobId: job.jobId, ownerId: owner });
    expect(await contextCount()).toBe(0);
  });

  it("cannot rewrite a frozen admission after queueing", async () => {
    const principal = await slot(), owner = await account(), foreign = await account(), job = await fixture.seedJob(owner, principal);
    await expect(fixture.db.query("update fluid_private.shared_job_admissions set owner_id=$1 where job_id=$2", [foreign, job.jobId])).rejects.toThrow(/shared_admission_immutable/);
    expect((await fixture.db.query<{ owner_id: string }>("select owner_id from fluid_private.shared_job_admissions where job_id=$1", [job.jobId])).rows[0]!.owner_id).toBe(owner);
  });

  it("does not revive pre-ban execution authority after unban, while retaining frozen observation", async () => {
    const principal = await slot(), owner = await account(), job = await fixture.seedJob(owner, principal);
    const lease = await fixture.lease(principal), execution = await action(principal, lease, null, "claim", job.jobId);
    await fixture.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1", [owner]);
    await fixture.db.query("update auth.users set banned_until=null where id=$1", [owner]);
    expect((await fixture.db.query<{ eligible: boolean }>("select fluid_private.shared_account_customer_active($1) eligible", [owner])).rows[0]!.eligible).toBe(true);
    await expect(action(principal, lease, execution, "active")).rejects.toThrow(/shared_dispatch_closed/);
    expect(await action(principal, lease, execution, "observe")).toMatchObject({ ownerId: owner, jobId: job.jobId, mode: "observe" });
    expect(await contextCount()).toBe(0);
  });

  it("enrolls confirmed customers as data without adding a database role", async () => {
    const before = (await fixture.db.query<{ n: number }>("select count(*)::integer n from pg_catalog.pg_roles")).rows[0]!.n;
    const owner = await account();
    const after = (await fixture.db.query<{ n: number }>("select count(*)::integer n from pg_catalog.pg_roles")).rows[0]!.n;
    expect(after).toBe(before);
    expect((await fixture.db.query<{ eligible: boolean }>("select fluid_private.shared_account_customer_active($1) eligible", [owner])).rows[0]!.eligible).toBe(true);
    await fixture.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1", [owner]);
    expect((await fixture.db.query<{ eligible: boolean }>("select fluid_private.shared_account_customer_active($1) eligible", [owner])).rows[0]!.eligible).toBe(false);
  });
});
