"use client";
import { useEffect, useEffectEvent, useState } from "react";
import type { IdentityAssetReceipt } from "../../domain/logo-deliverables";
import type { AccountLogoClient } from "../identity/account-logo-client";
import { privatePreviewIdentity } from "../assets/private-preview-identity";

/** The shared client checks owner/hash/MIME and returns a releasable object URL.
 * Failed image reads leave their accepted immutable result metadata untouched. */
export function LogoVerifiedPreview({ client, receipt, alt = "Image preview of saved logo concept" }: { client: AccountLogoClient; receipt: IdentityAssetReceipt; alt?: string }) {
  const [state, setState] = useState<{ client: AccountLogoClient; key: string; url: string | null; failed: boolean } | null>(null);
  const key = privatePreviewIdentity(receipt.reference, [receipt.id, receipt.publicationState, receipt.purpose, receipt.sourceReceiptId,
    receipt.rightsEvidenceId, receipt.verification.status, receipt.verification.contentHash, receipt.verification.mimeType, receipt.verification.byteLength]);
  if (state && (state.client !== client || state.key !== key)) setState(null);
  const readReceipt = useEffectEvent(() => receipt);
  useEffect(() => {
    const receipt = readReceipt();
    const controller = new AbortController(); let preview: { url: string; release(): void } | null = null;
    void client.previewAsset(receipt, controller.signal).then(value => {
      if (controller.signal.aborted) { value?.release(); return; }
      preview = value; setState({ client, key, url: value?.url ?? null, failed: !value });
    }).catch(() => { if (!controller.signal.aborted) setState({ client, key, url: null, failed: true }); });
    return () => { controller.abort(); preview?.release(); };
  }, [client, key]);
  const visible = state?.client === client && state.key === key ? state : null;
  // eslint-disable-next-line @next/next/no-img-element -- private verified object URL; no external image optimizer.
  return visible?.url ? <img src={visible.url} alt={alt} /> : <p>{visible?.failed ? "Image preview unavailable. Saved result retained." : "Loading image preview…"}</p>;
}
