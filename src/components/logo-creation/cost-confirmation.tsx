"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import type { LogoCreationController } from "./creation-controller";
import type { LogoBillingObservation, LogoConceptBatch, LogoCostQuote } from "../../domain/logo-jobs";
import type { LogoRasterSource } from "../../domain/logo-workspace";
import { displayLogoCost, LOGO_TYPE_LABELS } from "./presentation";
import { LogoVectorSettingsSummary } from "./vector-conversion-controls";
import styles from "./logo-creation.module.css";

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
export function LogoCostConfirmationView({ quote = null, billing = null, batch = null, onConfirm, onCancel, busy = false }: {
  quote?: LogoCostQuote | null;
  billing?: LogoBillingObservation | null;
  batch?: LogoConceptBatch | null;
  onConfirm?: () => void; onCancel?: () => void; busy?: boolean;
}) {
  const context = quote ? quoteContext(quote, batch) : null;
  return <section className={styles.costPanel} aria-label="Generation cost review">
    <h2>Review the cost</h2>
    {quote && context ? <>
      <p className={styles.note}><strong>{context.action}</strong><br />{context.target}</p>
      {quote.request.operation === "refine_preview" && <p className={styles.note} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><strong>Requested changes</strong><br />{quote.request.instruction}</p>}
      {quote.request.operation === "vectorize" && <LogoVectorSettingsSummary settings={quote.request.settings} />}
      <dl className={styles.costs}>
        <div><dt>Estimated cost</dt><dd>{displayLogoCost(quote.estimatedCostMicrousd)}</dd></div>
        <div><dt>Maximum cost</dt><dd>{displayLogoCost(quote.maxCostMicrousd)}</dd></div>
      </dl>
      <p className={styles.note}>This is an estimate, not a confirmed charge. Failed provider requests can still incur costs.</p>
    </> : <p className={styles.note}>A cost estimate is unavailable. Generation cannot be confirmed.</p>}
    {billing?.status === "recorded" && <p className={styles.note}>Confirmed charge for this request: {displayLogoCost(billing.confirmedMicrousd)}</p>}
    {billing?.status === "unknown" && <p className={styles.note}>Charge not confirmed for this request.</p>}
    {quote?.conceptPlan && quote.conceptPlan.uncoveredTypes.length > 0 && <p className={styles.warning}>Not included in this batch: {quote.conceptPlan.uncoveredTypes.map(type => LOGO_TYPE_LABELS[type]).join(", ")}. These are six total concepts.</p>}
    <div className={styles.actions}>
      <button className={styles.primaryButton} type="button" aria-label={onConfirm && context ? context.action : "Confirm generation"} disabled={!quote || !onConfirm || busy} onClick={onConfirm}>{busy ? "Confirming request…" : onConfirm && context ? context.action : "Confirm generation"}</button>
      {onCancel && <button className={styles.secondaryButton} type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
    </div>
    {!onConfirm && !busy && <p className={styles.note}>Generation is unavailable. No request can be started from this cost review.</p>}
  </section>;
}


export function LogoCostConfirmation({ controller, batch = null, returnFocusRef }: {
  controller: LogoCreationController; batch?: LogoConceptBatch | null;
  /** A preparatory save can disable the initiating control before quoting. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const trigger = useRef<{ controller: LogoCreationController; element: HTMLElement } | null>(null);
  const subscribe = useCallback((listener: () => void) => controller.subscribe(() => {
    // Capture synchronously, before quoting disables and blurs the triggering
    // control. Waiting for the dialog effect loses that keyboard return target.
    if (controller.getSnapshot().phase === "quoting") {
      const element = document.activeElement;
      trigger.current = element instanceof HTMLElement && element !== document.body ? { controller, element } : null;
    }
    listener();
  }), [controller]);
  const state = useSyncExternalStore(subscribe, controller.getSnapshot, controller.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const shown = state.quote !== null && (state.phase === "awaiting_confirmation" || state.phase === "admitting");
  useEffect(() => {
    const element = dialog.current;
    if (!shown || !element) return;
    const previous = returnFocusRef?.current ?? (trigger.current?.controller === controller ? trigger.current.element : document.activeElement);
    element.showModal();
    return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [shown, controller, returnFocusRef]);
  return <>
    {state.phase === "quoting" && <p role="status" className={styles.note}>Preparing your cost estimate…</p>}
    {state.error && <p role="status" className={styles.warning}>{state.error}</p>}
    {state.phase === "refreshing_workspace" && <p role="status" className={styles.note}>Refreshing saved logo inputs…</p>}
    {(state.phase === "rejected" || state.phase === "resolve_draft") && <div className={styles.actions}><button className={styles.secondaryButton} type="button" onClick={() => void controller.returnToCostReview()}>Return to cost review</button></div>}
    {state.phase === "needs_reconciliation" && <div className={styles.panel}>
      <p className={styles.note}>Check the original request to recover its results and charges. No new generation starts when you check.</p>
      <div className={styles.actions}>
        <button className={styles.secondaryButton} type="button" onClick={() => void controller.checkRequest()}>Check original generation request</button>
        {state.request?.status === "not_found" && <button className={styles.secondaryButton} type="button" onClick={() => void controller.retryOriginalIntent()}>Retry original request</button>}
      </div>
    </div>}
    <dialog ref={dialog} className={styles.costDialog} aria-label="Review generation cost" onCancel={event => { event.preventDefault(); if (state.phase !== "admitting") controller.cancelQuote(); }}>
      {shown && <LogoCostConfirmationView quote={state.quote} batch={batch} busy={state.phase === "admitting"}
        onConfirm={controller.canConfirmQuote() ? () => { if (state.quote) void controller.confirmQuote(state.quote.id); } : undefined} onCancel={() => controller.cancelQuote()} />}
    </dialog>
  </>;
}
