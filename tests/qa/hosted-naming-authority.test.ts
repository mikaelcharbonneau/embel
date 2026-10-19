import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { namingBrainJobInputSchema } from "../../src/domain/naming-brain";
import { createNamingBrainPolicy } from "../../src/server/ai/naming-brain/policy";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { id, snapshot } from "../domain/naming-brain-fixtures";

// Independent trust-boundary checks. The synthetic database response is the
// only claimed authority; no worker process setting or job JSON may replace it.
function input(hosted = true) {
  return namingBrainJobInputSchema.parse({
    version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api",
    runId: id(3), jobId: id(4), batchId: id(5), snapshot: snapshot(),
    acceptedPolicyIdentity: "a".repeat(64), policy: createNamingBrainPolicy("gpt-6-luna"),
    localTimingVersion: 2, localPipelineVersion: 2,
    ...(hosted ? { executionAuthority: "hosted_owner_v1" } : {}),
  });
}

function row(saved = input(), lease = id(9)) {
  return {
    id: id(4), owner_id: id(1), project_id: id(2), operation: "naming.generate",
    input: saved, input_revision: 1, lease_token: lease, state: "running",
    reserved_cost_microusd: 5_000_000, actual_cost_microusd: 0, billing_mode: "openai_api",
  };
}

function fixture(first: unknown) {
  let response = first;
  const query = vi.fn(async () => ({ rows: [{ result: response }] }));
  const store = new NamingBrainJobStore({ query }, "synthetic-hosted-deployment");
  return { store, query, reply(value: unknown) { response = value; } };
}

describe("independent hosted Naming authority fencing", () => {
  it.each([undefined, null, "local_owner_v1"])("rejects a hosted input when independent claim authority is %s", async executionAuthority => {
    const test = fixture({ mode: "execute", executionAuthority, job: row() });
    await expect(test.store.claim("synthetic-worker", 120)).rejects.toThrow("naming_execution_authority_mismatch");
    expect(test.query).toHaveBeenCalledTimes(1);
  });

  it("rejects a hosted claim attestation for a local job with otherwise identical progressive markers", async () => {
    const test = fixture({ mode: "execute", executionAuthority: "hosted_owner_v1", job: row(input(false)) });
    await expect(test.store.claim("synthetic-worker", 120)).rejects.toThrow("naming_execution_authority_mismatch");
  });

  it("does not take execution authority from a job-row property or progressive markers", async () => {
    const test = fixture({ mode: "execute", executionAuthority: null, job: { ...row(input(false)), executionAuthority: "hosted_owner_v1" } });
    await expect(test.store.claim("synthetic-worker", 120)).rejects.toThrow("naming_execution_authority_mismatch");
  });

  it("fences the previous lease when the same durable hosted job is reclaimed", async () => {
    const test = fixture({ mode: "execute", executionAuthority: "hosted_owner_v1", job: row() });
    const previous = (await test.store.claim("synthetic-first-worker", 120))!;
    expect(test.store.executionAuthority(previous)).toBe("hosted_owner_v1");
    test.reply({ mode: "observe_only", executionAuthority: "hosted_owner_v1", job: row(input(), id(10)) });
    const current = (await test.store.claim("synthetic-recovery-worker", 120))!;
    expect(test.store.executionAuthority(current)).toBe("hosted_owner_v1");
    expect(() => test.store.hasUnmeteredExecutionAuthority(previous)).toThrow("naming_execution_authority_mismatch");
  });

  it("does not let a rejected later claim replace an already acknowledged authority", async () => {
    const test = fixture({ mode: "execute", executionAuthority: "hosted_owner_v1", job: row() });
    const acknowledged = (await test.store.claim("synthetic-worker", 120))!;
    test.reply({ mode: "execute", executionAuthority: "local_owner_v1", job: row(input(), id(10)) });
    await expect(test.store.claim("synthetic-worker", 120)).rejects.toThrow("naming_execution_authority_mismatch");
    expect(test.store.executionAuthority(acknowledged)).toBe("hosted_owner_v1");
  });

  it("rejects a structurally valid model change made after the claim", async () => {
    const test = fixture({ mode: "execute", executionAuthority: "hosted_owner_v1", job: row() });
    const claimed = (await test.store.claim("synthetic-worker", 120))!;
    const changed = namingBrainJobInputSchema.parse({ ...input(), policy: createNamingBrainPolicy("gpt-6.1-sol") });
    expect(() => test.store.executionAuthority({ ...claimed, input: changed })).toThrow("naming_execution_authority_mismatch");
    expect(test.store.executionAuthority(claimed)).toBe("hosted_owner_v1");
  });

  it("cannot transfer an acknowledged hosted authority to a different valid job identity", async () => {
    const test = fixture({ mode: "execute", executionAuthority: "hosted_owner_v1", job: row() });
    const claimed = (await test.store.claim("synthetic-worker", 120))!;
    const changed = namingBrainJobInputSchema.parse({ ...input(), jobId: id(11) });
    expect(() => test.store.hasUnmeteredExecutionAuthority({ ...claimed, id: id(11), input: changed })).toThrow("naming_execution_authority_missing");
  });

  it("rejects a heartbeat with changed immutable model before accepting continuation", async () => {
    const test = fixture({ mode: "observe_only", executionAuthority: "hosted_owner_v1", job: row() });
    const claimed = (await test.store.claim("synthetic-worker", 120))!;
    const changed = namingBrainJobInputSchema.parse({ ...input(), policy: createNamingBrainPolicy("gpt-6.1-sol") });
    test.reply({ ...row(changed), recoveryMode: "execute", observationDeadlineAt: null });
    await expect(test.store.heartbeat(claimed, 120)).rejects.toThrow();
    expect(test.store.executionAuthority(claimed)).toBe("hosted_owner_v1");
  });

  it("rejects a foreign cancellation heartbeat before notifying the owned provider call", async () => {
    const test = fixture({ mode: "execute", executionAuthority: "hosted_owner_v1", job: row() });
    const claimed = (await test.store.claim("synthetic-worker", 120))!;
    const cancellation = vi.fn();
    const detach = test.store.onCancellation(claimed, cancellation);
    test.reply({ ...row(), owner_id: id(12), state: "cancel_requested", recoveryMode: "observe_only", observationDeadlineAt: null });
    await expect(test.store.heartbeat(claimed, 120)).rejects.toThrow();
    expect(cancellation).not.toHaveBeenCalled();
    detach();
  });
});
