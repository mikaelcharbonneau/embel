import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainJobInputSchema } from "../../src/domain/naming-brain";
import { createNamingBrainPolicy } from "../../src/server/ai/naming-brain/policy";
import { buildNamingManagedRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { runOneJob } from "../../worker/runner";
import { id, snapshot } from "../domain/naming-brain-fixtures";
import { createInertNamingHarness } from "./naming-brain-handler-fixture";

function row(inputPatch: Record<string, unknown> = {}) {
  return { id: id(4), owner_id: id(1), project_id: id(2), operation: "naming.generate", input_revision: 1, lease_token: id(9), state: "running",
    reserved_cost_microusd: 5_000_000, actual_cost_microusd: 0, billing_mode: "openai_api",
    input: namingBrainJobInputSchema.parse({ version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api", runId: id(3), jobId: id(4), batchId: id(5),
      snapshot: snapshot(), acceptedPolicyIdentity: "a".repeat(64), policy: createNamingBrainPolicy("gpt-6-luna"), ...inputPatch }) };
}

describe("Naming authority is admitted per job", () => {
  it("uses the approved hosted progressive timing on a worker without a local process flag", async () => {
    const jobRow = row({ executionAuthority: "hosted_owner_v1", localTimingVersion: 2, localPipelineVersion: 2 });
    const store = new NamingBrainJobStore({ query: async () => ({ rows: [{ result: { mode: "execute", executionAuthority: "hosted_owner_v1", job: jobRow } }] }) }, "fixture-deployment");
    const job = (await store.claim("fixture-worker", 120))!;
    const steps = createNamingBrainHandlers({ store, assertReady: async () => {} }).get("naming.generate")!.steps(job);
    expect(store.executionAuthority(job)).toBe("hosted_owner_v1");
    expect(steps.map(step => [step.key, step.timeoutMs])).toEqual([["creation", 3_600_000], ["prepare", 270_000]]);
  });

  it("retains pre-witness local call policies from explicit database claim authority", async () => {
    const fixture = createInertNamingHarness({ localPrototype: true, partialResearch: true });
    // No process-local option is passed to the handler or runner.
    const handlers = createNamingBrainHandlers({ store: fixture.store, assertReady: async () => {}, runtime: () => fixture.runtime });
    expect(await runOneJob({ store: fixture.store, handlers, workerId: "fixture-worker" })).toBe("succeeded");
    expect(fixture.input.localTimingVersion).toBeUndefined();
    expect(fixture.input.localPipelineVersion).toBeUndefined();
    expect(fixture.dispatched.length).toBeGreaterThan(0);
    for (const request of fixture.dispatched) {
      expect(request.policy).toMatchObject({ budgetControl: "local_unlimited_v1", deadlineMs: 240_000 });
      expect(buildNamingManagedRequest(request)).not.toHaveProperty("spend_control");
    }
  });

  it("does not grant compatibility policy from a process-local flag to an ordinary claim", async () => {
    const fixture = createInertNamingHarness();
    const handlers = createNamingBrainHandlers({ store: fixture.store, localPrototype: true, assertReady: async () => {}, runtime: () => fixture.runtime });
    expect(await runOneJob({ store: fixture.store, handlers, workerId: "fixture-worker", localPrototype: true })).toBe("succeeded");
    for (const request of fixture.dispatched) {
      expect(request.policy.budgetControl).toBeUndefined();
      expect(buildNamingManagedRequest(request)).toHaveProperty("spend_control.limit", request.policy.sessionLimitCents);
    }
  });

  it("does not infer authority from copied local timing or progressive witnesses", async () => {
    const store = new NamingBrainJobStore({ query: async () => ({ rows: [{ result: { mode: "execute", executionAuthority: null, job: row({ localTimingVersion: 2, localPipelineVersion: 2 }) } }] }) }, "fixture-deployment");
    await expect(store.claim("fixture-worker", 120)).rejects.toThrow("naming_execution_authority_mismatch");
  });

  it("keeps the runner's ordinary cost guard when an unmarked job is claimed in a local process", async () => {
    const fixture = createInertNamingHarness(), execute = vi.fn();
    const handlers = new Map([["naming.generate", { steps: () => [{ key: "research", maximumCostMicrousd: 5_000_001, execute }] }]]);
    expect(await runOneJob({ store: fixture.store, handlers, workerId: "fixture-worker", localPrototype: true })).toBe("failed");
    expect(execute).not.toHaveBeenCalled(); expect(fixture.dispatched).toEqual([]);
  });

  it("requires both immutable profile versions for hosted admission and rejects unknown authorities", () => {
    const input = row().input;
    for (const patch of [{ executionAuthority: "hosted_owner_v1" }, { executionAuthority: "hosted_owner_v1", localTimingVersion: 2 },
      { executionAuthority: "local_owner_v1", localTimingVersion: 2, localPipelineVersion: 2 }, { executionAuthority: "anything", localTimingVersion: 2, localPipelineVersion: 2 }]) {
      expect(namingBrainJobInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });
});
