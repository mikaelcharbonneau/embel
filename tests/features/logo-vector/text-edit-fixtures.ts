import { randomUUID } from "node:crypto";
import { applyLogoTextEdit, type LogoTextEditDependencies } from "../../../src/features/logo-vector/server/text-edits";
import { shapeLogoText } from "../../../src/features/logo-vector/server/text";
import { validateLogoVectorCandidate } from "../../../src/features/logo-vector/server/revisions";
import type { LogoManualEdit, LogoVectorRevision } from "../../../src/domain/logo-vector";
import type { LogoRasterRefinement } from "../../../src/domain/logo-jobs";
import type { LogoBriefRevision } from "../../../src/domain/logo-workspace";
import type { AuthenticatedContext } from "../../../src/server/auth/context";
import { licensedTextInput, textDocument } from "./text-fixtures";
import { syntheticConversionInput } from "./raster-fixtures";
import { separatedLogoDocument } from "./fixtures";

/** Synthetic owned records and raster; shaping uses the pinned, licensed Geist bytes. */
export async function textEditFixture(editable = false) {
  const raster = syntheticConversionInput("combination").source, ownerId = raster.reference.ownerId, projectId = raster.reference.projectId!;
  const input = licensedTextInput("A\u0301ster");
  input.font.record.asset = { ...input.font.record.asset, ownerId, projectId };
  input.source.font = { ...input.font.record.asset };
  const auth = { userId: ownerId } as AuthenticatedContext;
  const document = separatedLogoDocument();
  document.viewBox = [0, 0, 1000, 500];
  if (editable) {
    input.source.size = 40;
    const shaped = await shapeLogoText(input, new AbortController().signal);
    const component = structuredClone(textDocument(shaped.paths, input.source).components[0]!);
    component.transform = { x: 85, y: 130, scale: 1, rotation: 0 };
    document.components[1] = component;
  }
  const original = structuredClone(document);
  const proof = validateLogoVectorCandidate({ base: null, candidate: document, locks: [], expectedSource: raster.reference, source: raster });
  const brief: LogoBriefRevision = { version: 2, id: randomUUID(), ownerId, projectId, stage: "brief_references", revision: 1, parentRevisionId: null, inputRevisions: [], inputHash: "a".repeat(64), createdAt: "2026-10-07T00:00:00Z",
    payload: { name: input.source.text, activity: "Synthetic local text fixture", audience: "", personality: "", logoTypes: ["combination"], referenceSnapshotId: randomUUID(), sourceProjectRevision: 1 } };
  const revision: LogoVectorRevision = { id: randomUUID(), ownerId, projectId, parentRevisionId: null, source: { kind: "refinement", rasterRevisionId: randomUUID() }, sourcePreview: raster.reference,
    documentAsset: { ...raster.reference, assetId: randomUUID(), versionId: randomUUID(), contentHash: proof.documentHash }, svgAsset: { ...raster.reference, assetId: randomUUID(), versionId: randomUUID(), contentHash: proof.proof.svgContentHash },
    documentHash: proof.documentHash, proof: proof.proof, locks: [], inputRevisions: [{ stage: "brief_references", id: brief.id, revision: 1 }], reviewStatus: "review_required", createdAt: "2026-10-07T00:00:00Z" };
  const refinement: LogoRasterRefinement = { version: 2, id: revision.source.kind === "refinement" ? revision.source.rasterRevisionId : "", ownerId, projectId, requestKey: randomUUID(), jobId: randomUUID(), source: { kind: "vector", vectorRevisionId: randomUUID() }, logoType: "combination", state: "succeeded", preview: { id: randomUUID(), reference: { ...raster.reference }, verification: raster.verification, purpose: "brand_asset", sourceReceiptId: randomUUID(), rightsEvidenceId: null, publicationState: "committed" }, providerResponseReceiptId: randomUUID(), billing: { status: "recorded", confirmedMicrousd: 0 }, reason: null, inputRevisions: revision.inputRevisions, createdAt: "2026-10-07T00:00:00Z" };
  const deps: LogoTextEditDependencies = { async readConceptBatch() { throw new Error("No synthetic concept source"); }, async readRasterRefinement() { return refinement; }, async readBriefRevision() { return brief; }, async listFonts() { return [input.font.record]; }, async resolveFont() { return input.font; } };
  const apply = (edit: LogoManualEdit, signal = new AbortController().signal) => applyLogoTextEdit({ auth, projectId, revision, document, edit }, deps, signal);
  const seal = () => { const next = validateLogoVectorCandidate({ base: null, candidate: document, locks: [], expectedSource: raster.reference, source: raster }); revision.documentHash = revision.documentAsset.contentHash = next.documentHash; revision.proof = next.proof; revision.svgAsset.contentHash = next.proof.svgContentHash; };
  return { input, auth, projectId, document, original, revision, brief, refinement, deps, apply, seal, raster };
}

