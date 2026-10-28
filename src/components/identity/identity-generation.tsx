"use client";
import { useEffect, useRef, useState } from "react";
import { identityGenerationIntentSchema, type IdentityGenerationIntent } from "@/domain/identity-jobs";
import type { ProjectIdentityController } from "./use-project-identity";
import { identityBatchUnresolved } from "./identity-generation-controller";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";
import sheet from "@/components/ui/context-details.module.css";

type Review = { fence: string; input: IdentityGenerationIntent };
export function IdentityGeneration({ identity }: { identity: Pick<ProjectIdentityController, "generation" | "overview" | "verified" | "generationBlockedReason"> }) {
  const { generation, overview, verified, generationBlockedReason } = identity;
  const [review, setReview] = useState<Review | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const availability = generation.overview?.availability, batch = generation.batch;
  const fence = `${verified?.userId ?? ""}:${verified?.generation ?? ""}:${overview?.projectId ?? ""}`;
  const stoppable = identityBatchUnresolved(batch), stopAcknowledged = Boolean(batch && generation.stopAcknowledgedBatchId === batch.batchId), unresolved = identityBatchUnresolved(batch) || identityBatchUnresolved(generation.overview?.latest ?? null);
  const blocked = Boolean(generationBlockedReason || generation.busy || generation.retained || unresolved || availability?.status !== "available");
  const currentReview = review?.fence === fence ? review : null;
  const sameInputs = currentReview && overview && "version" in currentReview.input && currentReview.input.version === 2
    && currentReview.input.expectedProjectRevision === overview.project.current_revision
    && currentReview.input.expectedReferenceRevision === overview.referenceSnapshot.referenceRevision
    && currentReview.input.expectedPreferencesRevision === (overview.preferences?.revision ?? 0)
    && currentReview.input.expectedIdentityRevision === (overview.session?.identityRevision ?? 0)
    && availability?.status === "available" && currentReview.input.acceptedPolicyIdentity === availability.policyIdentity;
  useEffect(() => {
    const element = dialog.current; if (!element) return;
    if (currentReview && !element.open) element.showModal();
    if (!currentReview && element.open) {
      element.close();
      const target = trigger.current && !trigger.current.disabled && trigger.current.getClientRects().length ? trigger.current : heading.current;
      if (!document.querySelector("dialog[open]")) target?.focus({ preventScroll: true });
    }
  }, [currentReview]);
  function openReview() {
    if (blocked || !overview || !verified || availability?.status !== "available") return;
    const input = identityGenerationIntentSchema.parse({ version: 2, spendControl: "uncapped", expectedProjectRevision: overview.project.current_revision,
      expectedReferenceRevision: overview.referenceSnapshot.referenceRevision, expectedPreferencesRevision: overview.preferences?.revision ?? 0,
      expectedIdentityRevision: overview.session?.identityRevision ?? 0, idempotencyKey: crypto.randomUUID(), acceptedPolicyIdentity: availability.policyIdentity });
    setReview({ fence, input });
  }
  const unavailableReason = availability?.status === "unavailable" && availability.reason === "reference_limit_exceeded"
    ? "Choose one to four reference images totaling 20 MiB or less for this request. Your saved references and earlier systems are kept."
    : availability?.status === "unavailable" && availability.reason === "reference_bytes_exceeded" ? "Choose reference images totaling 20 MiB or less. Your saved selection and earlier systems are kept until you explicitly change them."
    : availability?.status === "unavailable" && availability.reason === "inputs_not_ready" ? "Finish the saved brief, brand name and reference selection before generating."
    : "New system generation is unavailable.";
  return <section className="identity-generation-gate" aria-label="Identity generation">
    <h3 ref={heading} tabIndex={-1}>Generate Identity systems</h3>
    <p>Create up to three coordinated system previews from your saved brief, selected references and Identity preferences. New results are saved in history; choosing a current system is a separate action.</p>
    {availability?.status !== "available" && <p>{unavailableReason}</p>}
    {generationBlockedReason && <p className="field-hint">{generationBlockedReason}</p>}
    {generation.error && <p className="identity-notice identity-error" role="alert">{generation.error}</p>}
    {generation.retained && <div className="identity-recovery" role="status"><p>The original generation request is not confirmed. Check it before starting another request.</p>
      <div className="identity-actions"><button type="button" className="identity-secondary-button" disabled={Boolean(generation.busy)} onClick={() => { void generation.controller?.refresh(); }}>Check original generation</button>
      <button type="button" className="identity-secondary-button" disabled={Boolean(generation.busy)} onClick={() => { void generation.controller?.closeOriginal(); }}>Stop original generation</button>
      {generation.lookup === "not_found" && <button type="button" className="identity-secondary-button" disabled={Boolean(generation.busy)} onClick={() => { void generation.controller?.retryOriginal(); }}>Retry original generation</button>}</div>
    </div>}
    {batch && <div className="identity-generation-progress" role="status" aria-live="polite">
      <p>{batch.fulfillment.acceptedCount} of {batch.fulfillment.targetCount} systems saved.</p>
      <p>{batch.status === "queued" ? "Generation is queued." : batch.status === "running" ? "Generation is in progress. Completed systems stay saved as the request continues."
        : batch.status === "cancel_requested" ? "Stopping is requested. Work already in progress may still finish and be saved."
        : batch.status === "needs_reconciliation" ? "This request needs verification before another generation can start. Your saved systems remain available."
        : batch.status === "cancelled" ? "Generation stopped. Completed systems remain in history."
        : batch.status === "partial" ? "This set did not fully finish. Its completed systems remain in history."
        : batch.status === "failed" ? "The request did not finish successfully. Any completed systems remain in history."
        : "The generated systems are saved. Review them below before choosing a current system."}</p>
      {batch.status === "needs_reconciliation" && <p>{stopAcknowledged ? "Stop is requested. Existing provider outcomes still need verification before this request can finish." : "You can request Stop to prevent further work. Existing provider outcomes still need verification; Stop does not confirm that a remote provider has stopped."}</p>}
      {batch.terminal && batch.fulfillment.acceptedCount < batch.fulfillment.targetCount && <p>A new set is a separate request; it does not replace these completed systems.</p>}
      <div className="identity-actions"><button type="button" className="text-link" disabled={Boolean(generation.busy)} onClick={() => { void generation.controller?.refresh(); }}>Check generation status</button>
        {stoppable && <button type="button" className="identity-secondary-button" disabled={Boolean(generation.busy) || batch.status === "cancel_requested" || stopAcknowledged} onClick={() => { void generation.controller?.stop(); }}>{generation.busy === "stopping" ? "Requesting Stop…" : stopAcknowledged && batch.status === "needs_reconciliation" ? "Stop requested" : batch.status === "cancel_requested" ? "Stopping…" : batch.status === "needs_reconciliation" ? "Stop further work" : "Stop generation"}</button>}</div>
    </div>}
    <div className="identity-actions"><button ref={trigger} type="button" className="identity-primary-button" disabled={blocked} aria-haspopup="dialog" onClick={openReview}>{batch?.terminal ? "Generate another set" : "Review Identity generation"}</button>
      {!batch && !generation.retained && <button type="button" className="text-link" disabled={Boolean(generation.busy)} onClick={() => { void generation.controller?.refresh(); }}>{generation.busy === "checking" ? "Checking generation…" : "Check generation availability"}</button>}</div>
    <dialog ref={dialog} className={sheet.sheet} aria-labelledby="identity-generation-review-title" onCancel={event => { event.preventDefault(); setReview(null); }} onClose={() => setReview(null)} onClick={event => { if (isDialogBackdropClick(event)) setReview(null); }}>
      <header><h2 id="identity-generation-review-title">Review Identity generation</h2><button type="button" className="button secondary small" onClick={() => setReview(null)}>Close generation review</button></header>
      <div className={sheet.content}><p>This starts a new AI request using the saved inputs you reviewed. It can produce up to three coordinated previews and component specifications.</p>
        <p>Font names are specifications; they do not establish font licenses or provide font files. Production files are shown only when actually supplied.</p>
        {(!sameInputs || blocked) && <p role="alert">The saved inputs or generation availability changed. Close this review and check the latest before continuing.</p>}
        <button type="button" className="identity-primary-button" disabled={!sameInputs || blocked} onClick={() => { if (!currentReview || !sameInputs || blocked) return; const input = currentReview.input; setReview(null); void generation.controller?.start(input); }}>Start Identity generation</button>
      </div>
    </dialog>
  </section>;
}
