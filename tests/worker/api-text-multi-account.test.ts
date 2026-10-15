import { describe, expect, it, vi } from "vitest";
import { apiTextDispatchDatabase, multiAccountApiTextEnabled } from "../../worker/api-text-multi-account";

const descriptor = { version: 1 as const, jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", policyIdentity: "a".repeat(64),
  deploymentId: "dpl_multi_fixture", dispatchIdentity: "b".repeat(64) };
describe("descriptor-only API database adapter", () => {
  it("requires the exact opt-in and keeps the default on the existing single-owner path", () => {
    for (const value of [undefined, "", "1", "TRUE", "false"]) expect(multiAccountApiTextEnabled({ FLUID_API_TEXT_MULTI_ACCOUNT_ENABLED: value })).toBe(false);
    expect(multiAccountApiTextEnabled({ FLUID_API_TEXT_MULTI_ACCOUNT_ENABLED: "true" })).toBe(true);
  });
  it("sends the exact admitted descriptor with a bounded action, never an owner selector or arbitrary SQL", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ result: { state: "running" } }] });
    const db = apiTextDispatchDatabase({ query }, descriptor);
    expect(await db.query("select * from public.heartbeat_job($1, $2, $3)", [descriptor.jobId, "lease-fixture", 60]))
      .toEqual({ rows: [{ state: "running" }] });
    expect(query).toHaveBeenCalledWith("select public.api_text_dispatch_action($1::jsonb,$2,$3::jsonb) as result",
      [JSON.stringify(descriptor), "heartbeat", JSON.stringify(["lease-fixture", 60])]);
    for (const sql of ["select * from public.jobs", "select public.claim_job($1,$2)", "set fluid.owner_id='other'", "select public.get_api_text_dispatch($1) as descriptor; select 1"]) {
      await expect(db.query(sql, [descriptor.jobId])).rejects.toThrow("Unsupported descriptor-bound query");
    }
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("rejects job, deployment, policy, dispatch and arity substitutions before reaching the database", async () => {
    const query = vi.fn(); const db = apiTextDispatchDatabase({ query }, descriptor);
    for (const [sql, args] of [
      ["select public.get_api_text_dispatch($1) as descriptor", [crypto.randomUUID()]],
      ["select public.get_api_text_dispatch($1) as descriptor", [descriptor.jobId, "owner"]],
      ["select public.claim_api_text_job($1, $2, $3, $4, $5) as result", [descriptor.jobId, "worker", 60, "c".repeat(64), descriptor.deploymentId]],
      ["select public.claim_api_text_job($1, $2, $3, $4, $5) as result", [descriptor.jobId, "worker", 60, descriptor.policyIdentity, "dpl_other"]],
      ["select public.mark_api_text_published($1,$2,$3,$4) as recorded", [descriptor.jobId, "c".repeat(64), 1, "message"]],
    ] as const) await expect(db.query(sql, [...args])).rejects.toThrow(/Dispatch .* mismatch/);
    expect(query).not.toHaveBeenCalled();
    expect(() => apiTextDispatchDatabase({ query }, { ...descriptor, ownerId: "untrusted" } as typeof descriptor)).toThrow();
  });
  it("does not retry or fall back after a database failure or an invalid result", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("connection uncertain")).mockResolvedValueOnce({ rows: [] });
    const db = apiTextDispatchDatabase({ query }, descriptor);
    await expect(db.query("select public.get_api_text_dispatch($1) as descriptor", [descriptor.jobId])).rejects.toThrow("connection uncertain");
    await expect(db.query("select public.get_api_text_dispatch($1) as descriptor", [descriptor.jobId])).rejects.toThrow("Dispatch response unavailable");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
