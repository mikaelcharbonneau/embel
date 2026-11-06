import styles from "./journey.module.css";

/** Real work in progress. It never claims completion; callers own the request state. */
export function ProgressCard({ title, description, onStop, stopping = false, stopLabel = "Stop" }: {
  title: string; description: string; onStop?: () => void; stopping?: boolean; stopLabel?: string;
}) {
  return <section className={styles.progress} aria-label={title}>
    <div role="status" aria-live="polite">
      <h3 className={styles.progressTitle}>{title}</h3>
      <p className={styles.progressText}>{description}</p>
    </div>
    <div className={styles.bar} aria-hidden="true"><span /></div>
    {onStop && <div className={styles.progressActions}>
      <button type="button" className={styles.pillButton} disabled={stopping} onClick={onStop}>{stopping ? "Stopping…" : stopLabel}</button>
    </div>}
  </section>;
}
