import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedStrategyFixture, OWNER_A } from "../database/shared-strategy-fixture";

// Real admission/claim/step/expiry gateways, synthetic accounts and no provider.
// A lost client acknowledgment is simulated only after actual SQL committed.
describe("shared Strategy recovery cannot invent a predispatch proof", () => {
  let fixture: Awaited<ReturnType<typeof createSharedStrategyFixture>>;
  beforeEach(async () => { fixture = await createSharedStrategyFixture(); }, 30_000);
  afterEach(async () => { await fixture?.close(); });

  it("retains a committed begin step after its ACK is lost and frees only observation-state capacity", async () => {
    const project = await fixture.project(), admitted = await fixture.submit(project.id), claim = await fixture.claim(admitted.dispatch);
    const lease = claim.result.job.lease_token, maximum = claim.result.job.reserved_cost_microusd, key = "synthetic-lost-ack";
    const before = (await fixture.db.query("select input,input_hash,attempts from public.jobs where id=$1", [admitted.id])).rows[0];
    await fixture.action(admitted.dispatch, "plan", [lease, [{ key, maximumCostMicrousd: maximum }]], claim.execution);
    await expect((async () => {
      await fixture.action(admitted.dispatch, "begin", [lease, key, claim.requestKey, maximum], claim.execution);
      throw Error("Synthetic lost begin acknowledgment after committed SQL");
    })()).rejects.toThrow("Synthetic lost begin acknowledgment");
    expect((await fixture.db.query("select state from public.job_steps where job_id=$1", [admitted.id])).rows).toEqual([{ state: "in_flight" }]);
    await fixture.db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [admitted.id]);
    expect((await fixture.action(admitted.dispatch, "expire")).result).toEqual({ disposition: "terminal", state: "needs_reconciliation" });
    expect((await fixture.db.query("select input,input_hash,attempts from public.jobs where id=$1", [admitted.id])).rows[0]).toEqual(before);
    await expect(fixture.action(admitted.dispatch, "authorize", [lease, key], claim.execution)).rejects.toThrow();
    await expect(fixture.action(admitted.dispatch, "begin", [lease, "synthetic-new-attempt", "f".repeat(64), maximum], claim.execution)).rejects.toThrow();
    await expect(fixture.submit(project.id)).rejects.toThrow("active_strategy_request");
    const other = await fixture.submit((await fixture.project()).id);
    expect((await fixture.claim(other.dispatch)).result.executionAuthority).toMatchObject({ ownerId: OWNER_A, jobId: other.id });
    expect((await fixture.db.query("select count(*)::integer n from public.job_steps where job_id=$1", [admitted.id])).rows).toEqual([{ n: 1 }]);
  });

  it("terminates a zero-step canceled attempt without requeueing or resetting attempts", async () => {
    const admitted = await fixture.submit((await fixture.project()).id);
    await fixture.claim(admitted.dispatch);
    await fixture.owner(OWNER_A, "request_job_cancel", [admitted.id]);
    await fixture.db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [admitted.id]);
    expect((await fixture.action(admitted.dispatch, "expire")).result).toEqual({ disposition: "terminal", state: "cancelled" });
    expect((await fixture.db.query("select state,attempts,lease_token from public.jobs where id=$1", [admitted.id])).rows).toEqual([{ state: "cancelled", attempts: 1, lease_token: null }]);
    expect((await fixture.db.query("select state from fluid_private.shared_worker_executions where job_id=$1", [admitted.id])).rows).toEqual([{ state: "closed" }]);
    expect((await fixture.action(admitted.dispatch, "claim", ["synthetic-retry", 120])).result).toMatchObject({ disposition: "terminal", state: "cancelled" });
    expect((await fixture.db.query("select count(*)::integer n from public.job_steps where job_id=$1", [admitted.id])).rows).toEqual([{ n: 0 }]);
  });
});
