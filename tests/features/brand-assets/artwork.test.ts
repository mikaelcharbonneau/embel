import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { BRAND_BOARD_FONTS } from "../../../src/domain/brand-board-fonts";
import { BRAND_APPLICATIONS, createBrandApplication, createFinalBrandBoard, drawBrandArtwork, editableBrandSvg } from "../../../src/features/brand-assets/model/artwork";
import { brandAssetFixture, hash } from "./fixtures";

export function actualRenderInputs() {
  const fonts = new Map<string, string>();
  for (const font of BRAND_BOARD_FONTS) { const name = `Test_${font.id}`; GlobalFonts.registerFromPath(`public${font.file}`, name); fonts.set(font.family, name); }
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
});
