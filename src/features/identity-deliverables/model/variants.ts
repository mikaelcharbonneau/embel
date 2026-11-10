import "server-only";
import {
  approvedLogoIdentitySnapshotSchema,
  logoVariantReviewSchema,
  resolvedLogoVariantSetSchema,
  type ApprovedLogoIdentitySnapshot,
  type LogoVariant,
  type LogoVariantReview,
  type ResolvedLogoVariantSet,
} from "../../../domain/logo-deliverables";
import {
  sha256,
  computeLogoVariantRenderHash,
  framedLogoDocument,
  logoPixelDimensions,
  LOGO_PREVIEW_LONG_EDGE,
} from "../server/render-policy";
import { canonicalLogoDocumentBytes } from "../../logo-vector/server/revisions";
import { serializeLogoSvg } from "../../logo-vector/model/svg";
import { runLogoProcess } from "../server/process";
export { computeLogoVariantRenderHash } from "../server/render-policy";
import type { LogoVectorComponent, LogoVectorDocument } from "../../../domain/logo-vector";
import {
  flattenLogoPaths,
  getLogoComponentPaintedBounds,
  getLogoPathPaintedBounds,
  validateLogoVectorDocument,
  type LogoPaintedBounds,
} from "../../logo-vector/model/geometry";

export type ProposedLogoVariant = {
  key: string;
  role: LogoVariant["role"];
  colorway: LogoVariant["colorway"];
  clearSpace: number;
  minimumDigitalSize: number | null;
} & (
  | { applicability: { status: "applicable" }; document: LogoVectorDocument }
  | { applicability: { status: "not_applicable"; reason: "no_symbol" | "inseparable_artwork" }; document: null }
);
export type ProposedLogoVariantSet = {
  approvedLogoId: string;
  directionApprovalId: string;
  items: ProposedLogoVariant[];
};
export type ReviewedLogoVariant = { variant: LogoVariant; review: LogoVariantReview; document: LogoVectorDocument };
export type ProposedVariantPreview = { svg: Uint8Array; png: Uint8Array; renderHash: string };

export class LogoVariantError extends Error {
  constructor(
    public readonly code: "approval_required" | "review_required" | "preview_renderer_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "LogoVariantError";
  }
}

const roles = ["primary", "horizontal", "stacked", "symbol_only"] as const;
const colorways = ["black", "white", "color"] as const;

function union(bounds: readonly LogoPaintedBounds[]): LogoPaintedBounds {
  if (!bounds.length)
    throw new LogoVariantError("approval_required", "The approved logo needs visible vector artwork.");
  return bounds.reduce((all, next) => ({
    minX: Math.min(all.minX, next.minX),
    minY: Math.min(all.minY, next.minY),
    maxX: Math.max(all.maxX, next.maxX),
    maxY: Math.max(all.maxY, next.maxY),
  }));
}
function paintedBounds(document: LogoVectorDocument): LogoPaintedBounds {
  return union(
    flattenLogoPaths(document)
      .map(getLogoPathPaintedBounds)
      .filter((value): value is LogoPaintedBounds => value !== null),
  );
}
function groupBounds(components: readonly LogoVectorComponent[]): LogoPaintedBounds | null {
  if (!components.length) return null;
  const bounds = components.map(getLogoComponentPaintedBounds);
  // Every selected component must have real visible geometry.
  if (bounds.some((value) => value === null)) return null;
  return union(bounds as LogoPaintedBounds[]);
}
const width = (bounds: LogoPaintedBounds) => bounds.maxX - bounds.minX;
const height = (bounds: LogoPaintedBounds) => bounds.maxY - bounds.minY;
const spacing = (bounds: LogoPaintedBounds) => Math.min(width(bounds), height(bounds)) * 0.25;

function frame(components: LogoVectorComponent[]): LogoVectorDocument {
  const bounds = groupBounds(components);
  if (!bounds) throw new LogoVariantError("approval_required", "The selected components need visible vector artwork.");
  // Whole-unit outward rounding avoids clipping at floating-point boundaries.
  // Recommended clear space stays separate until it is visually reviewed.
  const x = Math.floor(bounds.minX),
    y = Math.floor(bounds.minY);
  return validateLogoVectorDocument({
    version: 1,
    components,
    viewBox: [x, y, Math.ceil(bounds.maxX) - x, Math.ceil(bounds.maxY) - y],
  });
}
function translated(
  component: LogoVectorComponent,
  bounds: LogoPaintedBounds,
  x: number,
  y: number,
): LogoVectorComponent {
  const copy = structuredClone(component);
  copy.transform.x += x - bounds.minX;
  copy.transform.y += y - bounds.minY;
  return copy;
}
function arrangement(
  document: LogoVectorDocument,
  role: "horizontal" | "stacked",
  symbols: LogoPaintedBounds,
  lettering: LogoPaintedBounds,
): LogoVectorDocument {
  const gap = spacing(paintedBounds(document));
  const wide = role === "horizontal";
  const totalWidth = Math.max(width(symbols), width(lettering));
  const totalHeight = Math.max(height(symbols), height(lettering));
  // Preserve path data, proportions, internal group placement and paint order.
  return frame(
    document.components.map((component) =>
      component.role === "symbol"
        ? translated(
            component,
            symbols,
            wide ? 0 : (totalWidth - width(symbols)) / 2,
            wide ? (totalHeight - height(symbols)) / 2 : 0,
          )
        : translated(
            component,
            lettering,
            wide ? width(symbols) + gap : (totalWidth - width(lettering)) / 2,
            wide ? (totalHeight - height(lettering)) / 2 : height(symbols) + gap,
          ),
    ),
  );
}
function recolored(document: LogoVectorDocument, colorway: LogoVariant["colorway"]): LogoVectorDocument {
  const copy = structuredClone(document);
  if (colorway !== "color") {
    const color = colorway === "black" ? "#000000" : "#FFFFFF";
    for (const component of copy.components)
      for (const path of component.paths) {
        if (path.fill) path.fill.color = color;
        if (path.stroke) path.stroke.color = color;
      }
  }
  // No guessed palette assignment: color keeps the exact approved paint.
  return validateLogoVectorDocument(copy);
}

