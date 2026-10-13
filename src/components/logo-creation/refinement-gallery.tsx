import type { ReactNode } from "react";
import type { IdentityAssetReceipt } from "../../domain/logo-deliverables";
import type { LogoRasterRefinement } from "../../domain/logo-jobs";
import type { LogoRasterSource } from "../../domain/logo-workspace";
import type { LogoRefinementHistoryState } from "./refinement-history";
import { displayLogoCost, LOGO_TYPE_LABELS } from "./presentation";
import styles from "./logo-creation.module.css";
import { logoCandidateKey } from "./candidate-review";

const labels: Record<LogoRasterRefinement["state"], string> = { queued: "Waiting", running: "Creating", succeeded: "Ready", failed: "Failed", cancelled: "Cancelled", needs_reconciliation: "Outcome uncertain" };
const selectable = (record: LogoRasterRefinement) => record.state === "succeeded" && record.billing.status === "recorded" && record.preview?.publicationState === "committed";
function sourceLabel(source: LogoRasterRefinement["source"]) {
  if (source.kind === "concept") return `Source concept · batch ${source.batchId} · slot ${source.slotId} · attempt ${source.attemptId}`;
  if (source.kind === "refinement") return `Source image refinement · ${source.rasterRevisionId}`;
  return `Source vector revision · ${source.vectorRevisionId}`;
}
/** Saved raster records remain distinct from concept slots and approved vectors. */
export function LogoRefinementGallery({ history, selected = null, briefRevisionId, refinementAvailable = false, renderPreview, onSelect, onInspect, comparison = [], onCompare, onCompareSource, onRequestRefine, onRefresh, onLoadMore }: {
  history: LogoRefinementHistoryState;
  selected?: LogoRasterSource | null;
  briefRevisionId?: string;
  refinementAvailable?: boolean;
  renderPreview?: (receipt: IdentityAssetReceipt) => ReactNode;
  onSelect?: (source: Extract<LogoRasterSource, { kind: "refinement" }>) => void;
  onInspect?: (source: Extract<LogoRasterSource, { kind: "refinement" }>) => void;
  comparison?: LogoRasterSource[];
  onCompare?: (source: Extract<LogoRasterSource, { kind: "refinement" }>) => void;
  onCompareSource?: (parent: LogoRasterSource, source: Extract<LogoRasterSource, { kind: "refinement" }>) => void;
  onRequestRefine?: (source: Extract<LogoRasterSource, { kind: "refinement" }>) => void;
  onRefresh?: () => void;
  onLoadMore?: () => void;
}) {
  const selectedRecord = selected?.kind === "refinement" ? history.items.find(row => row.record.id === selected.rasterRevisionId && row.verified && selectable(row.record)) : null;
  return <section className={styles.panel} aria-label="Saved image refinements">
    <h2>Saved image refinements</h2>
    <p className={styles.note}>Each image keeps its original source and inputs. Selecting an image saves it for review; vector conversion and approval are separate steps.</p>
    {history.loading && <p className={styles.note} role="status">Reading saved image refinements…</p>}
    {history.error && <p className={styles.warning} role="status">{history.error}</p>}
    {history.loaded && !history.loading && !history.error && history.items.length === 0 && <p className={styles.note}>No saved image refinements yet.</p>}
    <ol className={styles.concepts}>
      {history.items.map(({ record, verified, error }) => {
        const source = { kind: "refinement" as const, rasterRevisionId: record.id };
        const isSelected = selected?.kind === "refinement" && selected.rasterRevisionId === record.id;
        const isCompared = comparison.some(item => logoCandidateKey(item) === logoCandidateKey(source));
        const priorBrief = record.inputRevisions.find(input => input.stage === "brief_references");
        return <li className={styles.conceptCard} key={record.id} data-refinement-id={record.id}>
          <div className={styles.cardHeading}><h3>Image refinement</h3><span className={styles.badge}>{verified ? labels[record.state] : "Details unverified"}</span></div>
          <p className={styles.typeLabel}>{LOGO_TYPE_LABELS[record.logoType]} · {new Date(record.createdAt).toLocaleString()}</p>
          <div className={styles.preview}>{verified && record.preview && renderPreview ? renderPreview(record.preview) : <p>{verified ? "Image preview unavailable. Saved result retained." : "Image details await verification."}</p>}</div>
          <p className={styles.note}>Image preview · Vector conversion and approval follow separately.</p>
          <p className={styles.note}>Refinement ID · {record.id}</p>
          <p className={styles.note}>{sourceLabel(record.source)}</p>
          {priorBrief && briefRevisionId && priorBrief.id !== briefRevisionId && <p className={styles.warning}>Uses an earlier saved brief. Its original inputs and preview are kept.</p>}
          <p className={styles.note}>{record.billing.status === "recorded" ? `Confirmed charge: ${displayLogoCost(record.billing.confirmedMicrousd)}` : "Charge not confirmed."}</p>
          {record.state === "needs_reconciliation" && <p className={styles.warning}>Outcome uncertain. Refresh saved results or check the original request before trying again.</p>}
          {error && <p className={styles.warning} role="status">{error}</p>}
          {onInspect && <button className={styles.secondaryButton} type="button" aria-label={`Inspect image refinement ${record.id}`} disabled={!verified || !selectable(record)} onClick={() => { if (verified && selectable(record)) onInspect(source); }}>Inspect refinement</button>}
          {onCompare && <button className={styles.secondaryButton} type="button" aria-label={`Compare image refinement ${record.id}`} aria-pressed={isCompared} disabled={!verified || !selectable(record) || !isCompared && comparison.length >= 2} onClick={() => { if (verified && selectable(record)) onCompare(source); }}>{isCompared ? "Remove from comparison" : "Add to comparison"}</button>}
          {onCompareSource && record.source.kind !== "vector" && <button className={styles.secondaryButton} type="button" aria-label={`Compare image refinement ${record.id} with source`} disabled={!verified || !selectable(record)} onClick={() => { if (verified && selectable(record) && record.source.kind !== "vector") onCompareSource(record.source, source); }}>Compare with source</button>}
          <button className={styles.secondaryButton} type="button" aria-label={`Select image refinement ${record.id}`} aria-pressed={isSelected}
            disabled={!verified || !selectable(record) || !onSelect} onClick={() => { if (verified && selectable(record)) onSelect?.(source); }}>{isSelected ? "Selected for review" : "Select image refinement"}</button>
        </li>;
      })}
    </ol>
    <div className={styles.actions}>
      <button className={styles.secondaryButton} type="button" aria-label="Refresh saved image refinements" disabled={!onRefresh || history.loading} onClick={onRefresh}>Refresh saved image refinements</button>
      {history.nextCursor && <button className={styles.secondaryButton} type="button" aria-label="Load older image refinements" disabled={!onLoadMore || history.loading} onClick={onLoadMore}>Load older image refinements</button>}
      <button className={styles.secondaryButton} type="button" aria-label="Refine selected image refinement" disabled={!selectedRecord || !refinementAvailable || !onRequestRefine}
        onClick={() => { if (selectedRecord && refinementAvailable) onRequestRefine?.({ kind: "refinement", rasterRevisionId: selectedRecord.record.id }); }}>Refine selected image refinement</button>
    </div>
    <p className={styles.note}>Further refinement requires its own cost review. Refreshing or selecting saved work does not start generation.</p>
  </section>;
}
