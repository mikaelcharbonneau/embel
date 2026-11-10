import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { unzipSync, zipSync } from "fflate";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND_BOARD_FONTS } from "../../../src/domain/brand-board-fonts";
import { brandAssetFixture, logoBytes, boardBytes } from "./fixtures";
import type { AccountLogoClient } from "../../../src/components/identity/account-logo-client";
import type { AccountIdentityClient } from "../../../src/components/identity/account-identity-client";
const fakes = vi.hoisted(() => ({ image: vi.fn(), fonts: vi.fn(), png: vi.fn() }));
vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  return { ...actual, zipSync: vi.fn(actual.zipSync) };
});
vi.mock("../../../src/features/brand-assets/client/browser-assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/brand-assets/client/browser-assets")>()),
  readBrandImage: fakes.image,
  loadBrandFonts: fakes.fonts,
  brandCanvasPng: fakes.png,
}));
import { buildBrandAssetPack } from "../../../src/features/brand-assets/client/build-pack";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  const f = brandAssetFixture(),
    releases = [vi.fn(), vi.fn(), vi.fn()],
    logo = createCanvas(100, 50),
    board = createCanvas(200, 300);
  logo.getContext("2d").fillRect(20, 10, 60, 30);
  board.getContext("2d").fillRect(10, 10, 180, 280);
  const image = (canvas: typeof logo, bytes: Uint8Array, release: () => void) => ({
    image: canvas,
    width: canvas.width,
    height: canvas.height,
    bytes,
    dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    release,
  });
  fakes.image
    .mockResolvedValueOnce(image(logo, logoBytes, releases[0]!))
    .mockResolvedValueOnce(image(board, boardBytes, releases[1]!));
  const names = new Map<string, string>();
  for (const font of BRAND_BOARD_FONTS.filter((font) =>
    [f.snapshot.heading.family, f.snapshot.body.family].includes(font.family),
  )) {
    const name = `Pack_${font.id}`;
    GlobalFonts.registerFromPath(`public${font.file}`, name);
    names.set(font.family, name);
  }
  fakes.fonts.mockResolvedValue({ names, release: releases[2] });
  fakes.png.mockImplementation(async (canvas: typeof logo) => Uint8Array.from(canvas.toBuffer("image/png")));
  vi.stubGlobal("document", {
    createElement: (name: string) => {
      expect(name).toBe("canvas");
      return createCanvas(1, 1);
    },
  });
  const logoClient = {
    previewAsset: vi.fn(),
    readLogoVectorDetail: vi.fn().mockResolvedValue(null),
  } as unknown as AccountLogoClient;
  const identityClient = { preview: vi.fn() } as unknown as AccountIdentityClient;
  return { ...f, releases, logoClient, identityClient };
}
describe("complete brand asset archive", () => {
  it("contains real PNGs at promised sizes, exact originals, editable templates and matching font/color guidance", async () => {
    const f = await setup();
    const slogan = "Clear routes for every city.",
      positioning = "For city cyclists, a calm route planner.";
    const result = await buildBrandAssetPack({ ...f, slogan, positioning }, new AbortController().signal);
    expect(zipSync).not.toHaveBeenCalled();
    const archive = result.getArchive(),
      entries = unzipSync(archive);
    expect(result.getArchive()).toBe(archive);
    expect(zipSync).toHaveBeenCalledOnce();
    expect(Object.keys(entries)).toHaveLength(20);
    expect(entries["design-system/design-tokens.css"]).toBeDefined();
    expect(entries["design-system/design-tokens.json"]).toBeDefined();
    expect(result.vectorIncluded).toBe(false);
    expect(entries["logo/logo-vector.svg"]).toBeUndefined();
    expect(entries["logo/logo-original.png"]).toEqual(logoBytes);
    expect(entries["direction/selected-direction.png"]).toEqual(boardBytes);
    // The transparent and reversed logos are derived rasters with transparency, at the original size.
    for (const name of ["logo/logo-transparent.png", "logo/logo-reversed.png"])
      expect(await sharp(entries[name]!).metadata()).toMatchObject({
        format: "png",
        width: 100,
        height: 50,
        hasAlpha: true,
      });
    for (const file of result.files.filter((file) => file.category === "social" || file.category === "board")) {
      if (file.mimeType === "image/png")
        expect(await sharp(entries[file.name]!).metadata()).toMatchObject({
          format: "png",
          width: file.width,
          height: file.height,
        });
      else {
        const svg = new TextDecoder().decode(entries[file.name]),
          text = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/gu)].map((match) => match[1]).join(" ");
        expect(text).toContain(slogan);
        if (file.name.includes("post-")) expect(text).toContain(positioning);
        expect(text).not.toMatch(/Your (headline|tagline)|Add your message/u);
        expect(svg).toContain('font-family="Fraunces"');
      }
    }
    expect(new TextDecoder().decode(entries["README.txt"])).not.toContain("placeholder");
    expect(new TextDecoder().decode(entries["guides/brand-guide.html"])).toContain(
      "https://fonts.google.com/specimen/Fraunces",
    );
    expect(JSON.parse(new TextDecoder().decode(entries["guides/colors.json"])).colors).toEqual(f.snapshot.colors);
    expect(Object.keys(entries).some((name) => /\.ttf$|\.woff2?$/.test(name))).toBe(false);
    expect(fakes.image.mock.calls[0]?.[0]).toEqual(f.sourceLogo.preview.reference);
    expect(fakes.image.mock.calls[1]?.[0]).toEqual(f.system.board.asset);
    f.releases.forEach((release) => expect(release).toHaveBeenCalledOnce());
  });
  it("can download the prepared files after a failed compression without rebuilding the previews", async () => {
    const f = await setup();
    const result = await buildBrandAssetPack(f, new AbortController().signal);
    vi.mocked(zipSync).mockImplementationOnce(() => {
      throw new Error("Compression failed");
    });
    expect(() => result.getArchive()).toThrow("Compression failed");
    const archive = result.getArchive();
    expect(unzipSync(archive)["logo/logo-original.png"]).toEqual(logoBytes);
    expect(result.getArchive()).toBe(archive);
    expect(zipSync).toHaveBeenCalledTimes(2);
    expect(fakes.image).toHaveBeenCalledTimes(2);
  });
  it("does not include a saved vector from a different original logo", async () => {
    const f = await setup();
    vi.mocked(f.logoClient.readLogoVectorDetail).mockResolvedValue({
      revision: { sourcePreview: { ...f.snapshot.logo.reference, contentHash: "b".repeat(64) } },
    } as never);
    const result = await buildBrandAssetPack({ ...f, vectorRevisionId: "saved-vector" }, new AbortController().signal);
    expect(result.vectorIncluded).toBe(false);
    expect(result.files.some((file) => file.name === "logo/logo-vector.svg")).toBe(false);
  });
  it("releases loaded sources and produces no archive when font loading fails", async () => {
    const f = await setup();
    fakes.fonts.mockRejectedValue(new Error("Unavailable font"));
    await expect(buildBrandAssetPack(f, new AbortController().signal)).rejects.toThrow("Unavailable font");
    expect(f.releases[0]).toHaveBeenCalledOnce();
    expect(f.releases[1]).toHaveBeenCalledOnce();
    expect(fakes.png).not.toHaveBeenCalled();
  });
});
