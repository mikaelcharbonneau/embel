"use client";

import { useSyncExternalStore } from "react";
import type { LogoCreationController } from "./creation-controller";
import type { LogoBillingObservation, LogoConceptBatch, LogoCostQuote } from "../../domain/logo-jobs";
import type { LogoRasterSource } from "../../domain/logo-workspace";
import { LOGO_TYPE_LABELS } from "./presentation";
import { LogoVectorSettingsSummary } from "./vector-conversion-controls";
import styles from "./logo-creation.module.css";
import stage from "@/styles/branding-stage.module.css";

function quoteContext(quote: LogoCostQuote, batch: LogoConceptBatch | null) {
  const ownedBatch = batch?.ownerId === quote.ownerId && batch?.projectId === quote.projectId ? batch : null;
  const rasterTarget = (source: LogoRasterSource) => {
    if (source.kind === "refinement") return `Saved image refinement · ${source.rasterRevisionId}`;
    const slot = ownedBatch?.id === source.batchId ? ownedBatch.slots.find(item => item.id === source.slotId) : undefined;
    const attempt = slot?.attempts.find(item => item.id === source.attemptId);
    return slot && attempt ? `Concept ${slot.ordinal + 1} · ${LOGO_TYPE_LABELS[slot.type]} · attempt ${attempt.attemptNumber}` : "Saved concept · target details unavailable";
  };
  const request = quote.request;
  switch (request.operation) {
    case "concepts": return { action: "Generate 6 concepts", target: "A new batch of six concepts" };
    case "more_concepts": return { action: "Generate 6 more concepts", target: "A separate new batch of six concepts" };
    case "retry_failed": {
      const slots = request.failedSlotIds.map(id => ownedBatch?.id === request.sourceBatchId ? ownedBatch.slots.find(slot => slot.id === id) : undefined);
      return { action: `Retry ${request.failedSlotIds.length} failed concept${request.failedSlotIds.length === 1 ? "" : "s"}`,
        target: slots.every(slot => slot !== undefined) ? slots.map(slot => `Concept ${slot!.ordinal + 1}`).join(", ") : "Failed concepts · target details unavailable" };
    }
    case "refine_preview": return { action: request.source.kind === "refinement" ? "Refine this image refinement" : "Refine this concept", target: rasterTarget(request.source) };
    case "refine_vector": return { action: "Refine vector logo", target: "Saved vector logo · target details unavailable" };
    case "vectorize": return { action: "Convert to vector", target: rasterTarget(request.source) };
    case "directions": return { action: "Build 3 identity directions", target: "Approved logo · target details unavailable" };
  }
}

/** Presentation shared by unavailable and controller-bound cost review. */
export function LogoCostConfirmationView({ quote = null, batch = null, onConfirm, onCancel, busy = false }: {
  quote?: LogoCostQuote | null;
  billing?: LogoBillingObservation | null;
  batch?: LogoConceptBatch | null;
  onConfirm?: () => void; onCancel?: () => void; busy?: boolean;
}) {
  const context = quote ? quoteContext(quote, batch) : null;
  return <section className={styles.costPanel} aria-label="Generation review">
    <h2 className={stage.sectionHeading}>Review generation</h2>
    {quote && context ? <>
      <p className={styles.note}><strong>{context.action}</strong><br />{context.target}</p>
      {quote.request.operation === "refine_preview" && <p className={styles.note} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><strong>Requested changes</strong><br />{quote.request.instruction}</p>}
      {quote.request.operation === "vectorize" && <LogoVectorSettingsSummary settings={quote.request.settings} />}
    </> : <p className={styles.note}>This request can’t be prepared right now. Nothing has started.</p>}
    {quote?.conceptPlan && quote.conceptPlan.uncoveredTypes.length > 0 && <p className={styles.warning}>Not included in this batch: {quote.conceptPlan.uncoveredTypes.map(type => LOGO_TYPE_LABELS[type]).join(", ")}. These are six total concepts.</p>}
    <div className={styles.actions}>
      <button className={styles.primaryButton} type="button" aria-label={onConfirm && context ? context.action : "Confirm generation"} disabled={!quote || !onConfirm || busy} onClick={onConfirm}>{busy ? "Confirming request…" : onConfirm && context ? context.action : "Confirm generation"}</button>
      {onCancel && <button className={styles.secondaryButton} type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
    </div>
    {!onConfirm && !busy && <p className={styles.note}>Generation is unavailable right now. Nothing has started.</p>}
  </section>;
}


/** Request status and safe recovery stay inline; this never opens a dialog. */
export function LogoCostConfirmation({ controller, batch = null }: {
  controller: LogoCreationController; batch?: LogoConceptBatch | null;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return <>
    {state.phase === "quoting" && <p role="status" className={styles.note}>Preparing your request…</p>}
    {state.error && <p role="status" className={styles.warning}>{state.error}</p>}
    {state.phase === "refreshing_workspace" && <p role="status" className={styles.note}>Refreshing saved logo inputs…</p>}
    {(state.phase === "rejected" || state.phase === "resolve_draft") && <div className={styles.actions}><button className={styles.secondaryButton} type="button" onClick={() => void controller.returnToCostReview()}>Refresh saved inputs</button></div>}
    {state.phase === "needs_reconciliation" && <div className={styles.panel}>
      <p className={styles.note}>Check the original request to recover its results and charges. No new generation starts when you check.</p>
      <div className={styles.actions}>
        <button className={styles.secondaryButton} type="button" onClick={() => void controller.checkRequest()}>Check original generation request</button>
        {state.request?.status === "not_found" && <button className={styles.secondaryButton} type="button" onClick={() => void controller.retryOriginalIntent()}>Retry original request</button>}
      </div>
    </div>}
    {state.quote && state.phase === "awaiting_confirmation" && <LogoCostConfirmationView quote={state.quote} batch={batch}
      onConfirm={controller.canConfirmQuote() ? () => { if (state.quote) void controller.confirmQuote(state.quote.id); } : undefined} onCancel={() => controller.cancelQuote()} />}

  </>;
}
