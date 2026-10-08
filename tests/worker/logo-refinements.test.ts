import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoRefinementHandler } from "../../worker/handlers/logo-refinements";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type { LogoImageProducer } from "../../src/server/logo-creation/openai-logo-provider";
import type { LogoResolvedRefinementInput } from "../../src/domain/logo-jobs";
import { logoFixtureId as id, syntheticLogoJob, syntheticResolvedLogoRefinement } from "../fixtures/logo-creation";
let png: Uint8Array<ArrayBuffer>;
beforeAll(async () => { png = new Uint8Array(await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#555555" } }).png().toBuffer()); });
function setup() {
  const original = syntheticResolvedLogoRefinement(), hash = createHash("sha256").update(png).digest("hex");
  const input: LogoResolvedRefinementInput = { ...original, basePreview: { ...original.basePreview, contentHash: hash } }, job = syntheticLogoJob(input.input);
  const produce = vi.fn<LogoImageProducer["produce"]>(async () => ({ status: "completed", bytes: png, mimeType: "image/png", providerRequestId: "req_refine", responseHash: "a".repeat(64), billing: { status: "recorded", confirmedMicrousd: 1000 } }));
  const publication = vi.fn<IdentityAssetStore["publishLeasedAsset"]>(async (_, body, bytes) => ({ id: id(720), reference: { ...input.basePreview, assetId: id(721), versionId: id(722), contentHash: body.contentHash }, verification: { status: "verified", checkedAt: "2026-10-06T12:00:00Z", contentHash: body.contentHash, mimeType: "image/png", byteLength: bytes.length }, purpose: "brand_asset", sourceReceiptId: body.source.sourceId, rightsEvidenceId: null, publicationState: "staged" }));
  const read = vi.fn<IdentityAssetStore["readLeasedAsset"]>(async (_, reference) => ({ reference, bytes: png, mimeType: "image/png", verification: { status: "verified", checkedAt: "2026-10-06T12:00:00Z", contentHash: hash, mimeType: "image/png", byteLength: png.length } }));
  const unused = async (): Promise<never> => { throw new Error("Unavailable fixture"); };
  const assets: IdentityAssetStore = { publishLeasedAsset: publication, readLeasedAsset: read, readOwnedAsset: unused, stageOwnedAsset: unused, publishOwnedUpload: unused };
  const handler = createLogoRefinementHandler({ producer: { produce }, assets, assertPolicyReady: async () => undefined, resolveInputs: async () => input,
    recordProviderResponse: async (bound, observation) => ({ ...observation, id: id(723), ownerId: bound.ownerId, projectId: bound.projectId, jobId: bound.id, leaseToken: bound.leaseToken }), loadGeneratedRaster: unused, vectorRefinement: null });
  return { input, job, produce, publication, read, handler };
}
describe("immutable raster refinement handler", () => {
  it("uses the exact retained base and one paid step without replacing or approving the source", async () => {
    const f = setup(), original = JSON.stringify(f.input), steps = f.handler.steps(f.job);
    expect(steps.map(step => step.key)).toEqual(["generate-refinement"]);
    const outcome = await steps[0]!.execute({ job: f.job, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "succeeded", result: { kind: "logo_refinement_raster", rasterRevisionId: f.input.input.rasterRevisionId, publicationId: id(720), providerResponseReceiptId: id(723) } });
    expect(f.produce).toHaveBeenCalledTimes(1); expect(f.produce.mock.calls[0]![1][0]!.reference).toEqual(f.input.basePreview);
    expect(JSON.stringify(f.input)).toBe(original); expect(f.publication.mock.calls[0]![1].requestKey).toBe(f.input.input.rasterRevisionId);
    expect(f.publication.mock.calls[0]![1].source.sourceId).toBe(f.input.input.rasterRevisionId);
  });
  it("aborted or wrong-source reads never dispatch", async () => {
    const f = setup();
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: AbortSignal.abort() })).toMatchObject({ status: "failed", costMicrousd: 0 });
    f.read.mockRejectedValue(new Error("Foreign source"));
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "failed", costMicrousd: 0 });
    expect(f.produce).not.toHaveBeenCalled();
  });
  it("vector refinements remain unavailable until the reviewed vector candidate facade exists", () => {
    const f = setup();
    const vector = { ...f.input.input, source: { kind: "vector", vectorRevisionId: id(900), documentHash: "a".repeat(64), logoType: "wordmark", locks: [], traceSettings: { preset: "bw", simplify: 1, filterSpeckle: 2, maxColors: 2 } } };
    expect(() => f.handler.steps({ ...f.job, input: vector })).toThrow(); expect(f.produce).not.toHaveBeenCalled();
  });
  it("unknown image outcome never retries or publishes a fabricated raster", async () => {
    const f = setup(); f.produce.mockResolvedValue({ status: "needs_reconciliation", code: "outcome_unknown", providerRequestId: "req_refine", responseHash: null, billing: { status: "unknown", confirmedMicrousd: null } });
    expect(await f.handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation" });
    expect(f.produce).toHaveBeenCalledTimes(1); expect(f.publication).not.toHaveBeenCalled();
  });
});
