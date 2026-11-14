import "server-only";
import { createHash } from "node:crypto";
import type { LogoVariant } from "../../../domain/logo-deliverables";
import type { LogoVectorDocument } from "../../../domain/logo-vector";
import { validateLogoVectorDocument } from "../../logo-vector/model/geometry";
import { serializeLogoSvg } from "../../logo-vector/model/svg";

const LOGO_RENDER_POLICY = "fluid-logo-files-v1";
export const LOGO_PREVIEW_LONG_EDGE = 512;
export const LOGO_RENDER_DEADLINE_MS = 60_000;
const LOGO_MAX_DECODED_PIXELS = 16_777_216;
export const LOGO_MAX_FILE_BYTES = 52_428_800;
const LOGO_ENGINE_VERSIONS = Object.freeze({
  pdfkit: "0.20.2",
  resvg: "2.6.2",
  pdfjs: "6.2.108",
  sharp: "0.35.5",
});
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type VariantRenderBasis = Pick<LogoVariant, "role" | "colorway" | "clearSpace" | "minimumDigitalSize">;
export class LogoFileError extends Error {
  constructor(
    public readonly code:
      "invalid_options" | "unavailable" | "render_failed" | "verification_failed" | "size_limit" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "LogoFileError";
  }
}
export function assertSupportedExportRuntime(version = process.versions.node): void {
  const [major] = version.split(".").map(Number);
  if (!major || major < 24) throw new LogoFileError("unavailable", "Logo exports require Node 24 or newer.");
}
export function assertFileBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > LOGO_MAX_FILE_BYTES)
    throw new LogoFileError("size_limit", "The logo file exceeds the supported byte limit or is empty.");
}
/** The same reviewed clear-space canvas is used for previews and every format. */
export function framedLogoDocument(document: LogoVectorDocument, clearSpace: number): LogoVectorDocument {
  if (!Number.isFinite(clearSpace) || clearSpace < 0 || clearSpace > 1_000_000)
    throw new LogoFileError("invalid_options", "Clear space must be a finite non-negative value.");
  const source = validateLogoVectorDocument(document),
    [x, y, width, height] = source.viewBox;
  return validateLogoVectorDocument({
    ...structuredClone(source),
    viewBox: [x - clearSpace, y - clearSpace, width + clearSpace * 2, height + clearSpace * 2],
  });
}
export function computeLogoVariantRenderHash(variant: VariantRenderBasis, document: LogoVectorDocument): string {
  const svg = serializeLogoSvg(framedLogoDocument(document, variant.clearSpace));
  return sha256(
    JSON.stringify({
      policy: LOGO_RENDER_POLICY,
      preview: {
        longEdge: LOGO_PREVIEW_LONG_EDGE,
        renderer: LOGO_ENGINE_VERSIONS.resvg,
        background: "transparent",
        systemFonts: false,
      },
      role: variant.role,
      colorway: variant.colorway,
      clearSpace: variant.clearSpace,
      minimumDigitalSize: variant.minimumDigitalSize,
      svgHash: sha256(svg),
    }),
  );
}
export function logoPixelDimensions(document: LogoVectorDocument, longEdge: number): { width: number; height: number } {
  const [, , w, h] = document.viewBox;
  const width = w >= h ? longEdge : Math.max(1, Math.round((longEdge * w) / h));
  const height = h >= w ? longEdge : Math.max(1, Math.round((longEdge * h) / w));
  if (width * height > LOGO_MAX_DECODED_PIXELS)
    throw new LogoFileError("size_limit", "The selected dimensions exceed the decoded-pixel limit.");
  return { width, height };
}
