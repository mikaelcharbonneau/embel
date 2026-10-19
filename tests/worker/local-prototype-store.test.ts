import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "../../src/domain/jobs";
import { PostgresJobStore } from "../../worker/postgres-store";
import { PlanConflictError } from "../../worker/runner";

const job: ClaimedJob = { id: "10000000-0000-4000-8000-000000000001", ownerId: "20000000-0000-4000-8000-000000000002", projectId: "30000000-0000-4000-8000-000000000003",
  leaseToken: "40000000-0000-4000-8000-000000000004", operation: "strategy.audience", input: {}, inputRevision: 1, status: "running", reservedCostMicrousd: 122880, actualCostMicrousd: 0 };
describe("prototype Strategy scoped step metadata", () => {
  it("asserts job/owner/project/key on the narrow RPC before dispatch", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [{ result: { state: "in_flight" } }] }), store = new PostgresJobStore({ query }, { localPrototype: true });
    expect(await store.beginStep(job, "proposal", 122880)).toBe("started");
    expect(query.mock.calls[0]).toEqual(["select * from public.read_local_strategy_steps($1,$2,$3,$4)", [job.id, job.ownerId, job.projectId, "proposal"]]);
    expect(query.mock.calls[1]).toEqual(["select public.local_strategy_job_action($1,$2,$3) as result",
      [job.id, "begin", JSON.stringify([job.leaseToken, "proposal", createHash("sha256").update(`${job.id}:proposal`).digest("hex"), 122880])]]);
    expect(query.mock.calls.every(([sql]) => !sql.includes("from public.job_steps"))).toBe(true);
  });
  it("reuses only an exact completed step and refuses uncertain metadata", async () => {
    const requestKey = createHash("sha256").update(`${job.id}:proposal`).digest("hex");
    const query = vi.fn().mockResolvedValue({ rows: [{ state: "succeeded", request_key: requestKey, reserved_cost_microusd: "122880" }] });
    const store = new PostgresJobStore({ query }, { localPrototype: true });
    expect(await store.beginStep(job, "proposal", 122880)).toBe("already_succeeded");
    query.mockResolvedValue({ rows: [{ state: "ambiguous", request_key: requestKey, reserved_cost_microusd: "122880" }] });
    await expect(store.beginStep(job, "proposal", 122880)).rejects.toThrow("reconciliation");
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([true, false])("retains whether a conflicting plan has partial results (%s)", async hasResults => {
    const query = vi.fn().mockRejectedValueOnce(new Error("plan_conflict")).mockResolvedValueOnce({ rows: hasResults ? [{ state: "succeeded" }] : [] });
    const store = new PostgresJobStore({ query }, { localPrototype: true });
    await expect(store.registerPlan(job, [{ key: "proposal", maximumCostMicrousd: 122880 }])).rejects.toEqual(new PlanConflictError(hasResults));
    expect(query.mock.calls[1]).toEqual(["select * from public.read_local_strategy_steps($1,$2,$3,$4)", [job.id, job.ownerId, job.projectId, null]]);
  });
  it("preserves normal hosted step reads", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] }), store = new PostgresJobStore({ query });
    await store.beginStep(job, "proposal", 122880);
    expect(query.mock.calls[0]![0]).toContain("from public.job_steps");
    expect(query.mock.calls.some(([sql]) => sql.includes("read_local_strategy_steps"))).toBe(false);
  });
  it("uses the Strategy-only gateway for every local mutation with structured original arguments", async () => {
    const row = { id: job.id, owner_id: job.ownerId, project_id: job.projectId, operation: job.operation, input: job.input, input_revision: job.inputRevision,
      lease_token: job.leaseToken, state: job.status, reserved_cost_microusd: job.reservedCostMicrousd, actual_cost_microusd: job.actualCostMicrousd };
    const query = vi.fn().mockResolvedValue({ rows: [{ result: row }] }), store = new PostgresJobStore({ query }, { localPrototype: true });
    const manifest = [{ key: "proposal", maximumCostMicrousd: 122880 }];
    expect(await store.heartbeat(job, 60)).toEqual({ cancelled: false });
    await store.registerPlan(job, manifest);
    await store.completeStep(job, "proposal", { status: "succeeded", costMicrousd: 1000, result: { retained: "synthetic original output" }, providerRequestId: "resp_synthetic" });
    await store.finish(job, "partial");
    expect(query.mock.calls.map(([sql, values]) => ({ sql, jobId: values[0], action: values[1], arguments: JSON.parse(values[2]) }))).toEqual([
      { sql: "select public.local_strategy_job_action($1,$2,$3) as result", jobId: job.id, action: "heartbeat", arguments: [job.leaseToken, 60] },
      { sql: "select public.local_strategy_job_action($1,$2,$3) as result", jobId: job.id, action: "plan", arguments: [job.leaseToken, manifest] },
      { sql: "select public.local_strategy_job_action($1,$2,$3) as result", jobId: job.id, action: "complete", arguments: [job.leaseToken, "proposal", "succeeded", 1000, { retained: "synthetic original output" }, "resp_synthetic"] },
      { sql: "select public.local_strategy_job_action($1,$2,$3) as result", jobId: job.id, action: "finish", arguments: [job.leaseToken, "partial", "operation_incomplete"] },
    ]);
  });
  it("does not acknowledge missing or malformed local mutation receipts", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] }), store = new PostgresJobStore({ query }, { localPrototype: true });
    await expect(store.finish(job, "failed")).rejects.toThrow("unconfirmed");
    query.mockResolvedValue({ rows: [{ result: null }] });
    await expect(store.finish(job, "failed")).rejects.toThrow();
  });
});
