import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderBrandGuidelines } from "../../../src/features/identity-deliverables/server/guidelines";
import { readFreeCatalogFont } from "../../../src/features/identity-directions/server/fonts";
import { hashBytes } from "./fixtures";
import { approvedExportFixture } from "./fixtures";
export async function pdfText(bytes: Uint8Array) {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 });
  try {
    const pdf = await task.promise, pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) pages.push((await (await pdf.getPage(n)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" "));
    return { pages: pdf.numPages, text: pages.join("\n") };
  } finally { await task.destroy(); }
}
describe("synthetic default guidelines", () => {
  it("preserves exact logo version, name, RGB/HEX, type and reviewed spacing", async () => {
    const input = await approvedExportFixture(), original = JSON.stringify(input);
    const parsed = await pdfText(await renderBrandGuidelines(input, new AbortController().signal));
    for (const section of ["Logo use", "Color specifications", "Typography", "Spacing rules", input.brandName, input.logoApproval.id, "#DB2777", "219, 39, 119", "Synthetic test family", "10", input.variants.items[0]!.id]) expect(parsed.text).toContain(section);
    expect(JSON.stringify(input)).toBe(original);
    expect(parsed.pages).toBeGreaterThan(0);
  });
  it("marks print matches and unavailable licensed specimens honestly", async () => {
    const input = await approvedExportFixture();
    const parsed = await pdfText(await renderBrandGuidelines(input, new AbortController().signal));
    expect(parsed.text).toMatch(/CMYK unavailable/);
    expect(parsed.text).toMatch(/Pantone unavailable/);
    expect(parsed.text).toMatch(/Specimen unavailable/);
    expect(parsed.text).toContain("Synthetic test family");
    expect(parsed.text).toContain("does not establish exclusive rights");
  });
  it("copies resolver Buffer before awaits and embeds only the hash-approved font", async () => {
    const [sans, mono] = await Promise.all([readFreeCatalogFont("geist-sans-variable"), readFreeCatalogFont("geist-mono-variable")]);
    // A valid original Sans file with harmless trailing padding gives both real
    // font files room in one aliased Buffer. Its entire exact byte hash is approved.
    const original = new Uint8Array(Math.max(sans.bytes.length, mono.bytes.length)); original.set(sans.bytes);
    const shared = Buffer.from(original), input = await approvedExportFixture(), font = input.fonts[0]!;
    font.family = sans.family; font.source = "user_upload"; font.asset.contentHash = hashBytes(original);
    font.rights = { ...sans.rights, fontContentHash: hashBytes(original) };
    input.typography.styles[0]!.sampleText = "Immutable approved specimen";
    input.typography.styles.push({ ...input.typography.styles[0]!, key: "second", role: "heading", sampleText: "Second approved specimen" });
    let calls = 0;
    const bytes = await renderBrandGuidelines(input, new AbortController().signal, { resolveEmbeddedFont: async record => {
      calls++;
      if (calls === 2) { shared.fill(0); shared.set(mono.bytes); }
      return { record, purpose: "embed", bytes: calls === 1 ? shared : new Uint8Array(original), contentHash: record.asset.contentHash };
    } });
    expect(calls).toBe(2);
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 });
    const specimenFonts: string[] = [];
    try {
      const pdf = await task.promise;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n); await page.getOperatorList();
        for (const item of (await page.getTextContent()).items) if ("str" in item && item.str.includes("Immutable approved specimen")) {
          const embedded = page.commonObjs.get(item.fontName) as { name: string };
          specimenFonts.push(embedded.name);
        }
      }
    } finally { await task.destroy(); }
    expect(specimenFonts).toHaveLength(1);
    expect(specimenFonts[0]).toContain("Geist-Regular");
    expect(specimenFonts[0]).not.toContain("GeistMono");
  });
  it("retains long Unicode brand spelling and fails closed on missing glyphs", async () => {
    const input = await approvedExportFixture(); input.brandName = "Étoile & Straße ".repeat(10);
    const result = await pdfText(await renderBrandGuidelines(input, new AbortController().signal));
    expect(result.text).toContain("Étoile & Straße");
    input.brandName = "Synthetic \u{10FFFF}";
    await expect(renderBrandGuidelines(input, new AbortController().signal)).rejects.toThrow(/glyph/i);
  });
});
