import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoConceptHandler } from "../../worker/handlers/logo-concepts";
import { runOneJob, type JobStore } from "../../worker/runner";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type { LogoProviderObservation, LogoProviderResponseReceipt } from "../../src/domain/logo-jobs";
import type { LogoImageProductionResult, LogoImageProducer } from "../../src/server/logo-creation/openai-logo-provider";
import type { StepOutcome } from "../../src/domain/jobs";
import { logoFixtureId as id, syntheticLogoJob, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
let png: Uint8Array, color: Uint8Array;
beforeAll(async () => {
  png = new Uint8Array(await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#000000" } }).png().toBuffer());
  color = new Uint8Array(await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#aa2288" } }).png().toBuffer());
});
const unknown = { status: "unknown" as const, confirmedMicrousd: null };
function setup() {
  const input = syntheticResolvedLogoConcept(), job = syntheticLogoJob(input.input);
  const observations: LogoProviderObservation[] = [];
  const produce = vi.fn<LogoImageProducer["produce"]>(async (): Promise<LogoImageProductionResult> => ({ status: "completed", bytes: png, mimeType: "image/png", providerRequestId: "req_fixture", responseHash: "a".repeat(64), billing: { status: "recorded", confirmedMicrousd: 1000 } }));
  const record = vi.fn(async (bound: typeof job, observation: LogoProviderObservation): Promise<LogoProviderResponseReceipt> => {
    observations.push(observation); return { ...observation, id: id(710), ownerId: bound.ownerId, projectId: bound.projectId, jobId: bound.id, leaseToken: bound.leaseToken };
  });
  const publish = vi.fn<IdentityAssetStore["publishLeasedAsset"]>(async (bound, publication, bytes) => ({ id: id(711), reference: { ownerId: bound.ownerId, projectId: bound.projectId, assetId: id(712), versionId: id(713), contentHash: createHash("sha256").update(bytes).digest("hex") },
    verification: { status: "verified", checkedAt: "2026-10-06T12:00:00Z", contentHash: publication.contentHash, mimeType: publication.mimeType, byteLength: bytes.length }, purpose: "brand_asset", sourceReceiptId: publication.source.sourceId, rightsEvidenceId: null, publicationState: "staged" }));
  const unavailable = async (): Promise<never> => { throw new Error("Unavailable fixture operation"); };
  const assets: IdentityAssetStore = { publishLeasedAsset: publish, readLeasedAsset: unavailable, readOwnedAsset: unavailable, stageOwnedAsset: unavailable, publishOwnedUpload: unavailable };
  const ready = vi.fn(async () => undefined), resolve = vi.fn(async () => input);
  const handler = createLogoConceptHandler({ producer: { produce }, assets, assertPolicyReady: ready, resolveInputs: resolve, recordProviderResponse: record });
  return { job, input, observations, produce, publish, record, ready, resolve, handler };
}
describe("one durable concept child handler", () => {
  it("freezes one stable bounded step and publishes only verified monochrome bytes with retained response receipt", async () => {
    const f = setup(), steps = f.handler.steps(f.job);
    expect(steps).toHaveLength(1); expect(steps[0]).toMatchObject({ key: `logo-preview-v1:${f.input.input.slotId}:${f.input.input.attemptId}`, maximumCostMicrousd: 2000, timeoutMs: 300000 });
    const result = await steps[0]!.execute({ job: f.job, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "succeeded", costMicrousd: 1000, result: { kind: "logo_concept", slotId: f.input.input.slotId, attemptId: f.input.input.attemptId, publicationId: id(711), providerResponseReceiptId: id(710) } });
    expect(f.produce.mock.calls[0]![2]).toBe(createHash("sha256").update(`${f.job.id}:${steps[0]!.key}`).digest("hex"));
    expect(f.observations[0]?.artifactHash).toBe(createHash("sha256").update(png).digest("hex")); expect(f.publish).toHaveBeenCalledTimes(1);
    const imageObservation = f.observations[0]!; if ("version" in imageObservation) throw new Error("Image must retain its legacy observation");
    expect(imageObservation.normalizedPixelHash).toMatch(/^[a-f0-9]{64}$/); expect(imageObservation.normalizedPixelHash).not.toBe(f.observations[0]?.artifactHash);
    expect(f.publish.mock.calls[0]![1].source.sourceId).toBe(f.input.input.attemptId);
    expect(f.publish.mock.calls[0]![1].inputRevisions).toEqual(f.input.inputRevisions);
  });
  it("completed preview with unknown billing is published and remains reconciliation rather than free", async () => {
    const f = setup(); f.produce.mockResolvedValue({ status: "completed", bytes: png, mimeType: "image/png", providerRequestId: "req_fixture", responseHash: "a".repeat(64), billing: unknown });
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation", code: "billing_unknown", costMicrousd: 0, result: { kind: "logo_concept" } });
    expect(f.publish).toHaveBeenCalledTimes(1); expect(f.observations[0]?.billing).toEqual(unknown);
  });
  it("chromatic output records actual charge/evidence without publishing or silently regenerating", async () => {
    const f = setup(); f.produce.mockResolvedValue({ status: "completed", bytes: color, mimeType: "image/png", providerRequestId: "req_fixture", responseHash: "a".repeat(64), billing: { status: "recorded", confirmedMicrousd: 1000 } });
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "failed", code: "chromatic_output", costMicrousd: 1000 });
    expect(f.produce).toHaveBeenCalledTimes(1); expect(f.record).toHaveBeenCalledTimes(1); expect(f.publish).not.toHaveBeenCalled();
  });
  it("refuses a resolved provenance list that omits the exact captured brief", async () => {
    const f = setup(); f.resolve.mockResolvedValue({ ...f.input, inputRevisions: [] });
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "failed", code: "not_dispatched" });
    expect(f.produce).not.toHaveBeenCalled();
  });
  it("mismatched saved input and missing current policy cause zero provider calls", async () => {
    const f = setup(); f.resolve.mockResolvedValue({ ...f.input, input: { ...f.input.input, inputHash: "a".repeat(64) } });
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "failed", costMicrousd: 0 });
    f.resolve.mockResolvedValue(f.input); f.ready.mockRejectedValue(new Error("No verified policy"));
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "failed", costMicrousd: 0 });
    expect(f.produce).not.toHaveBeenCalled();
  });
  it("lost publication acknowledgement or foreign provider receipt cannot publish success", async () => {
    const f = setup(); f.publish.mockRejectedValue(new Error("commit uncertain"));
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation", code: "publication_unknown", costMicrousd: 1000 });
    const g = setup(); g.record.mockImplementation(async (_, observation) => ({ ...observation, id: id(710), ownerId: id(999), projectId: g.job.projectId, jobId: g.job.id, leaseToken: g.job.leaseToken }));
    expect(await g.handler.steps(g.job)[0]!.execute({ job: g.job, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation" }); expect(g.publish).not.toHaveBeenCalled();
  });
  it("an uncertain child does not prevent five other independent jobs from retaining their outputs", async () => {
    const outcomes: StepOutcome[] = [];
    for (let index = 0; index < 6; index++) {
      const f = setup();
      if (index === 0) f.produce.mockResolvedValue({ status: "needs_reconciliation", code: "outcome_unknown", providerRequestId: "req_lost", responseHash: null, billing: unknown });
      const store: JobStore = { claim: async () => f.job, registerPlan: async () => undefined, heartbeat: async () => ({ cancelled: false }), beginStep: async () => "started",
        completeStep: async (_, __, result) => { outcomes.push(result); }, finish: async () => undefined };
      const result = await runOneJob({ store, handlers: new Map([[f.job.operation, f.handler]]), workerId: "local-fixture" });
      expect(result).toBe(index === 0 ? "needs_reconciliation" : "succeeded"); expect(f.produce).toHaveBeenCalledTimes(1);
    }
    expect(outcomes.filter(result => result.status === "succeeded")).toHaveLength(5); expect(outcomes[0]).toMatchObject({ status: "needs_reconciliation" });
  });
});
