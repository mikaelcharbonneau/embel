import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { ClaimedJob } from "../../src/domain/jobs";
import type { IdentityAssetPublication, IdentityAssetReceipt } from "../../src/domain/logo-deliverables";
import { createIdentityAssetStore, type IdentityAssetAccess, type IdentityAssetReservation } from "../../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { validateLogoVectorSvg } from "../../src/features/logo-vector/model/svg";
import { validateLogoVectorDocument } from "../../src/features/logo-vector/model/geometry";
import { createLogoVectorHandler } from "../../worker/logo-vector/handler";
import { createLogoVectorRuntimeAdapter } from "../../worker/logo-vector/runtime-adapter";
import { QUALIFIED_VTRACER } from "../../worker/logo-vector/engine";
import { syntheticConversionInput } from "../features/logo-vector/raster-fixtures";

const id = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
/** Real converter, canonical publication and asset verification; metadata and
 * immutable private blobs below are explicit local synthetic test adapters. */
function fixture() {
  const input = syntheticConversionInput("mascot"), original = Uint8Array.from(input.source.bytes);
  const job: ClaimedJob = { id: id(1), ownerId: input.source.reference.ownerId, projectId: input.source.reference.projectId,
    operation: "identity.logo_vectorize", inputRevision: 1, leaseToken: id(2), status: "running", reservedCostMicrousd: 0, actualCostMicrousd: 0,
    input: { version: 2, ownerId: input.source.reference.ownerId, projectId: input.source.reference.projectId,
      requestKey: id(3), quoteId: id(4), policyIdentity: "a".repeat(64), handlerVersion: "1", inputHash: "b".repeat(64),
      operation: "identity.logo_vectorize", source: { kind: "refinement", rasterRevisionId: id(5) }, settings: input.settings,
      engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm } } };
  const events: string[] = [], publications: IdentityAssetPublication[] = [];
  const rows = new Map<string, IdentityAssetReservation>();
  const receipts = new Map<string, IdentityAssetReceipt>();
  const blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const sourcePath = `${job.ownerId}/${job.projectId}/${input.source.reference.assetId}/${input.source.reference.versionId}`;
  const source: IdentityAssetReservation = { id: id(6), requestKey: id(7), reference: input.source.reference,
    storagePath: sourcePath, mimeType: input.source.mimeType, byteLength: original.length, purpose: "brand_asset",
    sourceReceiptId: id(5), rightsEvidenceId: null, publicationState: "committed" };
  rows.set(source.id, source); blobs.set(sourcePath, { bytes: original, mimeType: source.mimeType });
  const state = { lease: job.leaseToken, ready: true as unknown, available: true, stageUnknown: false,
    afterRead: undefined as undefined | (() => void), afterWrite: undefined as undefined | (() => void) };
  function lease(candidate: ClaimedJob) {
    if (candidate.id !== id(1) || candidate.leaseToken !== state.lease || candidate.ownerId !== input.source.reference.ownerId || candidate.projectId !== input.source.reference.projectId) throw Error("synthetic_lease_rejected");
  }
  const connection: LogoWorkerConnection = { async query<Row>(sql: string, parameters: unknown[] = []) {
    events.push(sql); lease({ ...job, id: parameters[0] as string, leaseToken: parameters[1] as string });
    let value: unknown;
    if (sql.includes("stage_logo_vector_publication")) {
      if (state.stageUnknown) throw Error("synthetic_acknowledgement_lost");
      const evidence = JSON.parse(parameters[2] as string); value = receipts.get(evidence.svgPublicationId);
    } else if (parameters[2] === "runtime_readiness") value = state.ready;
    else if (parameters[2] === "vector_input") value = { reference: input.source.reference, logoType: input.logoType, settings: input.settings };
    else if (parameters[2] === "input_revisions") value = [];
    else throw Error("Unexpected synthetic SQL");
    return { rows: [{ value }] as Row[] };
  } };
  function access(a: IdentityAssetAccess) { if (a.kind !== "leased") throw Error("No owned capability"); lease(a.job); }
  const assets = createIdentityAssetStore({ backend: {
    async prepare(a, write) {
      access(a); events.push("reserve"); if (write.kind !== "stage") throw Error("No upload capability");
      const p = write.publication; publications.push(p);
      const existing = [...rows.values()].find(r => r.requestKey === p.requestKey); if (existing) return existing;
      const number = 10 + publications.length * 3;
      const reference = { ownerId: a.ownerId, projectId: a.projectId, assetId: id(number), versionId: id(number + 1), contentHash: p.contentHash };
      const row: IdentityAssetReservation = { id: id(number + 2), requestKey: p.requestKey, reference,
        storagePath: `${a.ownerId}/${a.projectId}/${reference.assetId}/${reference.versionId}`, mimeType: p.mimeType, byteLength: p.byteLength,
        purpose: "brand_asset", sourceReceiptId: p.source.sourceId, rightsEvidenceId: null, publicationState: "staged" };
      rows.set(row.id, row); return row;
    },
    async resolve(a, reference) { access(a); events.push("resolve"); const row = [...rows.values()].find(r => r.reference.versionId === reference.versionId); if (!row) throw Error("No source"); return row; },
    async observe(a, receiptId, verification) { access(a); events.push("observe"); const row = rows.get(receiptId)!;
      const receipt: IdentityAssetReceipt = { id: row.id, reference: row.reference, verification, purpose: row.purpose, sourceReceiptId: row.sourceReceiptId, rightsEvidenceId: null, publicationState: row.publicationState };
      receipts.set(receipt.id, receipt); return receipt;
    },
  }, storage: {
    async putIfAbsent(path, bytes, mimeType) { events.push("write"); if (blobs.has(path)) { if (hash(blobs.get(path)!.bytes) !== hash(bytes)) throw Error("immutable_conflict"); }
      else blobs.set(path, { bytes: Uint8Array.from(bytes), mimeType }); state.afterWrite?.(); },
    async read(path) { events.push("read"); const file = blobs.get(path); if (!file) throw Error("No bytes"); const copy = { ...file, bytes: Uint8Array.from(file.bytes) }; state.afterRead?.(); return copy; },
  } });
  const options = { ownerId: job.ownerId, policyIdentity: "a".repeat(64), connection, assets,
    async assertAvailable(current: ClaimedJob) { events.push("availability"); lease(current); if (!state.available) throw Error("Synthetic storage unavailable"); } };
  const adapter = createLogoVectorRuntimeAdapter(options)!;
  return { options, adapter, job, state, events, input, original, sourcePath, blobs, publications, receipts };
}

