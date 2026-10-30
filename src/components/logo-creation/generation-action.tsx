"use client";

import { useId } from "react";
import type { GenerationEstimate } from "./use-generation-estimate";
import { displayLogoCost, LOGO_TYPE_LABELS } from "./presentation";
import styles from "./logo-creation.module.css";

export function LogoGenerationAction({ estimate, label, unavailable = "Save your inputs to continue.", onStart }: {
  estimate: GenerationEstimate; label: string; unavailable?: string; onStart?: () => void;
}) {
  const description = useId();
  const quote = estimate.quote;
  const cost = quote && "estimatedCostMicrousd" in quote && typeof quote.estimatedCostMicrousd === "number" ? quote.estimatedCostMicrousd : null;
  return <div className={styles.generationAction} role="group" aria-label={label}>
    <div className={styles.generationActionRow}>
      <button className={styles.primaryButton} type="button" disabled={!estimate.canStart} aria-label={label} aria-describedby={description} onClick={onStart ?? estimate.start}>{label}</button>
      <span id={description} className={styles.generationEstimate} role="status">{estimate.loading ? "Estimating cost…" : estimate.expired ? "Estimate expired."
        : estimate.error ? "Estimate unavailable." : quote ? cost !== null ? `Expected cost: ${displayLogoCost(cost)}` : "Expected cost unavailable."
        : estimate.busy ? "Request in progress…" : unavailable}</span>
    </div>
    {(estimate.error || estimate.expired) && <div className={styles.estimateRecovery}>
      {estimate.error && <p>{estimate.error}</p>}
      <button className={styles.secondaryButton} type="button" onClick={estimate.refresh}>Refresh estimate</button>
    </div>}
    {quote && !estimate.expired && <p className={styles.estimateNote}>An estimate, not a confirmed charge. Actual usage may differ.</p>}
    {quote?.conceptPlan && quote.conceptPlan.uncoveredTypes.length > 0 && <p className={styles.estimateNote}>Not included in this batch: {quote.conceptPlan.uncoveredTypes.map(type => LOGO_TYPE_LABELS[type]).join(", ")}. Six concepts total.</p>}
  </div>;
}
