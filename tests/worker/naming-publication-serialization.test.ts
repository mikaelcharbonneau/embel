import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainJobInputSchema, type NamingMicrobatchInput } from "../../src/domain/naming-brain";
import { createNamingBrainPolicy } from "../../src/server/ai/naming-brain/policy";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { parseClaimedJob } from "../../worker/postgres-store";
import { id, snapshot } from "../domain/naming-brain-fixtures";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const input = namingBrainJobInputSchema.parse({ version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api", runId: id(3), jobId: id(4), batchId: id(5), snapshot: snapshot(), acceptedPolicyIdentity: "a".repeat(64), policy: createNamingBrainPolicy("synthetic-model"), localTimingVersion: 2, localPipelineVersion: 2 });
  const job = parseClaimedJob({ id: id(4), owner_id: id(1), project_id: id(2), operation: "naming.generate", input, input_revision: 1, lease_token: id(9), state: "running", reserved_cost_microusd: 5_000_000, actual_cost_microusd: 0, billing_mode: "openai_api" });
  const other = parseClaimedJob({ id: id(14), owner_id: id(1), project_id: id(2), operation: "naming.generate", input: { ...input, jobId: id(14), runId: id(13) }, input_revision: 1, lease_token: id(19), state: "running", reserved_cost_microusd: 5_000_000, actual_cost_microusd: 0, billing_mode: "openai_api" });
  const publication: NamingMicrobatchInput = { version: 1, key: "part001", candidates: [{ candidateId: id(20), sourceArtifactId: id(21), candidateKey: "candidate-one", assignmentKey: "assignment-one", identityKey: "syntheticone" }], curationArtifactId: id(22), verification: { kind: "not_required", reason: "no_factual_claims" } };
  const store = new NamingBrainJobStore({ query: async () => { throw Error("Unit fixture must not access a database"); } }, "synthetic-deployment");
  // Only scheduling/error semantics are simulated here. The separate database
  // and installed-SDK suites exercise actual publication and authority guards.
  const action = vi.spyOn(store, "action").mockImplementation(async (_job, operation, payload) => {
    expect(operation).toBe("publish_microbatch");
    return { key: (payload as NamingMicrobatchInput).key, publicationId: id(23), entryIds: [id(24)], candidateIds: [id(20)], publishedCount: 1, primaryCounts: [{ approach: "real_words", count: 1 }], complete: false };
  });
  const identities = vi.spyOn(store, "identities").mockResolvedValue([]);
  return { store, job, other, publication, action, identities, signal: new AbortController().signal };
}

describe("Naming publication queue lifecycle", () => {
  it("lets a different job publish while one job is waiting for identity refresh", async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.identities.mockImplementation(async job => { if (job.id === f.job.id) { entered.resolve(); await release.promise; } return []; });
    const first = f.store.publishMicrobatch(f.job, f.publication, f.signal);
    await entered.promise;
    try {
      await expect(f.store.publishMicrobatch(f.other, f.publication, f.signal)).resolves.toMatchObject({ publishedCount: 1 });
      expect(f.action).toHaveBeenCalledTimes(1); expect(f.action.mock.calls[0]![0].id).toBe(f.other.id);
    } finally { release.resolve(); await first; }
  });

  it("propagates the original failure once and releases queued and future publications", async () => {
    const f = fixture(), entered = deferred(), release = deferred(), failure = new Error("synthetic_index_failure");
    f.identities.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw failure; });
    const first = f.store.publishMicrobatch(f.job, f.publication, f.signal);
    await entered.promise;
    const next = f.store.publishMicrobatch(f.job, { ...f.publication, key: "part002" }, f.signal);
    const settled = Promise.allSettled([first, next]);
    expect(f.identities).toHaveBeenCalledTimes(1);
    release.resolve();
    expect(await settled).toMatchObject([{ status: "rejected", reason: failure }, { status: "fulfilled" }]);
    await expect(f.store.publishMicrobatch(f.job, { ...f.publication, key: "part003" }, f.signal)).resolves.toMatchObject({ key: "part003" });
    expect(f.identities).toHaveBeenCalledTimes(3); expect(f.action).toHaveBeenCalledTimes(2);
  });

  it("does no identity or publication RPC for a queued caller cancelled during its wait", async () => {
    const f = fixture(), entered = deferred(), release = deferred(), cancelled = new AbortController();
    f.identities.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return []; });
    const first = f.store.publishMicrobatch(f.job, f.publication, f.signal);
    await entered.promise;
    const queued = f.store.publishMicrobatch(f.job, { ...f.publication, key: "part002" }, cancelled.signal);
    const rejected = expect(queued).rejects.toThrow("naming_index_cancelled");
    cancelled.abort(); release.resolve();
    await first; await rejected;
    expect(f.identities).toHaveBeenCalledTimes(1); expect(f.action).toHaveBeenCalledTimes(1);
    await expect(f.store.publishMicrobatch(f.job, { ...f.publication, key: "part003" }, f.signal)).resolves.toMatchObject({ key: "part003" });
  });

  it("rechecks cancellation after identity refresh before attempting publication", async () => {
    const f = fixture(), cancelled = new AbortController();
    f.identities.mockImplementationOnce(async () => { cancelled.abort(); return []; });
    await expect(f.store.publishMicrobatch(f.job, f.publication, cancelled.signal)).rejects.toThrow("naming_index_cancelled");
    expect(f.action).not.toHaveBeenCalled();
  });
});
