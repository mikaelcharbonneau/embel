import { createHash } from "node:crypto";
import type {
  ApprovedLogoIdentitySnapshot,
  LogoVariant,
  LogoVariantReview,
  ResolvedLogoVariantSet,
} from "../../../src/domain/logo-deliverables";
import type { LogoType, LogoVectorDocument } from "../../../src/domain/logo-vector";
import { canonicalLogoDocumentBytes } from "../../../src/features/logo-vector/server/revisions";
import { serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";

/** Original synthetic local test data. Never provider output, hosted storage or an app fallback. */
export const id = (n: number) => `95000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const at = "2026-10-07T00:00:00Z";
export const hashBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const types: LogoType[] = [
  "wordmark",
  "lettermark_monogram",
  "pictorial",
  "abstract",
  "combination",
  "emblem",
  "mascot",
];
export function syntheticDocument(type: LogoType = "combination"): LogoVectorDocument {
  const single = type !== "combination";
  const role = ["wordmark", "lettermark_monogram"].includes(type)
    ? "lettering"
    : ["emblem", "mascot"].includes(type)
      ? "whole_artwork"
      : "symbol";
  return {
    version: 1,
    viewBox: [0, 0, 200, 100],
    components: [
      {
        id: "synthetic-art",
        role,
        editingKind: role === "lettering" ? "outlined_custom" : "geometry",
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        paths: [
          {
            id: "synthetic-hole",
            d: "M 20 20 L 80 20 L 80 80 L 20 80 Z M 35 35 L 65 35 L 65 65 L 35 65 Z",
            fillRule: "evenodd",
            fill: { color: "#DB2777", opacity: 1 },
            stroke: null,
          },
        ],
      },
      ...(single
        ? []
        : [
            {
              id: "synthetic-letters",
              role: "lettering" as const,
              editingKind: "outlined_custom" as const,
              transform: { x: 0, y: 0, scale: 1, rotation: 0 },
              paths: [
                {
                  id: "synthetic-bars",
                  d: "M 100 30 L 180 30 L 180 40 L 100 40 Z M 100 60 L 170 60 L 170 70 L 100 70 Z",
                  fillRule: "nonzero" as const,
                  fill: { color: "#111827", opacity: 1 },
                  stroke: null,
                },
              ],
            },
          ]),
    ],
  };
}
export function deliverableFixture(type: LogoType = "combination"): ApprovedLogoIdentitySnapshot {
  const scope = { ownerId: id(1), projectId: id(2) },
    logoDocument = syntheticDocument(type);
  const documentHash = hashBytes(canonicalLogoDocumentBytes(logoDocument));
  const reference = (n: number, contentHash = "a".repeat(64)) => ({
    ...scope,
    assetId: id(n),
    versionId: id(n + 1),
    contentHash,
  });
  const basis = { ...scope, approvedLogoId: id(7), inputRevisions: [] };
  return {
    ...scope,
    brandName: "Synthetic brand",
    heads: {
      projectRevision: 1,
      referenceRevision: 0,
      preferencesRevision: 0,
      workspaceRevision: 1,
      stageRevisions: { brief_references: 1, concepts: 1, vector: 1, refinements: 0, directions: 1, deliverables: 0 },
    },
    logoDocument,
    logo: {
      id: id(6),
      ...scope,
      parentRevisionId: null,
      source: { kind: "refinement", rasterRevisionId: id(20) },
      sourcePreview: reference(21),
      documentAsset: reference(23, documentHash),
      svgAsset: reference(25, hashBytes(serializeLogoSvg(logoDocument))),
      documentHash,
      proof: {
        version: 1,
        svgContentHash: hashBytes(serializeLogoSvg(logoDocument)),
        documentHash,
        validator: { id: "synthetic-validator", version: "1" },
        viewBox: logoDocument.viewBox,
        pathCount: logoDocument.components.length,
        componentCount: logoDocument.components.length,
        externalFontDependencies: [],
      },
      locks: [],
      inputRevisions: [],
      reviewStatus: "review_required",
      createdAt: at,
    },
    logoApproval: { id: id(7), ...scope, vectorRevisionId: id(6), stageRevisionId: id(8), approvedAt: at },
    directionSelection: {
      id: id(9),
      ...basis,
      paletteVersionId: id(11),
      typographyVersionId: id(12),
      graphicsVersionId: id(13),
      sourceDirectionIds: [id(14)],
      consistency: { status: "pass", hash: "c".repeat(64), checks: [], warnings: [], blockingReasons: [] },
    },
    directionApproval: {
      id: id(10),
      ...scope,
      directionSelectionId: id(9),
      approvedLogoId: id(7),
      consistencyHash: "c".repeat(64),
      approvedAt: at,
    },
    palette: {
      id: id(11),
      ...basis,
      swatches: [
        {
          key: "accent",
          name: "Synthetic magenta",
          color: {
            hex: "#DB2777",
            rgb: [219, 39, 119],
            cmyk: { status: "unavailable", reason: "profile_unavailable" },
            pantone: { status: "unavailable", reason: "licensed_source_unavailable" },
          },
        },
      ],
      pairings: [],
    },
    typography: {
      id: id(12),
      ...basis,
      styles: [
        {
          key: "body",
          role: "body",
          sampleText: "Synthetic brand",
          fontVersionId: id(15),
          weight: 400,
          style: "normal",
          sizePx: 16,
          lineHeight: 1.5,
        },
      ],
    },
    graphics: { id: id(13), ...basis, elements: [] },
    fonts: [
      {
        id: id(15),
        asset: reference(30),
        family: "Synthetic test family",
        source: "free_catalog",
        rights: {
          id: id(16),
          fontContentHash: "a".repeat(64),
          sourceKind: "reviewed_license",
          sourceUrl: "https://example.com/synthetic-license",
          licenseTextHash: "b".repeat(64),
          permissions: {
            render: "allowed",
            outline: "allowed",
            embed: "denied",
            modify: "denied",
            redistribute: "denied",
          },
          commercialUse: "allowed",
          reviewedAt: at,
        },
      },
    ],
  };
}
/** Synthetic committed records only. The production server must actually stage/read back bytes. */
export function resolvedFixture(
  doc: LogoVectorDocument,
  hashFor: (
    variant: Pick<LogoVariant, "role" | "colorway" | "clearSpace" | "minimumDigitalSize">,
    document: LogoVectorDocument,
  ) => string,
): { resolved: ResolvedLogoVariantSet; review: LogoVariantReview } {
  const scope = { ownerId: id(1), projectId: id(2) };
  const items = (["black", "white", "color"] as const).map((colorway, index) => {
    const document = structuredClone(doc);
    if (colorway !== "color")
      for (const component of document.components)
        for (const path of component.paths) {
          if (path.fill) path.fill.color = colorway === "black" ? "#000000" : "#FFFFFF";
          if (path.stroke) path.stroke.color = colorway === "black" ? "#000000" : "#FFFFFF";
        }
    const docHash = hashBytes(canonicalLogoDocumentBytes(document)),
      n = 100 + index * 10;
    const variant: LogoVariant = {
      id: id(n),
      role: "primary",
      colorway,
      clearSpace: 10,
      minimumDigitalSize: null,
      applicability: { status: "applicable" },
      reviewStatus: "review_required",
      documentAsset: { ...scope, assetId: id(n + 1), versionId: id(n + 2), contentHash: docHash },
      renderHash: null,
      preview: {
        id: id(n + 3),
        reference: { ...scope, assetId: id(n + 4), versionId: id(n + 5), contentHash: "e".repeat(64) },
        verification: {
          status: "verified",
          checkedAt: at,
          contentHash: "e".repeat(64),
          mimeType: "image/png",
          byteLength: 100,
        },
        purpose: "brand_asset",
        sourceReceiptId: id(n + 6),
        rightsEvidenceId: null,
        publicationState: "committed",
      },
    };
    variant.renderHash = hashFor(variant, document);
    return { variant, document };
  });
  const set = {
    id: id(200),
    ...scope,
    approvedLogoId: id(7),
    directionApprovalId: id(10),
    items: items.map((i) => i.variant),
    createdAt: at,
  };
  return {
    resolved: { set, items },
    review: {
      id: id(201),
      ...scope,
      variantSetId: set.id,
      approvedLogoId: set.approvedLogoId,
      directionApprovalId: set.directionApprovalId,
      acceptedVariants: items.map((i) => ({ variantId: i.variant.id, renderHash: i.variant.renderHash! })),
      reviewedAt: at,
    },
  };
}

export async function approvedExportFixture() {
  const { computeLogoVariantRenderHash } =
    await import("../../../src/features/identity-deliverables/server/render-policy");
  const snapshot = deliverableFixture(),
    { resolved, review } = resolvedFixture(snapshot.logoDocument, computeLogoVariantRenderHash);
  return {
    ...snapshot,
    inputRevisions: [{ stage: "vector" as const, id: snapshot.logoApproval.stageRevisionId, revision: 1 }],
    variants: resolved.set,
    resolvedVariants: resolved,
    variantReview: review,
    pngLongEdge: 512 as const,
    socialSelections: [] as { kind: "avatar" | "banner"; presetId: string }[],
    sourceSnapshotHash: "d".repeat(64),
  };
}
