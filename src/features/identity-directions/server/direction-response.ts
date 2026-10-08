import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { identityDirectionProductionResultSchema, identityPaletteVersionSchema, identityTypographyVersionSchema, identityGraphicSpecSchema, type IdentityDirectionProductionResult } from "@/domain/logo-directions";
import { logoResolvedDirectionInputSchema, type LogoResolvedDirectionInput } from "@/domain/logo-jobs";
import { logoApprovalSchema, logoIdentifierSchema, logoJsonBytes, logoUuidSchema } from "@/domain/logo-vector";
import { fontPurposeAllowed } from "../model/font-rights";
import { canonicalIdentityInput } from "../model/font-check-binding";
import { describeColor } from "../model/colors";
import { renderDirectionGraphics } from "../model/graphics";
const directionSchema = z.strictObject({ name: z.string().trim().min(1).max(200), palette: z.strictObject({ swatches: z.array(z.strictObject({ key: logoIdentifierSchema, name: z.string().trim().min(1).max(200), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).min(1).max(32), pairings: identityPaletteVersionSchema.shape.pairings }), typography: z.strictObject({ styles: identityTypographyVersionSchema.shape.styles }), graphics: z.strictObject({ elements: z.array(identityGraphicSpecSchema).max(100) }) });
export const directionProviderResponseSchema = z.strictObject({ directions: z.tuple([directionSchema, directionSchema, directionSchema]) });
/** Provider output supplies bounded choices only. IDs, scope, sources and rights are server-owned. */
export function normalizeDirectionResponse(value: unknown, input: LogoResolvedDirectionInput): IdentityDirectionProductionResult {
  input = logoResolvedDirectionInputSchema.parse(input);
  const approval = logoApprovalSchema.parse(input.approvedLogo);
  if (input.targetCount !== 3 || input.brief.ownerId !== approval.ownerId || input.brief.projectId !== approval.projectId || input.references.ownerId !== approval.ownerId || input.references.projectId !== approval.projectId || input.brief.payload.referenceSnapshotId !== input.references.id || logoJsonBytes(value) > 393_216) throw new TypeError("The approved direction inputs are unavailable.");
  const response = directionProviderResponseSchema.parse(value);
  if (new Set(response.directions.map(d => canonicalIdentityInput({ palette: d.palette, typography: d.typography, graphics: d.graphics }))).size !== 3) throw new TypeError("Three distinct complete direction specifications are required.");
  const sourceRefs = input.inputRevisions;
  const basis = () => ({ id: logoUuidSchema.parse(randomUUID()), ownerId: approval.ownerId, projectId: approval.projectId, approvedLogoId: approval.id, inputRevisions: sourceRefs });
  const palettes: unknown[] = [], typography: unknown[] = [], graphics: unknown[] = [], directions: unknown[] = [];
  for (const candidate of response.directions) {
    for (const style of candidate.typography.styles) {
      const records = input.permittedFonts.filter(f => f.id === style.fontVersionId);
      if (records.length !== 1 || records[0]!.asset.ownerId !== approval.ownerId || records[0]!.asset.projectId !== approval.projectId || !fontPurposeAllowed(records[0]!, "render")) throw new TypeError("A direction requested a font without verified free commercial display rights.");
    }
    const palette = identityPaletteVersionSchema.parse({ ...basis(), ...candidate.palette, swatches: candidate.palette.swatches.map(s => ({ key: s.key, name: s.name, color: describeColor(s.hex, { icc: null, pantone: null }) })) });
    const type = identityTypographyVersionSchema.parse({ ...basis(), ...candidate.typography });
    const graphic = { ...basis(), ...candidate.graphics };
    renderDirectionGraphics(graphic, palette);
    palettes.push(palette); typography.push(type); graphics.push(graphic);
    directions.push({ ...basis(), name: candidate.name, paletteVersionId: palette.id, typographyVersionId: type.id, graphicsVersionId: graphic.id });
  }
  return identityDirectionProductionResultSchema.parse({ directions, palettes, typography, graphics });
}
