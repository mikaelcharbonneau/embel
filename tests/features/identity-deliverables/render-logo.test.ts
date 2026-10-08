import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import * as renderer from "../../../src/features/identity-deliverables/server/render-logo";
import * as verifier from "../../../src/features/identity-deliverables/server/verify-output";
import { assertSupportedExportRuntime, computeLogoVariantRenderHash, framedLogoDocument, logoPixelDimensions } from "../../../src/features/identity-deliverables/server/render-policy";
import { validateVariantReview } from "../../../src/features/identity-deliverables/model/variants";
import { resolvedFixture, syntheticDocument, types } from "./fixtures";

export function reviewedFixture(colorway: "black" | "white" | "color" = "color", document = syntheticDocument()) {
  const { resolved, review } = resolvedFixture(document, computeLogoVariantRenderHash);
  return validateVariantReview(resolved, review).find(v => v.variant.colorway === colorway)!;
}

describe("synthetic actual logo file rendering", () => {
  it("provides actual production and independent verification", () => {
    expect(renderer.renderLogoFiles).toBeTypeOf("function");
    expect(verifier.verifyLogoFiles).toBeTypeOf("function");
  });
  it.each(types)("genuine path SVG/vector PDF/transparent PNG open for %s", async type => {
    const input = reviewedFixture("color", syntheticDocument(type)), options = { pngLongEdge: 512 as const };
    const files = await renderer.renderLogoFiles(input, options, new AbortController().signal);
    const checked = await verifier.verifyLogoFiles(files, input, options);
    expect(checked.pdf.pages).toBe(1);
    expect(checked.pdf.pathPaintCount).toBeGreaterThan(0);
    expect(checked.pdf.rasterPaintCount).toBe(0);
    expect(checked.svg.rasterReferenceCount).toBe(0);
    expect(checked.png.hasTransparentPixels).toBe(true);
    expect(checked.fidelity.meanAbsoluteNormalizedError).toBeLessThanOrEqual(0.01);
    expect(checked.fidelity.alphaBoundsDelta).toBeLessThanOrEqual(1);
    expect(checked.sourceVariantHash).toBe(input.variant.renderHash);
  });
  it.each([512, 1024, 2048, 4096] as const)("retains selected %i PNG long edge and true white alpha", async pngLongEdge => {
    const input = reviewedFixture("white"), options = { pngLongEdge };
    const expected = logoPixelDimensions(framedLogoDocument(input.document, input.variant.clearSpace), pngLongEdge);
    const files = await renderer.renderLogoFiles(input, options, new AbortController().signal);
    const checked = await verifier.verifyLogoFiles(files, input, options);
    expect(checked.png).toMatchObject({ ...expected, hasAlpha: true, hasTransparentPixels: true });
    expect(Math.max(checked.png.width, checked.png.height)).toBe(pngLongEdge);
  });
  it("preserves holes, quadratic/cubic curves, stroke styles, alpha and rotation", async () => {
    const document = syntheticDocument();
    document.components[0]!.paths[0]!.fill!.opacity = 0.45;
    document.components[0]!.paths[0]!.stroke = { color: "#3C7290", opacity: 0.7, width: 2, linecap: "round", linejoin: "round", miterLimit: 4 };
    document.components[0]!.transform = { x: 7, y: -2, scale: 0.9, rotation: 5 };
    document.components[1]!.paths.push({ id: "curve", d: "M 105 48 Q 120 38 135 48 C 145 58 160 38 170 48", fill: null, stroke: { color: "#205C30", opacity: 0.8, width: 3, linecap: "square", linejoin: "miter", miterLimit: 6 }, fillRule: "nonzero" });
    const input = reviewedFixture("color", document), options = { pngLongEdge: 1024 as const };
    const checked = await verifier.verifyLogoFiles(await renderer.renderLogoFiles(input, options, new AbortController().signal), input, options);
    expect(checked.pdf.pathPaintCount).toBeGreaterThanOrEqual(3);
    expect(checked.fidelity.meanAbsoluteNormalizedError).toBeLessThanOrEqual(0.01);
  });
  it("cannot render rejected, mutated or aborted review", async () => {
    const input = structuredClone(reviewedFixture()); input.document.components[0]!.paths[0]!.fill!.color = "#FF0000";
    await expect(renderer.renderLogoFiles(input, { pngLongEdge: 512 }, new AbortController().signal)).rejects.toThrow();
    await expect(renderer.renderLogoFiles(reviewedFixture(), { pngLongEdge: 512 }, AbortSignal.abort())).rejects.toThrow();
  });
  it("render metadata is bound before asynchronous process execution", async () => {
    const mutable = structuredClone(reviewedFixture()), expected = mutable.variant.renderHash;
    const pending = renderer.renderLogoFiles(mutable, { pngLongEdge: 512 }, new AbortController().signal);
    mutable.variant.renderHash = "f".repeat(64);
    expect((await pending).variantHash).toBe(expected);
  });
  it("rejects absent and unsupported options rather than choosing a hidden default", async () => {
    for (const options of [undefined, {}, { pngLongEdge: 3000 }]) await expect(renderer.renderLogoFiles(reviewedFixture(), options as renderer.LogoRenderOptions, new AbortController().signal)).rejects.toThrow();
  });
  it("unsupported_verifier_node_version_is_unavailable_before_job_claim", () => {
    for (const version of ["20.19.0", "22.0.0", "22.12.0", "23.0.0"]) expect(() => assertSupportedExportRuntime(version)).toThrow();
    for (const version of ["22.13.0", "24.15.0", "24.19.0"]) expect(() => assertSupportedExportRuntime(version)).not.toThrow();
  });
});
