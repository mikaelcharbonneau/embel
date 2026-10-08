import "server-only";
import { logoVariantReviewSchema, logoVariantSchema } from "../../../domain/logo-deliverables";
import type { ReviewedLogoVariant } from "../model/variants";
import { flattenLogoPaths, validateLogoVectorDocument } from "../../logo-vector/model/geometry";
import { canonicalLogoDocumentBytes } from "../../logo-vector/server/revisions";
import { serializeLogoSvg } from "../../logo-vector/model/svg";
import { sha256, assertFileBytes, computeLogoVariantRenderHash, framedLogoDocument, logoPixelDimensions, LogoFileError } from "./render-policy";
import { runLogoProcess } from "./process";

export type LogoRenderOptions = { pngLongEdge: 512 | 1024 | 2048 | 4096 };
export type RenderedLogoFiles = { svg: Uint8Array; pdf: Uint8Array; png: Uint8Array; width: number; height: number; variantHash: string };
export function validateLogoRenderOptions(options: LogoRenderOptions): LogoRenderOptions {
  if (!options || Object.keys(options).length !== 1 || ![512, 1024, 2048, 4096].includes(options.pngLongEdge)) throw new LogoFileError("invalid_options", "Choose an explicit supported PNG long edge.");
  return { pngLongEdge: options.pngLongEdge };
}
/** Server callers must supply P1-resolved owned geometry, never browser approval DTOs. */
export function assertReviewedLogoVariant(input: ReviewedLogoVariant): void {
  const variant = logoVariantSchema.safeParse(input.variant), review = logoVariantReviewSchema.safeParse(input.review);
  if (!variant.success || !review.success || variant.data.applicability.status !== "applicable" || !variant.data.documentAsset || !variant.data.preview
    || variant.data.documentAsset.ownerId !== review.data.ownerId || variant.data.documentAsset.projectId !== review.data.projectId
    || variant.data.preview.verification.mimeType !== "image/png"
    || !review.data.acceptedVariants.some(v => v.variantId === variant.data.id && v.renderHash === variant.data.renderHash)
    || sha256(canonicalLogoDocumentBytes(input.document)) !== variant.data.documentAsset.contentHash
    || computeLogoVariantRenderHash(variant.data, validateLogoVectorDocument(input.document)) !== variant.data.renderHash) {
    throw new LogoFileError("verification_failed", "The file must match the exact reviewed variant and approved source.");
  }
}
export function snapshotReviewedLogoVariant(input: ReviewedLogoVariant): ReviewedLogoVariant {
  const frozen = { variant: logoVariantSchema.parse(input.variant), review: logoVariantReviewSchema.parse(input.review), document: validateLogoVectorDocument(input.document) };
  assertReviewedLogoVariant(frozen);
  return frozen;
}
export async function renderLogoFiles(input: ReviewedLogoVariant, rawOptions: LogoRenderOptions, signal: AbortSignal): Promise<RenderedLogoFiles> {
  signal.throwIfAborted();
  const options = validateLogoRenderOptions(rawOptions);
  input = snapshotReviewedLogoVariant(input);
  const document = framedLogoDocument(input.document, input.variant.clearSpace);
  const svg = serializeLogoSvg(document), dimensions = logoPixelDimensions(document, options.pngLongEdge);
  const rendered = await runLogoProcess<{ pdf: Uint8Array; png: Uint8Array }>({ operation: "logo", svg, paths: flattenLogoPaths(document), viewBox: document.viewBox, variantHash: input.variant.renderHash, ...dimensions }, signal);
  assertFileBytes(svg); assertFileBytes(rendered.pdf); assertFileBytes(rendered.png);
  signal.throwIfAborted();
  return { svg, ...rendered, ...dimensions, variantHash: input.variant.renderHash! };
}
