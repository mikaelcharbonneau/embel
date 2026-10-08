import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { ClaimedJob } from "../../src/domain/jobs";
import type { VerifiedAssetBytes } from "../../src/domain/logo-deliverables";
import { createIdentityAssetStore, type IdentityAssetReservation, type IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { canonicalLogoDocumentBytes } from "../../src/features/logo-vector/server/revisions";
import { serializeLogoSvg } from "../../src/features/logo-vector/model/svg";
import { renderProposedVariantPreview, validateVariantReview } from "../../src/features/identity-deliverables/model/variants";
import { framedLogoDocument, logoPixelDimensions } from "../../src/features/identity-deliverables/server/render-policy";
import { verifyLogoFiles } from "../../src/features/identity-deliverables/server/verify-output";
import { inspectLogoExportArchive } from "../../src/features/identity-deliverables/server/validate-assets";
import { publicLogoExportManifestSchema } from "../../src/features/identity-deliverables/server/public-manifest";
import type { ExportPublicationDetails } from "../../src/features/identity-deliverables/server/export-types";
import { createLogoExportsHandler, LOGO_EXPORT_POLICY_IDENTITY, LOGO_EXPORT_HANDLER_VERSION } from "../../worker/handlers/logo-exports";
import { createLogoExportsRuntimeAdapter } from "../../worker/logo-exports/runtime-adapter";
import { approvedExportFixture, at, hashBytes, id } from "../features/identity-deliverables/fixtures";
import { publicationFixture } from "../features/identity-deliverables/publication-fixture";

const signal = () => new AbortController().signal;
/** Actual owned-byte verification, renderer, verifier and export publisher.
 * Only frozen metadata and immutable private storage are local test adapters. */
async function fixture() {
  const snapshot = await approvedExportFixture(), sources = new Map<string, VerifiedAssetBytes>();
  function file(reference: VerifiedAssetBytes["reference"], bytes: Uint8Array, mimeType: string) {
    sources.set(reference.versionId, { reference, mimeType, bytes: Uint8Array.from(bytes), verification: {
      status: "verified", checkedAt: at, contentHash: hashBytes(bytes), mimeType, byteLength: bytes.length,
    } });
  }
  snapshot.logo.proof.validator = { id: "fluid.logo-vector", version: "1" };
  snapshot.logo.proof.pathCount = snapshot.logoDocument.components.reduce((n, c) => n + c.paths.length, 0);
  file(snapshot.logo.documentAsset, canonicalLogoDocumentBytes(snapshot.logoDocument), "application/json");
  file(snapshot.logo.svgAsset, serializeLogoSvg(snapshot.logoDocument), "image/svg+xml");
  for (const { variant, document } of snapshot.resolvedVariants.items) {
    file(variant.documentAsset!, canonicalLogoDocumentBytes(document!), "application/json");
    const preview = await renderProposedVariantPreview({ key: `${variant.role}:${variant.colorway}`, role: variant.role, colorway: variant.colorway,
      clearSpace: variant.clearSpace, minimumDigitalSize: variant.minimumDigitalSize, applicability: { status: "applicable" }, document: document! }, signal());
    variant.preview!.reference.contentHash = hashBytes(preview!.png); variant.preview!.verification.contentHash = variant.preview!.reference.contentHash;
    variant.preview!.verification.byteLength = preview!.png.length; file(variant.preview!.reference, preview!.png, "image/png");
  }
  snapshot.variants.items = snapshot.resolvedVariants.items.map(i => i.variant);
  const { logoDocument: _document, resolvedVariants: _resolved, ...frozen } = snapshot; void _document; void _resolved;
  const p = publicationFixture(snapshot), job = p.job, events: string[] = [];
  const state = { leased: true, available: true, ready: true as unknown, unknownStage: false,
    afterRead: undefined as undefined | (() => void), afterWrite: undefined as undefined | (() => void),
    beforeLoad: undefined as undefined | (() => Promise<void>), details: undefined as ExportPublicationDetails | undefined };
  function lease(current: ClaimedJob) { if (!state.leased || current.id !== job.id || current.leaseToken !== job.leaseToken || current.ownerId !== snapshot.ownerId || current.projectId !== snapshot.projectId) throw Error("Synthetic lease rejected"); }
  const sourceAssets = createIdentityAssetStore({ backend: {
    async prepare() { throw Error("Read-only source fixture"); }, async observe() { throw Error("Read-only source fixture"); },
    async resolve(access, reference): Promise<IdentityAssetReservation> {
      if (access.kind !== "leased") throw Error("No owned source access"); lease(access.job);
      const source = sources.get(reference.versionId); if (!source) throw Error("Missing source");
      return { id: source.reference.assetId, requestKey: source.reference.assetId, reference: source.reference,
        storagePath: `${source.reference.ownerId}/${source.reference.projectId}/${source.reference.assetId}/${source.reference.versionId}`,
        mimeType: source.mimeType, byteLength: source.bytes.length, purpose: "brand_asset", sourceReceiptId: snapshot.logoApproval.id,
        rightsEvidenceId: null, publicationState: "committed" };
    },
  }, storage: {
    async putIfAbsent() { throw Error("Immutable source fixture"); },
    async read(path) { events.push("source-read"); const source = [...sources.values()].find(s => path.endsWith(`/${s.reference.assetId}/${s.reference.versionId}`));
      if (!source) throw Error("Missing bytes"); const result = { bytes: Uint8Array.from(source.bytes), mimeType: source.mimeType }; state.afterRead?.(); return result; },
  } });
  const assets: IdentityAssetStore = { ...p.dependencies.assets,
    async readLeasedAsset(current, reference, abort) { lease(current); return sources.has(reference.versionId)
      ? sourceAssets.readLeasedAsset(current, reference, abort) : p.dependencies.assets.readLeasedAsset(current, reference, abort); },
    async publishLeasedAsset(current, publication, bytes, abort) { lease(current); events.push("publish");
      const receipt = await p.dependencies.assets.publishLeasedAsset(current, publication, bytes, abort); state.afterWrite?.(); return receipt; },
  };
  const connection: LogoWorkerConnection = { async query<Row>(sql: string, parameters: unknown[] = []) {
    events.push(sql); lease({ ...job, id: parameters[0] as string, leaseToken: parameters[1] as string }); let value: unknown;
    if (sql.includes("load_logo_export_inputs")) { await state.beforeLoad?.(); value = frozen; }
    else if (sql.includes("stage_logo_exports")) {
      const body = JSON.parse(parameters[2] as string); state.details = body;
      if (state.unknownStage) throw Error("Synthetic stage acknowledgement lost");
      value = { id: id(750), ownerId: job.ownerId, projectId: job.projectId, jobId: job.id,
        sourceSnapshotHash: snapshot.sourceSnapshotHash, assetReceiptIds: body.assetReceiptIds, publicationState: "staged" };
    } else if (parameters[2] === "runtime_readiness") value = state.ready;
    else throw Error("Unexpected synthetic SQL");
    return { rows: [{ value }] as Row[] };
  } };
  const options = { ownerId: snapshot.ownerId, connection, assets,
    async assertAvailable(current: ClaimedJob) { events.push("availability"); lease(current); if (!state.available) throw Error("Synthetic export storage unavailable"); } };
  const adapter = createLogoExportsRuntimeAdapter(options)!;
  return { p, snapshot, frozen, sources, job, state, events, options, adapter };
}

describe("injected non-generative export runtime adapter", () => {
  it("requires explicit dependencies and pins the qualified zero-cost policy without I/O", async () => {
    const f = await fixture(); expect(f.events).toEqual([]); expect(f.adapter).not.toBeNull();
    expect(createLogoExportsRuntimeAdapter(null)).toBeNull();
    for (const missing of ["connection", "assets", "assertAvailable"] as const) expect(createLogoExportsRuntimeAdapter({ ...f.options, [missing]: null })).toBeNull();
    expect(createLogoExportsRuntimeAdapter({ ...f.options, ownerId: "invalid" })).toBeNull();
    expect(f.adapter.capability).toEqual({ operation: "identity.logo_export", policyIdentity: LOGO_EXPORT_POLICY_IDENTITY,
      handlerVersion: LOGO_EXPORT_HANDLER_VERSION, provider: null, model: null, engine: null, maxCostMicrousd: 0 });
    expect(Object.isFrozen(f.adapter.dependencies.publication)).toBe(true);
  });
  it("rejects owner, project, operation, policy, handler, cost and cancellation mismatches before reads", async () => {
    const f = await fixture();
    const invalid = [ { ownerId: id(999) }, { projectId: id(999) }, { operation: "strategy" }, { reservedCostMicrousd: 1 }, { actualCostMicrousd: 1 },
      { status: "cancel_requested" }, { leaseToken: "invalid" }, { input: { ...f.job.input as object, policyIdentity: "f".repeat(64) } }, { input: { ...f.job.input as object, handlerVersion: "wrong" } } ];
    for (const delta of invalid) await expect(f.adapter.dependencies.loadInput({ ...f.job, ...delta } as ClaimedJob)).rejects.toThrow();
    expect(f.events).toEqual([]); expect(f.p.storage.size).toBe(0);
  });
  it("loads only the verified frozen approved version and rejects metadata, bytes or lease drift", async () => {
    const f = await fixture(), source = await f.adapter.dependencies.loadInput(f.job);
    expect(source).toEqual(f.snapshot);
    expect(() => { source.logoDocument.components[0]!.paths[0]!.d = "M 0 0 Z"; }).toThrow();
    expect(f.sources.get(f.snapshot.logo.documentAsset.versionId)!.bytes).toEqual(canonicalLogoDocumentBytes(f.snapshot.logoDocument));
    const altered = { ...f.job, input: { ...f.job.input as object, approvedLogoId: id(999) } };
    await expect(f.adapter.dependencies.loadInput(altered)).rejects.toThrow();
    f.sources.get(f.snapshot.logo.documentAsset.versionId)!.bytes[0] = 0;
    await expect(f.adapter.dependencies.loadInput(f.job)).rejects.toThrow();
    f.state.leased = false; await expect(f.adapter.dependencies.loadInput(f.job)).rejects.toThrow(); expect(f.p.storage.size).toBe(0);
  });
  it("requires exact leased readiness and a separately available runtime", async () => {
    const f = await fixture(); await f.adapter.dependencies.assertReady(f.job);
    f.state.available = false; await expect(f.adapter.dependencies.assertReady(f.job)).rejects.toThrow(); f.state.available = true;
    for (const ready of [false, null, "true", {}]) { f.state.ready = ready; await expect(f.adapter.dependencies.assertReady(f.job)).rejects.toThrow(); }
    expect(f.p.storage.size).toBe(0);
  });
  it("produces independently verified path SVG, vector PDF and transparent PNG from the approved synthetic version", async () => {
    const f = await fixture(), originalSources = [...f.sources.values()].map(s => hashBytes(s.bytes)), originalApproval = structuredClone(f.snapshot.logoApproval);
    const outcome = await createLogoExportsHandler(f.adapter.dependencies).steps(f.job)[0]!.execute({ job: f.job, signal: signal() });
    expect(outcome).toMatchObject({ status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { kind: "logo_export", publicationId: id(750) } });
    const details = f.state.details!; expect(details.completeness).toBe("complete"); expect(details.files).toHaveLength(11);
    const bytes = (name: string) => { const descriptor = details.files.find(file => file.name === name)!;
      return [...f.p.storage.values()].find(file => hashBytes(file.bytes) === descriptor.contentHash)!.bytes; };
    for (const source of validateVariantReview(f.snapshot.resolvedVariants, f.snapshot.variantReview)) {
      const name = `${source.variant.role}-${source.variant.colorway}-${source.variant.id}`;
      const dimensions = logoPixelDimensions(framedLogoDocument(source.document, source.variant.clearSpace), f.snapshot.pngLongEdge);
      const evidence = await verifyLogoFiles({ svg: bytes(`${name}.svg`), pdf: bytes(`${name}.pdf`), png: bytes(`${name}.png`), ...dimensions, variantHash: source.variant.renderHash! }, source, { pngLongEdge: f.snapshot.pngLongEdge });
      expect(evidence.svg.pathCount).toBeGreaterThan(0); expect(evidence.svg.rasterReferenceCount).toBe(0);
      expect(evidence.pdf.pathPaintCount).toBeGreaterThan(0); expect(evidence.pdf.rasterPaintCount).toBe(0);
      expect(evidence.png).toMatchObject({ hasAlpha: true, hasTransparentPixels: true, hasVisiblePixels: true });
    }
    const archive = inspectLogoExportArchive(bytes(`logo-pack-${f.snapshot.logoApproval.id}.zip`));
    const manifest = publicLogoExportManifestSchema.parse(JSON.parse(new TextDecoder().decode(archive["manifest.json"])));
    expect(manifest.approvedLogoId).toBe(f.snapshot.logoApproval.id); expect(manifest.sourceSnapshotHash).toBe(f.snapshot.sourceSnapshotHash);
    expect(manifest.licenseOmissions[0]!.fontVersionId).toBe(f.snapshot.fonts[0]!.id);
    expect(Object.keys(archive).some(name => /\.(ttf|otf|woff2?)$/i.test(name))).toBe(false);
    expect(manifest.files.some(file => ["avatar", "banner"].includes(file.role))).toBe(false);
    expect([...f.sources.values()].map(s => hashBytes(s.bytes))).toEqual(originalSources); expect(f.snapshot.logoApproval).toEqual(originalApproval);
    expect(f.events.join(" ")).not.toMatch(/accept_logo|restore_logo|apply_logo/);
  }, 30_000);
  it("blocks all publication when cancellation occurs during the legacy unsignalled source read", async () => {
    const f = await fixture(), controller = new AbortController(); f.state.afterRead = () => controller.abort();
    expect(await createLogoExportsHandler(f.adapter.dependencies).steps(f.job)[0]!.execute({ job: f.job, signal: controller.signal }))
      .toMatchObject({ status: "failed", code: "export_cancelled", costMicrousd: 0 });
    expect(f.p.storage.size).toBe(0); expect(f.state.details).toBeUndefined();
  });
  it("retains partial staged files and reconciliation if cancellation occurs during publication", async () => {
    const f = await fixture(), controller = new AbortController(); f.state.afterWrite = () => controller.abort();
    expect(await createLogoExportsHandler(f.adapter.dependencies).steps(f.job)[0]!.execute({ job: f.job, signal: controller.signal }))
      .toMatchObject({ status: "needs_reconciliation", code: "export_publication_unknown" });
    expect(f.p.storage.size).toBe(1); expect(f.state.details).toBeUndefined();
  }, 30_000);
  it("retains an ambiguous stage acknowledgement without retries, new versions or approval changes", async () => {
    const f = await fixture(); f.state.unknownStage = true;
    expect(await createLogoExportsHandler(f.adapter.dependencies).steps(f.job)[0]!.execute({ job: f.job, signal: signal() }))
      .toMatchObject({ status: "needs_reconciliation", code: "export_publication_unknown", costMicrousd: 0 });
    expect(f.p.storage.size).toBe(11); expect(f.events.filter(e => e.includes("stage_logo_exports"))).toHaveLength(1);
    expect(f.snapshot.logo.reviewStatus).toBe("review_required");
  }, 30_000);
});
