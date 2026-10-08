import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { ClaimedJob } from "../../../src/domain/jobs";
import type { IdentityAssetReceipt, IdentityAssetPublication } from "../../../src/domain/logo-deliverables";
import type { IdentityAssetStore } from "../../../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../../../src/server/data/logo-jobs";
import { publishLogoVectorResult, loadLeasedLogoVectorRevision } from "../../../src/features/logo-vector/server/publication";
import { QUALIFIED_VTRACER } from "../../../worker/logo-vector/engine";
import type { LogoVectorConversionResult } from "../../../src/features/logo-vector/server/converter";
import { canonicalLogoDocumentBytes, validateLogoVectorCandidate } from "../../../src/features/logo-vector/server/revisions";
import { serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";
import { separatedLogoDocument } from "./fixtures";
import { digestBytes, syntheticConversionInput, syntheticSource } from "./raster-fixtures";

/** Local in-memory storage/lease boundaries only; no provider or hosted calls. */
function fixture() {
  const loaded = syntheticConversionInput("combination"), document = separatedLogoDocument();
  const job: ClaimedJob = { id: randomUUID(), leaseToken: randomUUID(), ownerId: loaded.source.reference.ownerId,
    projectId: loaded.source.reference.projectId!, operation: "identity.logo_vectorize", inputRevision: 1,
    status: "running", reservedCostMicrousd: 0, actualCostMicrousd: 0,
    input: { version: 2, ownerId: loaded.source.reference.ownerId, projectId: loaded.source.reference.projectId!,
      requestKey: randomUUID(), quoteId: randomUUID(), policyIdentity: "a".repeat(64), handlerVersion: "1", inputHash: "b".repeat(64),
      operation: "identity.logo_vectorize", source: { kind: "refinement", rasterRevisionId: randomUUID() },
      settings: loaded.settings, engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm } } };
  const result: LogoVectorConversionResult = { source: structuredClone(loaded.source.reference), sourceContentHash: loaded.source.reference.contentHash,
    logoType: loaded.logoType, document, svg: Buffer.from(serializeLogoSvg(document)),
    engine: { name: "@visioncortex/vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm, settings: { ...loaded.settings } },
    raster: { inputFormat: "png", inputWidth: 48, inputHeight: 40, width: 48, height: 40, originalOrientation: 1, autoOriented: false, inputColorSpace: "srgb", outputColorSpace: "srgb", rgbaContentHash: "c".repeat(64), alphaStrategy: "exact-alpha-layers", alphaLevels: [255] } };
  const files = new Map<string, { bytes: Uint8Array; publication: IdentityAssetPublication; receipt: IdentityAssetReceipt }>();
  let group: unknown = null, beforeRead: (() => Promise<void>) | null = null, corruptReceipt = false;
  const assets = {
    async stageOwnedAsset() { throw new Error("not used"); },
    async publishOwnedUpload() { throw new Error("not used"); },
    async readOwnedAsset() { throw new Error("not used"); },
    async readLeasedAsset() { return loaded.source; },
    async publishLeasedAsset(_job: ClaimedJob, publication: IdentityAssetPublication, bytes: Uint8Array) {
      const prior = files.get(publication.requestKey);
      if (prior) { if (prior.publication.contentHash !== publication.contentHash) throw new Error("conflict"); return prior.receipt; }
      const receipt: IdentityAssetReceipt = { id: randomUUID(), reference: { ...loaded.source.reference, assetId: randomUUID(), versionId: randomUUID(), contentHash: publication.contentHash },
        verification: { status: "verified", contentHash: publication.contentHash, mimeType: publication.mimeType, byteLength: bytes.length, checkedAt: "2026-10-07T00:00:00Z" },
        purpose: "brand_asset", sourceReceiptId: job.id, rightsEvidenceId: null, publicationState: "staged" };
      files.set(publication.requestKey, { publication, receipt, bytes: Uint8Array.from(bytes) });
      return corruptReceipt ? { ...receipt, sourceReceiptId: randomUUID() } : receipt;
    },
  } as IdentityAssetStore;
  const connection: LogoWorkerConnection = { async query<Row>(sql: string, parameters?: unknown[]) {
    if (beforeRead) { const before = beforeRead; beforeRead = null; await before(); }
    if (sql.includes("stage_logo_vector_publication")) {
      group = JSON.parse(parameters![2] as string);
      const receipt = [...files.values()].find(f => f.publication.mimeType === "image/svg+xml")!.receipt;
      return { rows: [{ value: receipt }] as Row[] };
    }
    const value = parameters?.[2] === "input_revisions" ? [] : { reference: loaded.source.reference, logoType: loaded.logoType, settings: loaded.settings };
    return { rows: [{ value }] as Row[] };
  } };
  return { job, result, loaded, assets, connection, files, group: () => group, beforeRead: (run: () => Promise<void>) => { beforeRead = run; }, corrupt: () => { corruptReceipt = true; } };
}

describe("leased immutable vector publication adapter", () => {
  it("stages canonical JSON and exact portable SVG as one review-required group", async () => {
    const f = fixture(), receipt = await publishLogoVectorResult(f.connection, f.assets, f.job, f.result);
    expect(receipt.publicationState).toBe("staged"); expect(f.files.size).toBe(2);
    const json = [...f.files.values()].find(file => file.publication.mimeType === "application/json")!;
    const svg = [...f.files.values()].find(file => file.publication.mimeType === "image/svg+xml")!;
    expect(json.bytes).toEqual(canonicalLogoDocumentBytes(f.result.document)); expect(svg.bytes).toEqual(new Uint8Array(f.result.svg));
    expect(f.group()).toEqual({ documentPublicationId: json.receipt.id, svgPublicationId: receipt.id,
      documentHash: digestBytes(json.bytes), proof: expect.objectContaining({ documentHash: digestBytes(json.bytes), svgContentHash: digestBytes(svg.bytes), externalFontDependencies: [] }) });
    expect(f.group()).not.toHaveProperty("approval");
  });
  it("reuses separate deterministic member keys on exact replay", async () => {
    const f = fixture(); const first = await publishLogoVectorResult(f.connection, f.assets, f.job, f.result);
    expect(await publishLogoVectorResult(f.connection, f.assets, f.job, f.result)).toEqual(first);
    expect(f.files.size).toBe(2); expect(new Set([...f.files.values()].map(file => file.publication.requestKey)).size).toBe(2);
  });
  it("rejects changed source, settings, engine or SVG before storing either file", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.result.sourceContentHash = "f".repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.result.engine.settings.simplify = 1; },
      (f: ReturnType<typeof fixture>) => { f.result.engine.artifactHash = "f".repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.result.source.projectId = randomUUID(); },
      (f: ReturnType<typeof fixture>) => { f.result.svg[50] = f.result.svg[50]! ^ 1; },
    ]) { const f = fixture(); change(f); await expect(publishLogoVectorResult(f.connection, f.assets, f.job, f.result)).rejects.toBeDefined(); expect(f.files.size).toBe(0); }
  });
  it("snapshots Buffer bytes and geometry before the first awaited lease read", async () => {
    const f = fixture(), expectedSvg = Uint8Array.from(f.result.svg), expectedJson = canonicalLogoDocumentBytes(f.result.document);
    let release!: () => void; f.beforeRead(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = publishLogoVectorResult(f.connection, f.assets, f.job, f.result);
    f.result.svg.fill(0); f.result.document.components[0]!.paths[0]!.fill!.color = "#000000"; release();
    await pending;
    expect([...f.files.values()].find(f => f.publication.mimeType === "image/svg+xml")!.bytes).toEqual(expectedSvg);
    expect([...f.files.values()].find(f => f.publication.mimeType === "application/json")!.bytes).toEqual(expectedJson);
  });
  it("does not associate a receipt with the wrong authoritative source", async () => {
    const f = fixture(); f.corrupt(); await expect(publishLogoVectorResult(f.connection, f.assets, f.job, f.result)).rejects.toBeDefined(); expect(f.group()).toBeNull();
  });
  it("cancellation between members leaves no published group", async () => {
    const f = fixture(), controller = new AbortController(), original = f.assets.publishLeasedAsset;
    f.assets.publishLeasedAsset = async (...args) => { const result = await original(...args); controller.abort(); return result; };
    await expect(publishLogoVectorResult(f.connection, f.assets, f.job, f.result, controller.signal)).rejects.toBeDefined();
    expect(f.files.size).toBe(1); expect(f.group()).toBeNull();
  });
  it("loads only the exact leased immutable vector and rechecks the lease after byte I/O", async () => {
    const f = fixture(), source = f.loaded.source, document = f.result.document;
    const derived = validateLogoVectorCandidate({ base: null, candidate: document, locks: [], source, expectedSource: source.reference });
    const doc = syntheticSource(canonicalLogoDocumentBytes(document), "application/json"), svg = syntheticSource(derived.svg, "image/svg+xml");
    doc.reference.assetId = randomUUID(); doc.reference.versionId = randomUUID(); svg.reference.assetId = randomUUID(); svg.reference.versionId = randomUUID();
    const revision = { id: randomUUID(), ownerId: f.job.ownerId, projectId: f.job.projectId, parentRevisionId: null,
      source: { kind: "refinement", rasterRevisionId: randomUUID() }, sourcePreview: source.reference, documentAsset: doc.reference, svgAsset: svg.reference,
      documentHash: derived.documentHash, proof: derived.proof, locks: [], inputRevisions: [], reviewStatus: "review_required", createdAt: "2026-10-07T00:00:00Z" };
    let reads = 0, expire = false;
    const connection: LogoWorkerConnection = { async query<Row>() { reads++; if (expire && reads % 2 === 0) throw { code: "40001" }; return { rows: [{ value: revision }] as Row[] }; } };
    const store = { async readLeasedAsset(_job, ref) { return ref.versionId === doc.reference.versionId ? doc : svg; } } as IdentityAssetStore;
    expect(await loadLeasedLogoVectorRevision(connection, store, f.job, revision.id)).toEqual({ revision, document }); expect(reads).toBe(2);
    expire = true; await expect(loadLeasedLogoVectorRevision(connection, store, f.job, revision.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(loadLeasedLogoVectorRevision(connection, store, f.job, randomUUID())).rejects.toMatchObject({ code: "source_mismatch" });
  });
});
