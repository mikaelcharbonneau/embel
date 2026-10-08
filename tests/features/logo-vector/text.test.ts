import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { LogoTextSource } from "@/domain/logo-vector";
import baseline from "./fixtures/fonts/harfbuzz-1.6.2-baseline.json";
import { snapshotLogoTextInput } from "../../../worker/logo-vector/text-engine";
import { shapeLogoText } from "@/features/logo-vector/server/text";
import { canonicalizeLogoPath, encodeLogoPath, validateLogoVectorDocument } from "@/features/logo-vector/model/geometry";
import { serializeLogoSvg, validateLogoVectorSvg } from "@/features/logo-vector/model/svg";
import { digestTextBytes, licensedTextInput, licensedArabicTextInput, rebindTextFixtureBytes, textDocument } from "./text-fixtures";
const signal = () => new AbortController().signal;

describe("licensed real HarfBuzz text outlines", () => {
  it("preserves a combining sequence and rights source while producing canonical font outlines", async () => {
    const input = licensedTextInput("A\u0301"), original = structuredClone(input.source), originalBytes = Uint8Array.from(input.font.bytes);
    const result = await shapeLogoText(input, signal());
    expect(input.source).toEqual(original); expect(input.font.bytes).toEqual(originalBytes);
    expect(result.glyphs).toEqual([{ id: 2, cluster: 0, xAdvance: 66.8, yAdvance: 0, xOffset: 0, yOffset: 0 }]);
    const document = validateLogoVectorDocument(textDocument(result.paths, original));
    expect(document.components[0]!.paths.length).toBe(1);
    const svg = serializeLogoSvg(document);
    expect(validateLogoVectorSvg(svg).components.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(svg)).toContain("<path");
    expect(new TextDecoder().decode(svg)).not.toMatch(/<(text|image|use)\b|font-family|href/);
  });
  it("uses actual ligature glyphs rather than one path per character", async () => {
    const input = licensedTextInput("fi");
    const ligature = await shapeLogoText(input, signal());
    expect(ligature.glyphs).toEqual([{ id: 488, cluster: 0, xAdvance: 599 * 0.1, yAdvance: 0, xOffset: 0, yOffset: 0 }]);
    expect(ligature.paths).toHaveLength(1);
    const separate = await shapeLogoText({ ...input, source: { ...input.source, featureTags: { liga: false } } }, signal());
    expect(separate.glyphs).toHaveLength(2); expect(separate.paths).toHaveLength(2);
    expect(separate.paths).not.toEqual(ligature.paths);
  });
  it("uses HarfBuzz mark offsets and keeps all glyphs of one grapheme together", async () => {
    const input = licensedTextInput("A\u0323\u0301B"), plain = await shapeLogoText(input, signal());
    const spaced = await shapeLogoText({ ...input, source: { ...input.source, letterSpacing: 10 } }, signal());
    expect(plain.glyphs.slice(0, 2)).toEqual([{ id: 17, cluster: 0, xAdvance: 64.8, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 918, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: -39.5, yOffset: -18 }]);
    expect(spaced.paths.slice(0, 2)).toEqual(plain.paths.slice(0, 2));
    expect(spaced.glyphs[1]!.xAdvance).toBe(10);
    expect(spaced.paths[2]!.d).not.toBe(plain.paths[2]!.d);
  });
  it("applies supported variable axes to actual geometry", async () => {
    const input = licensedTextInput("A"), regular = await shapeLogoText(input, signal());
    const bold = await shapeLogoText({ ...input, source: { ...input.source, variationAxes: { wght: 900 } } }, signal());
    expect(bold.paths).not.toEqual(regular.paths);
  });
  it("permits whitespace advances without inventing a glyph outline", async () => {
    const input = licensedTextInput("A A"), result = await shapeLogoText(input, signal());
    expect(result.glyphs).toHaveLength(3); expect(result.paths).toHaveLength(2);
    expect(result.glyphs[1]!.xAdvance).toBeGreaterThan(0);
    await expect(shapeLogoText(licensedTextInput("   "), signal())).rejects.toMatchObject({ code: "empty_artwork" });
  });
  it("requires render and outline permission but not font-software modification permission", async () => {
    const allowed = licensedTextInput("A");
    expect(allowed.font.record.rights.permissions.modify).toBe("denied");
    await expect(shapeLogoText(allowed, signal())).resolves.toMatchObject({ paths: expect.any(Array) });
    for (const purpose of ["render", "outline"] as const) {
      const input = licensedTextInput("A"); input.font.record.rights.permissions[purpose] = "denied";
      await expect(shapeLogoText(input, signal())).rejects.toMatchObject({ code: "font_rights_required" });
    }
  });
  it("rejects font-byte, owned reference and rights evidence substitution", async () => {
    const changed = licensedTextInput("A"); changed.font.bytes[30] = changed.font.bytes[30]! ^ 1;
    await expect(shapeLogoText(changed, signal())).rejects.toMatchObject({ code: "source_mismatch" });
    const foreign = licensedTextInput("A"); foreign.source.font.ownerId = "65100000-0000-4000-8000-000000000099";
    await expect(shapeLogoText(foreign, signal())).rejects.toMatchObject({ code: "source_mismatch" });
    const rights = licensedTextInput("A"); rights.source.rightsEvidenceId = "65100000-0000-4000-8000-000000000099";
    await expect(shapeLogoText(rights, signal())).rejects.toMatchObject({ code: "source_mismatch" });
  });
  it("fails missing glyphs without system fallback", async () => {
    await expect(shapeLogoText(licensedTextInput("A\u{10ffff}"), signal())).rejects.toMatchObject({ code: "unsupported_text" });
    const input = licensedTextInput("سلام"); input.source.script = "Arab"; input.source.direction = "rtl"; input.source.language = "ar";
    await expect(shapeLogoText(input, signal())).rejects.toMatchObject({ code: "unsupported_text" });
  });
  it.each<Partial<LogoTextSource>>([
    { variationAxes: { FAKE: 500 } }, { variationAxes: { wght: 901 } }, { featureTags: { FAKE: true } },
    { script: "Deva" }, { direction: "rtl" }, { faceIndex: 1 }, { shapingEngine: { id: "harfbuzzjs", version: "0.0.0" } },
    { text: "AБ" }, { text: "A\u202eB" }, { text: "A\nB" },
  ])("rejects unsupported controls or layouts: %j", async patch => {
    const input = licensedTextInput("A");
    await expect(shapeLogoText({ ...input, source: { ...input.source, ...patch } }, signal())).rejects.toMatchObject({ code: expect.stringMatching(/unsupported_text|engine_unavailable/) });
  });
  it("enforces 200 Unicode code points and 10 MiB encoded font bounds", async () => {
    const input = licensedTextInput("A".repeat(201));
    await expect(shapeLogoText(input, signal())).rejects.toMatchObject({ code: "limit_exceeded" });
    input.source.text = "A"; input.font.bytes = new Uint8Array(10_485_761);
    await expect(shapeLogoText(input, signal())).rejects.toMatchObject({ code: "limit_exceeded" });
    const within = licensedTextInput("A".repeat(200)); within.source.size = 1;
    await expect(shapeLogoText(within, signal())).resolves.toMatchObject({ glyphs: expect.any(Array) });
  });
  it("rejects a malformed font even when the declared hash matches", async () => {
    const input = licensedTextInput("A"); input.font.bytes = new Uint8Array([0,1,0,0,0,0,0,0,0,0,0,0]);
    const hash = digestTextBytes(input.font.bytes); input.font.contentHash = hash; input.font.record.asset.contentHash = hash; input.font.record.rights.fontContentHash = hash; input.source.font.contentHash = hash;
    await expect(shapeLogoText(input, signal())).rejects.toMatchObject({ code: "invalid_font" });
  });
  it("snapshots Buffer bytes and text controls before the caller mutates them", async () => {
    const input = licensedTextInput("A\u0301"), mutable = Buffer.from(input.font.bytes); input.font.bytes = mutable;
    const pending = shapeLogoText(input, signal());
    mutable.fill(0); input.source.text = "B"; input.source.variationAxes.wght = 900;
    const result = await pending;
    const expected = await shapeLogoText(licensedTextInput("A\u0301"), signal());
    expect(result).toEqual(expected);
  });
  it("returns cancellation instead of producing a late replacement", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(shapeLogoText(licensedTextInput("A"), controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });
  it("matches independent pinned-HarfBuzz metrics for Latin and Arabic RTL without altering Unicode", async () => {
    for (const specimen of baseline.samples) {
      const input = specimen.script === "Arab" ? licensedArabicTextInput(specimen.text) : licensedTextInput(specimen.text);
      input.source.size = specimen.upem;
      const original = structuredClone(input.source), result = await shapeLogoText(input, signal());
      expect(input.source).toEqual(original); expect(input.font.contentHash).toBe(specimen.fontSha256);
      expect(result.glyphs).toHaveLength(specimen.glyphs.length);
      let penX = 0, penY = 0;
      result.glyphs.forEach((glyph, index) => {
        const expected = specimen.glyphs[index]!;
        expect(glyph.id).toBe(expected.id); expect(glyph.cluster).toBe(expected.cluster);
        expect(glyph.xAdvance).toBeCloseTo(expected.xAdvance * input.source.size / specimen.upem, 10);
        expect(glyph.yAdvance).toBeCloseTo(-expected.yAdvance * input.source.size / specimen.upem, 10);
        expect(glyph.xOffset).toBeCloseTo(expected.xOffset * input.source.size / specimen.upem, 10);
        expect(glyph.yOffset).toBeCloseTo(-expected.yOffset * input.source.size / specimen.upem, 10);
        const originalOutline = encodeLogoPath(canonicalizeLogoPath(result.paths[index]!.d, [1, 0, 0, -1, -penX - glyph.xOffset, penY + glyph.yOffset]));
        expect(digestTextBytes(originalOutline)).toBe(specimen.canonicalOutlineSha256[index]);
        penX += glyph.xAdvance; penY += glyph.yAdvance;
      });
      const component = validateLogoVectorDocument(textDocument(result.paths, input.source)).components[0]!;
      expect(component.editingKind === "editable_text" && component.textSource.text).toBe(specimen.text);
    }
  });
  it("preserves Arabic joining and descending source clusters with a licensed Arabic font", async () => {
    const input = licensedArabicTextInput("سَلَام"), result = await shapeLogoText(input, signal());
    expect(result.glyphs.map(glyph => glyph.cluster)).toEqual([5, 4, 2, 2, 0, 0]);
    expect(result.glyphs.map(glyph => glyph.id)).toEqual([74, 11, 371, 71, 371, 37]);
    expect(result.paths).toHaveLength(6);
    expect(result.glyphs[2]!.xOffset).toBeCloseTo(-11.9); expect(result.glyphs[2]!.yOffset).toBeCloseTo(-25.6);
  });
  it("refuses joining-script tracking and mixed bidi instead of silently rearranging them", async () => {
    const spaced = licensedArabicTextInput("سلام"); spaced.source.letterSpacing = 1;
    await expect(shapeLogoText(spaced, signal())).rejects.toMatchObject({ code: "unsupported_text" });
    for (const text of ["سلام ABC", "سلام 123", "سلام ١٢٣", "سلام\u2066"]) await expect(shapeLogoText(licensedArabicTextInput(text), signal())).rejects.toMatchObject({ code: "unsupported_text" });
  });
  it("rejects a printable glyph whose supplied font has no vector outline", async () => {
    const input = licensedTextInput("A"), bytes = Buffer.from(input.font.bytes);
    for (let i = 0; i < bytes.readUInt16BE(4); i++) {
      const offset = 12 + i * 16;
      if (bytes.toString("latin1", offset, offset + 4) === "glyf") bytes.fill(0, bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 8) + bytes.readUInt32BE(offset + 12));
    }
    rebindTextFixtureBytes(input, bytes);
    await expect(shapeLogoText(input, signal())).rejects.toMatchObject({ code: "invalid_font" });
  });
  it("rejects bitmap-only or corrupt table data rather than fabricating outline recovery", async () => {
    for (const mutation of ["bitmap", "overflow"] as const) {
      const input = licensedTextInput("A"), bytes = Buffer.from(input.font.bytes);
      for (let i = 0; i < bytes.readUInt16BE(4); i++) {
        const offset = 12 + i * 16;
        if (bytes.toString("latin1", offset, offset + 4) !== "glyf") continue;
        if (mutation === "bitmap") bytes.write("CBDT", offset, "latin1"); else bytes.writeUInt32BE(0xffffffff, offset + 12);
      }
      rebindTextFixtureBytes(input, bytes);
      await expect(shapeLogoText(input, signal())).rejects.toMatchObject({ code: "invalid_font" });
    }
  });

  it("rejects a feature present only in an unrelated script or language", async () => {
    const greek = licensedTextInput("Α"); greek.source.script = "Grek"; greek.source.language = "el"; greek.source.featureTags = { mark: true };
    await expect(shapeLogoText(greek, signal())).rejects.toMatchObject({ code: "unsupported_text" });
    const english = licensedTextInput("A"); english.source.featureTags = { locl: true };
    await expect(shapeLogoText(english, signal())).rejects.toMatchObject({ code: "unsupported_text" });
    const turkish = licensedTextInput("i"); turkish.source.language = "tr"; turkish.source.featureTags = { locl: true };
    await expect(shapeLogoText(turkish, signal())).resolves.toMatchObject({ paths: expect.any(Array) });
  });

  it.each(["A\u060B\u0608B", "A\u060DB", "A\u061BB", "A\u061FB", "A\u0640B"])("rejects strong Arabic symbols or punctuation in an LTR run: %j", async text => {
    const input = licensedArabicTextInput(text); input.source.script = "Latn"; input.source.language = "en"; input.source.direction = "ltr";
    const before = structuredClone(input.source);
    await expect(shapeLogoText(input, signal())).rejects.toMatchObject({ code: "unsupported_text" });
    expect(input.source).toEqual(before);
  });

  it("rejects strong Common symbols in an RTL run before considering glyph coverage", () => {
    // U+1F1E6 REGIONAL INDICATOR SYMBOL LETTER A is Common, category So, bidi L.
    const input = licensedArabicTextInput("سلام\u{1F1E6}"), before = structuredClone(input.source);
    expect(() => snapshotLogoTextInput(input)).toThrowError(expect.objectContaining({ code: "unsupported_text" }));
    expect(input.source).toEqual(before);
  });
  it("checks script compatibility for non-letter symbols as well as letters", () => {
    // U+0482 CYRILLIC THOUSANDS SIGN is category So and bidi L.
    const input = licensedTextInput("A\u0482B");
    expect(() => snapshotLogoTextInput(input)).toThrowError(expect.objectContaining({ code: "unsupported_text" }));
  });
  it("retains compatible punctuation and neutral symbols in single-script runs", async () => {
    await expect(shapeLogoText(licensedArabicTextInput("سلام؟"), signal())).resolves.toMatchObject({ paths: expect.any(Array) });
    await expect(shapeLogoText(licensedTextInput("A&B®"), signal())).resolves.toMatchObject({ paths: expect.any(Array) });
  });

  it("preserves neutral und language while shaping through the default feature set", async () => {
    const input = licensedTextInput("fi"); input.source.language = "und";
    const original = structuredClone(input.source);
    const result = await shapeLogoText(input, signal());
    expect(input.source).toEqual(original);
    expect(result.glyphs.map(glyph => [glyph.id, glyph.cluster])).toEqual([[488, 0]]);
    expect(result.paths).toHaveLength(1);
  });
  it("still rejects malformed locale tags before font shaping", async () => {
    const input = licensedTextInput("A"); input.source.language = "en--US";
    await expect(shapeLogoText(input, signal())).rejects.toMatchObject({ code: "unsupported_text" });
  });

});
