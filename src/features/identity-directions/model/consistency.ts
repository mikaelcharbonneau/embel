import {
  fontRecordSchema, fontTextCheckSchema, identityConsistencyResultSchema, identityDirectionBasisSchema,
  identityGraphicsVersionSchema, identityPaletteVersionSchema, identityTypographyVersionSchema,
  type FontRecord, type FontTextCheck, type IdentityConsistencyResult, type IdentityGraphicsVersion,
  type IdentityPaletteVersion, type IdentityTypographyVersion,
} from "@/domain/logo-directions";
import { canonicalIdentityInput as canonical, hashIdentityInput as digest, fontCheckBinding } from "./font-check-binding";
import { renderDirectionGraphics } from "./graphics";
import { fontPurposeAllowed } from "./font-rights";
import { logoApprovalSchema, sameLogoScope, type LogoApproval } from "@/domain/logo-vector";

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new TypeError("A color must use six-digit HEX.");
  const values = [1, 3, 5].map(start => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!;
}

/** WCAG sRGB contrast. Compare this value before rounding for presentation. */
export function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  const a = luminance(foregroundHex), b = luminance(backgroundHex);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const summary = (values: readonly string[]) => values.slice(0, 4).join("; ") + (values.length > 4 ? "; and " + (values.length - 4) + " more" : "");
type MixInput = { approvedLogo: LogoApproval; palette: IdentityPaletteVersion; typography: IdentityTypographyVersion; graphics: IdentityGraphicsVersion; fonts: readonly FontRecord[]; fontChecks: readonly FontTextCheck[] };

