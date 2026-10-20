"use client";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import type { IdentityReferenceMedia } from "@/domain/identity-references";
import type { AccountReferenceClient } from "./account-reference-client";
import { privatePreviewIdentity } from "../assets/private-preview-identity";

export function ReferencePreview({ media, label, client }: { media: IdentityReferenceMedia; label: string; client: AccountReferenceClient }) {
  const container = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ client: AccountReferenceClient; key: string; url?: string; release?: () => void; failed?: boolean } | null>(null), [attempt, setAttempt] = useState(0);
  const key = privatePreviewIdentity(media, [media.mimeType, media.purpose]);
  if (result && (result.client !== client || result.key !== key)) setResult(null);
  const readMedia = useEffectEvent(() => media);
  useEffect(() => {
    const media = readMedia();
    const controller = new AbortController(); let release: (() => void) | undefined, started = false;
    async function load() {
      if (started || controller.signal.aborted || !client.current()) return; started = true;
      try {
        const preview = await client.preview(media, controller.signal); if (!preview) return;
        if (controller.signal.aborted || !client.current()) { preview.release(); return; }
        release = preview.release; setResult({ client, key, ...preview });
      } catch { if (!controller.signal.aborted && client.current()) setResult({ client, key, failed: true }); }
    }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); } }, { rootMargin: "120px" });
    if (container.current) observer.observe(container.current);
    return () => { observer.disconnect(); controller.abort(); release?.(); };
  }, [client, key, attempt]);
  const shown = result?.client === client && result.key === key && client.current() ? result : null;
  const failed = shown?.failed;
  return <div className="identity-reference-preview" ref={container}>{shown?.url ? <>
    {/* Owned raster blobs never pass through a public image optimizer. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={shown.url} alt={label} onError={() => { shown.release?.(); setResult({ client, key, failed: true }); }} />
  </> : <div className="identity-reference-placeholder"><Icon name="assets" size={28} /><span>{failed ? "Reference preview unavailable" : "Loading private reference…"}</span>{failed && <button type="button" className="text-link" onClick={() => { setResult(null); setAttempt(value => value + 1); }}>Retry preview</button>}</div>}</div>;
}
