"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { accountSessionSchema, accountProjectResponseSchema, accountRevisionResponseSchema } from "@/domain/project-api";
import { strategyJobResponseSchema, strategyRuntimeResponseSchema, strategyOverviewResponseSchema } from "@/domain/strategy-jobs";
import { accountErrorMessage, AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { createAccountInput } from "./project-draft-adapter";
import type { LocalDraft } from "./local-drafts";
import { StartReceiptRecoveryError, readReceipt, readDraftFence, hasDraftReceipt, type StartReceipt } from "./account-project-start-recovery";
import { forgetStrategyIntent, formatStrategyCap, strategyPromptCost, promptStrategyPlan, rememberStrategyPlan, strategyAvailabilityMessage, strategyAllowanceWithin, strategyRequestPayload, strategyJobMatchesRequest, verifyStrategyJobs } from "./account-strategy-client";
import { rememberPromptForSignIn } from "./prompt-recovery";
import { guidedAllowance, initialGuidedContext } from "./guided-interview-client";
import { finishLocalDraftRecovery, saveLocalDraftToAccount } from "./save-local-draft-to-account";
import { projectStartHref, prepareProjectStart } from "./project-start-draft";
import type { ProjectScope } from "@/domain/projects";
import { bindGuidedStartConsent, guidedStartContext, isGuidedStartTurn } from "./guided-start-consent";

type Availability = z.infer<typeof strategyRuntimeResponseSchema>["availability"];
function subscriptionLimitsLabel(limits: NonNullable<ReturnType<typeof promptStrategyPlan>>["reformulation"] & { billingMode: "chatgpt_subscription" }) {
  const value = limits.limits, number = (n: number) => n.toLocaleString("en-US");
  return `up to ${number(value.maxInputBytes)} input bytes, ${number(value.maxOutputBytes)} output bytes, ${number(value.deadlineMs / 1000)} seconds, ${number(value.maxObservedWebSearchCalls)} observed web searches, ${number(value.maxRequestsPerHour)} requests/hour and ${number(value.maxQueuedJobs)} queued requests.`;
}

/** Saves an owned project before any separately authorized AI request. */
export function useAccountStrategyStart({ beforeSignIn, recoveryDraftId = null, recoveryLocked = false, guided = false, scope = "complete_brand" }: { guided?: boolean; scope?: ProjectScope; beforeSignIn?: (locked: boolean) => boolean; recoveryDraftId?: string | null; recoveryLocked?: boolean } = {}) {
  const { session, isCurrent, expire, refresh, drafts } = useAccountSession();
  const router = useRouter();
  const [, startNavigation] = useTransition();
  const destination = useRef<{ identity: string; href: string } | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState<string | null>(null);
  const identity = session.status === "ready" ? `${session.userId}:${session.generation}` : `unverified:${session.generation}`;
  const [runtime, setRuntime] = useState<{ identity: string; availability: Availability | null } | null>(null);
  const [action, setAction] = useState<{ identity: string; pending: boolean; message: string; recoveryBlocked?: boolean } | null>(null);
  const [retained, setRetained] = useState<StartReceipt | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const recoveryKey = `${identity}:${recoveryDraftId ?? ""}`;
  const [checkedRecovery, setCheckedRecovery] = useState<{ key: string; receipt: StartReceipt | null; fenced: boolean; error: string | null } | null>(null);
  const request = useRef<AbortController | null>(null);
  const readinessRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); readinessRequest.current?.abort(); };
  }, []);
  useEffect(() => () => {
    request.current?.abort(); request.current = null;
    readinessRequest.current?.abort(); readinessRequest.current = null;
    destination.current = null;
  }, [identity]);
  useEffect(() => {
    if (session.status !== "ready" || guided && scope !== "complete_brand") return;
    const controller = new AbortController(); readinessRequest.current = controller;
    void boundedAccountRequest("/api/strategy", strategyRuntimeResponseSchema, { signal: controller.signal }).then(({ availability }) => {
      if (!controller.signal.aborted && readinessRequest.current === controller && isCurrent(session)) setRuntime({ identity, availability });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || readinessRequest.current !== controller || !isCurrent(session)) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(session);
      else setRuntime({ identity, availability: null });
    });
    return () => {
      controller.abort();
      readinessRequest.current?.abort(); readinessRequest.current = null;
    };
  }, [session, identity, isCurrent, expire, guided, scope]);
  useEffect(() => {
    if (!recoveryDraftId) return;
    let receipt: StartReceipt | null = null, error: string | null = null, fenced = false;
    try {
      if (session.status === "ready" && isCurrent(session)) receipt = readReceipt(session.userId, recoveryDraftId);
      fenced = Boolean(receipt) || readDraftFence(recoveryDraftId);
    }
    catch (cause) { error = cause instanceof Error ? cause.message : "Saved recovery records could not be verified. Check account brands before continuing."; }
    // Receipt hydration is read-only with respect to account/project requests.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCheckedRecovery({ key: recoveryKey, receipt, fenced, error });
  }, [recoveryDraftId, recoveryKey, session, isCurrent]);
  const currentRuntime = runtime?.identity === identity ? runtime : null;
  const plan = promptStrategyPlan(currentRuntime?.availability ?? null);
  const needsProjectAdmission = currentRuntime?.availability?.reason === "request_unresolved" || currentRuntime?.availability?.reason === "request_active";
  const pending = action?.identity === identity && action.pending;
  const checked = checkedRecovery?.key === recoveryKey ? checkedRecovery : null;
  const checkingRecovery = Boolean(recoveryDraftId) && (session.status === "checking" || !checked);
  const knownRecovery = Boolean(checked?.fenced || (recoveryDraftId && hasDraftReceipt(recoveryDraftId)));
  const recovered = retained ?? checked?.receipt;
  const recovery = session.status === "ready" && recovered?.ownerId === session.userId ? recovered : null;
  const recoveryBlocked = checkingRecovery || Boolean(checked?.error) || Boolean(recovery && !recovery.projectId && !recovery.request) || ((recoveryLocked || knownRecovery) && !recovery);
  const locked = Boolean(retained || checked?.receipt || checked?.error || recoveryLocked || knownRecovery || checkingRecovery);
  const message = action?.identity === identity ? action.message : "";
  const recoveryMessage = checkingRecovery ? "Checking the saved prompt's recovery status before editing or sending…"
    : recovery?.projectId ? "Your project is saved. Open it below to check the original request."
    : recovery ? "The earlier save is not confirmed. Your original prompt is kept; check and retry the same save."
    : recoveryLocked || knownRecovery ? "This prompt is locked to an earlier account save. Verify the same account before continuing. No new request has been sent." : "";


  async function verifySession(account: VerifiedAccount, controller: AbortController) {
    const { user } = await boundedAccountRequest("/api/session", accountSessionSchema, { signal: controller.signal });
    if (!mounted.current || controller.signal.aborted || !isCurrent(account)) return false;
    if (user.id !== account.userId) { expire(account); return false; }
    return true;
  }
  async function readReadiness(account: VerifiedAccount, controller: AbortController) {
    const { availability } = await boundedAccountRequest("/api/strategy", strategyRuntimeResponseSchema, { signal: controller.signal });
    if (!mounted.current || controller.signal.aborted || !isCurrent(account)) return null;
    setRuntime({ identity, availability });
    return availability;
  }
  function stopReadinessCheck() {
    readinessRequest.current?.abort(); readinessRequest.current = null;
    setCheckingAvailability(null);
  }
  async function recheck() {
    if (request.current || destination.current || checkingAvailability === identity) return;
    if (session.status !== "ready" || !isCurrent(session)) { refresh(); return; }
    const account = session, controller = new AbortController();
    readinessRequest.current?.abort(); readinessRequest.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && readinessRequest.current === controller && !request.current && !destination.current && isCurrent(account);
    setCheckingAvailability(identity);
    setAction({ identity, pending: false, message: "Checking AI availability. You can keep editing your prompt." });
    try {
      const availability = await verifySession(account, controller) ? await readReadiness(account, controller) : null;
      if (availability && current()) setAction({ identity, pending: false, message: guided ? (guidedAllowance(availability, "strategy.competitors") ? "Competitor research is ready. Send your prompt to begin." : (availability.reason === "request_unresolved" || availability.reason === "request_active" ? "An earlier request is pending. Sending checks availability for your new project." : "Competitor research is unavailable right now. Your prompt is kept.")) : promptStrategyPlan(availability) ? "AI is available. Review the request details below, then Send to request a response." : strategyAvailabilityMessage(availability) });
    } catch (error: unknown) {
      if (!current()) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else { setRuntime({ identity, availability: null }); setAction({ identity, pending: false, message: "AI availability could not be confirmed. Your prompt is kept; recheck your connection." }); }
    } finally {
      if (readinessRequest.current === controller) {
        readinessRequest.current = null;
        if (mounted.current && isCurrent(account)) setCheckingAvailability(null);
      }
    }
  }

  function openProject(href: string) {
    destination.current = { identity, href };
    setOpening(identity);
    setAction({ identity, pending: true, message: "Project saved. Opening your project…" });
    try { startNavigation(() => router.push(href)); }
    catch (cause) { destination.current = null; throw cause; }
  }

  async function startGuided(draft: LocalDraft): Promise<boolean> {
    if (draft.scope !== "complete_brand") return save(draft);
    if (request.current || destination.current || session.status !== "ready" || !isCurrent(session) || (draft.id === recoveryDraftId && recoveryBlocked)) return false;
    const account = session, controller = new AbortController();
    request.current = controller; stopReadinessCheck(); setOpening(identity);
    setAction({ identity, pending: true, message: "Saving your project…" });
    const current = () => mounted.current && !controller.signal.aborted && isCurrent(account);
    try {
      // A quick Send can beat the background readiness read. Resolve that read
      // within this explicit submit, before atomically saving its research turn.
      // Never dispatch later merely because an unavailable runtime becomes ready.
      let submittedAvailability = currentRuntime?.availability ?? null;
      if (!submittedAvailability && !readReceipt(account.userId, draft.id)) {
        try { submittedAvailability = await readReadiness(account, controller); }
        catch (cause) { if (cause instanceof AccountRequestError && cause.status === 401) throw cause; }
        if (!current()) return false;
      }
      const accepted = guidedAllowance(submittedAvailability, "strategy.competitors");
      const input = createAccountInput(draft);
      // Save the initial intent atomically with the project. The destination
      // resumes this exact turn under fresh readiness and the accepted allowance;
      // no work or admission is owned by the outgoing page's lifetime.
      if (accepted && !readReceipt(account.userId, draft.id)) input.context = guidedStartContext(input.context, account.userId, accepted);
      const created = await saveLocalDraftToAccount({ account, draft, input, signal: controller.signal, isCurrent, expire, onReceipt: value => {
        if (current()) setRetained(value);
        try { rememberPromptForSignIn(draft.id, Boolean(value), draft); } catch { /* The exact account request remains in its recovery receipt. */ }
      } });
      if (!created?.receipt.projectId || !current()) return false;
      // Account-level availability is not project admission. A historical hold
      // may block Home while this newly owned project is eligible. Resolve the
      // exact project within this explicit Send, never on a later focus event.
      let acknowledged = created.project;
      if (!accepted) {
        let project = acknowledged;
        if (!project) project = (await boundedAccountRequest(`/api/projects/${created.receipt.projectId}`, accountProjectResponseSchema, { signal: controller.signal })).project;
        if (!current()) return false;
        if (project.owner_id !== account.userId || project.id !== created.receipt.projectId) { expire(account); return false; }
        if (project.current_revision === 1 && !project.context.intake.guidedInterview?.turns.length) {
          // The project save is already verified. Readiness is optional: an outage
          // must not turn a successful save into an apparent save failure. Keep
          // auth/not-found failures visible, and never swallow a later PATCH.
          let overview: z.infer<typeof strategyOverviewResponseSchema> | null = null;
          try { overview = await boundedAccountRequest(`/api/projects/${project.id}/strategy`, strategyOverviewResponseSchema, { signal: controller.signal }); }
          catch (cause) {
            if (cause instanceof AccountRequestError && [401, 403, 404].includes(cause.status)) throw cause;
          }
          if (!current()) return false;
          if (overview && !verifyStrategyJobs(overview.jobs, account.userId, project.id)) { expire(account); return false; }
          const projectAllowance = guidedAllowance(overview?.availability ?? null, "strategy.competitors");
          if (projectAllowance && overview && !overview.jobs.length) {
            const next = guidedStartContext(project.context, account.userId, projectAllowance, 2, project.id);
            const { revision } = await boundedAccountRequest(`/api/projects/${project.id}`, accountRevisionResponseSchema, {
              method: "PATCH", signal: controller.signal, body: { expectedRevision: 1, context: next },
            });
            if (!current()) return false;
            if (revision.owner_id !== account.userId || revision.project_id !== project.id || revision.revision !== 2) { expire(account); return false; }
            acknowledged = { ...project, current_revision: revision.revision, context: revision.context };
            const turn = revision.context.intake.guidedInterview?.turns.at(-1);
            if (isGuidedStartTurn(turn)) bindGuidedStartConsent(account.userId, turn!.id, project.id);
          }
        }
      }
      const savedTurn = (created.project?.context ?? created.receipt.request?.input.context)?.intake.guidedInterview?.turns.at(-1);
      if (isGuidedStartTurn(savedTurn)) bindGuidedStartConsent(account.userId, savedTurn!.id, created.receipt.projectId);
      openProject(prepareProjectStart(created.receipt.projectId, created.project?.scope ?? draft.scope, created.newProject ? acknowledged : null, account, drafts));
      finishLocalDraftRecovery(draft.id, account.userId, created.receipt.projectId);
      return true;
    } catch (cause) {
      if (!current()) return false;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setAction({ identity, pending: false, message: cause instanceof StartReceiptRecoveryError ? cause.message : "Your project could not be confirmed. Its original content is kept; check and retry the same save." });
      return false;
    } finally {
      if (request.current === controller) request.current = null;
      if (current() && !destination.current) { setAction(previous => previous?.identity === identity ? { ...previous, pending: false } : previous); setOpening(null); }
    }
  }

  async function start(draft: LocalDraft): Promise<boolean> {
    if (guided) return startGuided(draft);
    if (request.current || destination.current || session.status !== "ready" || !isCurrent(session) || (draft.id === recoveryDraftId && recoveryBlocked)) return false;
    const account = session, controller = new AbortController();
    request.current = controller; stopReadinessCheck();
    if (guided) setOpening(identity);
    setAction({ identity, pending: true, message: "" });
    const current = () => mounted.current && !controller.signal.aborted && isCurrent(account);
    let receipt: StartReceipt | null = null;
    try {
      // All readiness checks are read-only. Newly discovered or higher limits must
      // be displayed before a subsequent explicit Send can authorize generation.
      if (!await verifySession(account, controller)) return false;
      receipt = readReceipt(account.userId, draft.id);
      if (receipt) {
        setRetained(receipt);
        if (receipt.projectId) { openProject(`/brands/account/${receipt.projectId}`); finishLocalDraftRecovery(draft.id, account.userId, receipt.projectId); return true; }
        const recovered = await saveLocalDraftToAccount({ account, draft, signal: controller.signal, isCurrent, expire, sessionVerified: true, onReceipt: value => { receipt = value; if (current()) setRetained(value); } });
        if (recovered?.receipt.projectId && current()) { openProject(`/brands/account/${recovered.receipt.projectId}`); finishLocalDraftRecovery(draft.id, account.userId, recovered.receipt.projectId); return true; }
        return false;
      }
      const availability = await readReadiness(account, controller);
      if (!current() || !availability) return false;
      // Another mounted view may have started this exact browser draft while
      // readiness was being checked. Never create a second account copy.
      receipt = readReceipt(account.userId, draft.id);
      if (receipt) { setRetained(receipt); setAction({ identity, pending: false, message: "This draft already has an account save to check. Use its recovery link below." }); return false; }
      const freshPlan = promptStrategyPlan(availability);
      const selectedAllowance = guided ? guidedAllowance(availability, "strategy.competitors") : plan?.reformulation;
      if ((guided && !selectedAllowance) || (!guided && !freshPlan)) { setAction({ identity, pending: false, message: strategyAvailabilityMessage(availability) }); return false; }
      const acceptedResearch = guided ? guidedAllowance(currentRuntime?.availability, "strategy.competitors") : null;
      if (guided ? !acceptedResearch || !strategyAllowanceWithin(selectedAllowance!, acceptedResearch) : !plan || !freshPlan || freshPlan.kind !== plan.kind || !strategyAllowanceWithin(freshPlan.reformulation, plan.reformulation)
        || (freshPlan.kind === "response_and_competitors" && plan.kind === "response_and_competitors" && !strategyAllowanceWithin(freshPlan.competitors, plan.competitors))) {
        setAction({ identity, pending: false, message: "AI readiness or request details changed. Review the details below, then Send again. No AI request was sent." }); return false;
      }
      if (!selectedAllowance) return false;
      const input = createAccountInput(draft);
      if (guided) input.context = initialGuidedContext(input.context, 1);
      setAction({ identity, pending: true, message: "Saving your project…" });
      const created = await saveLocalDraftToAccount({ account, draft, input, sessionVerified: true, signal: controller.signal, isCurrent, expire, onReceipt: value => {
        receipt = value;
        if (current()) setRetained(value);
        try { rememberPromptForSignIn(draft.id, Boolean(value)); } catch { /* The owner-bound receipt still retains the exact save. */ }
      } });
      if (!created || !current()) return false;
      const project = created.project;
      if (!project || project.current_revision !== 1) { openProject(`/brands/account/${created.receipt.projectId}`); return true; }
      finishLocalDraftRecovery(draft.id, account.userId, project.id);
      if (!guided) rememberStrategyPlan({ ownerId: account.userId, projectId: project.id, revision: project.current_revision }, plan!);
      const operation = guided ? "strategy.competitors" : "strategy.reformulate";
      setAction({ identity, pending: true, message: "Submitting your AI response request…" });
      try {
        const { job } = await boundedAccountRequest(`/api/projects/${project.id}/strategy`, strategyJobResponseSchema, {
          method: "POST", signal: controller.signal,
          body: strategyRequestPayload(project.id, project.current_revision, operation, selectedAllowance),
        });
        if (!current()) return false;
        if (!verifyStrategyJobs([job], account.userId, project.id)) { expire(account); return false; }
        if (!strategyJobMatchesRequest(job, operation, project.current_revision, selectedAllowance)) {
          forgetStrategyIntent(account.userId, project.id, project.current_revision);
          throw new AccountRequestError(502);
        }
      } catch (error: unknown) {
        if (!current()) return false;
        if (error instanceof AccountRequestError && error.status === 401) { expire(account); return false; }
        setAction({ identity, pending: false, message: "Your account copy is saved, but the AI request is not confirmed. Open the saved project to check its status or explicitly retry there." });
        return false;
      }
      if (current()) openProject(`/brands/account/${project.id}`);
      return true;
    } catch (error: unknown) {
      if (!current()) return false;
      if (error instanceof AccountRequestError && error.status === 401) { expire(account); return false; }
      if (error instanceof StartReceiptRecoveryError) { setAction({ identity, pending: false, message: error.message, recoveryBlocked: true }); return false; }
      setAction({ identity, pending: false, message: receipt ? "The save is not confirmed. Your original prompt is kept; check and retry the same save." : `${accountErrorMessage(error)} No AI request was sent. Your prompt is kept.` });
      return false;
    } finally {
      if (request.current === controller) request.current = null;
      if (mounted.current && isCurrent(account) && !destination.current) { setAction(previous => previous?.identity === identity ? { ...previous, pending: false } : previous); setOpening(null); }
    }
  }
  async function save(draft: LocalDraft): Promise<boolean> {
    if (request.current || destination.current || session.status !== "ready" || !isCurrent(session) || (draft.id === recoveryDraftId && recoveryBlocked)) return false;
    const account = session, controller = new AbortController();
    request.current = controller; stopReadinessCheck();
    if (guided) setOpening(identity);
    setAction({ identity, pending: true, message: "Saving your project…" });
    const current = () => mounted.current && !controller.signal.aborted && isCurrent(account);
    try {
      const result = await saveLocalDraftToAccount({ account, draft, signal: controller.signal, isCurrent, expire, onReceipt: receipt => {
        if (current()) setRetained(receipt);
        try { rememberPromptForSignIn(draft.id, Boolean(receipt), draft); } catch { /* The exact save remains in the owner-bound receipt. */ }
      } });
      if (!result?.receipt.projectId || !current()) return false;
      const savedTurn = (result.project?.context ?? result.receipt.request?.input.context)?.intake.guidedInterview?.turns.at(-1);
      if (isGuidedStartTurn(savedTurn)) bindGuidedStartConsent(account.userId, savedTurn!.id, result.receipt.projectId);
      openProject(prepareProjectStart(result.receipt.projectId, result.project?.scope ?? draft.scope, result.newProject ? result.project : null, account, drafts)); finishLocalDraftRecovery(draft.id, account.userId, result.receipt.projectId); return true;
    } catch (cause) {
      if (!current()) return false;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setAction({ identity, pending: false, message: cause instanceof StartReceiptRecoveryError ? cause.message : "Your project could not be confirmed. Its original content is kept; check and retry the same save." });
      return false;
    } finally {
      if (request.current === controller) request.current = null;
      if (current() && !destination.current) { setAction(previous => previous?.identity === identity ? { ...previous, pending: false } : previous); setOpening(null); }
    }
  }
  const notice = <div>
    {checked?.error && <p className="form-error" role="alert">{checked.error}</p>}
    <p className="field-hint" role="status">{pending ? message || "Checking your account and AI readiness…" : message || recoveryMessage || (session.status === "checking"
      ? "Checking your account. Your prompt is kept; send once verification finishes."
      : session.status === "signed_out" ? "Sign in to save your project and request an AI response. Your prompt is kept."
      : session.status !== "ready" ? "Your account could not be verified. Recheck your account before requesting AI. Your prompt is kept."
      : !currentRuntime ? "Checking AI availability. Send rechecks readiness and keeps your prompt here if AI cannot start."
      : !plan ? strategyAvailabilityMessage(currentRuntime.availability) : "AI is available. Send requests a response using the details below.")}</p>
    {plan && <p className="field-hint">{plan.billingMode === "chatgpt_subscription"
      ? "Sending saves your project and uses your ChatGPT plan for a response. Competitor research starts after you apply the response. Your plan limits apply."
      : strategyPromptCost(plan) === null ? `Sending saves your project and uses OpenAI for ${plan.kind === "response_only" ? "a response. Competitor research is unavailable." : "a response and competitor research. Competitor research starts after you apply the response."}`
      : plan.kind === "response_only"
        ? `Sending saves your project and requests a response, up to ${formatStrategyCap(strategyPromptCost(plan)!)}. Competitor research is unavailable.`
      : `Sending saves your project and uses OpenAI for a response and competitor research, up to ${formatStrategyCap(strategyPromptCost(plan)!)} total. Competitor research starts after you apply the response.`}</p>}
    {plan?.billingMode === "chatgpt_subscription" && <div>
      <p className="field-hint" aria-label="Response usage limits">Response: {subscriptionLimitsLabel(plan.reformulation)}</p>
      <p className="field-hint" aria-label="Competitor research usage limits">Competitor research: {subscriptionLimitsLabel(plan.competitors)}</p>
      <p className="field-hint">These are Embel request limits, not your remaining ChatGPT plan quota.</p>
    </div>}
    {action?.identity === identity && action.recoveryBlocked && <p className="field-hint"><Link className="text-link" href="/brands">Check account brands</Link></p>}
    {recovery && <p className="field-hint">{recovery.projectId
      ? <Link className="text-link" href={`/brands/account/${recovery.projectId}`}>Open saved account project and check AI status</Link>
      : <>The earlier account save is not confirmed. <Link className="text-link" href="/brands">Check account brands</Link> before trying another account save. Your original prompt is kept.</>}</p>}
    <div className="account-strategy-actions">
      {session.status === "signed_out" && <Link className="text-link" href="/sign-in" onClick={event => { if (beforeSignIn && !beforeSignIn(locked)) event.preventDefault(); }}>Sign in</Link>}
      <button type="button" className="text-link" disabled={pending || checkingAvailability === identity || session.status === "checking"} onClick={() => void recheck()}>{session.status === "ready" ? "Recheck AI availability" : "Recheck account"}</button>
    </div>
  </div>;
  const guidedNotice = <div>{message && <p className="field-hint" role="status">{message}</p>}{recoveryMessage && <p className="field-hint">{recoveryMessage}</p>}{checked?.error && <p role="alert">{checked.error}</p>}{session.status === "signed_out" && <p className="field-hint"><Link href="/sign-in" className="text-link" onClick={event => { if (beforeSignIn && !beforeSignIn(locked)) event.preventDefault(); }}>Sign in</Link> to save your project. Your prompt is kept.</p>}{session.status === "ready" && scope === "complete_brand" && currentRuntime && !guidedAllowance(currentRuntime.availability, "strategy.competitors") && <p className="field-hint">{needsProjectAdmission ? "Sending checks AI availability for your new project. Earlier requests keep their own status." : "AI is unavailable right now. Continue to save your brief and edit your project."}</p>}{recovery?.projectId ? <Link className="text-link" href={projectStartHref(recovery.projectId, scope)}>Open saved project</Link> : recovery && <Link className="text-link" href="/brands">Check account brands</Link>}{scope === "complete_brand" && !pending && (message || !guidedAllowance(currentRuntime?.availability, "strategy.competitors")) && <button type="button" className="text-link" disabled={checkingAvailability === identity} onClick={() => void recheck()}>{checkingAvailability === identity ? "Checking AI availability…" : "Check AI availability"}</button>}</div>;
  function detachPrompt() { if (request.current || destination.current) return; setRetained(null); setCheckedRecovery(null); setAction(null); setOpening(null); }
  return { notice: guided ? guidedNotice : notice, pending, starting: guided && opening === identity && pending, startMessage: message, openingHref: destination.current?.identity === identity ? destination.current.href : null, start, save, detachPrompt, locked, checkingRecovery, recoveryBlocked, recoveryProjectId: recovery?.projectId ?? null };
}