/** Server preparation consumes a resolved approval. Proposals are geometry, never stored files or approvals. */
export function proposeLogoVariants(snapshot: ApprovedLogoIdentitySnapshot): ProposedLogoVariantSet {
  const approved = approvedLogoIdentitySnapshotSchema.safeParse(snapshot);
  if (!approved.success)
    throw new LogoVariantError(
      "approval_required",
      "An approved logo and matching approved identity direction are required.",
    );
  const source = validateLogoVectorDocument(approved.data.logoDocument);
  if (sha256(canonicalLogoDocumentBytes(source)) !== approved.data.logo.documentHash)
    throw new LogoVariantError("approval_required", "The approved logo document has changed.");
  const symbols = source.components.filter((component) => component.role === "symbol");
  const lettering = source.components.filter((component) => component.role === "lettering");
  const symbolBounds = groupBounds(symbols),
    letteringBounds = groupBounds(lettering);
  const separable =
    symbolBounds !== null &&
    letteringBounds !== null &&
    source.components.every((component) => component.role === "symbol" || component.role === "lettering");
  const items: ProposedLogoVariant[] = [];
  for (const role of roles) {
    let document: LogoVectorDocument | null = null;
    let reason: "no_symbol" | "inseparable_artwork" = "inseparable_artwork";
    if (role === "primary") document = source;
    else if (role === "symbol_only") {
      if (symbolBounds) document = frame(structuredClone(symbols));
      else reason = symbols.length ? "inseparable_artwork" : "no_symbol";
    } else if (separable) document = arrangement(source, role, symbolBounds, letteringBounds);
    const clearSpace = document ? spacing(paintedBounds(document)) : 0;
    for (const colorway of colorways) {
      const common = { key: `${role}:${colorway}`, role, colorway, clearSpace, minimumDigitalSize: null };
      items.push(
        document
          ? { ...common, applicability: { status: "applicable" }, document: recolored(document, colorway) }
          : { ...common, applicability: { status: "not_applicable", reason }, document: null },
      );
    }
  }
  return {
    approvedLogoId: approved.data.logoApproval.id,
    directionApprovalId: approved.data.directionApproval.id,
    items,
  };
}

/** Requires the shared resolver's verified documents; this function never resolves or manufactures asset bytes. */
export function validateVariantReview(
  variants: ResolvedLogoVariantSet,
  review: LogoVariantReview,
): readonly ReviewedLogoVariant[] {
  const resolved = resolvedLogoVariantSetSchema.safeParse(variants),
    accepted = logoVariantReviewSchema.safeParse(review);
  const reject = (): never => {
    throw new LogoVariantError(
      "review_required",
      "Review every applicable arrangement and color version from this exact approved logo and identity direction.",
    );
  };
  if (!resolved.success || !accepted.success) return reject();
  const { set, items } = resolved.data;
  const receipt = accepted.data;
  if (
    receipt.ownerId !== set.ownerId ||
    receipt.projectId !== set.projectId ||
    receipt.variantSetId !== set.id ||
    receipt.approvedLogoId !== set.approvedLogoId ||
    receipt.directionApprovalId !== set.directionApprovalId
  )
    return reject();
  const applicable = items.filter((item) => item.variant.applicability.status === "applicable");
  for (const role of roles) {
    if (role === "primary" || applicable.some((item) => item.variant.role === role)) {
      if (
        !colorways.every((colorway) =>
          applicable.some((item) => item.variant.role === role && item.variant.colorway === colorway),
        )
      )
        return reject();
    }
  }
  if (!applicable.length || receipt.acceptedVariants.length !== applicable.length) return reject();
  return applicable.map(({ variant, document }) => {
    if (
      !document ||
      !receipt.acceptedVariants.some((item) => item.variantId === variant.id && item.renderHash === variant.renderHash)
    )
      return reject();
    if (
      sha256(canonicalLogoDocumentBytes(document)) !== variant.documentAsset?.contentHash ||
      computeLogoVariantRenderHash(variant, document) !== variant.renderHash
    )
      return reject();
    return { variant, review: receipt, document: validateLogoVectorDocument(document) };
  });
}

/** Draft-only actual bytes. This neither approves the artwork nor produces final export receipts. */
export async function renderProposedVariantPreview(
  variant: ProposedLogoVariant,
  signal: AbortSignal,
): Promise<ProposedVariantPreview | null> {
  signal.throwIfAborted();
  if (variant.applicability.status === "not_applicable") return null;
  const document = framedLogoDocument(variant.document!, variant.clearSpace);
  const svg = serializeLogoSvg(document);
  const renderHash = computeLogoVariantRenderHash(variant, variant.document!);
  const png = await runLogoProcess<Uint8Array>(
    { operation: "png", svg, ...logoPixelDimensions(document, LOGO_PREVIEW_LONG_EDGE) },
    signal,
  );
  return { svg, png, renderHash };
}
