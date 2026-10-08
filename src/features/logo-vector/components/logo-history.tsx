import { logoHistoryPageSchema, type LogoHistoryPage } from "../../../domain/logo-workspace";
import styles from "./logo-vector.module.css";

/** Read-only projection. Actual pagination and restore intents remain with the future AccountLogoClient wrapper. */
export function LogoHistoryPresentation({ history }: { history: LogoHistoryPage | null }) {
  const parsed = history === null ? null : logoHistoryPageSchema.safeParse(history);
  const page = parsed?.success ? parsed.data : null;
  return <section className={styles.history} aria-label="Revision history">
    <h3>Revision history</h3>
    {page === null ? <p>Saved history unavailable. Connect the owned revision reader to show saved versions.</p> : page.items.length === 0 ? <p>No saved revisions.</p> :
      <ol>{page.items.map(revision => <li key={revision.id}>
        <div><strong>{revision.stage.replaceAll("_", " ")} · Version {revision.revision}</strong><time dateTime={revision.createdAt}>{revision.createdAt}</time></div>
        <button type="button" disabled title="Restoration is unavailable until the account mutation service is connected.">Restore version {revision.revision}</button>
      </li>)}</ol>}
    {page?.nextCursor && <button type="button" disabled>Load earlier versions</button>}
    <p className={styles.caption}>Restoration is unavailable. A future restore must create a new selection and preserve every historical revision.</p>
  </section>;
}
