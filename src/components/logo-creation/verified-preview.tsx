"use client";
import { useEffect, useState } from "react";
import type { IdentityAssetReceipt } from "../../domain/logo-deliverables";
import type { AccountLogoClient } from "../identity/account-logo-client";

/** The shared client checks owner/hash/MIME and returns a releasable object URL.
 * Failed image reads leave their accepted immutable result metadata untouched. */
export function LogoVerifiedPreview({ client, receipt, alt = "Image preview of saved logo concept" }: { client: AccountLogoClient; receipt: IdentityAssetReceipt; alt?: string }) {
  const [state, setState] = useState<{ receipt: IdentityAssetReceipt; url: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let preview: { url: string; release(): void } | null = null;
    void client.previewAsset(receipt, controller.signal).then(value => {
      if (controller.signal.aborted) { value?.release(); return; }
      preview = value; setState({ receipt, url: value?.url ?? null, failed: !value });
    }).catch(() => { if (!controller.signal.aborted) setState({ receipt, url: null, failed: true }); });
    return () => { controller.abort(); preview?.release(); };
  }, [client, receipt]);
  const visible = state?.receipt === receipt ? state : null;
  // eslint-disable-next-line @next/next/no-img-element -- private verified object URL; no external image optimizer.
  return visible?.url ? <img src={visible.url} alt={alt} /> : <p>{visible?.failed ? "Image preview unavailable. Saved result retained." : "Loading image preview…"}</p>;
}
