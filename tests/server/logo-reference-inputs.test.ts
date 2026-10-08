import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { resolveLogoReferenceInputs } from "../../src/server/logo-creation/reference-inputs";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type { VerifiedAssetBytes } from "../../src/domain/logo-deliverables";
import { logoFixtureId as id, syntheticLogoJob, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
let png: Uint8Array<ArrayBuffer>;
beforeAll(async () => { png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#aa2288" } }).png().toBuffer()); });
function fixture() {
  const source = syntheticResolvedLogoConcept(), hash = createHash("sha256").update(png).digest("hex");
  const references = (["curated", "upload"] as const).map((sourceKind, index) => ({ referenceId: id(800 + index), sourceKind, aspects: ["lettering" as const, "shape" as const, "composition" as const, "overall_feel" as const], rightsEvidenceId: id(820 + index),
    asset: { ownerId: source.input.ownerId, projectId: source.input.projectId, assetId: id(840 + index), versionId: id(860 + index), contentHash: hash } }));
  const snapshot = { ...source.referenceSnapshot, references }, input = { ...source.input, references: references.map(ref => ref.asset) }, job = syntheticLogoJob(input);
  const read = vi.fn<IdentityAssetStore["readLeasedAsset"]>(async (_, reference) => ({ reference, mimeType: "image/png", bytes: png,
    verification: { status: "verified", contentHash: hash, mimeType: "image/png", byteLength: png.length, checkedAt: "2026-10-06T12:00:00Z" } }));
  const unavailable = async (): Promise<never> => { throw new Error("Not used in fixture"); };
  const store: IdentityAssetStore = { readLeasedAsset: read, readOwnedAsset: unavailable, publishOwnedUpload: unavailable, publishLeasedAsset: unavailable, stageOwnedAsset: unavailable };
  return { snapshot, job, store, read };
}
describe("leased exact logo reference inputs", () => {
  it("curated and uploads retain exact order, immutable source IDs and equal four-aspect controls", async () => {
    const f = fixture(), before = JSON.stringify(f.snapshot);
    const output = await resolveLogoReferenceInputs(f.job, f.snapshot, f.store, new AbortController().signal);
    expect(output.map(file => file.reference.versionId)).toEqual(f.snapshot.references.map(ref => ref.asset.versionId));
    expect(f.read.mock.calls.map(call => call[1])).toEqual(f.snapshot.references.map(ref => ref.asset));
    expect(JSON.stringify(f.snapshot)).toBe(before);
  });
  it("empty owned references are permitted", async () => {
    const f = fixture(), source = syntheticResolvedLogoConcept();
    expect(await resolveLogoReferenceInputs(syntheticLogoJob(), source.referenceSnapshot, f.store, new AbortController().signal)).toEqual([]);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("foreign snapshots fail before byte access", async () => {
    const f = fixture();
    await expect(resolveLogoReferenceInputs(f.job, { ...f.snapshot, ownerId: id(999) }, f.store, new AbortController().signal)).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["hash", "owner", "html", "mime", "version"])("rejects invalid %s bytes rather than dropping a reference", async invalid => {
    const f = fixture();
    f.read.mockImplementation(async (_, reference) => {
      const value: VerifiedAssetBytes = { reference, mimeType: "image/png", bytes: png,
        verification: { status: "verified", contentHash: reference.contentHash, mimeType: "image/png", byteLength: png.length, checkedAt: "2026-10-06T12:00:00Z" } };
      if (invalid === "hash") value.reference = { ...reference, contentHash: "f".repeat(64) };
      if (invalid === "owner") value.reference = { ...reference, ownerId: id(999) };
      if (invalid === "version") value.reference = { ...reference, versionId: id(999) };
      if (invalid === "html") value.bytes = new TextEncoder().encode("<svg><script/></svg>");
      if (invalid === "mime") value.mimeType = "image/svg+xml";
      return value;
    });
    const saved = JSON.stringify(f.snapshot);
    await expect(resolveLogoReferenceInputs(f.job, f.snapshot, f.store, new AbortController().signal)).rejects.toThrow(); expect(JSON.stringify(f.snapshot)).toBe(saved);
  });
  it("revoked catalog rights are enforced by the leased source capability, never by URL attribution", async () => {
    const f = fixture(); f.read.mockRejectedValue(new Error("Curated source license revoked"));
    await expect(resolveLogoReferenceInputs(f.job, f.snapshot, f.store, new AbortController().signal)).rejects.toThrow(); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("rejects changed snapshot bindings and an aborted read without provider work", async () => {
    const f = fixture();
    await expect(resolveLogoReferenceInputs(f.job, { ...f.snapshot, id: id(999) }, f.store, new AbortController().signal)).rejects.toThrow();
    await expect(resolveLogoReferenceInputs(f.job, f.snapshot, f.store, AbortSignal.abort())).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
  });
});
