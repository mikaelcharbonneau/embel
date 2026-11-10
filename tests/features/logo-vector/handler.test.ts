import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoVectorHandler } from "../../../worker/logo-vector/handler";
import { QUALIFIED_VTRACER } from "../../../src/server/image-process/engine";
import { runOneJob, type JobStore } from "../../../worker/runner";
import type { ClaimedJob } from "../../../src/domain/jobs";
import type { IdentityAssetReceipt } from "../../../src/domain/logo-deliverables";
import type { LogoVectorConversionResult } from "../../../src/features/logo-vector/server/converter";
import { digestBytes, syntheticConversionInput, syntheticOwnerId, syntheticProjectId } from "./raster-fixtures";
const id = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
function fixture() {
  const input = syntheticConversionInput("mascot");
  const job: ClaimedJob = { id: id(1), ownerId: syntheticOwnerId, projectId: syntheticProjectId, operation: "identity.logo_vectorize", inputRevision: 1, leaseToken: id(2), status: "running", reservedCostMicrousd: 0, actualCostMicrousd: 0,
    input: { version: 2, ownerId: syntheticOwnerId, projectId: syntheticProjectId, requestKey: id(3), quoteId: id(4), policyIdentity: "a".repeat(64), handlerVersion: "1", inputHash: "b".repeat(64), operation: "identity.logo_vectorize", source: { kind: "refinement", rasterRevisionId: id(5) }, settings: input.settings, engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm } } };
  const loadInput = vi.fn(async () => input);
  const publish = vi.fn(async (_job: ClaimedJob, result: LogoVectorConversionResult): Promise<IdentityAssetReceipt> => {
    const hash = digestBytes(result.svg);
    return { id: id(6), reference: { ...input.source.reference, assetId: id(7), versionId: id(8), contentHash: hash }, verification: { status: "verified", checkedAt: "2026-10-07T00:00:00Z", contentHash: hash, mimeType: "image/svg+xml", byteLength: result.svg.length }, purpose: "brand_asset", sourceReceiptId: id(9), rightsEvidenceId: null, publicationState: "staged" };
  });
  const assertReady = vi.fn(async () => {});
  return { input, job, loadInput, publish, assertReady, handler: createLogoVectorHandler({ loadInput, publish, assertReady }) };
}
describe("lease-adapted vector job", () => {
  it("rejects unready conversion before creating or publishing new vector work", async () => {
    const f = fixture(); f.assertReady.mockRejectedValue(new Error("Readiness revoked"));
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "failed", code: "not_dispatched" });
    expect(f.assertReady).toHaveBeenCalledTimes(1); expect(f.publish).not.toHaveBeenCalled();
  });
  it("rejects unsupported handler versions before planning conversion", () => {
    const f = fixture(); f.job.input = { ...f.job.input as object, handlerVersion: "unsupported" };
    expect(() => f.handler.steps(f.job)).toThrow();
  });
  it("publishes real paths as an unapproved deterministic zero-provider-cost step", async () => {
    const f = fixture(), [step] = f.handler.steps(f.job);
    expect(step!.key).toBe("convert-vector"); expect(step!.maximumCostMicrousd).toBe(0);
    const result = await step!.execute({ job: f.job, signal: new AbortController().signal });
    expect(result).toEqual({ status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { version: 2, kind: "logo_vector", publicationId: id(6) } });
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0]![1].sourceContentHash).toBe(f.input.source.reference.contentHash);
    expect(f.publish.mock.calls[0]![1]).not.toHaveProperty("approval");
  });
  it("rejects foreign loaded bytes or drifted settings before publication", async () => {
    const f = fixture(); f.input.source.reference.ownerId = id(10);
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "failed", code: "source_mismatch" });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("retains uncertain publication instead of retrying or reporting failure", async () => {
    const f = fixture(); f.publish.mockRejectedValue(new Error("response lost"));
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation", code: "logo_publication_unknown", costMicrousd: 0 });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it("does not publish after cancellation while loading the exact source", async () => {
    const f = fixture(), controller = new AbortController();
    f.loadInput.mockImplementation(async () => { controller.abort(); return f.input; });
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: controller.signal })).toMatchObject({ status: "failed", code: "cancelled" });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("runner skips a completed step and blocks a stale lease without loading or publishing", async () => {
    const f = fixture();
    const store: JobStore = { claim: async () => f.job, registerPlan: async () => {}, heartbeat: vi.fn(async () => ({ cancelled: false })), beginStep: async () => "already_succeeded", completeStep: vi.fn(async () => {}), finish: async () => {} };
    const options = { store, handlers: new Map([[f.job.operation, f.handler]]), workerId: "synthetic-worker" };
    expect(await runOneJob(options)).toBe("succeeded");
    vi.mocked(store.heartbeat).mockRejectedValue(new Error("stale lease"));
    expect(await runOneJob(options)).toBe("lease_lost");
    expect(f.loadInput).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });
});
