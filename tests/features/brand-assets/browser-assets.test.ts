// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brandAssetFixture, logoBytes } from "./fixtures";
import { BRAND_BOARD_FONTS, brandBoardFont } from "../../../src/domain/brand-board-fonts";
import { boundedBrandAssetWork, BRAND_ASSET_TIMEOUT_MS, loadBrandFonts, readBrandImage } from "../../../src/features/brand-assets/client/browser-assets";
import { brandCopy, createBrandApplication, BRAND_APPLICATIONS } from "../../../src/features/brand-assets/model/artwork";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Image", class { src = ""; naturalWidth = 400; naturalHeight = 200; decode = async () => {}; });
  const f = brandAssetFixture(), release = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(logoBytes, { headers: { "content-type": "image/png" } })));
  return { ...f, release, preview: vi.fn(async () => ({ url: "blob:private-logo", release })) };
}
describe("browser asset verification and resource lifetimes", () => {
  it("rechecks actual immutable raster bytes and releases the private preview", async () => {
    const f = setup(), read = await readBrandImage(f.snapshot.logo.reference, "image/png", f.preview, new AbortController().signal);
    expect(read.bytes).toEqual(logoBytes); expect(read.dataUrl).toBe(`data:image/png;base64,${Buffer.from(logoBytes).toString("base64")}`);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("blob:private-logo", expect.objectContaining({ credentials: "omit", mode: "same-origin", redirect: "error" }));
    read.release(); expect(f.release).toHaveBeenCalledOnce(); expect(read.image.src).toBe("");
  });
  it.each(["hash", "signature", "mime", "remote"])("rejects %s mismatch without exporting substituted artwork", async mode => {
    const f = setup();
    const reference = mode === "hash" ? { ...f.snapshot.logo.reference, contentHash: "b".repeat(64) } : f.snapshot.logo.reference;
    if (mode === "signature") vi.stubGlobal("fetch", vi.fn(async () => new Response("not an image", { headers: { "content-type": "image/png" } })));
    if (mode === "mime") vi.stubGlobal("fetch", vi.fn(async () => new Response(logoBytes, { headers: { "content-type": "text/html" } })));
    if (mode === "remote") f.preview.mockResolvedValue({ url: "https://untrusted.example/image", release: f.release });
    await expect(readBrandImage(reference, "image/png", f.preview, new AbortController().signal)).rejects.toMatchObject({ reason: "source" });
    expect(f.release).toHaveBeenCalledOnce(); if (mode === "remote") expect(fetch).not.toHaveBeenCalled();
  });
  it("releases a preview arriving after cancellation", async () => {
    const f = setup(), controller = new AbortController(); let resolve!: (value: { url: string; release(): void }) => void;
    const pending = readBrandImage(f.snapshot.logo.reference, "image/png", () => new Promise(yes => { resolve = yes; }), controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolve({ url: "blob:late-private-logo", release: f.release }); await new Promise(yes => setTimeout(yes, 0));
    expect(f.release).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });
  it("loads exact bundled font bytes with their real variable weights and releases loaded faces", async () => {
    const f = setup(), descriptors: unknown[] = [], add = vi.fn(), remove = vi.fn();
    vi.stubGlobal("FontFace", class { status = "unloaded"; constructor(readonly name: string, readonly bytes: ArrayBuffer, descriptor: unknown) { descriptors.push(descriptor); } async load() { this.status = "loaded"; return this; } });
    Object.defineProperty(document, "fonts", { configurable: true, value: { add, delete: remove } });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(readFileSync(`public${path}`))));
    const copy = brandCopy(f.snapshot, { slogan: "Clear routes for every city." });
    const fonts = await loadBrandFonts([createBrandApplication(f.snapshot, BRAND_APPLICATIONS[1], copy)], new AbortController().signal);
    expect([...fonts.names.keys()]).toEqual(["Fraunces", "Manrope"]); expect(descriptors).toEqual([{ style: "normal", weight: "100 900", display: "block" }, { style: "normal", weight: "200 800", display: "block" }]);
    expect(add).toHaveBeenCalledTimes(2); fonts.release(); expect(remove).toHaveBeenCalledTimes(2);
    expect(BRAND_BOARD_FONTS.map(font => font.family)).toContain("Lora");
  });
  it("does not load altered font bytes or silently use a fallback font", async () => {
    const f = setup(), load = vi.fn();
    vi.stubGlobal("FontFace", class { load = load; });
    Object.defineProperty(document, "fonts", { configurable: true, value: { add: vi.fn(), delete: vi.fn() } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("changed font")));
    await expect(loadBrandFonts([createBrandApplication(f.snapshot, BRAND_APPLICATIONS[1])], new AbortController().signal)).rejects.toMatchObject({ reason: "font" });
    expect(load).not.toHaveBeenCalled();
  });
  it("loads only the selected full CJK font and verifies bytes beyond the former 2 MiB limit", async () => {
    const f = setup(), font = brandBoardFont("Noto Sans SC")!, add = vi.fn(), remove = vi.fn(), loaded: ArrayBuffer[] = [];
    vi.stubGlobal("FontFace", class { status = "unloaded"; constructor(_name: string, readonly bytes: ArrayBuffer) { loaded.push(bytes); } async load() { this.status = "loaded"; return this; } });
    Object.defineProperty(document, "fonts", { configurable: true, value: { add, delete: remove } });
    const original = readFileSync(`public${font.file}`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(original)));
    const snapshot = { ...f.snapshot, name: "茶屋 Studio", heading: { ...f.snapshot.heading, family: font.family, font }, body: { ...f.snapshot.body, family: font.family, font } };
    const art = createBrandApplication(snapshot, BRAND_APPLICATIONS[3]);
    const fonts = await loadBrandFonts([art, art], new AbortController().signal);
    expect(original.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(font.file, expect.objectContaining({ cache: "force-cache", mode: "same-origin", credentials: "omit", redirect: "error" }));
    expect(loaded).toHaveLength(1); expect(Buffer.from(loaded[0]!).equals(original)).toBe(true);
    expect([...fonts.names.keys()]).toEqual([font.family]); expect(add).toHaveBeenCalledOnce();
    fonts.release(); expect(remove).toHaveBeenCalledOnce();
  });
  it.each([["茶屋", "font_coverage"], ["Tea 🍵", "unsupported_text"]])("rejects %s before fetching an incompatible saved font", async (name, reason) => {
    const f = setup();
    vi.stubGlobal("FontFace", class {});
    Object.defineProperty(document, "fonts", { configurable: true, value: { add: vi.fn(), delete: vi.fn() } });
    const art = createBrandApplication({ ...f.snapshot, name }, BRAND_APPLICATIONS[3]);
    await expect(loadBrandFonts([art], new AbortController().signal)).rejects.toMatchObject({ reason });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects appended bytes at the selected font's exact bound without registering it", async () => {
    const f = setup(), font = brandBoardFont(f.snapshot.heading.family)!, add = vi.fn();
    vi.stubGlobal("FontFace", class {});
    Object.defineProperty(document, "fonts", { configurable: true, value: { add, delete: vi.fn() } });
    const original = readFileSync(`public${font.file}`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.concat([original, Buffer.from([0])]))));
    await expect(loadBrandFonts([createBrandApplication(f.snapshot, BRAND_APPLICATIONS[3])], new AbortController().signal)).rejects.toMatchObject({ reason: "size" });
    expect(add).not.toHaveBeenCalled();
  });
  it("bounds a browser operation that never settles", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const pending = boundedBrandAssetWork(controller.signal, () => new Promise(() => {}));
    const checked = expect(pending).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(BRAND_ASSET_TIMEOUT_MS); await checked;
  });
});
