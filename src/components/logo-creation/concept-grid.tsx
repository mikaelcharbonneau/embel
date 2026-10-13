import type { ReactNode } from "react";
import type { LogoConceptBatch, LogoConceptPlan, LogoRequestState } from "../../domain/logo-jobs";
import type { IdentityAssetReceipt } from "../../domain/logo-deliverables";
import type { LogoCapability, LogoConceptSource, LogoRasterSource } from "../../domain/logo-workspace";
import { logoCandidateKey } from "./candidate-review";
import { acceptedConceptAttempt, CONCEPT_ORDINALS, displayLogoCost, LOGO_TYPE_LABELS } from "./presentation";
import styles from "./logo-creation.module.css";

/** No polling, persistence or generation lives in this view. Request callbacks only open cost review. */
export function LogoConceptGridView({ batch = null, plan = null, selected = null, request = null, generation, refinement = generation, savedBatchUnavailable = false,
  renderPreview, onSelect, onInspect, comparison = [], onCompare, onRequestConcepts, onRequestMore, onRequestRefine, onRequestRetryFailed, onCheckRequest,
}: {
  batch?: LogoConceptBatch | null;
  plan?: LogoConceptPlan | null;
  selected?: LogoConceptSource | null;
  request?: LogoRequestState | null;
  generation?: LogoCapability;
  refinement?: LogoCapability;
  /** A saved batch is known, but its details have not been verified for display. */
  savedBatchUnavailable?: boolean;
  /** The owning client wrapper must provide and release only verified image previews. */
  renderPreview?: (receipt: IdentityAssetReceipt) => ReactNode;
  onSelect?: (source: LogoConceptSource) => void;
  onInspect?: (source: LogoConceptSource) => void;
  comparison?: LogoRasterSource[];
  onCompare?: (source: LogoConceptSource) => void;
  onRequestConcepts?: () => void;
  onRequestMore?: () => void;
  onRequestRefine?: (source: LogoConceptSource) => void;
  onRequestRetryFailed?: (slotIds: string[]) => void;
  /** Supplied only when the owner retains an original request identity for read-only recovery. */
  onCheckRequest?: () => void;
}) {
  const activePlan = batch?.plan ?? plan;
  const readyCount = batch?.slots.filter(slot => acceptedConceptAttempt(slot)).length ?? 0;
  const failedSlotIds = batch?.slots.filter(slot => !acceptedConceptAttempt(slot) && slot.attempts.at(-1)?.state === "failed" && slot.attempts.at(-1)?.billing.status === "recorded").map(slot => slot.id) ?? [];
  const canGenerate = generation?.status === "available";
  const selectedSlot = batch?.id === selected?.batchId ? batch?.slots.find(slot => slot.id === selected?.slotId) : undefined;
  const acceptedSelection = selectedSlot ? acceptedConceptAttempt(selectedSlot) : null;
  const validSelection = Boolean(selected && acceptedSelection?.id === selected.attemptId);
  const recoveryPending = Boolean(onCheckRequest && !batch && (!request || request.status === "not_found"));
  const uncertain = recoveryPending || request?.status === "needs_reconciliation" || batch?.slots.some(slot => {
    const attempt = slot.attempts.at(-1);
    return attempt?.state === "needs_reconciliation" || (attempt?.state === "failed" && attempt.billing.status === "unknown");
  });
  const stateLabel = { queued: "Waiting", running: "Creating", succeeded: "Ready", failed: "Failed", cancelled: "Cancelled", needs_reconciliation: "Outcome uncertain" };
  return <section className={styles.panel} aria-label="Logo concepts">
    <div className={styles.heading}><div><p className={styles.eyebrow}>03 / Explore</p><h2>Six starting points</h2></div><span className={styles.badge}>Black and white</span></div>
    <p className={styles.muted}>Six total concepts, with the logo type shown on each card. Review a cost estimate before every new generation or refinement.</p>
    {activePlan && <p className={styles.note}>Included: {activePlan.coveredTypes.map(type => LOGO_TYPE_LABELS[type]).join(", ")}.{activePlan.uncoveredTypes.length > 0 && <> Not included in this batch: {activePlan.uncoveredTypes.map(type => LOGO_TYPE_LABELS[type]).join(", ")}. A later batch can cover these types.</>}</p>}
    <p className={styles.progress} role="status" aria-live="polite">{savedBatchUnavailable ? "Saved concept details unavailable" : readyCount + " of 6 concepts ready"}</p>
    {uncertain && <p className={styles.warning}>Outcome uncertain. Check the existing request before trying again. Completed concepts stay available.</p>}
    <ol className={styles.concepts}>
      {CONCEPT_ORDINALS.map(ordinal => {
        const slot = batch?.slots.find(item => item.ordinal === ordinal);
        const planned = activePlan?.slots.find(item => item.ordinal === ordinal);
        const attempt = slot?.attempts.at(-1);
        const accepted = slot ? acceptedConceptAttempt(slot) : null;
        const source: LogoConceptSource | null = batch && slot && accepted ? { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: accepted.id } : null;
        const isSelected = Boolean(source && selected && source.batchId === selected.batchId && source.slotId === selected.slotId && source.attemptId === selected.attemptId);
        const isCompared = Boolean(source && comparison.some(item => logoCandidateKey(item) === logoCandidateKey(source)));
        return <li className={styles.conceptCard} key={ordinal} data-concept-ordinal={ordinal}>
          <div className={styles.cardHeading}><h3>Concept {ordinal + 1}</h3><span className={styles.badge}>{attempt ? stateLabel[attempt.state] : savedBatchUnavailable ? "Unavailable" : "Not requested"}</span></div>
          <p className={styles.typeLabel}>{planned ? LOGO_TYPE_LABELS[planned.type] : savedBatchUnavailable ? "Saved logo type unavailable" : "Choose logo types to begin"}</p>
          <div className={styles.preview}>
            {accepted?.preview && renderPreview ? renderPreview(accepted.preview) : <p>{accepted ? "Image preview unavailable" : attempt ? "No image preview yet" : savedBatchUnavailable ? "Saved preview unavailable" : "Your concept will appear here"}</p>}
          </div>
          {accepted && <p className={styles.note}>Image preview · Vector conversion and approval follow separately.</p>}
          {slot && <div aria-label={`Charges for concept ${ordinal + 1}`}>
            {slot.attempts.map(record => <p className={styles.note} key={record.id}>
              {`Attempt ${record.attemptNumber} · ${record.billing.status === "recorded" ? `Confirmed charge: ${displayLogoCost(record.billing.confirmedMicrousd)}` : "Charge not confirmed."}`}
            </p>)}
          </div>}
          {onInspect && <button className={styles.secondaryButton} type="button" aria-label={`Inspect concept ${ordinal + 1}`} disabled={!source} onClick={() => { if (source) onInspect(source); }}>Inspect concept</button>}
          {onCompare && <button className={styles.secondaryButton} type="button" aria-label={`Compare concept ${ordinal + 1}`} aria-pressed={isCompared} disabled={!source || !isCompared && comparison.length >= 2} onClick={() => { if (source) onCompare(source); }}>{isCompared ? "Remove from comparison" : "Add to comparison"}</button>}
          <button className={styles.secondaryButton} type="button" aria-label={`Select concept ${ordinal + 1}`} aria-pressed={isSelected} disabled={!source || !onSelect} onClick={() => { if (source) onSelect?.(source); }}>{isSelected ? "Selected for review" : "Use this version"}</button>
        </li>;
      })}
    </ol>
    {!canGenerate && <p className={styles.note}>Generation is unavailable. You can keep reviewing the brief and any saved results.</p>}
    <div className={styles.actions}>
      {!batch && <button className={styles.primaryButton} type="button" aria-label="Explore six concepts" disabled={!canGenerate || !onRequestConcepts} onClick={onRequestConcepts}>Explore six concepts</button>}
      <button className={styles.secondaryButton} type="button" aria-label="More concepts" disabled={!batch || !canGenerate || !onRequestMore} onClick={onRequestMore}>More concepts</button>
      <button className={styles.secondaryButton} type="button" aria-label="Refine selected" disabled={!validSelection || refinement?.status !== "available" || !onRequestRefine} onClick={() => { if (validSelection && selected) onRequestRefine?.(selected); }}>Refine selected</button>
      {failedSlotIds.length > 0 && <button className={styles.secondaryButton} type="button" aria-label={`Retry ${failedSlotIds.length} failed concept${failedSlotIds.length === 1 ? "" : "s"}`} disabled={!canGenerate || !onRequestRetryFailed} onClick={() => onRequestRetryFailed?.(failedSlotIds)}>Retry {failedSlotIds.length} failed concept{failedSlotIds.length === 1 ? "" : "s"}</button>}
      <button className={styles.secondaryButton} type="button" aria-label="Check request" disabled={!onCheckRequest} onClick={onCheckRequest}>Check request</button>
    </div>
    <p className={styles.note}>More, refine and retry each require a separate cost review. Checking a request does not start a new generation.</p>
  </section>;
}
