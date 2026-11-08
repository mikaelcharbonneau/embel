import Link from "next/link";
import { projectStrategyHref } from "@/domain/project-handoff";
import type { LogoSavedInputPreparation } from "./saved-inputs-controller";
import styles from "./logo-creation.module.css";

export type LogoSavedInputState = LogoSavedInputPreparation | { status: "idle" } | { status: "reading" } | { status: "saving" };

export function LogoSavedInputsStatus({ state, projectId, onRefresh }: { state: LogoSavedInputState; projectId: string; onRefresh(): void }) {
  // Preparing happens quietly; only a blocker that needs the person is shown.
  if (state.status !== "blocked") return null;
  return <div className={styles.savedInputReview} role="status">
    {state.source?.draft && <p>Prepared for <strong>{state.source.draft.name}</strong> with {state.source.inspirationCount} saved inspiration{state.source.inspirationCount === 1 ? "" : "s"}.</p>}
    <p>{state.message}</p>
    {state.source?.draft === null && <Link className={styles.secondaryButton} href={projectStrategyHref(projectId)}>Open project to choose a name</Link>}
    <button className={styles.secondaryButton} type="button" onClick={onRefresh}>Refresh logo inputs</button>
  </div>;
}
