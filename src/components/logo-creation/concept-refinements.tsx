import type { ReactNode } from "react";
import type { IdentityAssetReceipt } from "@/domain/logo-deliverables";
import type { LogoRasterSource } from "@/domain/logo-workspace";
import type { LogoRefinementHistoryState } from "./refinement-history";
import styles from "./logo-creation.module.css";

/** Only verified, committed outputs can become the source of another edit. */
export function ConceptRefinements({ history, selected, renderPreview, onSelect }: {
  history: LogoRefinementHistoryState; selected: LogoRasterSource | null;
  renderPreview(receipt: IdentityAssetReceipt): ReactNode;
  onSelect?: (source: Extract<LogoRasterSource, { kind: "refinement" }>) => void;
}) {
  if (!history.items.length && !history.error) return null;
  return <section className={styles.gallery} aria-label="Logo refinements">
    <h2>Your refinements</h2>
    {history.error && <p role="status">{history.error}</p>}
    <ol className={styles.concepts}>
      {history.items.map(({ record, verified, error }, index) => {
        const ready = verified && record.state === "succeeded" && record.billing.status === "recorded" && record.preview?.publicationState === "committed";
        const active = selected?.kind === "refinement" && selected.rasterRevisionId === record.id;
        const label = `Refinement ${history.items.length - index}`;
        return <li key={record.id} className={styles.galleryCard} data-refinement-id={record.id} data-selected={active || undefined}>
          <button type="button" className={styles.refinementPreview} aria-label={`Select ${label.toLowerCase()}`} aria-pressed={active}
            disabled={!ready || !onSelect} onClick={() => onSelect?.({ kind: "refinement", rasterRevisionId: record.id })}>
            {ready && record.preview ? renderPreview(record.preview) : <span>{record.state === "queued" || record.state === "running" ? "Refining your logo…" : "Refinement preview unavailable"}</span>}
          </button>
          <div className={styles.galleryCaption}><h3>{label}</h3><p>{active ? "Selected" : ready ? "Click to select and keep refining" : error ?? (record.state === "queued" || record.state === "running" ? "Refining your logo…" : record.state === "needs_reconciliation" ? "Checking the saved result…" : record.state === "cancelled" ? "Cancelled" : "Refinement failed. Your original logo is kept.")}</p></div>
        </li>;
      })}
    </ol>
  </section>;
}
