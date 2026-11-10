"use client";

import { useId } from "react";
import type { GenerationEstimate } from "./use-generation-estimate";
import styles from "./logo-creation.module.css";

/** One deliberate click starts the request. No cost is shown. */
export function LogoGenerationAction({
  estimate,
  label,
  unavailable = "Save your inputs to continue.",
  onStart,
  variant = "primary",
}: {
  estimate: GenerationEstimate;
  label: string;
  unavailable?: string;
  onStart?: () => void;
  /** Secondary for actions beside the main next step, such as More concepts. */
  variant?: "primary" | "secondary";
}) {
  const description = useId();
  const status = estimate.busy
    ? "Request in progress…"
    : estimate.error
      ? "Not ready yet."
      : estimate.canStart
        ? ""
        : unavailable;
  return (
    <div className={styles.generationAction} role="group" aria-label={label}>
      <div className={styles.generationActionRow}>
        <button
          className={variant === "primary" ? styles.primaryButton : styles.secondaryButton}
          type="button"
          disabled={!estimate.canStart}
          aria-label={label}
          aria-describedby={description}
          onClick={onStart ?? estimate.start}
        >
          {label}
        </button>
        <span id={description} className={styles.generationEstimate} role="status">
          {status}
        </span>
      </div>
      {estimate.error && (
        <div className={styles.estimateRecovery}>
          <p>{estimate.error}</p>
          <button className={styles.secondaryButton} type="button" onClick={estimate.refresh}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
