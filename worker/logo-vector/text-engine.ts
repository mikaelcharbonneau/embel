import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import nodeModule from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fontRecordSchema, type PermittedFont } from "../../src/domain/logo-directions";
import { freezeLogoRecord, logoTextSourceSchema, logoVectorPathSchema, type LogoTextSource, type LogoVectorPath } from "../../src/domain/logo-vector";
import { fontPurposeAllowed } from "../../src/features/identity-directions/model/font-rights";
import { LogoVectorError } from "../../src/features/logo-vector/model/errors";
import { canonicalizeLogoPath, encodeLogoPath, getLogoPathPaintedBounds, validateLogoVectorDocument } from "../../src/features/logo-vector/model/geometry";
import bidiData from "./text-bidi-data.json";
import { VECTOR_LIMITS } from "../../src/features/logo-vector/model/limits";

export const LOGO_TEXT_LIMITS = Object.freeze({ codePoints: 200, fontBytes: 10_485_760, timeoutMs: 5_000, glyphs: 4096, outputBytes: 8_388_608 });
export const QUALIFIED_HARFBUZZ = Object.freeze({ id: "harfbuzzjs", version: "1.6.2", core: "14.5.0",
  entry: "04ece1914c8720ad96257728119c1bf24088ee4ef3ab2a2ca688c9a4895d4e7e",
  bridge: "ba43463df44851fd58211ef8c19aa7956965390857727ae867b70dc7b3682de1",
  wasm: "684bda29aee2411d05e6859070a9b1a6b8d061025ededb5a8910098fd0cf10f4" });
