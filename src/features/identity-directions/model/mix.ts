import { identityDirectionsOverviewSchema, type IdentityConsistencyResult, type IdentityDirectionsOverview } from "@/domain/logo-directions";
import { freezeLogoRecord, sameLogoScope } from "@/domain/logo-vector";
import { evaluateIdentityMix } from "./consistency";

export type DirectionMixPreview = {
  approvedLogoId: string;
  components: { paletteVersionId: string; typographyVersionId: string; graphicsVersionId: string };
  sourceDirectionIds: readonly string[];
  consistency: IdentityConsistencyResult;
  comparisonHash: string;
};
export class DirectionMixError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "logo_approval_required", message: string) {
    super(message); this.name = "DirectionMixError";
  }
}

/** Resolves existing component versions; never creates a saved selection or changes the logo. */
export async function previewIdentityMix(input: { overview: IdentityDirectionsOverview; paletteVersionId: string; typographyVersionId: string; graphicsVersionId: string }): Promise<DirectionMixPreview> {
  const parsed = identityDirectionsOverviewSchema.safeParse(input.overview);
  if (!parsed.success) throw new DirectionMixError("not_found", "These direction components are unavailable.");
  const overview = parsed.data, approvedLogo = overview.currentApprovedLogo;
  if (!approvedLogo) throw new DirectionMixError("logo_approval_required", "Approve a logo before choosing identity directions.");
  if (overview.stale) throw new DirectionMixError("conflict", "These directions need review after the saved inputs changed.");
  const palette = overview.palettes.filter(value => value.id === input.paletteVersionId);
  const typography = overview.typography.filter(value => value.id === input.typographyVersionId);
  const graphics = overview.graphics.filter(value => value.id === input.graphicsVersionId);
  if (palette.length !== 1 || typography.length !== 1 || graphics.length !== 1) throw new DirectionMixError("not_found", "A selected component is unavailable.");
  const components = [palette[0]!, typography[0]!, graphics[0]!];
  if (components.some(value => !sameLogoScope(value, approvedLogo))) throw new DirectionMixError("not_found", "A selected component is unavailable.");
  if (components.some(value => value.approvedLogoId !== approvedLogo.id || JSON.stringify(value.inputRevisions) !== JSON.stringify(components[0]!.inputRevisions))) {
    throw new DirectionMixError("conflict", "The selected components use an earlier logo or different saved inputs.");
  }
  const sourceDirectionIds: string[] = [];
  for (const [field, componentId] of [["paletteVersionId", input.paletteVersionId], ["typographyVersionId", input.typographyVersionId], ["graphicsVersionId", input.graphicsVersionId]] as const) {
    const sources = overview.directions.filter(direction => direction[field] === componentId && direction.approvedLogoId === approvedLogo.id && sameLogoScope(direction, approvedLogo) &&
      JSON.stringify(direction.inputRevisions) === JSON.stringify(components[0]!.inputRevisions));
    if (!sources.length) throw new DirectionMixError("not_found", "The source direction for a selected component is unavailable.");
    const source = [...sources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0]!;
    if (!sourceDirectionIds.includes(source.id)) sourceDirectionIds.push(source.id);
  }
  const consistency = await evaluateIdentityMix({ approvedLogo, palette: palette[0]!, typography: typography[0]!, graphics: graphics[0]!, fonts: overview.fonts, fontChecks: overview.fontChecks });
  return freezeLogoRecord({ approvedLogoId: approvedLogo.id, components: { paletteVersionId: input.paletteVersionId, typographyVersionId: input.typographyVersionId, graphicsVersionId: input.graphicsVersionId },
    sourceDirectionIds, consistency, comparisonHash: consistency.hash });
}
