"use client";
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { useAccountSession } from "@/components/workspace/account-session";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoDraftMemory } from "@/components/identity/logo-draft-memory";
import { displayLogoCost } from "@/components/logo-creation/presentation";
import { createLogoVectorProposalApplicationClient, type LogoVectorProposalApplicationResult } from "../client/proposal-application";
import { createVectorProposalController, EMPTY_PROPOSALS, type ProposalEditorContext, type VectorProposalController } from "../client/proposal-controller";
import styles from "./logo-vector.module.css";
import panel from "./vector-proposal-panel.module.css";
import type { LogoVectorProposalRecord } from "@/domain/logo-vector-proposal-jobs";

function editSummary(proposal: LogoVectorProposalRecord) {
  if (proposal.payload?.status !== "proposed") return null;
  const edit = proposal.payload.edit;
  switch (edit.kind) {
    case "size": return `Scale: ${edit.scale}.`;
    case "rotation": return `Rotation: ${edit.degrees}°.`;
    case "color": return `Fill: ${edit.fill ?? "none"}; stroke: ${edit.stroke ?? "none"}.`;
    case "spacing": return `Letter spacing: ${edit.letterSpacing}; line height: ${edit.lineHeight}.`;
    case "font": return `Font: ${proposal.context.fonts.find(font => font.id === edit.fontVersionId)?.family ?? "Saved permitted font"}.`;
    case "arrangement": return edit.placements.map(item => { const component = proposal.context.components.find(value => value.id === item.componentId); return `${component?.role.replaceAll("_", " ") ?? "Component"}: x ${item.transform.x}, y ${item.transform.y}, scale ${item.transform.scale}, rotation ${item.transform.rotation}°`; }).join("; ");
  }
}

