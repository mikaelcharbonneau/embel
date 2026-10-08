import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoVectorMutationProducers, type LogoVectorMutationDependencies } from "../../../src/features/logo-vector/server/mutations";
import { canonicalLogoDocumentBytes, verifyLogoVectorRevision } from "../../../src/features/logo-vector/server/revisions";
import { serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";
import type { IdentityAssetPublication, IdentityAssetReceipt, LogoVectorDetail, VerifiedAssetBytes } from "../../../src/domain/logo-deliverables";
import type { LogoExpectedHeads, LogoManualCommand, LogoWorkspaceV2 } from "../../../src/domain/logo-workspace";
import type { IdentityAssetStore } from "../../../src/server/data/identity-asset-store";
import { textEditFixture } from "./text-edit-fixtures";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const f = await textEditFixture(), records = new Map<string, VerifiedAssetBytes>();
  for (const [reference, bytes, mimeType] of [[f.revision.documentAsset, canonicalLogoDocumentBytes(f.document), "application/json"], [f.revision.svgAsset, serializeLogoSvg(f.document), "image/svg+xml"]] as const) records.set(reference.versionId, { reference, bytes: Uint8Array.from(bytes), mimeType, verification: { status: "verified", contentHash: reference.contentHash, mimeType, byteLength: bytes.length, checkedAt: "2026-10-07T00:00:00Z" } });
  records.set(f.raster.reference.versionId, f.raster);
  const publications: { publication: IdentityAssetPublication; bytes: Uint8Array; receipt: IdentityAssetReceipt }[] = [];
  const detail: LogoVectorDetail = { revision: f.revision, document: f.document, sourcePreview: f.refinement.preview! };
  const expected: LogoExpectedHeads = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 1, stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
  const workspace: LogoWorkspaceV2 = { version: 2, ownerId: f.revision.ownerId, projectId: f.projectId, heads: expected, stages: { brief_references: { stage: "brief_references", id: f.brief.id, revision: 1 }, concepts: null, vector: null, refinements: null, directions: null, deliverables: null }, approvedLogo: null, staleStages: [], capabilities: Object.fromEntries(["save", "upload", "generate", "convert", "export"].map(key => [key, { status: "available" }])) as LogoWorkspaceV2["capabilities"] };
  const deps: LogoVectorMutationDependencies = { assetStore: {
    async readOwnedAsset(_auth, ref) { const file = records.get(ref.versionId); if (!file) throw Error("Missing synthetic asset"); return file; },
    async stageOwnedAsset(_auth, _projectId, publication, bytes) {
      const prior = publications.find(item => item.publication.requestKey === publication.requestKey);
      if (prior) { expect(prior.publication).toEqual(publication); expect(prior.bytes).toEqual(bytes); return prior.receipt; }
      expect(publication.contentHash).toBe(hash(bytes));
      const receipt: IdentityAssetReceipt = { id: randomUUID(), reference: { ownerId: f.revision.ownerId, projectId: f.projectId, assetId: randomUUID(), versionId: randomUUID(), contentHash: publication.contentHash }, verification: { status: "verified", contentHash: publication.contentHash, mimeType: publication.mimeType, byteLength: bytes.length, checkedAt: "2026-10-07T00:00:00Z" }, purpose: "brand_asset", sourceReceiptId: publication.source.sourceId, rightsEvidenceId: null, publicationState: "staged" };
      publications.push({ publication, bytes: Uint8Array.from(bytes), receipt }); return receipt;
    },
  } as IdentityAssetStore, async readVectorDetail() { return detail; }, async getWorkspace() { return workspace; }, async readCurrentVectorRevisionId() { return f.revision.id; }, async readStageRevision() { return f.brief; }, textEdits: f.deps };
  const command: LogoManualCommand = { method: "saveLogoEdit", body: { requestKey: randomUUID(), expected: structuredClone(expected), baseVectorRevisionId: f.revision.id, edit: { kind: "replace_outlined_lettering", componentId: "synthetic-lettering", text: f.brief.payload.name, fontVersionId: f.input.font.record.id } } };
  const save = () => createLogoVectorMutationProducers(deps).saveLogoEdit!(f.auth, f.projectId, command);
  return { ...f, deps, records, publications, workspace, command, save };
}

describe("text edits through immutable asset publication", () => {
  it("publishes actual canonical editable source and portable outlined SVG without changing approval", async () => {
    const f = await fixture(), evidence = await f.save();
    expect(f.publications).toHaveLength(2);
    const document = f.publications.find(item => item.publication.mimeType === "application/json")!, svg = f.publications.find(item => item.publication.mimeType === "image/svg+xml")!;
    const decoded = JSON.parse(new TextDecoder().decode(document.bytes));
    expect(decoded.components[1]).toMatchObject({ editingKind: "editable_text", textSource: { text: f.brief.payload.name, font: f.input.source.font } });
    expect(new TextDecoder().decode(svg.bytes)).toContain("<path"); expect(new TextDecoder().decode(svg.bytes)).not.toMatch(/<(text|image)\b/);
    expect(evidence).toMatchObject({ baseVectorRevisionId: f.revision.id, documentPublicationId: document.receipt.id, svgPublicationId: svg.receipt.id, documentHash: hash(document.bytes), proof: { svgContentHash: hash(svg.bytes) }, locks: [] });
    expect(evidence).not.toHaveProperty("approvalId"); expect(f.workspace.approvedLogo).toBeNull();
    const checked = await verifyLogoVectorRevision({ revision: { ...f.revision, id: randomUUID(), parentRevisionId: f.revision.id, documentAsset: document.receipt.reference, svgAsset: svg.receipt.reference, documentHash: hash(document.bytes), proof: (evidence as { proof: typeof f.revision.proof }).proof }, document: { reference: document.receipt.reference, bytes: Uint8Array.from(document.bytes), verification: document.receipt.verification, mimeType: document.publication.mimeType }, svg: { reference: svg.receipt.reference, bytes: Uint8Array.from(svg.bytes), verification: svg.receipt.verification, mimeType: svg.publication.mimeType } });
    expect(checked).toEqual(decoded); expect(f.document.components[1]).not.toHaveProperty("textSource");
  });
  it("uses the original deterministic publication keys on an unchanged request", async () => {
    const f = await fixture(), first = await f.save(); expect(await f.save()).toEqual(first); expect(f.publications).toHaveLength(2);
  });
  it.each(["workspace", "base"])("rejects a stale %s before publishing text assets", async failure => {
    const f = await fixture();
    if (failure === "workspace") f.workspace.heads.workspaceRevision++;
    else f.deps.readCurrentVectorRevisionId = async () => randomUUID();
    await expect(f.save()).rejects.toMatchObject({ code: "conflict" }); expect(f.publications).toHaveLength(0);
  });
  it("keeps text unavailable without explicitly composed owned font/source loaders", async () => {
    const f = await fixture(); delete f.deps.textEdits;
    await expect(f.save()).rejects.toMatchObject({ code: "font_rights_required" }); expect(f.publications).toHaveLength(0);
  });
});
