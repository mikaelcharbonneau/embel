"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/message";
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
  // One message per state: a refusal is explained once, by the message below with its Try again, so the line
  // beside the button stays empty instead of repeating it ("Not ready yet." used to linger after a refusal).
  // While an unconfirmed request is kept, its own message says why nothing else can start.
  const status = estimate.busy
    ? "Request in progress…"
    : estimate.error || estimate.canStart || estimate.held
      ? ""
      : unavailable;
  return (
    <div className={styles.generationAction} role="group" aria-label={label}>
      <div className={styles.generationActionRow}>
        <span id={description} className={styles.generationStatus} role="status">
          {status}
        </span>
        <Button
          variant={variant}
          disabled={!estimate.canStart}
          aria-label={label}
          aria-describedby={description}
          onClick={onStart ?? estimate.start}
        >
          {label}
        </Button>
      </div>
      <LogoRefusal estimate={estimate} />
    </div>
  );
}

/** Why the action's request was refused, beside the action. Try again is offered only when pressing is not
 * refused at once again (docs/state-machines.md); otherwise the message can simply be closed. */
export function LogoRefusal({ estimate }: { estimate: Pick<GenerationEstimate, "error" | "refresh" | "tryAgain"> }) {
  if (!estimate.error) return null;
  const tryAgain = estimate.tryAgain !== false;
  return (
    <InlineMessage
      form="field"
      tone="warning"
      onDismiss={tryAgain ? undefined : estimate.refresh}
      actions={
        tryAgain ? (
          <Button size="sm" onClick={estimate.refresh}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {estimate.error}
    </InlineMessage>
  );
}
