"use client";

import { useId } from "react";
import { displayLogoCost } from "@/components/logo-creation/presentation";
import type { DirectionGeneration } from "./use-direction-generation";
import styles from "./identity-directions.module.css";

export function DirectionGenerationControls({ controller }: { controller: DirectionGeneration }) {
  const descriptionId = useId();
  const state = controller?.state, generation = state?.generation, quote = generation?.quote;
  const request = generation?.request && generation.request.status !== "not_found" ? generation.request : null;
  const subscription = quote?.billingMode === "chatgpt_subscription";
  const confirming = generation?.phase === "admitting" || !!state?.loadingFonts;
  const otherOperation = request?.receipt && "operation" in request.receipt && request.receipt.operation !== "identity.logo_directions";
  const status = otherOperation ? "Another logo operation is retained for this workspace. Check its status before generating directions." : request?.status === "admitted" ? "Request accepted. Waiting for the worker."
    : request?.status === "running" ? "Generating three coordinated directions."
    : request?.status === "succeeded" ? "The generation request completed. Review its saved directions below."
    : request?.status === "partial" ? "The request ended with partial results. Earlier saved directions are kept."
    : request?.status === "failed" ? "The generation request did not complete. Earlier saved directions are kept."
    : request?.status === "cancelled" ? "The generation request was cancelled. Earlier saved directions are kept."
    : request?.status === "needs_reconciliation" ? "The generation outcome still needs checking. Its original request is retained." : null;
  return <section className={styles.generationSection} aria-label="Generate identity directions">
    <div className={styles.generation}><div><h3>Three directions, one logo</h3><p id={descriptionId} className={styles.caption}>
      {state?.canEstimate ? "Get an estimate for exactly three coordinated palette, typography and graphics directions. Your approved logo stays unchanged." : state?.unavailableReason ?? "Generation is unavailable while your workspace is loading."}
    </p></div><button type="button" disabled={!state?.canEstimate} aria-describedby={descriptionId} onClick={() => { void controller?.prepare(); }}>Estimate directions</button></div>
    {state?.fonts && state.fonts.length > 0 && <details className={styles.details}><summary>Permitted font versions ({state.fonts.length})</summary>
      <p className={styles.caption}>Generation uses the saved, owned fonts with reviewed commercial-use and display permissions. Embedding and sharing files require their separate permissions. Paid-font suggestions are excluded.</p>
      <ul className={styles.fontList}>{state.fonts.map(font => <li key={font.id}>{font.family} · {font.source === "free_catalog" ? "Free catalog" : "Reviewed upload"}<span className={styles.version}>Version {font.id}</span></li>)}</ul>
    </details>}
    {state && <button type="button" onClick={() => { void controller?.refreshAvailability(); }}>Refresh operation availability</button>}
    {state && <button type="button" disabled={state.loadingFonts || state.checking} onClick={() => { void controller?.refreshFonts(); }}>Refresh generation inputs</button>}
    {generation?.phase === "quoting" && <p className={styles.caption} role="status">Preparing your cost estimate…</p>}
    {quote && ["awaiting_confirmation", "admitting"].includes(generation!.phase) && <section className={styles.costReview} aria-label="Direction generation cost review">
      <h3>{subscription ? "Review subscription usage" : "Review the cost"}</h3><p className={styles.caption}>Generate exactly 3 identity directions around the approved logo. Existing saved directions remain in history.</p>
      <p className={styles.caption}>{quote.provider && quote.model ? `${quote.provider} · ${quote.model}` : "Configured generation operation"}</p>
      <p className={styles.version}>Approved logo {quote.request.operation === "directions" ? quote.request.approvedLogoId : "unavailable"}</p>
      {state?.reviewedVisualDirection && <p className={styles.caption}>Reviewed visual direction version {state.reviewedVisualDirection.revision} · {state.reviewedVisualDirection.references.length} attributed references. Your written guidance and saved aspects are included as text.</p>}
      {subscription ? <><p className={styles.caption}>ChatGPT subscription usage applies. No separate API charge under this verified subscription policy.</p>
        <p className={styles.caption}>Remaining allowance is unavailable. Token usage is unavailable unless the provider reports it; interrupted requests may still consume subscription usage.</p></> : <><dl className={styles.permissions}><div><dt>Estimated cost</dt><dd>{displayLogoCost(quote.estimatedCostMicrousd)}</dd></div><div><dt>Maximum cost</dt><dd>{displayLogoCost(quote.maxCostMicrousd)}</dd></div></dl>
        <p className={styles.caption}>This is an estimate, not a confirmed charge. Failed provider requests can still incur costs.</p></>}
      <div className={styles.actions}><button type="button" disabled={confirming || !state?.canConfirm} onClick={() => { void controller?.confirmQuote(quote.id); }}>{generation!.phase === "admitting" ? "Confirming request…" : "Confirm and generate 3 directions"}</button>
        <button type="button" disabled={generation!.phase === "admitting"} onClick={() => controller?.cancelQuote()}>Cancel estimate</button></div>
    </section>}
    {generation?.error && <p className={styles.warning} role="status">{generation.error}</p>}
    {state?.message && <p className={styles.notice} role="status">{state.message}</p>}
    {(generation?.phase === "rejected" || generation?.phase === "resolve_draft") && <button type="button" disabled={state?.checking} onClick={() => { void controller?.returnToCostReview(); }}>Return to cost review</button>}
    {generation?.phase === "refreshing_workspace" && <p className={styles.caption} role="status">Refreshing saved inputs…</p>}
    {request && <div className={styles.notice} role="status"><strong>{status}</strong>
      {request.outputs.length > 0 && <p>{request.outputs.length} verified output{request.outputs.length === 1 ? " is" : "s are"} retained with this request. A partial result is not an approved identity.</p>}
      {request.billing.status === "recorded" ? <p>Recorded API charge: {displayLogoCost(request.billing.confirmedMicrousd)}</p> : <p>API charge not confirmed for this request.</p>}
      <p className={styles.caption}>Subscription usage, when applicable, is separate from API charges. Remaining allowance is unavailable.</p>
      <p className={styles.version}>Request {request.requestKey}</p>
    </div>}
    {(generation?.phase === "active" || generation?.phase === "needs_reconciliation" || generation?.phase === "admitting") && <div className={styles.actions}>
      <button type="button" disabled={state?.checking || generation.phase === "admitting"} onClick={() => { void controller?.checkRequest(); }}>{state?.checking ? "Checking original request…" : "Check original generation request"}</button>
      <p className={styles.caption}>Checking reads the retained request and never starts or retries generation.</p>
    </div>}
  </section>;
}
