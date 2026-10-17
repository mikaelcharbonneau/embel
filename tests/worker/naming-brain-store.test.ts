import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { createNamingBrainPolicy } from "../../src/server/ai/naming-brain/policy";
import { namingBrainJobInputSchema } from "../../src/domain/naming-brain";
import { id, snapshot } from "../domain/naming-brain-fixtures";
const input = () => namingBrainJobInputSchema.parse({ version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api", runId: id(3), jobId: id(4), batchId: id(5), snapshot: snapshot(), acceptedPolicyIdentity: "a".repeat(64), policy: createNamingBrainPolicy("fixture-selected-model") });
const row = () => ({ id: id(4), owner_id: id(1), project_id: id(2), operation: "naming.generate", input: input(), input_revision: 1, lease_token: id(9), state: "running", reserved_cost_microusd: 5_000_000, actual_cost_microusd: 0, billing_mode: "openai_api" });
describe("Naming scoped worker store", () => {
  it("claims only V2 and never uses generic finish/settlement", async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const store = new NamingBrainJobStore({ query: async (sql, values = []) => { calls.push({ sql, values }); return { rows: [{ result: sql.includes("claim_naming") ? { mode: "execute", job: row() } : values[2] === "heartbeat" ? { ...row(), recoveryMode: "execute", observationDeadlineAt: null } : { state: "succeeded" } }] }; } }, "deployment-fixture");
    const job = await store.claim("worker-fixture", 120); expect(job?.id).toBe(id(4)); await store.finish(job!, "succeeded");
    expect(calls[2]!.sql).toContain("naming_brain_worker_action"); expect(calls[2]!.values[2]).toBe("finish");
    expect(calls.every(call => !call.sql.includes("public.finish_job") && !call.sql.includes("settle_reservation"))).toBe(true);
  });
  it("refuses another operation despite an apparently successful claim", async () => {
    const store = new NamingBrainJobStore({ query: async () => ({ rows: [{ result: { mode: "execute", job: { ...row(), operation: "strategy.reformulate" } } }] }) }, "deployment-fixture");
    await expect(store.claim("worker-fixture", 120)).rejects.toThrow();
  });
  it("does not pass the numeric runner subtotal as expense certification", async () => {
    const calls: unknown[][] = [];
    const store = new NamingBrainJobStore({ query: async (_sql, values = []) => { calls.push(values); return { rows: [{ result: calls.length === 1 ? { mode: "execute", job: row() } : {} }] }; } }, "deployment-fixture");
    const job = await store.claim("worker-fixture", 120);
    await store.completeStep(job!, "research", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } });
    expect(calls[1]).toHaveLength(5); expect(JSON.parse(calls[1]![4] as string)).toEqual({ artifactIds: [] });
  });
});


it("observes a stopped known session while conveying durable Stop to the adapter and final finish", async () => {
  const writes: unknown[][] = [];
  const store = new NamingBrainJobStore({ query: async (sql, values = []) => {
    writes.push(values);
    return { rows: [{ result: sql.includes("claim_naming") ? { mode: "observe_only", job: { ...row(), state: "cancel_requested" } } : values[2] === "heartbeat" ? { ...row(), state: "cancel_requested", recoveryMode: "observe_only", observationDeadlineAt: null } : {} }] };
  } }, "deployment-fixture");
  const job = (await store.claim("fixture", 120))!;
  let cancellations = 0; const detach = store.onCancellation(job, () => { cancellations++; });
  expect(cancellations).toBe(1);
  expect(await store.heartbeat(job, 120)).toEqual({ cancelled: false });
  await expect(store.assertContinuation(job)).rejects.toThrow("naming_observe_only");
  detach(); await store.finish(job, "succeeded");
  expect(JSON.parse(String(writes.at(-1)![3]))).toEqual({ state: "cancelled", errorCode: null });
});