/** Diagnostics only. Persistence must resolve these immutable inputs server-side. */
export async function evaluateIdentityMix(input: MixInput): Promise<IdentityConsistencyResult> {
  const approvedLogo = logoApprovalSchema.parse(input.approvedLogo);
  const palette = identityPaletteVersionSchema.parse(input.palette);
  const typography = identityTypographyVersionSchema.parse(input.typography);
  const graphicBasis = identityDirectionBasisSchema.parse({ id: input.graphics.id, ownerId: input.graphics.ownerId, projectId: input.graphics.projectId,
    approvedLogoId: input.graphics.approvedLogoId, inputRevisions: input.graphics.inputRevisions });
  const graphicResult = identityGraphicsVersionSchema.safeParse(input.graphics);
  if (input.fonts.length > 100 || input.fontChecks.length > 100) throw new RangeError("Too many font records.");
  const usedFonts = new Set(typography.styles.map(style => style.fontVersionId));
  const fonts = input.fonts.map(font => fontRecordSchema.parse(font)).filter(font => usedFonts.has(font.id)).sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const fontChecks = input.fontChecks.map(check => fontTextCheckSchema.parse(check)).filter(check => check.typographyVersionId === typography.id).sort((a,b)=>a.styleKey < b.styleKey ? -1 : a.styleKey > b.styleKey ? 1 : 0);
  const checks: IdentityConsistencyResult["checks"] = [];
  function add(id: string, code: IdentityConsistencyResult["checks"][number]["code"], role: string | null, status: "pass" | "warning" | "blocked", message: string) {
    checks.push({ id, code, role, status, message });
  }
  const foreign = [palette, typography, graphicBasis].some(component => !sameLogoScope(component, approvedLogo) || component.approvedLogoId !== approvedLogo.id);
  const mismatchedInputs = canonical(palette.inputRevisions) !== canonical(typography.inputRevisions) || canonical(palette.inputRevisions) !== canonical(graphicBasis.inputRevisions);
  add("logo-basis", "foreign_logo_basis", null, foreign || mismatchedInputs ? "blocked" : "pass",
    foreign ? "These components do not belong to the same approved logo and project." : mismatchedInputs ? "These components use different saved inputs. Review their source versions." : "All components keep the same approved logo.");

  for (const role of ["heading", "body", "accent"] as const) {
    const styles = typography.styles.filter(style => style.role === role);
    if (!styles.length) continue;
    const pairs = palette.pairings.filter(pair => pair.role === role);
    if (!pairs.length) {
      add("palette-" + role, "unknown_palette_role", role, "blocked", "No text and background color pair is specified for " + role + ".");
    } else {
      // Every style for this role uses the declared role pairs, so use the strictest size threshold.
      const required = styles.some(style => style.sizePx < 24 && !(style.weight >= 700 && style.sizePx >= 18.667)) ? 4.5 : 3;
      const candidates = pairs.map(pair => ({ pair, ratio: contrastRatio(palette.swatches.find(swatch => swatch.key === pair.foregroundKey)!.color.hex,
        palette.swatches.find(swatch => swatch.key === pair.backgroundKey)!.color.hex) }));
      const lowest = candidates.reduce((a, b) => a.ratio <= b.ratio ? a : b);
      add("contrast-" + role, "text_contrast", role, lowest.ratio < required ? "warning" : "pass",
        role + ": " + lowest.pair.foregroundKey + " on " + lowest.pair.backgroundKey + " has " + lowest.ratio.toFixed(3) + ":1 contrast; " + required + ":1 required" +
        (lowest.ratio < required ? ". Review legibility before approval." : "."));
    }

    const denied: string[] = [], missingPoints = new Set<number>(), unsupported: string[] = [], unavailable: string[] = [];
    for (const style of styles) {
      const matches = fonts.filter(font => font.id === style.fontVersionId);
      const font = matches.length === 1 ? matches[0] : undefined;
      if (!font || !sameLogoScope(font.asset, approvedLogo) || !fontPurposeAllowed(font, "render")) denied.push(style.key);
      if (!font || !sameLogoScope(font.asset, approvedLogo)) { unavailable.push(style.key); continue; }
      const binding = await fontCheckBinding({ text: style.sampleText, fontVersionId: font.id, fontContentHash: font.asset.contentHash, weight: style.weight, style: style.style });
      const linked = fontChecks.filter(check => check.typographyVersionId === typography.id && check.styleKey === style.key && check.role === role &&
        check.fontVersionId === font.id && check.fontContentHash === font.asset.contentHash && check.sampleHash === binding.sampleHash && check.styleHash === binding.styleHash);
      if (linked.length !== 1) { unavailable.push(style.key); continue; }
      for (const check of linked) {
        for (const point of check.missingCodePoints) missingPoints.add(point);
        if (!check.styleSupported) unsupported.push(style.key);
      }
    }
    add("font-permission-" + role, "font_permission", role, denied.length ? "blocked" : "pass",
      denied.length ? "Font use is unavailable for " + role + ": " + summary(denied) + ". A matching reviewed commercial-use and display permission is required." : "The saved " + role + " fonts have reviewed commercial-use and display permissions.");
    if (missingPoints.size) {
      const points = [...missingPoints].sort((a, b) => a - b).map(point => "U+" + point.toString(16).toUpperCase().padStart(4, "0"));
      add("missing-glyphs-" + role, "missing_glyphs", role, "blocked", "A saved check reports missing characters for " + role + ": " + summary(points) + ". No system-font substitution is made.");
    }
    add("font-check-" + role, "font_check_unavailable", role, unavailable.length || unsupported.length ? "blocked" : "pass",
      unavailable.length ? "Exact text verification is missing or no longer matches " + role + ": " + summary(unavailable) + "."
      : unsupported.length ? "The font file does not support the requested weight or style for " + role + ": " + summary(unsupported) + "."
      : "The exact saved " + role + " specimen and font style have been checked.");
  }

  if (!graphicResult.success) {
    add("graphics", "unsupported_graphic", null, "blocked", "The supporting graphics cannot be displayed with the available shapes.");
  } else {
    const unknown = [...new Set(graphicResult.data.elements.filter(element => !palette.swatches.some(swatch => swatch.key === element.paletteKey)).map(element => element.paletteKey))];
    add("graphic-colors", "unknown_palette_role", "graphics", unknown.length ? "blocked" : "pass", unknown.length
      ? "Supporting graphics refer to colors missing from this palette: " + summary(unknown) + "." : "Supporting graphics use colors in this palette.");
    let supported = true;
    if (!unknown.length) { try { renderDirectionGraphics(graphicResult.data, palette); } catch { supported = false; } }
    add("graphics", "unsupported_graphic", null, supported ? "pass" : "blocked", supported ? "Supporting graphics use supported shapes." : "Supporting graphics exceed the supported drawing bounds.");
  }
  const warnings = checks.filter(check => check.status === "warning").map(check => check.message);
  const blockingReasons = checks.filter(check => check.status === "blocked").map(check => check.message);
  const hash = await digest({ version: 2, approvedLogo, palette, typography, graphics: input.graphics, fonts, fontChecks, checks });
  return identityConsistencyResultSchema.parse({ hash, status: blockingReasons.length ? "blocked" : warnings.length ? "warning" : "pass", checks, warnings, blockingReasons });
}
