import styles from "./journey.module.css";

/** Real work in progress. It never claims completion; callers own the request state. */
export function ProgressCard({ title, description, note, onStop, stopping = false, stopDisabled = false, stopLabel = "Stop" }: {
  title: string; description: string; note?: string; onStop?: () => void; stopping?: boolean; stopDisabled?: boolean; stopLabel?: string;
}) {
  return <section className={styles.progress} aria-label={title}>
    <div role="status" aria-live="polite">
      <h3 className={styles.progressTitle}>{title}</h3>
      <p className={styles.progressText}>{description}</p>
    </div>
    <div className={styles.bar} aria-hidden="true"><span /></div>
    {(note || onStop) && <div className={styles.progressActions}>
      {note && <p className={styles.progressNote}>{note}</p>}
      {onStop && <button type="button" className={styles.pillButton} disabled={stopping || stopDisabled} onClick={onStop}>{stopping ? "Stopping…" : stopLabel}</button>}
    </div>}
  </section>;
}
