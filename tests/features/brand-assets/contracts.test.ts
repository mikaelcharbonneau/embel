import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { BRAND_BOARD_FONTS, supportedBrandBoardTypography } from "../../../src/domain/brand-board-fonts";
import { createBrandAssetSnapshot } from "../../../src/features/brand-assets/model/snapshot";
import { brandGuideHtml, brandPaletteFiles } from "../../../src/features/brand-assets/model/guides";
import { fontSupportsBrandText } from "../../../src/features/brand-assets/client/browser-assets";
import provenance from "../../../public/fonts/brand/provenance.json";
import { brandBoardContrastRatio } from "../../../src/domain/brand-board-design";
import { createIdentityInputSnapshot } from "../../../src/domain/project-identity";
import { brandAssetFixture, hash } from "./fixtures";
const fontkit = createRequire(import.meta.url)("fontkit") as { create(bytes: Uint8Array): { variationAxes: Record<string, { min: number; max: number }> } };

describe("brand asset source and font contracts", () => {
  it("uses only copied decisions from the selected system and exact logo receipt", () => {
    const f = brandAssetFixture();
    expect(f.snapshot.heading.family).toBe("Fraunces"); expect(f.snapshot.body.family).toBe("Manrope");
    expect(f.snapshot.palette).toEqual({ primary: "#25463D", accent: "#DEDB62", background: "#F3EFE5", text: "#182A24" });
    expect(f.snapshot.logo.reference).toEqual(f.sourceLogo.preview.reference);
    expect(JSON.stringify(f.snapshot)).not.toContain("independent design studio");
  });
  it("refuses older systems without explicit application decisions and invalid color/type bindings", () => {
    const f = brandAssetFixture();
    for (const design of [undefined, { ...f.system.applicationDesign!, paletteRoles: { ...f.system.applicationDesign!.paletteRoles, primary: "missing" } }, { ...f.system.applicationDesign!, headingStyleKey: "missing" }]) {
      expect(() => createBrandAssetSnapshot({ ...f, ownerId: f.account.userId, system: { ...f.system, applicationDesign: design } })).toThrow();
    }
  });
  it("rejects foreign source logos and obsolete inherited boards", () => {
    const f = brandAssetFixture();
    expect(() => createBrandAssetSnapshot({ ...f, ownerId: f.projectId })).toThrow();
    expect(() => createBrandAssetSnapshot({ ...f, ownerId: f.account.userId, system: { ...f.system, board: { ...f.system.board, staleComponents: ["colors"] } } })).toThrow();
  });
  it("binds a v2 final system to the complete exact saved source logo brief", () => {
    const f = brandAssetFixture(), input = createIdentityInputSnapshot({ ...f.system.input, logoBrief: f.sourceLogo.brief });
    const system = { ...f.system, input };
    expect(createBrandAssetSnapshot({ ...f, system, ownerId: f.account.userId }).name).toBe("Northline");
    const sourceLogo = { ...f.sourceLogo, brief: { ...f.sourceLogo.brief, payload: { ...f.sourceLogo.brief.payload, activity: "Changed source brief" } } };
    expect(() => createBrandAssetSnapshot({ ...f, system, sourceLogo, ownerId: f.account.userId })).toThrow();
  });
  it("shares exact contrast measurements with generation validation", () => {
    expect(brandBoardContrastRatio("#000000", "#FFFFFF")).toBe(21);
    expect(brandBoardContrastRatio("#F3EFE5", "#F3EFE5")).toBe(1);
    expect(brandBoardContrastRatio("#182A24", "#F3EFE5")).toBeGreaterThan(4.5);
    expect(brandBoardContrastRatio("invalid", "#F3EFE5")).toBe(0);
  });
  it("ships exactly inspected variable font bytes and original OFL notices", () => {
    for (const font of BRAND_BOARD_FONTS) {
      const bytes = readFileSync(`public${font.file}`), record = provenance.files.find(row => row.id === font.id)!;
      expect(hash(bytes)).toBe(font.sha256); expect(record.sha256).toBe(font.sha256); expect(bytes.length).toBe(record.byteLength);
      const face = fontkit.create(bytes);
      expect(face.variationAxes.wght!.min).toBe(font.minWeight); expect(face.variationAxes.wght!.max).toBe(font.maxWeight);
      const license = readFileSync(`public/fonts/brand/OFL-${font.id}.txt`);
      expect(hash(license)).toBe(record.licenseSha256); expect(license.toString()).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(fontSupportsBrandText(font, "Northline Àa Bb Cc 0123456789")).toBe(true);
      expect(fontSupportsBrandText(font, "北线")).toBe(false);
    }
  });
  it("rejects font substitution, synthetic unsupported weights and italics", () => {
    expect(supportedBrandBoardTypography({ family: "Lora", weight: 600, style: "normal" })).toBe(true);
    for (const style of [{ family: "Lora", weight: 900, style: "normal" }, { family: "Manrope", weight: 100, style: "normal" }, { family: "Fraunces", weight: 600, style: "italic" }, { family: "Arial", weight: 400, style: "normal" }]) expect(supportedBrandBoardTypography(style)).toBe(false);
  });
  it("exports exact palette values and escaped guidance with supported official font links", () => {
    const f = brandAssetFixture({}, 'Northline <script>alert("x")</script>');
    const guide = new TextDecoder().decode(brandGuideHtml(f.snapshot)), palette = brandPaletteFiles(f.snapshot);
    expect(guide).not.toContain("<script>"); expect(guide).toContain("&lt;script&gt;");
    expect(guide).toContain("https://fonts.google.com/specimen/Fraunces"); expect(guide).toContain("https://fonts.google.com/specimen/Manrope");
    expect(JSON.parse(new TextDecoder().decode(palette.json)).colors).toEqual(f.system.components.colors.swatches);
    expect(new TextDecoder().decode(palette.css)).toContain("--brand-primary: #25463D;");
    expect(guide).not.toContain(f.account.userId); expect(guide).not.toContain(f.system.id);
  });
});
