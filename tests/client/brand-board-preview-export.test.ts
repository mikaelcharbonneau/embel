// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { BOARD_PREVIEW_HEIGHT, BOARD_PREVIEW_TIMEOUT_MS, BOARD_PREVIEW_WIDTH, boardPreviewFilename, boundedBoardPreview, createBoardPreviewSnapshot, prepareBoardPreview, recheckBoardPreviewLogo } from "../../src/components/logo-creation/brand-board-preview-export";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";
import { inspirationCatalog } from "../../src/domain/inspiration";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
const blobs = new Map<string, Blob>();
const revoke = vi.fn(), drawImage = vi.fn(), text = vi.fn(), fillRect = vi.fn(), loadFont = vi.fn(), decode = vi.fn();
const contexts: string[] = [];
const context = { fillStyle: "", font: "", textBaseline: "", letterSpacing: "", fillRect, drawImage, fillText: text, measureText: (value: string) => ({ width: value.length * 10 }) };
const controls = { imageDecode: "ok", font: "ok", canvas: true, output: "ok" };
async function fixture() {
  const fixture = await syntheticRefinementWorkspaceHttp(true), account = { status: "ready" as const, userId: fixture.workspace.ownerId, generation: 1 };
  const output = await sharp({ create: { width: BOARD_PREVIEW_WIDTH, height: BOARD_PREVIEW_HEIGHT, channels: 3, background: "#f5f3ec" } }).png().toBuffer();
  const client = createAccountLogoClient(account, fixture.workspace.projectId, () => true, vi.fn(), fixture.fetcher);
  const snapshot = createBoardPreviewSnapshot({ name: "Élan & Co", logoType: "wordmark", choices: [], receipt: fixture.batch.slots[0]!.acceptedPreview!, logoNeedsReview: false });
  return { fixture, account, client, snapshot, output };
}
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", NodeBlob);
  blobs.clear(); revoke.mockReset(); drawImage.mockReset(); text.mockReset(); fillRect.mockReset(); loadFont.mockReset(); decode.mockReset(); contexts.length = 0;
  Object.assign(controls, { imageDecode: "ok", font: "ok", canvas: true, output: "ok" });
  let next = 0; const OriginalURL = URL;
  vi.stubGlobal("URL", class extends OriginalURL {
    static createObjectURL = (blob: Blob) => { const url = `blob:board-${++next}`; blobs.set(url, blob); return url; };
    static revokeObjectURL = (url: string) => { revoke(url); blobs.delete(url); };
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    expect(String(url)).toMatch(/^blob:/);
    return new Response(blobs.get(String(url)) ?? null, { status: blobs.has(String(url)) ? 200 : 404 });
  }));
  vi.stubGlobal("Image", class {
    src = ""; naturalWidth = 0; naturalHeight = 0;
    async decode() {
      decode();
      if (controls.imageDecode === "hang") return new Promise<void>(() => {});
      if (controls.imageDecode === "fail") throw new Error("Synthetic unreadable image");
      const blob = blobs.get(this.src); if (!blob) throw new Error("Missing synthetic blob");
      const metadata = await sharp(new Uint8Array(await blob.arrayBuffer())).metadata();
      this.naturalWidth = controls.imageDecode === "oversized" ? 9000 : metadata.width;
      this.naturalHeight = metadata.height;
    }
  });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => controls.font === "fallback" ? "sans-serif" : '"__GeistSans_test", "__GeistSans_Fallback_test"' }));
  loadFont.mockImplementation(async (font: string) => {
    contexts.push(font);
    if (controls.font === "hang") return new Promise(() => {});
    if (controls.font === "rejected") throw new Error("Synthetic rejected font request");
    return controls.font === "missing" ? [] : [{ status: "loaded" }];
  });
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: loadFont, check: () => true } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => controls.canvas ? context as never : null);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => {
    if (controls.output === "hang") return;
    callback(controls.output === "null" ? null : new Blob([controls.output === "invalid" ? "not a png" : new Uint8Array(f.output)], { type: controls.output === "wrong-mime" ? "image/jpeg" : "image/png" }));
  });
  f = await fixture();
});
afterEach(() => { f.client.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const prepare = (signal = new AbortController().signal) => boundedBoardPreview(signal, bounded => prepareBoardPreview(f.client, f.snapshot, bounded));

describe("local board PNG preview", () => {
  it("captures only displayed saved values, with detached inputs and no raw brief", () => {
    const choice = { referenceId: inspirationCatalog.find(row => row.tags.includes("blue"))!.id, elements: ["colors"], ensemble: false } as Parameters<typeof createBoardPreviewSnapshot>[0]["choices"][number];
    const input = { name: "Élan & Co", logoType: "wordmark" as const, choices: [choice], receipt: f.snapshot.receipt, logoNeedsReview: true, activity: "Private internal brief" };
    const snapshot = createBoardPreviewSnapshot(input);
    const before = JSON.stringify(snapshot);
    expect(snapshot.receipt).not.toBe(input.receipt);
    expect(snapshot.receipt.reference).not.toBe(input.receipt.reference);
    input.receipt = { ...input.receipt, reference: { ...input.receipt.reference, contentHash: "a".repeat(64) } }; choice.elements.length = 0;
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(before).not.toContain("Private internal brief");
    expect(snapshot.palette[0]!.hex).toBe("#2454DB");
    expect(snapshot.paletteSource).toBe("saved_inspiration");
    expect(snapshot.type).toMatchObject({ family: "Geist Sans", headingWeight: 600, tracking: "-0.03em" });
  });
  it("uses verified exact artwork and truthful proposal labels, then validates a decodable opaque PNG", async () => {
    const blob = await prepare();
    const metadata = await sharp(new Uint8Array(await blob.arrayBuffer())).metadata();
    expect(blob.type).toBe("image/png");
    expect(metadata).toMatchObject({ format: "png", width: 1600, height: 1100, hasAlpha: false });
    expect(drawImage).toHaveBeenCalledTimes(1);
    const [, x, y, width, height] = drawImage.mock.calls[0]!;
    expect(width).toBe(height); expect(x).toBeGreaterThan(64); expect(y).toBeGreaterThan(230);
    const labels = text.mock.calls.map(row => row[0]);
    expect(labels).toContain("Élan & Co"); expect(labels).toContain("BRAND BOARD · PREVIEW");
    expect(labels).toContain("Proposed palette"); expect(labels).toContain("Neutral starting point");
    expect(labels).toContain("Geist Sans · Default preview"); expect(labels).toContain("Heading · Semibold 600 · Tracking -0.03em");
    expect(labels).toContain("Saved selection"); expect(labels.join(" ")).toContain("Not SVG/PDF masters, transparent logo files or a final brand package");
    for (const color of f.snapshot.palette) expect(labels).toContain(color.hex);
    expect(labels.join(" ")).not.toContain("Tea shop");
    expect(fillRect.mock.calls[0]).toEqual([0, 0, 1600, 1100]);
    expect(contexts).toEqual(['400 24px "__GeistSans_test"', '500 24px "__GeistSans_test"', '600 24px "__GeistSans_test"']);
    expect(blobs.size).toBe(0); expect(revoke).toHaveBeenCalledTimes(2);
    expect(f.fixture.admissions).toEqual([]); expect(f.fixture.selections).toEqual([]); expect(f.fixture.quotes).toEqual([]);
  });
  it("retains stale-input guidance and the exact proposed 700-weight typography", async () => {
    f.snapshot = createBoardPreviewSnapshot({ name: "Saved name", logoType: "abstract", choices: [], receipt: f.snapshot.receipt, logoNeedsReview: true });
    await prepare();
    expect(text.mock.calls.map(row => row[0])).toContain("Saved selection · Review changed inputs");
    expect(text.mock.calls.map(row => row[0])).toContain("Heading · Bold 700 · Tracking -0.045em");
  });
  it.each([401, 403, 404])("refuses inaccessible source status %i without drawing or leaking a local URL", async status => {
    const client = createAccountLogoClient(f.account, f.fixture.workspace.projectId, () => true, vi.fn(), async () => new Response(null, { status }));
    try { await expect(boundedBoardPreview(new AbortController().signal, signal => prepareBoardPreview(client, f.snapshot, signal))).rejects.toBeTruthy(); }
    finally { client.dispose(); }
    expect(drawImage).not.toHaveBeenCalled(); expect(blobs.size).toBe(0);
  });
  it("refuses bytes that no longer match the selected receipt hash", async () => {
    const client = createAccountLogoClient(f.account, f.fixture.workspace.projectId, () => true, vi.fn(), async () => new Response(new Uint8Array(f.snapshot.receipt.verification.byteLength), { headers: { "content-type": "image/png" } }));
    try { await expect(boundedBoardPreview(new AbortController().signal, signal => prepareBoardPreview(client, f.snapshot, signal))).rejects.toMatchObject({ status: 502 }); }
    finally { client.dispose(); }
    expect(drawImage).not.toHaveBeenCalled(); expect(blobs.size).toBe(0);
  });
  it("rechecks the exact private source without generation or drawing before download", async () => {
    await boundedBoardPreview(new AbortController().signal, signal => recheckBoardPreviewLogo(f.client, f.snapshot, signal));
    expect(drawImage).not.toHaveBeenCalled(); expect(blobs.size).toBe(0);
    expect(f.fixture.admissions).toEqual([]); expect(f.fixture.selections).toEqual([]);
  });
  it.each(["fail", "oversized"])("rejects %s source decoding and releases its verified URL", async mode => {
    controls.imageDecode = mode;
    await expect(prepare()).rejects.toMatchObject({ reason: "image" });
    expect(drawImage).not.toHaveBeenCalled(); expect(blobs.size).toBe(0);
  });
  it("rejects a JPEG advertised as PNG even when its hash and length match", async () => {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).jpeg().toBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(value => value.toString(16).padStart(2, "0")).join("");
    f.snapshot = { ...f.snapshot, receipt: { ...f.snapshot.receipt, reference: { ...f.snapshot.receipt.reference, contentHash: hash }, verification: { ...f.snapshot.receipt.verification, contentHash: hash, byteLength: bytes.length } } };
    const client = createAccountLogoClient(f.account, f.fixture.workspace.projectId, () => true, vi.fn(), async () => new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } }));
    try { await expect(boundedBoardPreview(new AbortController().signal, signal => prepareBoardPreview(client, f.snapshot, signal))).rejects.toMatchObject({ reason: "image" }); }
    finally { client.dispose(); }
    expect(drawImage).not.toHaveBeenCalled(); expect(blobs.size).toBe(0);
  });
  it.each(["missing", "fallback", "rejected"])("does not silently substitute a %s Geist font", async mode => {
    controls.font = mode;
    await expect(prepare()).rejects.toMatchObject({ reason: "font" });
    expect(drawImage).not.toHaveBeenCalled(); expect(blobs.size).toBe(0);
  });
  it("fails closed when canvas is unsupported", async () => {
    controls.canvas = false;
    await expect(prepare()).rejects.toMatchObject({ reason: "canvas" }); expect(blobs.size).toBe(0);
  });
  it.each(["null", "invalid", "wrong-mime"])("rejects a %s PNG encoder result", async output => {
    controls.output = output;
    await expect(prepare()).rejects.toMatchObject({ reason: "canvas" }); expect(blobs.size).toBe(0);
  });
  it.each(["imageDecode", "font", "output"] as const)("bounds a hanging %s and releases the source", async phase => {
    vi.useFakeTimers(); controls[phase] = "hang";
    const pending = prepare(), assertion = expect(pending).rejects.toMatchObject({ reason: "timeout" });
    await vi.waitFor(() => expect(phase === "imageDecode" ? decode : phase === "font" ? loadFont : HTMLCanvasElement.prototype.toBlob).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(BOARD_PREVIEW_TIMEOUT_MS);
    await assertion;
    await vi.waitFor(() => expect(blobs.size).toBe(0));
  });
  it("releases a late verified URL after cancellation and never draws it", async () => {
    let resolve!: (value: { url: string; release(): void }) => void;
    const client = { previewAsset: vi.fn(() => new Promise<{ url: string; release(): void }>(done => { resolve = done; })) };
    const controller = new AbortController(), release = vi.fn();
    const pending = boundedBoardPreview(controller.signal, signal => prepareBoardPreview(client, f.snapshot, signal));
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await assertion;
    resolve({ url: "blob:late", release }); await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1); expect(drawImage).not.toHaveBeenCalled();
  });
  it("makes a safe PNG filename without identifiers or path characters", () => {
    expect(boardPreviewFilename(f.snapshot)).toBe("elan-co-board-preview.png");
    expect(boardPreviewFilename({ ...f.snapshot, name: "../../\n🚀/" })).toBe("brand-board-preview.png");
    expect(boardPreviewFilename({ ...f.snapshot, name: "A".repeat(300) })).toHaveLength(64 + "-board-preview.png".length);
  });
});
