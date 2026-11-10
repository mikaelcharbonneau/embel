import "server-only";
import { identityAssetReceiptSchema, type IdentityAssetReceipt, type LogoVariant } from "@/domain/logo-deliverables";
import { prepareLogoVariantsInputSchema, reviewLogoVariantsInputSchema } from "@/domain/logo-workspace";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import { logoId, logoOwner, type LogoMutationProducer } from "@/server/data/logo-transaction";
import { ApiError } from "@/server/http/errors";
import { canonicalLogoDocumentBytes } from "@/features/logo-vector/server/revisions";
import { canonicalIdentityInput } from "@/features/identity-directions/model/font-check-binding";
import { proposeLogoVariants, renderProposedVariantPreview, validateVariantReview } from "../model/variants";
import { sha256 } from "./render-policy";
import { createLogoDeliverablesService } from "./persistence";
const same = (a: unknown, b: unknown) => canonicalIdentityInput(a) === canonicalIdentityInput(b);
function stableId(key: string, part: string) {
  const hex = sha256(`${key}:${part}`).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
type Service = Pick<
  ReturnType<typeof createLogoDeliverablesService>,
  "readSources" | "getApprovedLogoIdentitySnapshot" | "resolveLogoVariantSet"
>;
/** Produces trusted evidence outside the short shared transaction. The generic
 * transaction then rechecks all current heads, exact sources and staged receipts. */
export function createLogoDeliverableProducers(dependencies: { assets: IdentityAssetStore; service?: Service }) {
  const service = dependencies.service ?? createLogoDeliverablesService(dependencies);
  const prepareLogoVariants: LogoMutationProducer = async (auth, projectId, command, providedSignal) => {
    const signal = providedSignal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (command.method !== "prepareLogoVariants") throw new ApiError("invalid_input");
    const body = prepareLogoVariantsInputSchema.parse(command.body),
      owner = logoOwner(auth);
    projectId = logoId(projectId);
    const source = await service.readSources(auth, projectId, signal);
    if (
      source.ownerId !== owner ||
      source.projectId !== projectId ||
      !same(source.heads, body.expected) ||
      source.logoApproval.id !== body.approvedLogoId ||
      source.directionApproval.id !== body.directionApprovalId
    )
      throw new ApiError("conflict");
    const snapshot = await service.getApprovedLogoIdentitySnapshot(auth, projectId, signal);
    if (
      !same(snapshot.heads, body.expected) ||
      snapshot.logoApproval.id !== body.approvedLogoId ||
      snapshot.directionApproval.id !== body.directionApprovalId
    )
      throw new ApiError("conflict");
    const proposal = proposeLogoVariants(snapshot),
      items: LogoVariant[] = [];
    for (const item of proposal.items) {
      signal.throwIfAborted();
      const common = {
        id: stableId(body.requestKey, `variant:${item.key}`),
        role: item.role,
        colorway: item.colorway,
        clearSpace: item.clearSpace,
        minimumDigitalSize: item.minimumDigitalSize,
        applicability: item.applicability,
        reviewStatus: "review_required" as const,
      };
      if (item.applicability.status === "not_applicable") {
        items.push({ ...common, documentAsset: null, preview: null, renderHash: null });
        continue;
      }
      const document = canonicalLogoDocumentBytes(item.document!),
        preview = await renderProposedVariantPreview(item, signal);
      if (!preview) throw new ApiError("integration_unavailable");
      async function stage(bytes: Uint8Array, mimeType: string, part: string): Promise<IdentityAssetReceipt> {
        const contentHash = sha256(bytes),
          receipt = identityAssetReceiptSchema.parse(
            await dependencies.assets.stageOwnedAsset(
              auth,
              projectId,
              {
                requestKey: stableId(body.requestKey, `${part}:${item.key}:${contentHash}`),
                inputRevisions: source.inputRevisions,
                mimeType,
                contentHash,
                byteLength: bytes.byteLength,
                source: { kind: "variant", sourceId: body.approvedLogoId },
              },
              bytes,
              signal,
            ),
          );
        if (
          receipt.reference.ownerId !== owner ||
          receipt.reference.projectId !== projectId ||
          receipt.reference.contentHash !== contentHash ||
          receipt.sourceReceiptId !== body.approvedLogoId ||
          receipt.purpose !== "brand_asset" ||
          receipt.verification.mimeType !== mimeType ||
          receipt.verification.byteLength !== bytes.byteLength
        )
          throw new ApiError("not_found");
        return receipt;
      }
      const documentReceipt = await stage(document, "application/json", "document"),
        previewReceipt = await stage(preview.png, "image/png", "preview");
      items.push({
        ...common,
        documentAsset: documentReceipt.reference,
        preview: previewReceipt,
        renderHash: preview.renderHash,
      });
    }
    if (!same(source, await service.readSources(auth, projectId, signal))) throw new ApiError("conflict");
    signal.throwIfAborted();
    return {
      source,
      variantSet: {
        id: stableId(body.requestKey, "variant-set"),
        ownerId: owner,
        projectId,
        approvedLogoId: body.approvedLogoId,
        directionApprovalId: body.directionApprovalId,
        items,
        createdAt: new Date().toISOString(),
      },
    };
  };
  const reviewLogoVariants: LogoMutationProducer = async (auth, projectId, command, providedSignal) => {
    const signal = providedSignal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (command.method !== "reviewLogoVariants") throw new ApiError("invalid_input");
    const body = reviewLogoVariantsInputSchema.parse(command.body),
      owner = logoOwner(auth);
    projectId = logoId(projectId);
    const resolved = await service.resolveLogoVariantSet(auth, projectId, body.variantSetId, signal);
    const accepted = resolved.set.items
      .filter((item) => body.acceptedVariantIds.includes(item.id))
      .map((item) => ({ variantId: item.id, renderHash: item.renderHash }));
    validateVariantReview(resolved, {
      id: stableId(body.requestKey, "variant-review"),
      ownerId: owner,
      projectId,
      variantSetId: body.variantSetId,
      approvedLogoId: body.approvedLogoId,
      directionApprovalId: body.directionApprovalId,
      acceptedVariants: accepted as { variantId: string; renderHash: string }[],
      reviewedAt: new Date().toISOString(),
    });
    signal.throwIfAborted();
    return { variantSet: resolved.set, acceptedVariants: accepted };
  };
  return { prepareLogoVariants, reviewLogoVariants };
}
