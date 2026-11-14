/**
 * Sentences the AI step screens share for the same server situation (docs/state-machines.md).
 * A screen that already has its own sentence for a situation keeps it; these are for the
 * situations a screen said nothing about. Which one applies is decided by `stepView` in
 * generation-run.ts, never here. Plain words, never a price.
 */

/** A status check failed while the run is still working. */
export const UPDATES_DELAYED = "Updates are delayed. Still working, and checking again.";
/** The Stop request got no answer; its Try again asks once more. */
export const STOP_UNCONFIRMED = "Stop couldn’t be confirmed.";
