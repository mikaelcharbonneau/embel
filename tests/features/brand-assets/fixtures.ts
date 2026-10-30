import { createHash } from "node:crypto";
import { fixtureInput, fixtureSystem, fixtureOwner, fixtureProject, fixtureId } from "../../client/project-identity-fixtures";
import { syntheticResolvedLogoConcept } from "../../fixtures/logo-creation";
import { identityLogoSourceSchema } from "../../../src/domain/identity-logo-source";
import { createBrandAssetSnapshot, type BrandAssetSystem } from "../../../src/features/brand-assets/model/snapshot";
import type { BrandBoardApplicationDesign } from "../../../src/domain/brand-board-design";

export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const logoBytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", "base64"));
export const boardBytes = Uint8Array.from(logoBytes);
export const account = { status: "ready" as const, userId: fixtureOwner, generation: 1 };
export const projectId = fixtureProject;
export function brandAssetFixture(design: Partial<BrandBoardApplicationDesign> = {}, name = "Northline") {
  const original = fixtureSystem(fixtureInput({ name }));
  const system: BrandAssetSystem = { ...original, board: { ...original.board, asset: { ...original.board.asset, contentHash: hash(boardBytes) } }, productionFiles: [],
    components: { ...original.components, colors: { swatches: [
      { key: "primary", name: "Forest", hex: "#25463D" }, { key: "accent", name: "Citrine", hex: "#DEDB62" },
      { key: "paper", name: "Parchment", hex: "#F3EFE5" }, { key: "ink", name: "Ink", hex: "#182A24" },
    ], usageNotes: "Parchment surfaces with Forest and Citrine accents." }, typography: { styles: [
      { key: "heading", role: "Headings", family: "Fraunces", weight: 600, style: "normal" },
      { key: "body", role: "Body", family: "Manrope", weight: 400, style: "normal" },
    ], usageNotes: "Expressive headings paired with clear body text." } },
    applicationDesign: { version: 1, graphic: "rounded_shapes", layout: "editorial", paletteRoles: { primary: "primary", accent: "accent", background: "paper", text: "ink" }, headingStyleKey: "heading", bodyStyleKey: "body", ...design },
  };
  const originalLogo = syntheticResolvedLogoConcept();
  const sourceLogo = identityLogoSourceSchema.parse({ version: 1, selectionRevision: 1, logoType: "combination", source: { kind: "concept", batchId: fixtureId(800), slotId: fixtureId(801), attemptId: fixtureId(802) },
    brief: { ...originalLogo.brief, ownerId: fixtureOwner, projectId: fixtureProject, payload: { ...originalLogo.brief.payload, name } },
    preview: { id: fixtureId(803), reference: { ownerId: fixtureOwner, projectId: fixtureProject, assetId: fixtureId(804), versionId: fixtureId(805), contentHash: hash(logoBytes) },
      verification: { status: "verified", contentHash: hash(logoBytes), mimeType: "image/png", byteLength: logoBytes.length, checkedAt: "2026-10-30T00:00:00Z" }, purpose: "brand_asset", sourceReceiptId: fixtureId(806), rightsEvidenceId: null, publicationState: "committed" },
  });
  const snapshot = createBrandAssetSnapshot({ system, sourceLogo, ownerId: fixtureOwner, projectId: fixtureProject });
  return { system, sourceLogo, snapshot, account, projectId };
}