export type LogoTextInput = { source: LogoTextSource; font: PermittedFont };
const position = z.number().finite().min(-VECTOR_LIMITS.coordinate).max(VECTOR_LIMITS.coordinate);
export const shapedLogoTextSchema = z.strictObject({
  paths: z.array(logoVectorPathSchema).min(1).max(VECTOR_LIMITS.paths),
  glyphs: z.array(z.strictObject({ id: z.number().int().min(1).max(65_535), cluster: z.number().int().min(0).max(399), xAdvance: position, yAdvance: position, xOffset: position, yOffset: position })).min(1).max(LOGO_TEXT_LIMITS.glyphs),
});
export type ShapedLogoText = { paths: readonly LogoVectorPath[]; glyphs: readonly z.infer<typeof shapedLogoTextSchema>["glyphs"][number][] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const unsupported = (message: string): never => { throw new LogoVectorError("unsupported_text", message); };
const invalidFont = (): never => { throw new LogoVectorError("invalid_font", "The supplied file does not contain a supported single outline font."); };
const scriptPolicies: Readonly<Record<string, { characters: RegExp; direction: "ltr" | "rtl"; joining: boolean }>> = Object.freeze({
  Latn: { characters: /\p{Script_Extensions=Latin}/u, direction: "ltr", joining: false },
  Grek: { characters: /\p{Script_Extensions=Greek}/u, direction: "ltr", joining: false },
  Cyrl: { characters: /\p{Script_Extensions=Cyrillic}/u, direction: "ltr", joining: false },
  Arab: { characters: /\p{Script_Extensions=Arabic}/u, direction: "rtl", joining: true },
  Hebr: { characters: /\p{Script_Extensions=Hebrew}/u, direction: "rtl", joining: false },
});
/** Unicode 17 class lookup only; never performs bidi layout or changes the source text. */
export function logoTextBidiClass(codepoint: number): string {
  if (!Number.isSafeInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) return unsupported("The source contains an invalid Unicode code point.");
  let low = 0, high = bidiData.ranges.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (codepoint <= bidiData.ranges[middle]![0]!) high = middle; else low = middle + 1;
  }
  const range = bidiData.ranges[low]!, type = bidiData.classes[range[1]!];
  if (codepoint > range[0]! || type === undefined) throw new LogoVectorError("engine_unavailable", "The qualified Unicode character data is unavailable.");
  return type;
}
/** Contract/rights/hash check and real copy before any asynchronous work. No font parser runs here. */
export function snapshotLogoTextInput(input: LogoTextInput): LogoTextInput {
  if (typeof input?.source?.text === "string" && (input.source.text.length > LOGO_TEXT_LIMITS.codePoints * 2 || [...input.source.text].length > LOGO_TEXT_LIMITS.codePoints)) throw new LogoVectorError("limit_exceeded", "Logo text is limited to 200 Unicode code points.");
  if (!(input?.font?.bytes instanceof Uint8Array) || input.font.bytes.byteLength > LOGO_TEXT_LIMITS.fontBytes) throw new LogoVectorError("limit_exceeded", "Use a font file up to 10 MiB.");
  const source = logoTextSourceSchema.safeParse(input.source), record = fontRecordSchema.safeParse(input.font.record);
  if (!source.success) return unsupported("The editable text source is invalid or unsupported.");
  if (!record.success) throw new LogoVectorError("font_rights_required", "A verified font record and reviewed render/outline rights are required.");
  const s = source.data, r = record.data;
  if (!["render", "outline"].includes(input.font.purpose) || !fontPurposeAllowed(r, "render") || !fontPurposeAllowed(r, "outline")) throw new LogoVectorError("font_rights_required", "This text needs both render and outline permission for the exact font file.");
  // Do not use Buffer.slice: caller-owned Buffers must not alias the process input.
  const bytes = Uint8Array.from(input.font.bytes);
  if (input.font.contentHash !== r.asset.contentHash || hash(bytes) !== r.asset.contentHash || s.rightsEvidenceId !== r.rights.id ||
      Object.keys(r.asset).some(key => r.asset[key as keyof typeof r.asset] !== s.font[key as keyof typeof s.font])) throw new LogoVectorError("source_mismatch", "Text, font bytes and rights must name the same owned immutable font version.");
  if (s.shapingEngine.id !== QUALIFIED_HARFBUZZ.id || s.shapingEngine.version !== QUALIFIED_HARFBUZZ.version) throw new LogoVectorError("engine_unavailable", "The exact saved text shaping engine is unavailable.");
  if (s.faceIndex !== 0) return unsupported("Font collections and nonzero face indexes are not supported.");
  const policy = scriptPolicies[s.script];
  if (!policy || s.direction !== policy.direction) return unsupported("This script and direction need an unsupported text layout.");
  try { new Intl.Locale(s.language); } catch { return unsupported("The text language is unsupported."); }
  for (const character of s.text) {
    if (/[\p{Control}\p{Format}\p{Line_Separator}\p{Paragraph_Separator}\p{Surrogate}]/u.test(character)) return unsupported("Multiline text, layout controls and bidi controls are not supported.");
    const bidi = logoTextBidiClass(character.codePointAt(0)!);
    if ((s.direction === "ltr" && (bidi === "R" || bidi === "AL")) || (s.direction === "rtl" && bidi === "L")) return unsupported("Mixed-direction text needs a bidi layout engine.");
    // Check every category: symbols and punctuation can carry script and strong
    // direction too. Script_Extensions=Common is narrower than Script=Common.
    const shared = /[\p{Script_Extensions=Common}\p{Script_Extensions=Inherited}]/u.test(character);
    if (!policy.characters.test(character) && (!shared || /[\p{Letter}\p{Mark}]/u.test(character))) return unsupported("Mixed-script text needs separate supported runs.");
    if (s.direction === "rtl" && (bidi === "EN" || bidi === "AN" || /\p{Number}/u.test(character))) return unsupported("Mixed-direction numeric text needs a bidi layout engine.");
  }
  if (policy.joining && s.letterSpacing !== 0) return unsupported("Letter spacing is unavailable for joining scripts.");
  return { source: s, font: { record: r, bytes, contentHash: input.font.contentHash, purpose: input.font.purpose } };
}

async function verifiedHarfBuzz(): Promise<typeof import("harfbuzzjs")> {
  try {
    const entry = nodeModule.createRequire(join(process.cwd(), "package.json")).resolve("harfbuzzjs"), dist = dirname(entry);
    const manifest = JSON.parse(readFileSync(join(dist, "../package.json"), "utf8")) as { version?: string };
    if (manifest.version !== QUALIFIED_HARFBUZZ.version || hash(readFileSync(entry)) !== QUALIFIED_HARFBUZZ.entry ||
        hash(readFileSync(join(dist, "harfbuzz.js"))) !== QUALIFIED_HARFBUZZ.bridge || hash(readFileSync(join(dist, "harfbuzz.wasm"))) !== QUALIFIED_HARFBUZZ.wasm) throw new Error();
    const hb = await import("harfbuzzjs");
    if (hb.versionString() !== QUALIFIED_HARFBUZZ.core) throw new Error();
    return hb;
  } catch { throw new LogoVectorError("engine_unavailable", "The exact qualified local text shaping engine is unavailable."); }
}

