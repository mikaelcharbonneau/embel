import { createHash } from "node:crypto";
import type { FontRecord } from "../../../src/domain/logo-directions";
import type { LogoBriefRevision } from "../../../src/domain/logo-workspace";
import type { LogoVectorDocument, LogoVectorRevision } from "../../../src/domain/logo-vector";
import { canonicalLogoDocumentBytes } from "../../../src/features/logo-vector/model/canonical";
import { captureLogoComponentLocks } from "../../../src/features/logo-vector/model/locks";
import { serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";
import { separatedLogoDocument } from "./fixtures";

export const proposalId = (n: number) => `76100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const proposalHash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export const proposalHeads = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 1,
  stageRevisions: { brief_references: 1, concepts: 1, vector: 1, refinements: 0, directions: 0, deliverables: 0 } };
/** Synthetic metadata only: no real font bytes, paid output, storage, or shaping claim. */
export function proposalFixture(editable = false) {
  const ownerId = proposalId(1), projectId = proposalId(2);
  const asset = (n: number, contentHash = "a".repeat(64)) => ({ ownerId, projectId, assetId: proposalId(n), versionId: proposalId(n + 1), contentHash });
  const font: FontRecord = { id: proposalId(20), asset: asset(21), family: "Synthetic A", source: "free_catalog",
    rights: { id: proposalId(23), fontContentHash: "a".repeat(64), sourceKind: "reviewed_license", sourceUrl: "https://example.com/license", licenseTextHash: "b".repeat(64), commercialUse: "allowed", permissions: { render: "allowed", outline: "allowed", embed: "denied", modify: "denied", redistribute: "denied" }, reviewedAt: "2026-10-08T00:00:00Z" } };
  const alternative: FontRecord = { ...structuredClone(font), id: proposalId(30), family: "Synthetic B", asset: asset(31, "c".repeat(64)), rights: { ...structuredClone(font.rights), id: proposalId(33), fontContentHash: "c".repeat(64) } };
  const document: LogoVectorDocument = separatedLogoDocument();
  document.viewBox = [0, 0, 1000, 500];
  if (editable) document.components[1] = { ...document.components[1]!, editingKind: "editable_text", textSource: {
    text: "Aster", contentKind: "brand_name", font: { ...font.asset }, rightsEvidenceId: font.rights.id, faceIndex: 0, size: 40,
    variationAxes: {}, featureTags: {}, language: "en", script: "Latn", direction: "ltr", letterSpacing: 0, lineHeight: 1,
    shapingEngine: { id: "harfbuzzjs", version: "1.6.2" },
  } };
  const brief: LogoBriefRevision = { version: 2, id: proposalId(3), ownerId, projectId, stage: "brief_references", revision: 1, parentRevisionId: null,
    inputRevisions: [], inputHash: "d".repeat(64), createdAt: "2026-10-08T00:00:00Z",
    payload: { name: "Aster", activity: "Synthetic proposal fixture", audience: "", personality: "", logoTypes: ["combination"], referenceSnapshotId: proposalId(4), sourceProjectRevision: 1 } };
  const revision: LogoVectorRevision = { id: proposalId(5), ownerId, projectId, parentRevisionId: null, source: { kind: "refinement", rasterRevisionId: proposalId(6) },
    sourcePreview: asset(7), documentAsset: asset(9), svgAsset: asset(11), documentHash: "a".repeat(64),
    proof: { version: 1, documentHash: "a".repeat(64), svgContentHash: "a".repeat(64), validator: { id: "fluid.logo-vector", version: "1" }, viewBox: document.viewBox, pathCount: 2, componentCount: 2, externalFontDependencies: [] },
    locks: [], inputRevisions: [{ stage: "brief_references", id: brief.id, revision: 1 }], reviewStatus: "review_required", createdAt: "2026-10-08T00:00:00Z" };
  const seal = (lockedIds: string[] = []) => {
    const hash = proposalHash(canonicalLogoDocumentBytes(document)), svgHash = proposalHash(serializeLogoSvg(document));
    revision.documentHash = revision.documentAsset.contentHash = revision.proof.documentHash = hash;
    revision.svgAsset.contentHash = revision.proof.svgContentHash = svgHash;
    revision.proof.viewBox = [...document.viewBox]; revision.proof.pathCount = document.components.reduce((n, c) => n + c.paths.length, 0); revision.proof.componentCount = document.components.length;
    revision.locks = structuredClone([...captureLogoComponentLocks(document, lockedIds)]);
  };
  seal();
  return { revision, document, brief, fonts: [font, alternative], targetComponentIds: document.components.map(c => c.id), seal };
}
export const proposed = (edit: unknown) => ({ version: 1, status: "proposed", edit, explanation: "One bounded synthetic edit." });
