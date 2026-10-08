"use client";

import { useEffect } from "react";
import type { LogoVectorDocument } from "../../../domain/logo-vector";
import { useBoundedCanonicalPreview } from "./bounded-canonical-preview";
import styles from "./logo-vector.module.css";

export type ConversionReviewReadiness = { document: LogoVectorDocument; originalUrl?: string; scopeKey?: string; ready: boolean };
type Props = Omit<ConversionReviewReadiness, "ready"> & { onReadinessChange?: (state: ConversionReviewReadiness) => void };

/** Only owner-fenced, hash-checked object URLs may supply the original preview. */
export function ConversionReviewPresentation({ document, originalUrl, scopeKey, onReadinessChange }: Props) {
  const preview = useBoundedCanonicalPreview({ document, originalUrl, scopeKey });
  useEffect(() => {
    onReadinessChange?.({ document, originalUrl, scopeKey, ready: preview.ready });
    return () => onReadinessChange?.({ document, originalUrl, scopeKey, ready: false });
  }, [document, originalUrl, scopeKey, preview.ready, onReadinessChange]);
  return <div className={styles.comparison}>
    <section className={styles.previewPanel} aria-label="Original preview">
      <h3>Original concept</h3>
      {preview.originalUrl ? <div className={styles.canvas}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Verified private object URL, never a remote image service. */}
        <img key={preview.key} src={preview.originalUrl} alt="Original concept" className={styles.originalImage} onLoad={preview.onOriginalLoad} onError={preview.onOriginalError} />
      </div> : <div className={styles.missingPreview}><p>Original preview unavailable</p><p>The original will appear when its verified saved source can be loaded.</p></div>}
      {preview.originalStatus === "loading" && <p role="status">Loading the original preview…</p>}
      {originalUrl?.startsWith("blob:") && preview.originalStatus === "unavailable" && <p role="alert">The original preview is unavailable. Reload the workspace to try again.</p>}
    </section>
    <section className={styles.previewPanel} aria-label="Canonical vector preview">
      <h3>Vector candidate</h3>
      <div className={styles.canvas}>
        <svg role="img" aria-label="Vector candidate" aria-busy={preview.canonicalStatus === "loading"} viewBox={document.viewBox.join(" ")} xmlns="http://www.w3.org/2000/svg">
          {preview.canonicalUrl && <image key={preview.key} href={preview.canonicalUrl} x={document.viewBox[0]} y={document.viewBox[1]} width={document.viewBox[2]} height={document.viewBox[3]} preserveAspectRatio="none"
            onLoad={preview.onCanonicalLoad} onError={preview.onCanonicalError} />}
        </svg>
      </div>
      {preview.canonicalStatus === "loading" && <p role="status">Preparing the vector preview…</p>}
      {preview.canonicalStatus === "unavailable" && <p role="alert">Vector preview unavailable. Reload the workspace to try again.</p>}
      {preview.canonicalStatus === "ready" && <p className={styles.caption}>Validated path geometry</p>}
    </section>
  </div>;
}