describe("injected local vector runtime adapter", () => {
  it("is absent without complete dependencies and performs no construction I/O", () => {
    const f = fixture();
    expect(f.adapter).not.toBeNull(); expect(f.events).toEqual([]);
    expect(createLogoVectorRuntimeAdapter(null)).toBeNull();
    for (const missing of ["connection", "assets", "assertAvailable"] as const) expect(createLogoVectorRuntimeAdapter({ ...f.options, [missing]: null })).toBeNull();
    expect(createLogoVectorRuntimeAdapter({ ...f.options, ownerId: "invalid" })).toBeNull();
    expect(createLogoVectorRuntimeAdapter({ ...f.options, policyIdentity: "invalid" })).toBeNull();
    expect(f.adapter.capability).toEqual({ operation: "identity.logo_vectorize", policyIdentity: "a".repeat(64), handlerVersion: "1",
      provider: null, model: null, engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm }, maxCostMicrousd: 0 });
    expect(Object.isFrozen(f.adapter.capability.engine)).toBe(true);
    f.options.policyIdentity = "c".repeat(64); expect(f.adapter.capability.policyIdentity).toBe("a".repeat(64));
  });
  it.each(["owner", "project", "policy", "engine", "handler", "operation", "reserved", "actual", "cancelled", "lease"])("rejects a mismatched %s before source I/O", async mismatch => {
    const f = fixture(), job = structuredClone(f.job), input = job.input as Record<string, unknown>;
    if (mismatch === "owner") job.ownerId = id(99);
    if (mismatch === "project") job.projectId = id(99);
    if (mismatch === "policy") input.policyIdentity = "c".repeat(64);
    if (mismatch === "engine") input.engine = { id: "vtracer", version: "wrong", artifactHash: QUALIFIED_VTRACER.wasm };
    if (mismatch === "handler") input.handlerVersion = "wrong";
    if (mismatch === "operation") job.operation = "strategy";
    if (mismatch === "reserved") job.reservedCostMicrousd = 1;
    if (mismatch === "actual") job.actualCostMicrousd = 1;
    if (mismatch === "cancelled") job.status = "cancel_requested";
    if (mismatch === "lease") job.leaseToken = "invalid";
    await expect(f.adapter.dependencies.loadInput(job, signal())).rejects.toThrow(); expect(f.events).toEqual([]);
  });
  it("requires independently available storage and exact current leased readiness", async () => {
    const f = fixture(); await f.adapter.dependencies.assertReady(f.job);
    f.state.available = false; await expect(f.adapter.dependencies.assertReady(f.job)).rejects.toThrow();
    f.state.available = true;
    for (const ready of [false, null, "true", {}]) { f.state.ready = ready; await expect(f.adapter.dependencies.assertReady(f.job)).rejects.toThrow(); }
    f.state.ready = true; f.state.lease = id(99); await expect(f.adapter.dependencies.assertReady(f.job)).rejects.toThrow();
  });
  it("loads immutable original bytes and rejects an expired lease after storage I/O", async () => {
    const f = fixture(), loaded = await f.adapter.dependencies.loadInput(f.job, signal());
    expect(loaded.source.reference).toEqual(f.input.source.reference); expect(loaded.source.bytes).toEqual(f.original);
    loaded.source.bytes[0] = loaded.source.bytes[0]! ^ 1; expect(f.blobs.get(f.sourcePath)!.bytes).toEqual(f.original);
    f.state.afterRead = () => { f.state.lease = id(99); };
    await expect(f.adapter.dependencies.loadInput(f.job, signal())).rejects.toThrow(); expect(f.publications).toEqual([]);
  });
  it("never traces or publishes a cancelled or hash-mismatched raster", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.adapter.dependencies.loadInput(f.job, controller.signal)).rejects.toMatchObject({ code: "cancelled" }); expect(f.events).toEqual([]);
    f.blobs.get(f.sourcePath)!.bytes[0] = f.blobs.get(f.sourcePath)!.bytes[0]! ^ 1;
    const outcome = await createLogoVectorHandler(f.adapter.dependencies).steps(f.job)[0]!.execute({ job: f.job, signal: signal() });
    expect(outcome.status).toBe("failed"); expect(f.publications).toEqual([]);
  });
  it("converts an actual local PNG with the qualified engine and stages inspected JSON/SVG as one unapproved group", async () => {
    const f = fixture(), step = createLogoVectorHandler(f.adapter.dependencies).steps(f.job)[0]!;
    const outcome = await step.execute({ job: f.job, signal: signal() });
    expect(outcome).toMatchObject({ status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { kind: "logo_vector" } });
    expect(f.publications.map(p => p.mimeType)).toEqual(["application/json", "image/svg+xml"]);
    expect(f.blobs.get(f.sourcePath)!.bytes).toEqual(f.original);
    for (const receipt of f.receipts.values()) {
      expect(receipt.reference.ownerId).toBe(f.job.ownerId); expect(receipt.reference.projectId).toBe(f.job.projectId);
      expect(receipt.sourceReceiptId).toBe(f.job.id); expect(receipt.publicationState).toBe("staged");
      const file = [...f.blobs.values()].find(value => hash(value.bytes) === receipt.reference.contentHash)!;
      if (file.mimeType === "image/svg+xml") {
        expect(validateLogoVectorSvg(file.bytes).components.flatMap(c => c.paths).length).toBeGreaterThan(0);
        expect(new TextDecoder().decode(file.bytes)).not.toMatch(/<(image|text|use)\b/);
      } else expect(validateLogoVectorDocument(JSON.parse(new TextDecoder().decode(file.bytes))).components.length).toBeGreaterThan(0);
    }
    expect(f.events.filter(e => e.includes("stage_logo_vector_publication"))).toHaveLength(1);
    expect(f.events.join(" ")).not.toMatch(/accept_logo|restore_logo|apply_logo/);
  });
  it("retains ambiguous group publication without retries or replacement versions", async () => {
    const f = fixture(); f.state.stageUnknown = true;
    expect(await createLogoVectorHandler(f.adapter.dependencies).steps(f.job)[0]!.execute({ job: f.job, signal: signal() }))
      .toMatchObject({ status: "needs_reconciliation", code: "logo_publication_unknown", costMicrousd: 0 });
    expect(f.publications).toHaveLength(2); expect(f.blobs.size).toBe(3);
    expect(f.events.filter(e => e.includes("stage_logo_vector_publication"))).toHaveLength(1);
    expect(f.blobs.get(f.sourcePath)!.bytes).toEqual(f.original);
  });
  it("fences cancellation during publication, retaining only the first staged member and original", async () => {
    const f = fixture(), controller = new AbortController(); f.state.afterWrite = () => controller.abort();
    expect(await createLogoVectorHandler(f.adapter.dependencies).steps(f.job)[0]!.execute({ job: f.job, signal: controller.signal }))
      .toMatchObject({ status: "needs_reconciliation", code: "logo_publication_unknown" });
    expect(f.publications).toHaveLength(1); expect(f.blobs.size).toBe(2);
    expect(f.events.some(e => e.includes("stage_logo_vector_publication"))).toBe(false);
    expect(f.blobs.get(f.sourcePath)!.bytes).toEqual(f.original);
  });
});