const noopSubscription = () => () => {}, empty = () => EMPTY_PROPOSALS;
export function VectorProposalPanel({ account, projectId, client, memory, context, isCurrent, onApplied }: {
  account: VerifiedAccount; projectId: string; client: AccountLogoClient; memory: LogoDraftMemory; context: ProposalEditorContext; isCurrent(): boolean;
  onApplied(result: Extract<LogoVectorProposalApplicationResult, { status: "succeeded" }>): Promise<void>;
}) {
  const { expire } = useAccountSession();
  const [controller, setController] = useState<VectorProposalController | null>(null);
  useEffect(() => {
    const applicationClient = createLogoVectorProposalApplicationClient(account, projectId, () => isCurrent(), expire);
    const value = createVectorProposalController({ account, projectId, memory, client, applicationClient, isCurrent, now: Date.now, newKey: () => crypto.randomUUID(), onApplied });
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled && isCurrent()) { setController(value); void value.refresh(); } });
    return () => { cancelled = true; value.dispose(); };
  }, [account, projectId, memory, client, isCurrent, expire, onApplied]);
  useLayoutEffect(() => { controller?.updateContext(context); }, [controller, context]);
  const state = useSyncExternalStore(controller?.subscribe ?? noopSubscription, controller?.getSnapshot ?? empty, controller?.getServerSnapshot ?? empty);
  const form = state.session, busy = !["idle", "review"].includes(state.phase), frozen = Boolean(form?.pendingGeneration || form?.pendingApplication);
  const components = context?.detail.document.components ?? [], locks = context?.detail.revision.locks ?? [];
  const targets = form?.targetComponentIds ?? [context?.targetId ?? components[0]?.id ?? ""], instruction = form?.instruction ?? "";
  const proposal = state.application?.proposal, quote = state.quote;
  useEffect(() => {
    if (!controller || !state.capabilities) return;
    const readiness = state.capabilities.operations["identity.logo_vector_propose"];
    if (readiness?.status !== "available") return;
    const timer = setTimeout(() => controller.expireAvailability(), Math.max(1, Date.parse(readiness.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [controller, state.capabilities]);
  const active = state.discovery?.items.some(value => value.state.status !== "needs_reconciliation") || state.request && ["admitted", "running"].includes(state.request.state.status);
  useEffect(() => {
    if (!controller || !active || state.discovery?.nextCursor || state.discoveryCursor) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { if (!cancelled && document.visibilityState === "visible") timer = setTimeout(() => { void poll(); }, 4000); };
    async function poll() { if (cancelled) return; await controller!.refresh(); arm(); }
    const visible = () => { clearTimeout(timer); if (document.visibilityState === "visible") void poll(); };
    arm(); document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [controller, active, state.discovery?.nextCursor, state.discoveryCursor]);
  return <section className={panel.panel} aria-label="AI vector edit suggestions">
    <div className={styles.headingRow}><h3>AI vector edit suggestions</h3><button type="button" className="text-link" disabled={busy} onClick={() => void controller?.refresh()}>Check suggestions and requests</button></div>
    <p className={styles.caption}>Ask for one controlled change to saved components: size, rotation, color, arrangement, font or spacing. This creates a suggestion; it does not redraw or approve your logo.</p>
    {state.error && <p role="alert" className={styles.notice}>{state.error}</p>}{state.notice && <p role="status" className={styles.notice}>{state.notice}</p>}
    {!state.discovery && <p role="status">Pending AI requests have not been verified. A new suggestion cannot start until they are checked.</p>}
    {state.discovery && !state.discoveryClear && <section className={styles.notice} aria-label="Pending vector suggestions"><h4>Resolve saved requests first</h4><p>These requests still need completion or verification. Stop requests do not confirm that an external provider has stopped.</p>
      <ul className={panel.requests}>{state.discovery.items.map(value => <li key={value.input.requestKey}><p>Saved request · {value.state.status.replaceAll("_", " ")}</p><div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => void controller?.checkRequest(value.input)}>Check saved request</button>
        <button type="button" disabled={busy || state.stopAcknowledged.includes(value.input.requestKey)} onClick={() => void controller?.stopRequest(value.input)}>{state.stopAcknowledged.includes(value.input.requestKey) ? "Stop requested" : "Stop further work"}</button>
      </div></li>)}</ul>
      {state.discovery.nextCursor && <button type="button" disabled={busy} onClick={() => void controller?.morePending()}>More pending requests</button>}
      <button type="button" disabled={busy} onClick={() => void controller?.refresh()}>Check all pending requests again</button>
    </section>}
    {form?.pendingGeneration && <div className={styles.notice} role="status"><h4>Original AI request retained</h4><p>The exact instruction, saved vector and accepted request are kept until the outcome is confirmed.</p><div className={styles.actions}>
      <button type="button" disabled={busy} onClick={() => void controller?.checkRequest()}>Check original suggestion request</button>
      <button type="button" disabled={busy} onClick={() => void controller?.retryOriginal()}>Retry original suggestion request</button>
      <button type="button" disabled={busy || state.stopAcknowledged.includes(form.pendingGeneration.input.requestKey)} onClick={() => void controller?.stopRequest()}>{state.stopAcknowledged.includes(form.pendingGeneration.input.requestKey) ? "Stop requested" : "Stop original suggestion request"}</button>
    </div></div>}
    <form className={panel.form} onSubmit={event => { event.preventDefault(); void controller?.prepare(); }}>
      <fieldset disabled={busy || frozen || !context}><legend>Request a vector edit</legend>
        <label>Component<select aria-label="Suggestion component" value={targets[0] ?? ""} onChange={event => controller?.setForm(instruction, [event.target.value])}>
          {!components.some(component => component.id === targets[0]) && <option value={targets[0] ?? ""}>Earlier saved component</option>}
          {components.map((component, index) => <option key={component.id} value={component.id} disabled={locks.some(lock => lock.componentId === component.id)}>{component.role.replaceAll("_", " ")} · {index + 1}{locks.some(lock => lock.componentId === component.id) ? " (locked)" : ""}</option>)}
        </select></label>
        <label>Requested change<textarea aria-label="Requested vector change" maxLength={4000} value={instruction} onChange={event => controller?.setForm(event.target.value, targets)} placeholder="For example, make the selected symbol slightly smaller." rows={3} /></label>
        <div className={styles.actions}><button type="submit" disabled={!controller?.canPrepare() || !instruction.trim()}>Review AI suggestion request</button>{form && !frozen && <button type="button" onClick={() => controller?.discardDraft()}>Discard suggestion draft</button>}</div>
      </fieldset>
      {!controller?.canPrepare() && !frozen && <p className={styles.caption}>Use a verified current vector, resolve pending edits and requests, then check AI availability before reviewing a new request.</p>}
    </form>
    {quote && <section className={styles.notice} aria-label="Review AI suggestion request"><h4>Review the exact request</h4>
      {quote.request.operation === "propose_vector_edit" && <><p className={panel.instruction}>{quote.request.instruction}</p><p>Target: {quote.request.targetComponentIds.map(id => { const component = components.find(value => value.id === id); return component ? component.role.replaceAll("_", " ") : "Earlier saved component"; }).join(", ")}</p></>}
      {"spendControl" in quote ? <p>This request uses the configured AI service. Actual usage is recorded when reported.</p> : <p>Estimated cost: {displayLogoCost(quote.estimatedCostMicrousd)}. Accepted maximum: {displayLogoCost(quote.maxCostMicrousd)}. Failed provider calls can still incur costs.</p>}
      <p>Your approved logo stays unchanged. Applying the returned suggestion requires another explicit action.</p>
      {!controller?.canConfirm() && <p role="status">Saved inputs, availability or this review changed. Check the current vector and review a new request.</p>}
      <div className={styles.actions}><button type="button" disabled={busy || !controller?.canConfirm()} onClick={() => void controller?.confirm()}>Request AI suggestion</button><button type="button" disabled={busy} onClick={() => controller?.cancelQuote()}>Cancel suggestion review</button></div>
    </section>}
    {state.application && proposal && <section className={styles.notice} aria-label="Saved AI vector suggestion"><h4>Review saved suggestion</h4><p>Result: {proposal.state.replaceAll("_", " ")}</p>
      {proposal.payload && <><p className={panel.instruction}>{proposal.payload.explanation}</p>{proposal.payload.status === "proposed" && <><p>Proposed change: {proposal.payload.edit.kind.replaceAll("_", " ")}. Only the saved permitted command will be applied.</p><p>{editSummary(proposal)}</p></>}{proposal.payload.status === "unsupported" && <p>This request did not produce a supported edit. The saved artwork is unchanged.</p>}</>}
      {proposal.state === "needs_reconciliation" && <p>The provider outcome or charge still needs verification. This is not an applicable candidate.</p>}
      {state.application.materialization ? <p>This suggestion already has a saved vector candidate. Review it in vector history; accepting a logo is separate.</p> : <><p>Apply creates a saved, unapproved vector candidate using the original source and current saved locks. It makes no AI request.</p>
        <button type="button" disabled={busy || !controller?.canApply()} onClick={() => void controller?.apply()}>Apply as vector candidate</button>
        {!controller?.canApply() && <p className={styles.caption}>Application requires this exact saved vector and unchanged inputs, a verified result, and no unresolved local change.</p>}</>}
    </section>}
    {form?.pendingApplication && <div className={styles.notice} role="status"><h4>Original candidate application retained</h4><p>Its result is not confirmed. Checking or retrying cannot create another AI request.</p><div className={styles.actions}>
      <button type="button" disabled={busy} onClick={() => void controller?.recoverApplication(false)}>Check original candidate application</button><button type="button" disabled={busy} onClick={() => void controller?.recoverApplication(true)}>Retry original candidate application</button><button type="button" disabled={busy} onClick={() => void controller?.cancelApplication()}>Cancel original candidate application</button>
    </div></div>}
    <section aria-label="AI suggestion history"><h4>Saved suggestion history</h4>{state.history?.items.length === 0 && <p>No saved suggestions.</p>}<ul className={panel.requests}>{state.history?.items.map(value => <li key={value.id}><span>{value.state.replaceAll("_", " ")}</span><button type="button" disabled={busy || Boolean(form?.pendingApplication)} onClick={() => void controller?.selectProposal(value.id)}>Review saved suggestion</button></li>)}</ul>{state.history?.nextCursor && <button type="button" disabled={busy} onClick={() => void controller?.moreHistory()}>Earlier suggestions</button>}</section>
  </section>;
}
