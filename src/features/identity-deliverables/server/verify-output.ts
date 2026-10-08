import "server-only";
import type { ReviewedLogoVariant } from "../model/variants";
import { flattenLogoPaths } from "../../logo-vector/model/geometry";
import { serializeLogoSvg, validateLogoVectorSvg } from "../../logo-vector/model/svg";
import { snapshotReviewedLogoVariant, validateLogoRenderOptions, type LogoRenderOptions, type RenderedLogoFiles } from "./render-logo";
import { assertFileBytes, framedLogoDocument, logoPixelDimensions, LOGO_ENGINE_VERSIONS, LOGO_RENDER_POLICY, LogoFileError, sha256 } from "./render-policy";
import { runLogoProcess } from "./process";

export type FileByteEvidence = { contentHash: string; byteLength: number; mimeType: string };
export type LogoFileVerification = {
  sourceVariantHash: string;
  rendererPolicy: string;
  verifierVersions: typeof LOGO_ENGINE_VERSIONS;
  svg: FileByteEvidence & { pathCount: number; rasterReferenceCount: 0; activeContentCount: 0; externalReferenceCount: 0 };
  pdf: FileByteEvidence & { pages: 1; pathPaintCount: number; rasterPaintCount: 0; activeContentCount: 0; externalReferenceCount: 0 };
  png: FileByteEvidence & { width: number; height: number; hasAlpha: true; hasTransparentPixels: true; hasVisiblePixels: true };
  fidelity: { meanAbsoluteNormalizedError: number; alphaBoundsDelta: number; pngPixelHash: string };
};
type ProcessVerification = { pathPaintCount: number; meanAbsoluteNormalizedError: number; alphaBoundsDelta: number; pngPixelHash: string };
const evidence = (bytes: Uint8Array, mimeType: string): FileByteEvidence => ({ contentHash: sha256(bytes), byteLength: bytes.byteLength, mimeType });

/** Actual-byte verification is independent of producer success and receipt metadata. */
export async function verifyLogoFiles(files: RenderedLogoFiles, source: ReviewedLogoVariant, rawOptions: LogoRenderOptions, signal: AbortSignal = new AbortController().signal): Promise<LogoFileVerification> {
  signal.throwIfAborted();
  const options = validateLogoRenderOptions(rawOptions);
  source = snapshotReviewedLogoVariant(source);
  for (const key of ["svg", "pdf", "png"] as const) assertFileBytes(files[key]);
  files = { ...files, svg: new Uint8Array(files.svg), pdf: new Uint8Array(files.pdf), png: new Uint8Array(files.png) };
  if (files.variantHash !== source.variant.renderHash) throw new LogoFileError("verification_failed", "The output is bound to a different reviewed variant.");
  const document = framedLogoDocument(source.document, source.variant.clearSpace), expectedSvg = serializeLogoSvg(document);
  const dimensions = logoPixelDimensions(document, options.pngLongEdge);
  const parsed = validateLogoVectorSvg(files.svg);
  if (sha256(files.svg) !== sha256(expectedSvg) || files.width !== dimensions.width || files.height !== dimensions.height) throw new LogoFileError("verification_failed", "The output differs from the reviewed geometry or frozen size.");
  const observed = await runLogoProcess<ProcessVerification>({ operation: "verify", ...dimensions, svg: expectedSvg, pdf: files.pdf, png: files.png, variantHash: files.variantHash, expectedViewBox: document.viewBox }, signal);
  return {
    sourceVariantHash: files.variantHash, rendererPolicy: LOGO_RENDER_POLICY, verifierVersions: LOGO_ENGINE_VERSIONS,
    svg: { ...evidence(files.svg, "image/svg+xml"), pathCount: flattenLogoPaths(parsed).length, rasterReferenceCount: 0, activeContentCount: 0, externalReferenceCount: 0 },
    pdf: { ...evidence(files.pdf, "application/pdf"), pages: 1, pathPaintCount: observed.pathPaintCount, rasterPaintCount: 0, activeContentCount: 0, externalReferenceCount: 0 },
    png: { ...evidence(files.png, "image/png"), ...dimensions, hasAlpha: true, hasTransparentPixels: true, hasVisiblePixels: true },
    fidelity: { meanAbsoluteNormalizedError: observed.meanAbsoluteNormalizedError, alphaBoundsDelta: observed.alphaBoundsDelta, pngPixelHash: observed.pngPixelHash },
  };
}
