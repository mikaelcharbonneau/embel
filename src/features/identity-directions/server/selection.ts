import "server-only";
import { selectIdentityDirectionComponentsInputSchema } from "@/domain/logo-workspace";
import type { IdentityConsistencyResult, IdentityDirectionsOverview } from "@/domain/logo-directions";
import type { selectIdentityDirectionComponents } from "@/server/data/logo-workspace";
import { ApiError } from "@/server/http/errors";
import { previewIdentityMix, DirectionMixError } from "../model/mix";
type DirectionComponentSelectionRequest = Parameters<typeof selectIdentityDirectionComponents>[2];
/** Called under the shared source/head fences; browser diagnostics are never trusted. */
export async function verifyDirectionSelection(input: {
  overview: IdentityDirectionsOverview;
  request: DirectionComponentSelectionRequest;
}): Promise<IdentityConsistencyResult> {
  const parsed = selectIdentityDirectionComponentsInputSchema.safeParse(input.request);
  if (!parsed.success) throw new ApiError("invalid_input");
  if (parsed.data.approvedLogoId !== input.overview.currentApprovedLogo?.id) throw new ApiError("conflict");
  try {
    const preview = await previewIdentityMix({ overview: input.overview, ...parsed.data });
    if (preview.consistency.status === "blocked") throw new ApiError("integration_unavailable");
    return preview.consistency;
  } catch (error) {
    if (error instanceof DirectionMixError)
      throw new ApiError(error.code === "logo_approval_required" ? "conflict" : error.code);
    throw error;
  }
}

export async function buildDirectionSelectionEvidence(
  overview: IdentityDirectionsOverview,
  request: DirectionComponentSelectionRequest,
) {
  const parsed = selectIdentityDirectionComponentsInputSchema.parse(request);
  const preview = await previewIdentityMix({ overview, ...parsed });
  if (preview.consistency.status === "blocked" || preview.approvedLogoId !== parsed.approvedLogoId)
    throw new ApiError("integration_unavailable");
  const typography = overview.typography.find((row) => row.id === parsed.typographyVersionId)!;
  const usedFonts = new Set(typography.styles.map((s) => s.fontVersionId));
  return {
    sources: {
      approvedLogo: overview.currentApprovedLogo!,
      palette: overview.palettes.find((row) => row.id === parsed.paletteVersionId)!,
      typography,
      graphics: overview.graphics.find((row) => row.id === parsed.graphicsVersionId)!,
      fonts: overview.fonts.filter((f) => usedFonts.has(f.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      fontChecks: overview.fontChecks
        .filter((c) => c.typographyVersionId === typography.id)
        .sort((a, b) => (a.styleKey < b.styleKey ? -1 : a.styleKey > b.styleKey ? 1 : 0)),
      sourceDirectionIds: preview.sourceDirectionIds,
    },
    consistency: preview.consistency,
  };
}
