"use client";
import { useEffect, useEffectEvent, useState } from "react";
import type { IdentityAssetReceipt } from "../../domain/logo-deliverables";
import type { AccountLogoClient } from "../identity/account-logo-client";
import { privatePreviewIdentity } from "../assets/private-preview-identity";

/** The shared client checks owner/hash/MIME and returns a releasable object URL (a blob, so its pixels are readable
 * by the logo reveal). Failed image reads leave their accepted immutable result metadata untouched. */
export function useVerifiedPreview(
  client: AccountLogoClient | null,
  receipt: IdentityAssetReceipt | null,
): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{
    client: AccountLogoClient;
    key: string;
    url: string | null;
    failed: boolean;
  } | null>(null);
  const key = receipt
    ? privatePreviewIdentity(receipt.reference, [
        receipt.id,
        receipt.publicationState,
        receipt.purpose,
        receipt.sourceReceiptId,
        receipt.rightsEvidenceId,
        receipt.verification.status,
        receipt.verification.contentHash,
        receipt.verification.mimeType,
        receipt.verification.byteLength,
      ])
    : null;
  if (state && (state.client !== client || state.key !== key)) setState(null);
  const readReceipt = useEffectEvent(() => receipt);
  useEffect(() => {
    const receipt = readReceipt();
    if (!client || !key || !receipt) return;
    const controller = new AbortController();
    let preview: { url: string; release(): void } | null = null;
    void client
      .previewAsset(receipt, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) {
          value?.release();
          return;
        }
        preview = value;
        setState({ client, key, url: value?.url ?? null, failed: !value });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ client, key, url: null, failed: true });
      });
    return () => {
      controller.abort();
      preview?.release();
    };
  }, [client, key]);
  const visible = state?.client === client && state.key === key ? state : null;
  return { url: visible?.url ?? null, failed: Boolean(visible?.failed) };
}

export function LogoVerifiedPreview({
  client,
  receipt,
  alt = "Image preview of saved logo concept",
}: {
  client: AccountLogoClient;
  receipt: IdentityAssetReceipt;
  alt?: string;
}) {
  const { url, failed } = useVerifiedPreview(client, receipt);
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- private verified object URL; no external image optimizer.
    <img src={url} alt={alt} />
  ) : (
    <p>{failed ? "Image preview unavailable. Saved result retained." : "Loading image preview…"}</p>
  );
}