/** Bounded SFNT framing before HarfBuzz sanitizes individual tables. No WOFF, collection or bitmap fallback. */
function assertOutlineFont(bytes: Uint8Array): void {
  if (bytes.byteLength < 12) return invalidFont();
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), signature = b.readUInt32BE(0), count = b.readUInt16BE(4), directoryEnd = 12 + count * 16;
  if (![0x00010000, 0x4f54544f].includes(signature) || count < 1 || count > 256 || directoryEnd > b.length) return invalidFont();
  const tables = new Map<string, { offset: number; length: number }>();
  for (let n = 0; n < count; n++) {
    const index = 12 + n * 16, tag = b.toString("latin1", index, index + 4), offset = b.readUInt32BE(index + 8), length = b.readUInt32BE(index + 12);
    if (tables.has(tag) || offset < directoryEnd || offset > b.length || length > b.length - offset) return invalidFont();
    tables.set(tag, { offset, length });
  }
  for (const [tag, length] of [["head", 54], ["hhea", 36], ["maxp", 6], ["cmap", 4], ["hmtx", 4]] as const) if ((tables.get(tag)?.length ?? 0) < length) return invalidFont();
  if (signature === 0x00010000 ? !tables.has("glyf") || !tables.has("loca") : !tables.has("CFF ") && !tables.has("CFF2")) return invalidFont();
  // Color/bitmap/SVG faces need a separately qualified paint implementation; do not flatten their appearance silently.
  if (["COLR", "SVG ", "CBDT", "CBLC", "EBDT", "EBLC", "sbix"].some(tag => tables.has(tag))) return unsupported("Color and bitmap font glyphs are not supported as monochrome outline text.");
}

/** Revalidates the returned shape using the common canonical geometry validator. */
export function validateShapedLogoText(value: unknown, source: LogoTextSource): ShapedLogoText {
  const parsed = shapedLogoTextSchema.safeParse(value);
  if (!parsed.success) throw new LogoVectorError("invalid_geometry", "The text engine returned invalid glyph geometry or positions.");
  const result = parsed.data;
  if (result.glyphs.some(glyph => glyph.cluster >= source.text.length)) throw new LogoVectorError("invalid_geometry", "The text engine returned an invalid source cluster.");
  const bounds = result.paths.map(getLogoPathPaintedBounds);
  if (bounds.some(b => b === null)) throw new LogoVectorError("invalid_font", "A printable glyph has no verifiable outline ink.");
  const ink = bounds.filter(b => b !== null), x = Math.min(...ink.map(b => b.minX)), y = Math.min(...ink.map(b => b.minY));
  const enclosingSize = (start: number, end: number) => {
    const size = end - start;
    // A tight ink box can subtract then add to a value one ULP below the real
    // edge. Expand only this private validation canvas, never glyph geometry.
    return start + size < end ? size + Number.EPSILON * Math.max(1, Math.abs(start), Math.abs(end), size) : size;
  };
  const width = enclosingSize(x, Math.max(...ink.map(b => b.maxX))), height = enclosingSize(y, Math.max(...ink.map(b => b.maxY)));
  validateLogoVectorDocument({ version: 1, viewBox: [x, y, width, height], components: [{ id: "shaped-lettering", role: "lettering", editingKind: "editable_text", paths: result.paths, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, textSource: source }] });
  return freezeLogoRecord(result);
}

