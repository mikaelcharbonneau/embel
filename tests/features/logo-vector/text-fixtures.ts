import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PermittedFont } from "@/domain/logo-directions";
import type { LogoTextSource, LogoVectorDocument, LogoVectorPath } from "@/domain/logo-vector";
import { getLogoPathPaintedBounds } from "@/features/logo-vector/model/geometry";
import catalog from "@/features/identity-directions/catalog/free-fonts.json";

export const digestTextBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const id = (n: number) => `65100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Synthetic owner records; the pinned Geist font/license are real, reviewed OFL bytes. */
export function licensedTextInput(text: string): { source: LogoTextSource; font: PermittedFont } {
  const entry = catalog.entries[0]!;
  const bytes = new Uint8Array(readFileSync(`node_modules/geist/dist/fonts/${entry.file}`));
  if (digestTextBytes(bytes) !== entry.contentHash || digestTextBytes(readFileSync("node_modules/geist/LICENSE.txt")) !== entry.licenseTextHash) throw new Error("The pinned licensed text fixture changed.");
  const asset = { ownerId: id(1), projectId: id(2), assetId: id(3), versionId: id(4), contentHash: entry.contentHash };
  const font: PermittedFont = { record: { id: id(5), asset, family: entry.family, source: "free_catalog", rights: { id: entry.rightsEvidenceId, fontContentHash: entry.contentHash, sourceKind: "reviewed_license", sourceUrl: entry.licenseSourceUrl, licenseTextHash: entry.licenseTextHash, commercialUse: "allowed", permissions: { render: "allowed", outline: "allowed", embed: "denied", modify: "denied", redistribute: "denied" }, reviewedAt: entry.reviewedAt } }, bytes, contentHash: entry.contentHash, purpose: "outline" };
  return { font, source: { text, contentKind: "brand_name", font: { ...asset }, rightsEvidenceId: entry.rightsEvidenceId, faceIndex: 0, size: 100, variationAxes: {}, featureTags: {}, language: "en", script: "Latn", direction: "ltr", letterSpacing: 0, lineHeight: 1, shapingEngine: { id: "harfbuzzjs", version: "1.6.2" } } };
}
export function textDocument(paths: readonly LogoVectorPath[], source: LogoTextSource): LogoVectorDocument {
  const bounds = paths.map(getLogoPathPaintedBounds).filter(value => value !== null);
  if (!bounds.length) throw new Error("Text fixture has no visible geometry.");
  const x = Math.floor(Math.min(...bounds.map(b => b.minX))) - 1, y = Math.floor(Math.min(...bounds.map(b => b.minY))) - 1;
  const right = Math.ceil(Math.max(...bounds.map(b => b.maxX))) + 1, bottom = Math.ceil(Math.max(...bounds.map(b => b.maxY))) + 1;
  return { version: 1, viewBox: [x, y, right - x, bottom - y], components: [{ id: "synthetic-lettering", role: "lettering", editingKind: "editable_text", paths: [...paths], textSource: source, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }] };
}

/** Official Google Fonts bytes, fetched by immutable commit, never exposed as an app catalog option. */
export function licensedArabicTextInput(text: string): ReturnType<typeof licensedTextInput> {
  const receipt = JSON.parse(readFileSync("tests/features/logo-vector/fixtures/fonts/NotoSansArabic-receipt.json", "utf8")) as { files: { file: string; sourceUrl: string; sha256: string; byteLength: number }[] };
  const fontFile = receipt.files[0]!, licenseFile = receipt.files[1]!;
  const bytes = new Uint8Array(readFileSync(`tests/features/logo-vector/fixtures/fonts/${fontFile.file}`));
  if (bytes.length !== fontFile.byteLength || digestTextBytes(bytes) !== fontFile.sha256 || digestTextBytes(readFileSync(`tests/features/logo-vector/fixtures/fonts/${licenseFile.file}`)) !== licenseFile.sha256) throw new Error("The licensed Arabic fixture changed.");
  const input = licensedTextInput(text), asset = { ...input.source.font, assetId: id(13), versionId: id(14), contentHash: fontFile.sha256 };
  input.font = { record: { ...input.font.record, id: id(15), asset, family: "Noto Sans Arabic", source: "user_upload", rights: { ...input.font.record.rights, id: id(16), sourceUrl: licenseFile.sourceUrl, fontContentHash: fontFile.sha256, licenseTextHash: licenseFile.sha256 } }, bytes, contentHash: fontFile.sha256, purpose: "outline" };
  input.source = { ...input.source, font: { ...asset }, rightsEvidenceId: id(16), script: "Arab", direction: "rtl", language: "ar" };
  return input;
}
/** Malformed-data tests retain synthetic records and rebind only their deliberate byte mutation. */
export function rebindTextFixtureBytes(input: ReturnType<typeof licensedTextInput>, bytes: Uint8Array): void {
  const hash = digestTextBytes(bytes); input.font.bytes = bytes; input.font.contentHash = hash;
  input.font.record.asset.contentHash = hash; input.font.record.rights.fontContentHash = hash; input.source.font.contentHash = hash;
  input.font.record.source = "user_upload";
}
