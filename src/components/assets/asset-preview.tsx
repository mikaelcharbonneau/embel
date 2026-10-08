"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import type { AssetVersionDetail } from "@/domain/asset-library";
import { canPreviewAsset, type AccountAssetsClient } from "./account-assets-client";

export function AssetPreview({ version, client, label, retryable = true }: { version: AssetVersionDetail | null; client: AccountAssetsClient; label: string; retryable?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ url: string; version: AssetVersionDetail; release: () => void } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!version || !canPreviewAsset(version)) return;
    const controller = new AbortController();
    let release: (() => void) | undefined, started = false;
    async function load() {
      if (started) return; started = true;
      try {
        const preview = await client.preview(version!, controller.signal);
        if (!preview) return;
        if (controller.signal.aborted || !client.current()) { preview.release(); return; }
        release = preview.release; setResult({ url: preview.url, version: version!, release: preview.release }); setFailed(false);
      } catch { if (!controller.signal.aborted && client.current()) setFailed(true); }
    }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); } }, { rootMargin: "120px" });
    if (container.current) observer.observe(container.current);
    return () => { observer.disconnect(); controller.abort(); release?.(); };
  }, [client, version, attempt]);
  const available = result?.version === version && client.current() ? result : null;
  return <div className="assets-preview" ref={container}>
    {available ? <>
      {/* Private blob URLs must stay in this owner-scoped consumer, without an image proxy. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={available.url} alt={label} onError={() => { available.release(); setResult(null); setFailed(true); }} />
      <span className="assets-file-check">File checked</span>
    </> : <div className="assets-file-placeholder"><Icon name={version && canPreviewAsset(version) ? "assets" : "file"} size={32} /><strong>{version ? version.format.toUpperCase() : "No file"}</strong><span>{failed ? "Preview unavailable" : version?.fileState === "metadata_only" ? "Metadata only" : version?.fileState === "missing_or_invalid" ? "File unavailable" : version && canPreviewAsset(version) ? "Private preview" : version ? "Preview not supported" : "No versions yet"}</span>{failed && retryable && <button className="text-link" type="button" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>Retry preview</button>}</div>}
  </div>;
}
