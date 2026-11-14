import { identitySystemVersionSchema, type IdentitySystemVersion } from "@/domain/project-identity";
import { identityLogoSourceSchema, type IdentityLogoSource } from "@/domain/identity-logo-source";
import { brandBoardApplicationDesignSchema, type BrandBoardApplicationDesign } from "@/domain/brand-board-design";
import { brandBoardFont, supportedBrandBoardTypography } from "@/domain/brand-board-fonts";

export type BrandAssetSystem = IdentitySystemVersion & { applicationDesign?: BrandBoardApplicationDesign };
export class BrandAssetError extends Error {
  constructor(
    readonly reason:
      | "selection"
      | "unsupported"
      | "source"
      | "font"
      | "font_coverage"
      | "unsupported_text"
      | "canvas"
      | "timeout"
      | "size",
  ) {
    super(reason);
  }
}

/** Copy only the selected system's explicit design decisions. Historical boards
 * without a production design remain downloadable as images, not guessed packs. */
export function createBrandAssetSnapshot(input: {
  system: BrandAssetSystem;
  sourceLogo: IdentityLogoSource;
  ownerId: string;
  projectId: string;
}) {
  const system = identitySystemVersionSchema.parse(input.system),
    sourceLogo = identityLogoSourceSchema.parse(input.sourceLogo);
  const designResult = brandBoardApplicationDesignSchema.safeParse(system.applicationDesign);
  if (!designResult.success) throw new BrandAssetError("unsupported");
  const design = designResult.data;
  if (
    system.ownerId !== input.ownerId ||
    system.projectId !== input.projectId ||
    sourceLogo.preview.reference.ownerId !== input.ownerId ||
    sourceLogo.preview.reference.projectId !== input.projectId ||
    system.source.kind !== "generated" ||
    system.board.staleComponents.length ||
    system.board.depictsSystemVersionId !== system.id ||
    (system.input.version === 2 && JSON.stringify(system.input.logoBrief) !== JSON.stringify(sourceLogo.brief))
  )
    throw new BrandAssetError("selection");
  const colors = system.components.colors.swatches;
  const role = (key: string) => {
    const color = colors.find((item) => item.key === key);
    if (!color) throw new BrandAssetError("unsupported");
    return color.hex;
  };
  const typography = system.components.typography.styles;
  if (typography.some((style) => !supportedBrandBoardTypography(style))) throw new BrandAssetError("font");
  const style = (key: string) => {
    const value = typography.find((item) => item.key === key);
    if (!value) throw new BrandAssetError("unsupported");
    return { ...value, font: brandBoardFont(value.family)! };
  };
  return {
    version: 1 as const,
    systemId: system.id,
    ownerId: input.ownerId,
    projectId: input.projectId,
    name: system.input.basis.name,
    design,
    colors,
    colorNotes: system.components.colors.usageNotes,
    typography,
    typeNotes: system.components.typography.usageNotes,
    graphicNotes: system.components.graphics.direction,
    imageryNotes: system.components.imagery.direction,
    compositionNotes: system.components.composition.direction,
    palette: {
      primary: role(design.paletteRoles.primary),
      accent: role(design.paletteRoles.accent),
      background: role(design.paletteRoles.background),
      text: role(design.paletteRoles.text),
    },
    heading: style(design.headingStyleKey),
    body: style(design.bodyStyleKey),
    logo: sourceLogo.preview,
    board: system.board.asset,
    sourceLogoSelection: sourceLogo.source,
    sourceLogoRevision: sourceLogo.selectionRevision,
    sourceBriefRevisionId: sourceLogo.brief.id,
  };
}
export type BrandAssetSnapshot = ReturnType<typeof createBrandAssetSnapshot>;
export function brandAssetSlug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64)
      .replace(/-$/, "") || "brand"
  );
}
