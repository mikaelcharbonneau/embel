import "server-only";
import { approvedDeliverableSnapshotSchema, type ApprovedDeliverableSnapshot } from "../../../domain/logo-deliverables";
import { validateVariantReview } from "../model/variants";
import { serializeLogoSvg } from "../../logo-vector/model/svg";
import { framedLogoDocument, sha256, LogoFileError } from "./render-policy";
import { runLogoProcess } from "./process";
import type { PreparedExportFile } from "./export-types";
export const LOGO_SOCIAL_PRESETS = Object.freeze({
  "avatar-1024-contain-v1": { kind: "avatar", width: 1024, height: 1024 },
  "banner-1500x500-contain-v1": { kind: "banner", width: 1500, height: 500 },
} as const);
/** These generic presets contain the full reviewed clear-space canvas and never crop the logo. */
export async function renderSelectedSocial(input: ApprovedDeliverableSnapshot, signal: AbortSignal): Promise<readonly PreparedExportFile[]> {
  const snapshot = approvedDeliverableSnapshotSchema.parse(input), reviewed = validateVariantReview(snapshot.resolvedVariants, snapshot.variantReview);
  const source = reviewed.find(item => item.variant.role === "primary" && item.variant.colorway === "color");
  if (!source) throw new LogoFileError("verification_failed", "A reviewed primary color logo is required for social files.");
  const files: PreparedExportFile[] = [];
  for (const selection of snapshot.socialSelections) {
    signal.throwIfAborted();
    const preset = LOGO_SOCIAL_PRESETS[selection.presetId as keyof typeof LOGO_SOCIAL_PRESETS];
    if (!preset || preset.kind !== selection.kind) throw new LogoFileError("invalid_options", "Choose a reviewed social containment preset.");
    const document = structuredClone(framedLogoDocument(source.document, source.variant.clearSpace));
    const [x, y, width, height] = document.viewBox, targetRatio = preset.width / preset.height;
    const canvasWidth = Math.max(width, height * targetRatio), canvasHeight = Math.max(height, width / targetRatio);
    document.viewBox = [x - (canvasWidth - width) / 2, y - (canvasHeight - height) / 2, canvasWidth, canvasHeight];
    const bytes = await runLogoProcess<Uint8Array>({ operation: "png", svg: serializeLogoSvg(document), width: preset.width, height: preset.height }, signal);
    files.push({ name: `${selection.kind}-${selection.presetId}-${source.variant.id}.png`, role: selection.kind, mimeType: "image/png", bytes, contentHash: sha256(bytes), sourceVariantId: source.variant.id, verification: null });
  }
  return files;
}
