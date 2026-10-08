"use client";

import { useEffect, useRef, useState } from "react";
import type { LogoVectorDocument } from "../../../domain/logo-vector";
import { serializeLogoSvg } from "../model/svg";

type ImageStatus = "loading" | "ready" | "unavailable";
type Basis = { document: LogoVectorDocument; originalUrl?: string; scopeKey?: string };
type Lease = Basis & { key: number; url: string | null; disposed: boolean; release(): void };
type Preview = { lease: Lease; canonical: ImageStatus; original: ImageStatus };

/** Owns only the reconstructed canonical SVG URL. The account client retains
 * ownership/hash validation and lifetime of the separate original raster URL.
 * No source XML, remote resource, raster conversion, or path DOM is involved. */
export function useBoundedCanonicalPreview({ document, originalUrl, scopeKey }: Basis) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    let url: string | null = null, released = false;
    try { url = URL.createObjectURL(new Blob([Uint8Array.from(serializeLogoSvg(document))], { type: "image/svg+xml" })); }
    catch { /* Keep the source intact and expose unavailable rather than a fallback image. */ }
    const lease: Lease = { document, originalUrl, scopeKey, key: ++sequence.current, url, disposed: false,
      release() { if (!released && url !== null) { released = true; URL.revokeObjectURL(url); } },
    };
    queueMicrotask(() => {
      if (!lease.disposed) setPreview({ lease, canonical: url === null ? "unavailable" : "loading", original: originalUrl?.startsWith("blob:") ? "loading" : "unavailable" });
    });
    return () => { lease.disposed = true; lease.release(); };
  }, [document, originalUrl, scopeKey]);

  // Hide a previous document/account synchronously, before effect cleanup or
  // preparation of its replacement. Status belongs to this exact byte source.
  const active = preview?.lease.document === document && preview.lease.originalUrl === originalUrl && preview.lease.scopeKey === scopeKey ? preview : null;
  function settle(which: "canonical" | "original", status: "ready" | "unavailable") {
    if (!active || active.lease.disposed) return;
    if (which === "canonical" && status === "unavailable") active.lease.release();
    setPreview(current => {
      if (current?.lease !== active.lease || current.lease.disposed || current[which] === "unavailable" || current[which] === status) return current;
      return { ...current, [which]: status };
    });
  }
  return {
    key: active?.lease.key,
    canonicalUrl: active?.canonical === "unavailable" ? null : active?.lease.url,
    originalUrl: active?.original === "unavailable" ? null : active?.lease.originalUrl,
    canonicalStatus: active?.canonical ?? "loading",
    originalStatus: active?.original ?? (originalUrl?.startsWith("blob:") ? "loading" : "unavailable"),
    ready: active?.canonical === "ready" && active.original === "ready",
    onCanonicalLoad: () => settle("canonical", "ready"),
    onCanonicalError: () => settle("canonical", "unavailable"),
    onOriginalLoad: () => settle("original", "ready"),
    onOriginalError: () => settle("original", "unavailable"),
  };
}