/** Only call inside the killable text subprocess. Does not read fonts from paths, URLs or the OS. */
export async function shapeLogoTextInProcess(input: LogoTextInput): Promise<ShapedLogoText> {
  const { source, font: permitted } = snapshotLogoTextInput(input);
  assertOutlineFont(permitted.bytes);
  const hb = await verifiedHarfBuzz();
  try {
    const face = new hb.Face(new hb.Blob(permitted.bytes), source.faceIndex), font = new hb.Font(face);
    const head = face.referenceTable("head"), maxp = face.referenceTable("maxp");
    if (!head || head.length < 54 || !maxp || maxp.length < 6 || !Number.isInteger(face.upem) || face.upem < 16 || face.upem > 16_384) return invalidFont();
    const glyphCount = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4, false);
    if (!glyphCount || !face.collectUnicodes().length) return invalidFont();
    const axes = face.getAxisInfos();
    for (const [tag, value] of Object.entries(source.variationAxes)) {
      const axis = axes[tag];
      if (!axis || value < axis.min || value > axis.max) return unsupported("The selected variation axis is unavailable or outside this font's range.");
    }
    const availableFeatures = new Set<string>();
    // Intl represents the valid undetermined language with no primary language.
    // Keep it neutral; do not substitute the server's or user's default locale.
    const language = (new Intl.Locale(source.language).language ?? "und").toLowerCase();
    for (const table of ["GSUB", "GPOS"] as const) {
      const scripts = face.getTableScriptTags(table);
      let scriptIndex = scripts.findIndex(tag => hb.otTagToScript(tag) === source.script);
      if (scriptIndex < 0) scriptIndex = scripts.indexOf("DFLT");
      if (scriptIndex < 0) continue;
      const languages = face.getScriptLanguageTags(table, scriptIndex);
      const languageIndex = languages.findIndex(tag => hb.otTagToLanguage(tag).toLowerCase() === language);
      for (const tag of face.getLanguageFeatureTags(table, scriptIndex, languageIndex < 0 ? 0xffff : languageIndex)) availableFeatures.add(tag);
    }
    for (const tag of Object.keys(source.featureTags)) if (!availableFeatures.has(tag)) return unsupported("The selected OpenType feature is unavailable for this font's script and language.");
    font.setScale(face.upem, face.upem);
    font.setVariations(Object.entries(source.variationAxes).map(([tag, value]) => new hb.Variation(tag, value)));
    const buffer = new hb.Buffer();
    buffer.addText(source.text); // v1.6.2 uses UTF-16 offsets; preserve the exact source string.
    buffer.setClusterLevel(hb.ClusterLevel.MONOTONE_GRAPHEMES);
    buffer.setScript(source.script); buffer.setLanguage(source.language); buffer.setDirection(source.direction === "rtl" ? hb.Direction.RTL : hb.Direction.LTR);
    hb.shape(font, buffer, Object.entries(source.featureTags).map(([tag, enabled]) => new hb.Feature(tag, enabled ? 1 : 0)));
    const infos = buffer.getGlyphInfos(), positions = buffer.getGlyphPositions();
    if (!infos.length || infos.length !== positions.length || infos.length > LOGO_TEXT_LIMITS.glyphs) throw new LogoVectorError("limit_exceeded", "Shaped glyph count exceeds the supported limit.");
    const graphemeStarts = new Set(Array.from(new Intl.Segmenter(source.language, { granularity: "grapheme" }).segment(source.text), segment => segment.index));
    const starts = [...new Set(infos.map(info => info.cluster))].sort((a, b) => a - b), ends = new Map(starts.map((start, i) => [start, starts[i + 1] ?? source.text.length]));
    const factor = source.size / face.upem, paths: LogoVectorPath[] = [], glyphs: z.infer<typeof shapedLogoTextSchema>["glyphs"] = [];
    let penX = 0, penY = 0, commands = 0, outputBytes = 0;
    for (const [index, info] of infos.entries()) {
      if (info.codepoint === 0 || info.codepoint >= glyphCount) return unsupported("The supplied font is missing one or more required glyphs. No fallback font was used.");
      if (!graphemeStarts.has(info.cluster) || (index > 0 && (source.direction === "ltr" ? info.cluster < infos[index - 1]!.cluster : info.cluster > infos[index - 1]!.cluster))) return unsupported("The shaped clusters require an unsupported text layout.");
      const p = positions[index]!, xOffset = p.xOffset * factor, yOffset = -p.yOffset * factor;
      const d = font.glyphToPath(info.codepoint), clusterText = source.text.slice(info.cluster, ends.get(info.cluster));
      if (d) {
        outputBytes += Buffer.byteLength(d);
        if (outputBytes > LOGO_TEXT_LIMITS.outputBytes) throw new LogoVectorError("limit_exceeded", "Font outlines exceed the 8 MiB geometry limit.");
        // HarfBuzz outlines are y-up. Flip exactly once and apply its actual pen/mark offsets.
        const path = canonicalizeLogoPath(d, [factor, 0, 0, -factor, penX + xOffset, penY + yOffset]);
        commands += path.commands.length;
        if (commands > VECTOR_LIMITS.commands) throw new LogoVectorError("limit_exceeded", "Font outlines exceed the command-count limit.");
        paths.push({ id: `text-glyph-${index}`, d: encodeLogoPath(path), fill: { color: "#000000", opacity: 1 }, stroke: null, fillRule: "nonzero" });
      } else if (!/^\p{White_Space}+$/u.test(clusterText)) return invalidFont();
      const spacing = index < infos.length - 1 && infos[index + 1]!.cluster !== info.cluster ? source.letterSpacing : 0;
      const glyph = { id: info.codepoint, cluster: info.cluster, xAdvance: p.xAdvance * factor + spacing, yAdvance: -p.yAdvance * factor, xOffset, yOffset };
      glyphs.push(glyph); penX += glyph.xAdvance; penY += glyph.yAdvance;
    }
    if (!paths.length) throw new LogoVectorError("empty_artwork", "This text contains no visible outline artwork.");
    return validateShapedLogoText({ paths, glyphs }, source);
  } catch (error) {
    if (error instanceof LogoVectorError) throw error;
    return invalidFont();
  }
}
