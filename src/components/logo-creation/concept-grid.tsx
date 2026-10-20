import type { ReactNode } from "react";
import type { LogoConceptBatch, LogoConceptPlan, LogoRequestState } from "../../domain/logo-jobs";
import type { IdentityAssetReceipt } from "../../domain/logo-deliverables";
import type { LogoCapability, LogoConceptSource, LogoRasterSource } from "../../domain/logo-workspace";
import { logoCandidateKey } from "./candidate-review";
import { acceptedConceptAttempt, CONCEPT_ORDINALS, displayLogoCost, LOGO_TYPE_LABELS } from "./presentation";
import styles from "./logo-creation.module.css";
import type { LogoCardVersion } from "./concept-versions";

/** No polling, persistence or generation lives in this view. Request callbacks only open cost review. */
export function LogoConceptGridView({ batch = null, plan = null, selected = null, request = null, generation, refinement = generation, savedBatchUnavailable = false, savedBatchLoading = false,
  gallery = false, versions = {}, selectedVersion = selected, selectionAt, viewedVersions = {}, onViewVersion, onSelectVersion, filter = "all", allowInputPreparation = false, renderPreview, onSelect, onInspect, comparison = [], onCompare, onRequestConcepts, onRequestMore, onRequestRefine, onRequestRetryFailed, onCheckRequest,
}: {
  gallery?: boolean;
  versions?: Record<string, LogoCardVersion[]>;
  selectedVersion?: LogoRasterSource | null;
  selectionAt?: string;
  viewedVersions?: Record<string, { key: string; count: number }>;
  onViewVersion?: (slotId: string, key: string, count: number) => void;
  onSelectVersion?: (source: LogoRasterSource) => void;
  /** Preparing saved inputs can reveal a setup blocker without admitting work. */
  allowInputPreparation?: boolean;
  filter?: "all" | "saved";
  batch?: LogoConceptBatch | null;
  plan?: LogoConceptPlan | null;
  selected?: LogoConceptSource | null;
  request?: LogoRequestState | null;
  generation?: LogoCapability;
  refinement?: LogoCapability;
  /** Saved concepts could not be verified; this is not a confirmed empty workspace. */
  savedBatchUnavailable?: boolean;
  /** Saved reads are incomplete; absence is not yet a confirmed empty workspace. */
  savedBatchLoading?: boolean;
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
  return <section className={gallery ? styles.gallery : styles.panel} aria-label="Logo concepts" aria-busy={savedBatchLoading}>
    {!gallery && <><div className={styles.heading}><div><p className={styles.eyebrow}>03 / Explore</p><h2>Six starting points</h2></div><span className={styles.badge}>Black and white</span></div>
    <p className={styles.muted}>Six total concepts, with the logo type shown on each card. Review a cost estimate before every new generation or refinement.</p>
    {activePlan && <p className={styles.note}>Included: {activePlan.coveredTypes.map(type => LOGO_TYPE_LABELS[type]).join(", ")}.{activePlan.uncoveredTypes.length > 0 && <> Not included in this batch: {activePlan.uncoveredTypes.map(type => LOGO_TYPE_LABELS[type]).join(", ")}. A later batch can cover these types.</>}</p>}
    </>}
    {gallery && !batch && !savedBatchLoading && !savedBatchUnavailable && <div className={styles.generationActions}><button className={styles.primaryButton} type="button" disabled={(!canGenerate && !allowInputPreparation) || !onRequestConcepts} onClick={onRequestConcepts}>Generate six concepts</button></div>}
    <p className={gallery ? styles.galleryProgress : styles.progress} role="status" aria-live="polite">{savedBatchUnavailable ? "Saved concept details unavailable" : savedBatchLoading ? "Loading saved concepts…" : readyCount + " of 6 concepts ready"}</p>
    {uncertain && <p className={styles.warning}>Outcome uncertain. Check the existing request before trying again. Completed concepts stay available.</p>}
    <ol className={styles.concepts}>
      {CONCEPT_ORDINALS.map(ordinal => {
        const slot = batch?.slots.find(item => item.ordinal === ordinal);
        const planned = activePlan?.slots.find(item => item.ordinal === ordinal);
        const attempt = slot?.attempts.at(-1);
        const accepted = slot ? acceptedConceptAttempt(slot) : null;
        const source: LogoConceptSource | null = batch && slot && accepted ? { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: accepted.id } : null;
        const history = slot ? versions[slot.id] ?? [] : [];
        const latest = history.at(-1);
        const viewed = slot ? viewedVersions[slot.id] : undefined;
        const savedVersion = selectedVersion ? history.find(version => version.key === logoCandidateKey(selectedVersion)) : undefined;
        const version = (viewed?.count === history.length ? history.find(item => item.key === viewed.key) : undefined)
          ?? (savedVersion && selectionAt && latest && Date.parse(selectionAt) >= Date.parse(latest.createdAt) ? savedVersion : latest);
        const displayedSource = gallery ? version?.source ?? source : source;
        const preview = gallery ? version?.preview ?? accepted?.preview : accepted?.preview;
        const selectDisplayed = displayedSource ? onSelectVersion ? () => onSelectVersion(displayedSource) : displayedSource.kind === "concept" && onSelect ? () => onSelect(displayedSource) : undefined : undefined;
        const isSelected = Boolean(displayedSource && selectedVersion && logoCandidateKey(displayedSource) === logoCandidateKey(selectedVersion));
        const isCompared = Boolean(source && comparison.some(item => logoCandidateKey(item) === logoCandidateKey(source)));
        return <li className={gallery ? styles.galleryCard : styles.conceptCard} key={ordinal} hidden={filter === "saved" && !savedBatchLoading && !isSelected && !savedVersion} data-concept-ordinal={ordinal} data-concept-slot={slot?.id} data-selected={isSelected || undefined}>
          {!gallery && <><div className={styles.cardHeading}><h3>Concept {ordinal + 1}</h3><span className={styles.badge}>{attempt ? stateLabel[attempt.state] : savedBatchUnavailable ? "Unavailable" : "Not requested"}</span></div>
          <p className={styles.typeLabel}>{planned ? LOGO_TYPE_LABELS[planned.type] : savedBatchUnavailable ? "Saved logo type unavailable" : "Choose logo types to begin"}</p>
          </>}
          {gallery && history.length > 1 && <label className={styles.versionPicker}><select aria-label={`Versions for concept ${ordinal + 1}`} value={version?.key} disabled={!onSelectVersion} onChange={event => {
            const chosen = history.find(item => item.key === event.target.value);
            if (chosen && slot) { onViewVersion?.(slot.id, chosen.key, history.length); onSelectVersion?.(chosen.source); }
          }}>{history.map(item => <option key={item.key} value={item.key}>{item.label}{item === latest ? " · Latest" : ""}</option>)}</select></label>}
          <div className={gallery ? styles.galleryPreview : styles.preview} role={gallery && selectDisplayed ? "button" : undefined} tabIndex={gallery && selectDisplayed ? 0 : undefined} aria-label={gallery ? `Select concept ${ordinal + 1}` : undefined} aria-pressed={gallery && displayedSource ? isSelected : undefined} onClick={gallery ? selectDisplayed : undefined} onKeyDown={event => { if (gallery && selectDisplayed && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); selectDisplayed(); } }}>
            {preview && renderPreview ? renderPreview(preview) : <p>{accepted ? "Image preview unavailable" : attempt ? "No image preview yet" : savedBatchLoading ? "Loading saved preview…" : savedBatchUnavailable ? "Saved preview unavailable" : "Your concept will appear here"}</p>}
          </div>
          {gallery && <div className={styles.galleryCaption}><div><h3>Concept {ordinal + 1}</h3><button type="button" className={styles.galleryLike} disabled title="Concept likes are not available yet" aria-label={`Like concept ${ordinal + 1}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-concepts/heart.svg" width={16} height={16} alt="" />Like
          </button></div><p>{planned ? LOGO_TYPE_LABELS[planned.type] : savedBatchLoading ? "Loading saved exploration…" : savedBatchUnavailable ? "Saved exploration unavailable" : "Awaiting your first exploration"}{attempt ? ` · ${stateLabel[attempt.state]}` : ""}</p></div>}
          <div hidden={gallery}>
          {accepted && <p className={styles.note}>Image preview · Vector conversion and approval follow separately.</p>}
          {slot && <div aria-label={`Charges for concept ${ordinal + 1}`}>
            {slot.attempts.map(record => <p className={styles.note} key={record.id}>
              {`Attempt ${record.attemptNumber} · ${record.billing.status === "recorded" ? `Confirmed charge: ${displayLogoCost(record.billing.confirmedMicrousd)}` : "Charge not confirmed."}`}
            </p>)}
          </div>}
          {!gallery && onInspect && <button className={styles.secondaryButton} type="button" aria-label={`Inspect concept ${ordinal + 1}`} disabled={!source} onClick={() => { if (source) onInspect(source); }}>Inspect concept</button>}
          {onCompare && <button className={styles.secondaryButton} type="button" aria-label={`Compare concept ${ordinal + 1}`} aria-pressed={isCompared} disabled={!source || !isCompared && comparison.length >= 2} onClick={() => { if (source) onCompare(source); }}>{isCompared ? "Remove from comparison" : "Add to comparison"}</button>}
          <button className={styles.secondaryButton} type="button" aria-label={`Select concept ${ordinal + 1}`} aria-pressed={isSelected} disabled={!source || !onSelect} onClick={() => { if (source) onSelect?.(source); }}>{isSelected ? "Selected for review" : "Use this version"}</button>
          </div>
        </li>;
      })}
    </ol>
    {filter === "saved" && !savedBatchLoading && !savedBatchUnavailable && !validSelection && !Object.values(versions).some(history => selectedVersion && history.some(version => version.key === logoCandidateKey(selectedVersion))) && <p className={styles.note}>No concept selected in this batch. Open a concept to review and select it.</p>}
    {!canGenerate && <p className={styles.note}>Generation is unavailable. You can keep reviewing the brief and any saved results.</p>}
    <div className={styles.actions}>
      {!gallery && !batch && <button className={styles.primaryButton} type="button" aria-label="Explore six concepts" disabled={!canGenerate || !onRequestConcepts} onClick={onRequestConcepts}>Explore six concepts</button>}
      <button className={styles.secondaryButton} type="button" aria-label="More concepts" disabled={!batch || !canGenerate || !onRequestMore} onClick={onRequestMore}>More concepts</button>
      <button className={styles.secondaryButton} type="button" aria-label="Refine selected" disabled={!validSelection || refinement?.status !== "available" || !onRequestRefine} onClick={() => { if (validSelection && selected) onRequestRefine?.(selected); }}>Refine selected</button>
      {failedSlotIds.length > 0 && <button className={styles.secondaryButton} type="button" aria-label={`Retry ${failedSlotIds.length} failed concept${failedSlotIds.length === 1 ? "" : "s"}`} disabled={!canGenerate || !onRequestRetryFailed} onClick={() => onRequestRetryFailed?.(failedSlotIds)}>Retry {failedSlotIds.length} failed concept{failedSlotIds.length === 1 ? "" : "s"}</button>}
      <button className={styles.secondaryButton} type="button" aria-label="Check request" disabled={!onCheckRequest} onClick={onCheckRequest}>Check request</button>
    </div>
  </section>;
}
