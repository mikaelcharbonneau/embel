import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { BRAND_BOARD_FONTS, brandBoardFont } from "../../../src/domain/brand-board-fonts";
import { BRAND_APPLICATIONS, createBrandApplication, createFinalBrandBoard, drawBrandArtwork, editableBrandSvg, type BrandArtwork } from "../../../src/features/brand-assets/model/artwork";
import { brandAssetFixture, hash } from "./fixtures";

export function actualRenderInputs(families: readonly string[] = ["Fraunces", "Manrope"]) {
  const fonts = new Map<string, string>();
  for (const font of BRAND_BOARD_FONTS.filter(font => families.includes(font.family))) { const name = `Test_${font.id}`; expect(GlobalFonts.registerFromPath(`public${font.file}`, name)).not.toBeNull(); fonts.set(font.family, name); }
  const logo = createCanvas(400, 200), ink = logo.getContext("2d"); ink.fillStyle = "#FFFFFF"; ink.fillRect(0, 0, 400, 200); ink.fillStyle = "#182A24"; ink.fillRect(100, 50, 200, 100);
  const direction = createCanvas(200, 300); direction.getContext("2d").fillRect(0, 0, 200, 300);
  const images = { logo: { image: logo as unknown as CanvasImageSource, width: 400, height: 200, dataUrl: logo.toDataURL("image/png") }, direction: { image: direction as unknown as CanvasImageSource, width: 200, height: 300, dataUrl: direction.toDataURL("image/png") } };
  return { fonts, images };
}
describe("real brand asset rendering", () => {
  it("renders the final board and every application at the promised dimensions with real bundled fonts", async () => {
    const { snapshot } = brandAssetFixture(), { fonts, images } = actualRenderInputs();
    for (const art of [createFinalBrandBoard(snapshot), ...BRAND_APPLICATIONS.map(spec => createBrandApplication(snapshot, spec))]) {
      const canvas = createCanvas(1, 1), fitted = drawBrandArtwork(canvas as unknown as HTMLCanvasElement, art, images, fonts);
      const png = canvas.toBuffer("image/png"), meta = await sharp(png).metadata();
      expect(meta).toMatchObject({ format: "png", width: art.width, height: art.height });
      const svg = new TextDecoder().decode(editableBrandSvg(fitted, images));
      expect(svg).not.toContain("https://"); expect(svg).not.toContain("<script");
      if (art.title.includes("post")) { expect(svg).toContain('font-family="Fraunces"'); expect(svg).toContain('font-family="Manrope"'); expect(svg).toContain("original logo remains an embedded raster image"); }
      expect(fitted.nodes.filter(node => node.kind === "text").every(node => node.x >= 0 && node.y >= 0 && node.y <= art.height)).toBe(true);
    }
  });
  it("follows explicit selected layout and graphic treatments, producing distinct usable compositions", () => {
    const { fonts, images } = actualRenderInputs(), hashes: string[] = [];
    for (const [layout, graphic] of [["editorial", "rounded_shapes"], ["centered", "fine_lines"], ["split", "bold_blocks"]] as const) {
      const { snapshot } = brandAssetFixture({ layout, graphic }), canvas = createCanvas(1, 1);
      drawBrandArtwork(canvas as unknown as HTMLCanvasElement, createBrandApplication(snapshot, BRAND_APPLICATIONS[1]), images, fonts);
      hashes.push(hash(canvas.toBuffer("image/png")));
    }
    expect(new Set(hashes).size).toBe(3);
  });
  it("preserves the whole rectangular source logo inside a circular-crop-safe profile region", () => {
    const { snapshot } = brandAssetFixture(), { fonts, images } = actualRenderInputs(), canvas = createCanvas(1, 1);
    const art = drawBrandArtwork(canvas as unknown as HTMLCanvasElement, createBrandApplication(snapshot, BRAND_APPLICATIONS[0]), images, fonts);
    const image = art.nodes.find(node => node.kind === "image")!;
    expect(image).toMatchObject({ source: "logo" });
    expect([...canvas.getContext("2d").getImageData(512, 512, 1, 1).data]).toEqual([24, 42, 36, 255]);
    expect([...canvas.getContext("2d").getImageData(240, 512, 1, 1).data]).toEqual([255, 255, 255, 255]);
  });
  it.each([
    ["茶屋 カフェ", "Noto Sans JP", "ltr"], ["茶屋 Studio", "Noto Sans SC", "ltr"], ["한글", "Noto Sans KR", "ltr"],
    ["مقهى Café", "Noto Sans Arabic", "rtl"], ["שָׁלוֹם Studio", "Noto Sans Hebrew", "rtl"], ["क्षेत्र Studio", "Noto Sans Devanagari", "ltr"], ["ਪੰਜਾਬ Studio", "Noto Sans Gurmukhi", "ltr"],
  ])("draws %s with the selected real font inside its text region and preserves editable Unicode", (name, family, direction) => {
    const { fonts, images } = actualRenderInputs([family]), canvas = createCanvas(1, 1);
    const art: BrandArtwork = { width: 640, height: 220, title: name, nodes: [
      { kind: "rect", x: 0, y: 0, width: 640, height: 220, fill: "#FFFFFF" },
      { kind: "text", text: name, family, weight: 400, size: 64, x: 40, y: 140, maxWidth: 540, color: "#000000" },
    ] };
    const fitted = drawBrandArtwork(canvas as unknown as HTMLCanvasElement, art, images, fonts);
    const pixels = canvas.getContext("2d").getImageData(0, 0, 640, 220).data;
    let minX = 640, maxX = 0, ink = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index]! < 128) { const x = index / 4 % 640; minX = Math.min(minX, x); maxX = Math.max(maxX, x); ink++; }
    expect(ink).toBeGreaterThan(500); expect(minX).toBeGreaterThanOrEqual(38); expect(maxX).toBeLessThanOrEqual(582);
    if (direction === "rtl") expect(maxX).toBeGreaterThan(560); else expect(minX).toBeLessThan(60);
    const svg = new TextDecoder().decode(editableBrandSvg(fitted, images));
    expect(svg).toContain(`font-family="${family}"`); expect(svg).toContain(`direction="${direction}" unicode-bidi="isolate" text-anchor="start"`);
    expect(svg).toContain(`<text x="${direction === "rtl" ? 580 : 40}"`); expect(svg).toContain(`>${name}</text>`);
  });
  it("renders multilingual selections throughout the actual board and centered template", async () => {
    const f = brandAssetFixture({ layout: "centered" }, "مقهى Studio"), font = brandBoardFont("Noto Sans Arabic")!;
    const snapshot = { ...f.snapshot, heading: { ...f.snapshot.heading, family: font.family, font }, body: { ...f.snapshot.body, family: font.family, font } };
    const { fonts, images } = actualRenderInputs([font.family]);
    for (const art of [createFinalBrandBoard(snapshot), createBrandApplication(snapshot, BRAND_APPLICATIONS[3])]) {
      const canvas = createCanvas(1, 1), fitted = drawBrandArtwork(canvas as unknown as HTMLCanvasElement, art, images, fonts);
      expect(await sharp(canvas.toBuffer("image/png")).metadata()).toMatchObject({ width: art.width, height: art.height });
      const texts = fitted.nodes.filter(node => node.kind === "text");
      expect(texts.every(node => node.family === font.family)).toBe(true); expect(texts.some(node => node.text === snapshot.name)).toBe(true);
      expect(new TextDecoder().decode(editableBrandSvg(fitted, images))).toContain('direction="rtl" unicode-bidi="isolate" text-anchor="middle"');
    }
  });
  it("keeps the complete long CJK name fitted identically in PNG and editable SVG", () => {
    const family = "Noto Sans JP", name = "茶屋".repeat(100), { fonts, images } = actualRenderInputs([family]), canvas = createCanvas(1, 1);
    const art: BrandArtwork = { width: 300, height: 120, title: name, nodes: [
      { kind: "rect", x: 0, y: 0, width: 300, height: 120, fill: "#FFFFFF" },
      { kind: "text", text: name, family, weight: 400, size: 30, x: 40, y: 80, maxWidth: 220, color: "#000000" },
    ] };
    const fitted = drawBrandArtwork(canvas as unknown as HTMLCanvasElement, art, images, fonts), node = fitted.nodes[1]!;
    expect(node).toMatchObject({ text: name, family, size: 10, textLength: 220 });
    const svg = new TextDecoder().decode(editableBrandSvg(fitted, images));
    expect(svg).toContain('textLength="220" lengthAdjust="spacingAndGlyphs"'); expect(svg).toContain(`>${name}</text>`);
  });
});
