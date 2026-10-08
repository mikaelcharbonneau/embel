import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { renderLogoFiles, type RenderedLogoFiles } from "../../../src/features/identity-deliverables/server/render-logo";
import { verifyLogoFiles } from "../../../src/features/identity-deliverables/server/verify-output";
import { computeLogoVariantRenderHash } from "../../../src/features/identity-deliverables/server/render-policy";
import { validateVariantReview } from "../../../src/features/identity-deliverables/model/variants";
import { hashBytes, resolvedFixture, syntheticDocument } from "./fixtures";
const fixture = resolvedFixture(syntheticDocument(), computeLogoVariantRenderHash);
const input = validateVariantReview(fixture.resolved, fixture.review)[2]!;
const options = { pngLongEdge: 512 as const };
let files: RenderedLogoFiles;
beforeAll(async () => { files = await renderLogoFiles(input, options, new AbortController().signal); });

function imagePdf(png: Uint8Array): Promise<Uint8Array> {
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: [600, 400], margin: 0 }), chunks: Uint8Array[] = [];
    doc.on("data", chunk => chunks.push(chunk)); doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.image(Buffer.from(png), 0, 0, { width: 600, height: 400 }); doc.end();
  });
}
describe("synthetic independent output verification", () => {
  it("binds each actual byte hash and exact MIME", async () => {
    const checked = await verifyLogoFiles(files, input, options);
    for (const key of ["svg", "pdf", "png"] as const) {
      expect(checked[key].contentHash).toBe(hashBytes(files[key]));
      expect(checked[key].byteLength).toBe(files[key].byteLength);
    }
    expect(checked.pdf.mimeType).toBe("application/pdf");
  });
  it("verification snapshots Buffer inputs before asynchronous decoding", async () => {
    const captured = { ...files, svg: Buffer.from(files.svg), pdf: Buffer.from(files.pdf), png: Buffer.from(files.png) };
    const expectedHash = hashBytes(captured.pdf), pending = verifyLogoFiles(captured, input, options);
    captured.pdf.fill(0);
    const verified = await pending;
    expect(verified.pdf.contentHash).toBe(expectedHash);
  });
  it("rejects raster-wrapped SVG and image-only PDF", async () => {
    const rasterSvg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><image href="data:image/png;base64,${Buffer.from(files.png).toString("base64")}"/></svg>`);
    await expect(verifyLogoFiles({ ...files, svg: rasterSvg }, input, options)).rejects.toThrow();
    await expect(verifyLogoFiles({ ...files, pdf: await imagePdf(files.png) }, input, options)).rejects.toThrow();
  });
  it("corrupt, truncated or wrong-format bytes cannot verify", async () => {
    for (const key of ["svg", "pdf", "png"] as const) {
      await expect(verifyLogoFiles({ ...files, [key]: files[key].slice(0, 30) }, input, options)).rejects.toThrow();
      await expect(verifyLogoFiles({ ...files, [key]: new Uint8Array([1, 2, 3, 4]) }, input, options)).rejects.toThrow();
    }
  });
  it("rejects a hidden 2048 default when 512 was selected", async () => {
    const wrong = await renderLogoFiles(input, { pngLongEdge: 2048 }, new AbortController().signal);
    await expect(verifyLogoFiles(wrong, input, options)).rejects.toThrow();
  });
  it("rejects opaque or empty output and a different approved artwork", async () => {
    const opaque = await sharp(files.png).flatten({ background: "#ffffff" }).png().toBuffer();
    await expect(verifyLogoFiles({ ...files, png: opaque }, input, options)).rejects.toThrow();
    const wrongFixture = resolvedFixture(syntheticDocument("wordmark"), computeLogoVariantRenderHash);
    const wrongSource = validateVariantReview(wrongFixture.resolved, wrongFixture.review)[2]!;
    const wrong = await renderLogoFiles(wrongSource, options, new AbortController().signal);
    await expect(verifyLogoFiles({ ...files, pdf: wrong.pdf }, input, options)).rejects.toThrow();
    await expect(verifyLogoFiles({ ...files, variantHash: "0".repeat(64) }, input, options)).rejects.toThrow();
  });
});
