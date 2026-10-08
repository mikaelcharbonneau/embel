"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import type { IdentityReferenceMedia } from "@/domain/identity-references";
import type { AccountReferenceClient } from "./account-reference-client";

export function ReferencePreview({ media, label, client }: { media: IdentityReferenceMedia; label: string; client: AccountReferenceClient }) {
  const container = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ media: IdentityReferenceMedia; url: string; release: () => void } | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let release: (() => void) | undefined, started = false;
    async function load() {
      if (started) return; started = true;
      try {
        const preview = await client.preview(media, controller.signal); if (!preview) return;
        if (controller.signal.aborted || !client.current()) { preview.release(); return; }
        release = preview.release; setResult({ media, ...preview }); setFailed(false);
      } catch { if (!controller.signal.aborted && client.current()) setFailed(true); }
    }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); } }, { rootMargin: "120px" });
    if (container.current) observer.observe(container.current);
    return () => { observer.disconnect(); controller.abort(); release?.(); };
  }, [client, media, attempt]);
  const shown = result?.media === media && client.current() ? result : null;
  return <div className="identity-reference-preview" ref={container}>{shown ? <>
    {/* Owned raster blobs never pass through a public image optimizer. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={shown.url} alt={label} onError={() => { shown.release(); setResult(null); setFailed(true); }} />
  </> : <div className="identity-reference-placeholder"><Icon name="assets" size={28} /><span>{failed ? "Reference preview unavailable" : "Loading private reference…"}</span>{failed && <button type="button" className="text-link" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>Retry preview</button>}</div>}</div>;
}
