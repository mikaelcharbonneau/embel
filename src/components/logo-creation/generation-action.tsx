"use client";

import { useId } from "react";
import type { GenerationEstimate } from "./use-generation-estimate";
import { LOGO_TYPE_LABELS } from "./presentation";
import styles from "./logo-creation.module.css";

/** One deliberate click starts the request. The quote that admits the work is
 * prepared in the background and is never shown as a cost. */
export function LogoGenerationAction({ estimate, label, unavailable = "Save your inputs to continue.", onStart }: {
  estimate: GenerationEstimate; label: string; unavailable?: string; onStart?: () => void;
}) {
  const description = useId();
  const quote = estimate.quote;
  const status = estimate.busy ? "Request in progress…" : estimate.loading || estimate.expired ? "Getting ready…"
    : estimate.error ? "Not ready yet." : quote ? "" : unavailable;
  return <div className={styles.generationAction} role="group" aria-label={label}>
    <div className={styles.generationActionRow}>
      <button className={styles.primaryButton} type="button" disabled={!estimate.canStart} aria-label={label} aria-describedby={description} onClick={onStart ?? estimate.start}>{label}</button>
      <span id={description} className={styles.generationEstimate} role="status">{status}</span>
    </div>
    {estimate.error && <div className={styles.estimateRecovery}>
      <p>{estimate.error}</p>
      <button className={styles.secondaryButton} type="button" onClick={estimate.refresh}>Try again</button>
    </div>}
    {quote?.conceptPlan && quote.conceptPlan.uncoveredTypes.length > 0 && <p className={styles.estimateNote}>Not included in this batch: {quote.conceptPlan.uncoveredTypes.map(type => LOGO_TYPE_LABELS[type]).join(", ")}. Six concepts total.</p>}
  </div>;
}
