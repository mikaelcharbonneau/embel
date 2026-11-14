import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { BRAND_BOARD_FONTS, brandBoardFont } from "../../../src/domain/brand-board-fonts";
import {
  BRAND_APPLICATIONS,
  brandCopy,
  brandTemplateFamily,
  createBrandApplication,
  createFinalBrandBoard,
  drawBrandArtwork,
  drawReversedLogo,
  drawTransparentLogo,
  editableBrandSvg,
  type BrandArtwork,
  type BrandImages,
} from "../../../src/features/brand-assets/model/artwork";
import { plainBrandNotes } from "../../../src/features/brand-assets/model/guides";
import { brandAssetFixture, hash } from "./fixtures";

/** The same light and dark copies the pack derives from the original logo. */
function derived(original: BrandImages["logo"], draw: typeof drawTransparentLogo): BrandImages["logo"] {
  const canvas = createCanvas(1, 1);
  draw(canvas as unknown as HTMLCanvasElement, original);
  return {
    image: canvas as unknown as CanvasImageSource,
    width: original.width,
    height: original.height,
    dataUrl: canvas.toDataURL("image/png"),
  };
}
export function actualRenderInputs(families: readonly string[] = ["Fraunces", "Manrope"]) {
  const fonts = new Map<string, string>();
  for (const font of BRAND_BOARD_FONTS.filter((font) => families.includes(font.family))) {
    const name = `Test_${font.id}`;
    expect(GlobalFonts.registerFromPath(`public${font.file}`, name)).not.toBeNull();
    fonts.set(font.family, name);
  }
  const logo = createCanvas(400, 200),
    ink = logo.getContext("2d");
  ink.fillStyle = "#FFFFFF";
  ink.fillRect(0, 0, 400, 200);
  ink.fillStyle = "#182A24";
  ink.fillRect(100, 50, 200, 100);
  const direction = createCanvas(200, 300);
  direction.getContext("2d").fillRect(0, 0, 200, 300);
  const original = {
    image: logo as unknown as CanvasImageSource,
    width: 400,
    height: 200,
    dataUrl: logo.toDataURL("image/png"),
  };
  const images: BrandImages = {
    logo: derived(original, drawTransparentLogo),
    logoReversed: derived(original, drawReversedLogo),
    direction: {
      image: direction as unknown as CanvasImageSource,
      width: 200,
      height: 300,
      dataUrl: direction.toDataURL("image/png"),
    },
  };
  return { fonts, images, original };
}
const saved = { slogan: "Clear routes for every city.", positioning: "For city cyclists, a calm route planner." };
describe("real brand asset rendering", () => {
  it("renders the final board and every application at the promised dimensions with real bundled fonts", async () => {
    const { snapshot } = brandAssetFixture(),
      { fonts, images } = actualRenderInputs(),
      copy = brandCopy(snapshot, saved);
    for (const art of [
      createFinalBrandBoard(snapshot, copy),
      ...BRAND_APPLICATIONS.map((spec) => createBrandApplication(snapshot, spec, copy)),
    ]) {
      const canvas = createCanvas(1, 1),
        fitted = drawBrandArtwork(canvas as unknown as HTMLCanvasElement, art, images, fonts);
      const png = canvas.toBuffer("image/png"),
        meta = await sharp(png).metadata();
      expect(meta).toMatchObject({ format: "png", width: art.width, height: art.height });
      const svg = new TextDecoder().decode(editableBrandSvg(fitted, images));
      expect(svg).not.toContain("https://");
      expect(svg).not.toContain("<script");
      if (art.title.includes("post")) {
        expect(svg).toContain('font-family="Fraunces"');
        expect(svg).toContain('font-family="Manrope"');
        expect(svg).toContain("logo remains an embedded raster image made from your original logo");
      }
      expect(
        fitted.nodes
          .filter((node) => node.kind === "text")
          .every((node) => node.x >= 0 && node.y >= 0 && node.y <= art.height),
      ).toBe(true);
    }
  });
  it("fills templates with the saved slogan and positioning, and leaves out lines that were never saved", () => {
    const { snapshot } = brandAssetFixture(),
      filler = /Your (headline|tagline)|goes here|Add your message|READY TO MAKE YOUR OWN/u;
    const words = (art: BrandArtwork) =>
      art.nodes.flatMap((node) => (node.kind === "text" ? [node.text] : [])).join(" ");
    for (const graphic of ["rounded_shapes", "fine_lines"] as const) {
      const f = brandAssetFixture({ graphic }),
        copy = brandCopy(f.snapshot, saved);
      for (const spec of BRAND_APPLICATIONS.slice(1)) {
        const text = words(createBrandApplication(f.snapshot, spec, copy));
        expect(text).not.toMatch(filler);
        // The logo carries the name; a template never sets it again beside the logo.
        expect(text).not.toContain(snapshot.name);
        expect(text).toContain(saved.slogan);
        if (spec.id.startsWith("post")) expect(text).toContain(saved.positioning);
      }
      // Nothing was saved, so nothing is written: the logo alone.
      for (const spec of BRAND_APPLICATIONS)
        expect(words(createBrandApplication(f.snapshot, spec, brandCopy(f.snapshot)))).toBe("");
    }
    expect(words(createFinalBrandBoard(snapshot, brandCopy(snapshot)))).not.toMatch(filler);
    expect(words(createFinalBrandBoard(snapshot, brandCopy(snapshot, saved)))).toContain(saved.slogan);
    // Saved text the chosen fonts cannot draw is left out instead of failing the kit.
    expect(brandCopy(snapshot, { slogan: "茶屋へようこそ", positioning: "Tea 🍵 for all" })).toEqual({
      tagline: null,
      headline: null,
      message: null,
    });
  });
  it("chooses a template family from the selected direction, producing distinct usable compositions", () => {
    const { fonts, images } = actualRenderInputs(),
      hashes = new Map<string, string>();
    const plain = brandAssetFixture({ graphic: "rounded_shapes" }).snapshot;
    const cases = [
      ["frames", plain],
      ["lines", brandAssetFixture({ graphic: "fine_lines" }).snapshot],
      // The direction's own words about its graphics choose the grid-and-line family too.
      ["lines", { ...plain, graphicNotes: "A fine grid, flight-path lines and data points." }],
      ["frames", brandAssetFixture({ graphic: "bold_blocks", layout: "split" }).snapshot],
    ] as const;
    for (const [family, snapshot] of cases) {
      expect(brandTemplateFamily(snapshot)).toBe(family);
      const canvas = createCanvas(1, 1);
      drawBrandArtwork(
        canvas as unknown as HTMLCanvasElement,
        createBrandApplication(snapshot, BRAND_APPLICATIONS[1], brandCopy(snapshot, saved)),
        images,
        fonts,
      );
      hashes.set(family, hash(canvas.toBuffer("image/png")));
    }
    expect(new Set(hashes.values()).size).toBe(2);
  });
  it("preserves the whole rectangular source logo inside a circular-crop-safe profile region, without a light box around it", () => {
    const { snapshot } = brandAssetFixture(),
      { fonts, images } = actualRenderInputs(),
      canvas = createCanvas(1, 1);
    const art = drawBrandArtwork(
      canvas as unknown as HTMLCanvasElement,
      createBrandApplication(snapshot, BRAND_APPLICATIONS[0]),
      images,
      fonts,
    );
    const image = art.nodes.find((node) => node.kind === "image")!;
    expect(image).toMatchObject({ source: "logo" });
    // The ink keeps its exact color, and the logo's white background shows the surface.
    expect([...canvas.getContext("2d").getImageData(512, 512, 1, 1).data]).toEqual([24, 42, 36, 255]);
    expect([...canvas.getContext("2d").getImageData(240, 512, 1, 1).data]).toEqual([243, 239, 229, 255]);
    expect(art.nodes.some((node) => node.kind === "rect" && node.fill === "#FFFFFF")).toBe(false);
  });
  it("derives a transparent copy for light colors and a one-color reversed copy for dark colors", () => {
    const { original } = actualRenderInputs(),
      light = createCanvas(1, 1),
      dark = createCanvas(1, 1);
    drawTransparentLogo(light as unknown as HTMLCanvasElement, original);
    drawReversedLogo(dark as unknown as HTMLCanvasElement, original);
    expect([light.width, light.height, dark.width, dark.height]).toEqual([400, 200, 400, 200]);
    const at = (canvas: typeof light, x: number, y: number) => [
      ...canvas.getContext("2d").getImageData(x, y, 1, 1).data,
    ];
    expect(at(light, 200, 100)).toEqual([24, 42, 36, 255]);
    expect(at(light, 20, 20)[3]).toBe(0);
    expect(at(dark, 200, 100)).toEqual([255, 255, 255, 255]);
    expect(at(dark, 20, 20)[3]).toBe(0);
    // Edges and pale tints keep their look over white.
    const tint = createCanvas(3, 1),
      ink = tint.getContext("2d");
    ink.fillStyle = "#808080";
    ink.fillRect(0, 0, 1, 1);
    ink.fillStyle = "#F5B58F";
    ink.fillRect(1, 0, 1, 1);
    ink.fillStyle = "#FBFBF8";
    ink.fillRect(2, 0, 1, 1);
    const copy = createCanvas(1, 1);
    drawTransparentLogo(copy as unknown as HTMLCanvasElement, {
      image: tint as unknown as CanvasImageSource,
      width: 3,
      height: 1,
    });
    const over = (x: number) => {
      const [r, g, b, a] = at(copy, x, 0);
      return [r!, g!, b!].map((c) => Math.round((c * a!) / 255 + 255 * (1 - a! / 255)));
    };
    over(0).forEach((value) => expect(Math.abs(value - 128)).toBeLessThanOrEqual(2));
    over(1).forEach((value, channel) => expect(Math.abs(value - [245, 181, 143][channel]!)).toBeLessThanOrEqual(2));
    expect(at(copy, 2, 0)[3]).toBe(0);
  });
  it("puts the reversed copy on dark surfaces in both the PNG and the editable SVG", () => {
    const { snapshot } = brandAssetFixture({ layout: "split", graphic: "fine_lines" }),
      { fonts, images } = actualRenderInputs(),
      canvas = createCanvas(1, 1);
    const fitted = drawBrandArtwork(
      canvas as unknown as HTMLCanvasElement,
      createBrandApplication(snapshot, BRAND_APPLICATIONS[1]),
      images,
      fonts,
    );
    const logo = fitted.nodes.find((node) => node.kind === "image")!;
    if (logo.kind !== "image") throw new Error("logo");
    expect(logo.source).toBe("logoReversed");
    // Posts place the logo at the top left of its box.
    expect(logo.anchor).toBe("start");
    const scale = Math.min(logo.width / 400, logo.height / 200),
      left = logo.x,
      top = logo.y;
    const pixel = (x: number, y: number) => [
      ...canvas.getContext("2d").getImageData(Math.round(left + x * scale), Math.round(top + y * scale), 1, 1).data,
    ];
    // The ink mark turns white; the logo's white background becomes the Forest surface.
    expect(pixel(200, 100)).toEqual([255, 255, 255, 255]);
    expect(pixel(30, 100)).toEqual([37, 70, 61, 255]);
    expect(new TextDecoder().decode(editableBrandSvg(fitted, images))).toContain(
      `href="${images.logoReversed.dataUrl}"`,
    );
  });
  it("names type styles in plain words instead of saved style keys", () => {
    const { snapshot } = brandAssetFixture(),
      styles = [
        { key: "guide_heading", role: "Headline", family: "Fraunces", weight: 600, style: "normal" as const },
        { key: "clear_body", role: "Body", family: "Manrope", weight: 400, style: "normal" as const },
        { key: "action_label", role: "Labels", family: "Manrope", weight: 600, style: "normal" as const },
      ];
    const named = {
      ...snapshot,
      typography: styles,
      design: { ...snapshot.design, headingStyleKey: "guide_heading", bodyStyleKey: "clear_body" },
    };
    expect(
      plainBrandNotes(
        named,
        "Use guide_heading at 48–64 px. Set clear_body at 16–18 px, and action_label at 14–16 px. Keep body copy calm.",
      ),
    ).toBe(
      "Use headings at 48–64 px. Set body text at 16–18 px, and buttons and labels at 14–16 px. Keep body copy calm.",
    );
    expect(plainBrandNotes(snapshot, "Pair heading with body; avoid hero_image_overlay.")).toBe(
      "Pair heading with body; avoid hero image overlay.",
    );
  });
  it.each([
    ["茶屋 カフェ", "Noto Sans JP", "ltr"],
    ["茶屋 Studio", "Noto Sans SC", "ltr"],
    ["한글", "Noto Sans KR", "ltr"],
    ["مقهى Café", "Noto Sans Arabic", "rtl"],
    ["שָׁלוֹם Studio", "Noto Sans Hebrew", "rtl"],
    ["क्षेत्र Studio", "Noto Sans Devanagari", "ltr"],
    ["ਪੰਜਾਬ Studio", "Noto Sans Gurmukhi", "ltr"],
  ])(
    "draws %s with the selected real font inside its text region and preserves editable Unicode",
    (name, family, direction) => {
      const { fonts, images } = actualRenderInputs([family]),
        canvas = createCanvas(1, 1);
      const art: BrandArtwork = {
        width: 640,
        height: 220,
        title: name,
        nodes: [
          { kind: "rect", x: 0, y: 0, width: 640, height: 220, fill: "#FFFFFF" },
          { kind: "text", text: name, family, weight: 400, size: 64, x: 40, y: 140, maxWidth: 540, color: "#000000" },
        ],
      };
      const fitted = drawBrandArtwork(canvas as unknown as HTMLCanvasElement, art, images, fonts);
      const pixels = canvas.getContext("2d").getImageData(0, 0, 640, 220).data;
      let minX = 640,
        maxX = 0,
        ink = 0;
      for (let index = 0; index < pixels.length; index += 4)
        if (pixels[index]! < 128) {
          const x = (index / 4) % 640;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          ink++;
        }
      expect(ink).toBeGreaterThan(500);
      expect(minX).toBeGreaterThanOrEqual(38);
      expect(maxX).toBeLessThanOrEqual(582);
      if (direction === "rtl") expect(maxX).toBeGreaterThan(560);
      else expect(minX).toBeLessThan(60);
      const svg = new TextDecoder().decode(editableBrandSvg(fitted, images));
      expect(svg).toContain(`font-family="${family}"`);
      expect(svg).toContain(`direction="${direction}" unicode-bidi="isolate" text-anchor="start"`);
      expect(svg).toContain(`<text x="${direction === "rtl" ? 580 : 40}"`);
      expect(svg).toContain(`>${name}</text>`);
    },
  );
  it("renders multilingual selections throughout the actual board and centered template", async () => {
    const f = brandAssetFixture({ layout: "centered" }, "مقهى Studio"),
      font = brandBoardFont("Noto Sans Arabic")!;
    const snapshot = {
      ...f.snapshot,
      heading: { ...f.snapshot.heading, family: font.family, font },
      body: { ...f.snapshot.body, family: font.family, font },
    };
    const { fonts, images } = actualRenderInputs([font.family]);
    const slogan = "قهوة كل صباح";
    for (const [art, expected] of [
      [createFinalBrandBoard(snapshot), snapshot.name],
      [createBrandApplication(snapshot, BRAND_APPLICATIONS[3], brandCopy(snapshot, { slogan })), slogan],
    ] as const) {
      const canvas = createCanvas(1, 1),
        fitted = drawBrandArtwork(canvas as unknown as HTMLCanvasElement, art, images, fonts);
      expect(await sharp(canvas.toBuffer("image/png")).metadata()).toMatchObject({
        width: art.width,
        height: art.height,
      });
      const texts = fitted.nodes.filter((node) => node.kind === "text");
      expect(texts.every((node) => node.family === font.family)).toBe(true);
      expect(texts.map((node) => node.text).join(" ")).toContain(expected);
      expect(new TextDecoder().decode(editableBrandSvg(fitted, images))).toContain(
        'direction="rtl" unicode-bidi="isolate" text-anchor="start"',
      );
    }
  });
  it("keeps the complete long CJK name fitted identically in PNG and editable SVG", () => {
    const family = "Noto Sans JP",
      name = "茶屋".repeat(100),
      { fonts, images } = actualRenderInputs([family]),
      canvas = createCanvas(1, 1);
    const art: BrandArtwork = {
      width: 300,
      height: 120,
      title: name,
      nodes: [
        { kind: "rect", x: 0, y: 0, width: 300, height: 120, fill: "#FFFFFF" },
        { kind: "text", text: name, family, weight: 400, size: 30, x: 40, y: 80, maxWidth: 220, color: "#000000" },
      ],
    };
    const fitted = drawBrandArtwork(canvas as unknown as HTMLCanvasElement, art, images, fonts),
      node = fitted.nodes[1]!;
    expect(node).toMatchObject({ text: name, family, size: 10, textLength: 220 });
    const svg = new TextDecoder().decode(editableBrandSvg(fitted, images));
    expect(svg).toContain('textLength="220" lengthAdjust="spacingAndGlyphs"');
    expect(svg).toContain(`>${name}</text>`);
  });
});
