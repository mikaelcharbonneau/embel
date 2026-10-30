import Link from "next/link";
import type { LogoSavedInputs } from "@/domain/logo-saved-inputs";
import type { LogoSavedInputChoice, LogoSavedInputPreparation } from "./saved-inputs-controller";
import styles from "./logo-creation.module.css";

export type LogoSavedInputState = LogoSavedInputPreparation
  | { status: "idle" } | { status: "reading" } | { status: "saving" }
  | { status: "reviewing_cost"; source: LogoSavedInputs; used: "brand" | "current" };

export function LogoSavedInputsStatus({ state, projectId, onChoice, onCancel, onRefresh }: {
  state: LogoSavedInputState; projectId: string;
  onChoice(choice: LogoSavedInputChoice): void; onCancel(): void; onRefresh(): void;
}) {
  if (state.status === "idle" || state.status === "obsolete") return null;
  if (state.status === "reading" || state.status === "saving") return <p className={styles.note} role="status">
    {state.status === "reading" ? "Reading your saved brand and inspiration…" : "Saving logo inputs…"}
  </p>;
  if (state.status === "review") {
    const { review } = state, source = review.source;
    return <section className={styles.savedInputReview} aria-label="Confirm logo inputs">
      {source.nameConflict && <p>Your selected name differs from the name originally supplied. Confirm <strong>{source.draft?.name}</strong> before continuing.</p>}
      {review.currentBrief && <p>{source.draft ? "Your current logo brief has different details. Keep it, or use the latest saved brand and inspiration."
        : "Your project has no saved brand name. You can continue with the name in your current logo brief."}</p>}
      <div className={styles.actions}>
        {source.draft && <button type="button" className={styles.primaryButton} onClick={() => onChoice({ review, use: "brand" })}>
          {review.currentBrief ? "Update from brand and inspiration" : `Use ${source.draft.name} and continue`}
        </button>}
        {review.currentBrief && <button type="button" className={styles.secondaryButton} onClick={() => onChoice({ review, use: "current" })}>Use current logo brief</button>}
        <button type="button" className={styles.secondaryButton} onClick={onCancel}>Keep reviewing</button>
      </div>
    </section>;
  }
  if (state.status === "blocked") return <div className={styles.savedInputReview} role="status">
    {state.source?.draft && <p>Prepared for <strong>{state.source.draft.name}</strong> with {state.source.inspirationCount} saved inspiration{state.source.inspirationCount === 1 ? "" : "s"}.</p>}
    <p>{state.message}</p>
    {state.source?.draft === null && <Link className={styles.secondaryButton} href={`/brands/account/${projectId}`}>Open project to choose a name</Link>}
    <button className={styles.secondaryButton} type="button" onClick={onRefresh}>Refresh logo inputs</button>
  </div>;
  return <p className={styles.note} role="status">{state.status === "prepared" ? "Using your saved brand and logo inputs."
    : state.used === "current" ? "Using your saved logo brief."
    : `Saved. Your brand${state.source.inspirationCount ? ` and ${state.source.inspirationCount} saved inspiration${state.source.inspirationCount === 1 ? "" : "s"}` : ""} will guide this exploration.`}</p>;
}
