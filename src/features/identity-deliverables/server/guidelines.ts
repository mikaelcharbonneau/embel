import "server-only";
import { approvedDeliverableSnapshotSchema, type ApprovedDeliverableSnapshot } from "../../../domain/logo-deliverables";
import type { FontRecord, PermittedFont } from "../../../domain/logo-directions";
import { validateVariantReview } from "../model/variants";
import { flattenLogoPaths } from "../../logo-vector/model/geometry";
import { fontPurposeAllowed } from "../../identity-directions/model/font-rights";
import { readFreeCatalogFont, listFreeFontCatalog } from "../../identity-directions/server/fonts";
import { inspectFontBytes, MAX_FONT_BYTES } from "../../identity-directions/server/font-inspection";
import { assertFileBytes, framedLogoDocument, sha256, LogoFileError } from "./render-policy";
import { runLogoProcess } from "./process";

export type GuidelinesDependencies = { resolveEmbeddedFont?(record: FontRecord, signal: AbortSignal): Promise<PermittedFont> };
type TypographyRow = { family: string; description: string; sample: string | null; bytes: Uint8Array | null; unavailable: string | null };
const neutralCatalogId = "geist-sans-variable";
function copyFontBytes(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12 || bytes.byteLength > MAX_FONT_BYTES) throw new LogoFileError("verification_failed", "The font bytes exceed the supported bounds.");
  return new Uint8Array(bytes);
}
async function catalogSpecimen(record: FontRecord): Promise<Uint8Array | null> {
  if (record.source !== "free_catalog" || !fontPurposeAllowed(record, "embed")) return null;
  const catalog = (await listFreeFontCatalog()).find(font => font.rights.fontContentHash === record.asset.contentHash && font.rights.licenseTextHash === record.rights.licenseTextHash && font.rights.sourceUrl === record.rights.sourceUrl);
  return catalog ? (await readFreeCatalogFont(catalog.id)).bytes : null;
}
/** The neutral text font is distinct from the named brand typography; missing specimens are explicit. */
export async function renderBrandGuidelines(input: ApprovedDeliverableSnapshot, signal: AbortSignal, dependencies: GuidelinesDependencies = {}): Promise<Uint8Array> {
  signal.throwIfAborted();
  const snapshot = approvedDeliverableSnapshotSchema.parse(input), reviewed = validateVariantReview(snapshot.resolvedVariants, snapshot.variantReview);
  const neutralRecord = await readFreeCatalogFont(neutralCatalogId);
  const neutral = { ...neutralRecord, bytes: copyFontBytes(neutralRecord.bytes) };
  if (neutral.rights.commercialUse !== "allowed" || neutral.rights.permissions.embed !== "allowed" || sha256(neutral.bytes) !== neutral.contentHash) throw new LogoFileError("unavailable", "The guidelines body font is unavailable for embedding.");
  const typography: TypographyRow[] = [];
  for (const style of snapshot.typography.styles) {
    const record = snapshot.fonts.find(font => font.id === style.fontVersionId);
    const row: TypographyRow = { family: record?.family ?? `Unavailable font ${style.fontVersionId}`, description: `${style.role}; weight ${style.weight}; ${style.style}; ${style.sizePx} px; line height ${style.lineHeight}`, sample: null, bytes: null, unavailable: "Specimen unavailable: verified font embedding, actual font bytes and glyph/style coverage are required." };
    if (record && fontPurposeAllowed(record, "embed")) {
      try {
        if (dependencies.resolveEmbeddedFont) {
          const permitted = await dependencies.resolveEmbeddedFont(record, signal);
          const bytes = copyFontBytes(permitted.bytes);
          if (permitted.purpose !== "embed" || JSON.stringify(permitted.record) !== JSON.stringify(record) || permitted.contentHash !== record.asset.contentHash || sha256(bytes) !== record.asset.contentHash) throw new Error("Wrong font evidence");
          row.bytes = bytes;
        } else {
          const bytes = await catalogSpecimen(record);
          row.bytes = bytes ? copyFontBytes(bytes) : null;
          if (row.bytes && sha256(row.bytes) !== record.asset.contentHash) throw new Error("Wrong catalog font bytes");
        }
        if (row.bytes) {
          const mime = Buffer.from(row.bytes.subarray(0, 4)).toString("latin1") === "OTTO" ? "font/otf" : "font/ttf";
          const inspection = await inspectFontBytes(row.bytes, mime, signal), points = new Set(inspection.codePoints);
          const weight = inspection.variations.wght;
          // PDFKit uses the verified face's default variation; do not silently use another weight.
          const weightSupported = weight ? style.weight === weight.default : style.weight === inspection.weight;
          if (!weightSupported || inspection.italic !== (style.style === "italic") || [...style.sampleText].some(c => !points.has(c.codePointAt(0)!))) row.bytes = null;
          else { row.sample = style.sampleText; row.unavailable = null; }
        }
      } catch (error) { signal.throwIfAborted(); void error; row.bytes = null; }
    }
    typography.push(row);
  }
  const colors = snapshot.palette.swatches.map(swatch => {
    const color = swatch.color;
    const cmyk = color.cmyk.status === "unavailable" ? "CMYK unavailable: no reviewed conversion profile." : `CMYK ${color.cmyk.channels.join(", ")}; ICC profile ${color.cmyk.profileId} (${color.cmyk.profileHash}); ${color.cmyk.limitations.join(" ")}`;
    const pantone = color.pantone.status === "unavailable" ? "Pantone unavailable: no licensed matching source." : `Pantone approximate reference ${color.pantone.reference}; source ${color.pantone.sourceId}; ${color.pantone.limitations.join(" ")}`;
    return { hex: color.hex, description: `${swatch.name}: ${color.hex}; RGB ${color.rgb.join(", ")}. ${cmyk} ${pantone}` };
  });
  const variants = reviewed.map(item => {
    const document = framedLogoDocument(item.document, item.variant.clearSpace);
    return { id: item.variant.id, role: item.variant.role, colorway: item.variant.colorway, paths: flattenLogoPaths(document), viewBox: document.viewBox, clearSpace: item.variant.clearSpace, minimumDigitalSize: item.variant.minimumDigitalSize };
  });
  const notice = "Export does not establish exclusive rights, copyright protection, uniqueness or trademark clearance. Logo PDFs use RGB; no press or PDF/X conformance is claimed.";
  const bodyStrings = [snapshot.brandName, ...colors.map(c => c.description), ...typography.flatMap(row => [row.family, row.description, row.unavailable ?? ""])];
  const neutralInspection = await inspectFontBytes(neutral.bytes, neutral.mimeType, signal), neutralPoints = new Set(neutralInspection.codePoints);
  if (bodyStrings.some(text => [...text].some(char => ![10, 13].includes(char.codePointAt(0)!) && !neutralPoints.has(char.codePointAt(0)!)))) throw new LogoFileError("unavailable", "The guidelines body font does not cover every required glyph. No spelling or font was silently replaced.");
  const pdf = await runLogoProcess<Uint8Array>({ operation: "guidelines", brandName: snapshot.brandName, logoApprovalId: snapshot.logoApproval.id, directionApprovalId: snapshot.directionApproval.id, variants, colors, typography, bodyFont: neutral.bytes, bodyFontLicense: neutral.licenseText, notice }, signal);
  assertFileBytes(pdf);
  return pdf;
}
