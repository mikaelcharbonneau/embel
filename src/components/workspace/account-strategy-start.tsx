"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { accountProjectResponseSchema, accountSessionSchema } from "@/domain/project-api";
import { strategyJobResponseSchema, strategyRuntimeResponseSchema } from "@/domain/strategy-jobs";
import { accountErrorMessage, accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { createAccountInput } from "./project-draft-adapter";
import { DRAFT_STORAGE_KEY, getLocalDraft, localDraftStorageState, type LocalDraft } from "./local-drafts";
import { forgetStrategyIntent, formatStrategyCap, promptStrategyPlan, rememberStrategyPlan, strategyAvailabilityMessage, strategyAllowanceWithin, strategyRequestPayload, strategyJobMatchesRequest, verifyStrategyJobs } from "./account-strategy-client";
import { rememberPromptForSignIn } from "./prompt-recovery";

type Availability = z.infer<typeof strategyRuntimeResponseSchema>["availability"];
// Project creation has no idempotency key. Retain only recovery IDs, never prompts
// or credentials, and do not repeat an unconfirmed create after remount/retry.
const startReceiptSchema = z.strictObject({ ownerId: z.uuid(), draftId: z.uuid(), projectId: z.uuid().nullable() });
type StartReceipt = z.infer<typeof startReceiptSchema>;
const legacyReceiptKey = "fluid.strategy-starts.v1";
const receiptKey = (ownerId: string) => `fluid.strategy-starts.v2:${ownerId}`;
const receipts = new Map<string, StartReceipt>();
const receiptId = (ownerId: string, draftId: string) => `${ownerId}:${draftId}`;
class StartReceiptRecoveryError extends Error {}
const ownerReceipts = (ownerId: string) => [...receipts.values()].filter(receipt => receipt.ownerId === ownerId);
function persistReceipts(ownerId: string) {
  try { window.sessionStorage.setItem(receiptKey(ownerId), JSON.stringify(ownerReceipts(ownerId))); }
  catch { /* This running tab retains every unresolved guard when storage fails. */ }
}
function retireConfirmedReceipts(ownerId: string, activeDraftId: string) {
  // A known account destination can retire only when its browser source is gone
  // from both the current draft store and freshly readable durable storage. Never
  // retire an uncertain create or use unavailable/corrupt storage as deletion proof.
  let storedIds: Set<string>;
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (raw && raw.length > 8_000_000) return;
    const stored = z.object({ version: z.literal(1), drafts: z.array(z.object({ id: z.uuid() })).max(50) }).safeParse(JSON.parse(raw ?? '{"version":1,"drafts":[]}'));
    if (!stored.success || localDraftStorageState() !== "available") return;
    storedIds = new Set(stored.data.drafts.map(draft => draft.id));
  } catch { return; }
  let changed = false;
  for (const receipt of ownerReceipts(ownerId)) {
    if (receipt.projectId && receipt.draftId !== activeDraftId && !storedIds.has(receipt.draftId) && !getLocalDraft(receipt.draftId)) {
      receipts.delete(receiptId(ownerId, receipt.draftId)); changed = true;
    }
  }
  if (changed) persistReceipts(ownerId);
}
function readReceipt(ownerId: string, draftId: string) {
  let raw: string | null = null, legacy = false;
  try {
    raw = window.sessionStorage.getItem(receiptKey(ownerId));
    if (raw === null) { raw = window.sessionStorage.getItem(legacyReceiptKey); legacy = true; }
  } catch { /* Existing in-memory guards remain authoritative in this tab. */ }
  if (raw !== null) {
    const stored = z.array(startReceiptSchema).max(legacy ? 200 : 250).safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
    if (!stored.success || (!legacy && stored.data.some(receipt => receipt.ownerId !== ownerId))) throw new StartReceiptRecoveryError("Saved recovery records could not be verified. No new account project or AI request was sent. Check account brands before continuing.");
    for (const receipt of stored.data) if (receipt.ownerId === ownerId && !receipts.has(receiptId(ownerId, receipt.draftId))) receipts.set(receiptId(ownerId, receipt.draftId), receipt);
  }
  retireConfirmedReceipts(ownerId, draftId);
  return receipts.get(receiptId(ownerId, draftId)) ?? null;
}
function readDraftFence(draftId: string) {
  if ([...receipts.values()].some(receipt => receipt.draftId === draftId)) return true;
  // Older Home markers had no edit-fence bit. Before authentication, consult only
  // the local receipt metadata for a boolean fence; never expose an owner's destination.
  for (let index = 0; index < window.sessionStorage.length; index++) {
    const key = window.sessionStorage.key(index);
    if (!key || (key !== legacyReceiptKey && !key.startsWith("fluid.strategy-starts.v2:"))) continue;
    const raw = window.sessionStorage.getItem(key);
    if (!raw?.includes(draftId)) continue;
    const stored = z.array(startReceiptSchema).max(250).safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
    if (!stored.success) throw new StartReceiptRecoveryError("Saved recovery records could not be verified. Check account brands before continuing.");
    if (stored.data.some(receipt => receipt.draftId === draftId)) return true;
  }
  return false;
}
function rememberReceipt(receipt: StartReceipt) {
  const owned = ownerReceipts(receipt.ownerId);
  if (!receipts.has(receiptId(receipt.ownerId, receipt.draftId)) && (owned.filter(item => item.projectId === null).length >= 200 || owned.length >= 250)) {
    throw new StartReceiptRecoveryError("Recovery storage is full for this account. No new account project or AI request was sent. Check the existing account saves before continuing; their recovery links remain available.");
  }
  receipts.set(receiptId(receipt.ownerId, receipt.draftId), receipt);
  persistReceipts(receipt.ownerId);
}
function forgetReceipt(receipt: StartReceipt) {
  receipts.delete(receiptId(receipt.ownerId, receipt.draftId));
  persistReceipts(receipt.ownerId);
}
function subscriptionLimitsLabel(limits: NonNullable<ReturnType<typeof promptStrategyPlan>>["reformulation"] & { billingMode: "chatgpt_subscription" }) {
  const value = limits.limits, number = (n: number) => n.toLocaleString("en-US");
  return `up to ${number(value.maxInputBytes)} input bytes, ${number(value.maxOutputBytes)} output bytes, ${number(value.deadlineMs / 1000)} seconds, ${number(value.maxObservedWebSearchCalls)} observed web searches, ${number(value.maxRequestsPerHour)} requests/hour and ${number(value.maxQueuedJobs)} queued requests.`;
}

/** Starts from the independent browser copy; unavailable AI never becomes a fake Send. */
export function useAccountStrategyStart({ beforeSignIn, recoveryDraftId = null, recoveryLocked = false }: { beforeSignIn?: (locked: boolean) => boolean; recoveryDraftId?: string | null; recoveryLocked?: boolean } = {}) {
  const { session, isCurrent, expire, refresh } = useAccountSession();
  const router = useRouter();
  const identity = session.status === "ready" ? `${session.userId}:${session.generation}` : `unverified:${session.generation}`;
  const [runtime, setRuntime] = useState<{ identity: string; availability: Availability | null } | null>(null);
  const [action, setAction] = useState<{ identity: string; pending: boolean; message: string; recoveryBlocked?: boolean } | null>(null);
  const [retained, setRetained] = useState<StartReceipt | null>(null);
  const recoveryKey = `${identity}:${recoveryDraftId ?? ""}`;
  const [checkedRecovery, setCheckedRecovery] = useState<{ key: string; receipt: StartReceipt | null; fenced: boolean; error: string | null } | null>(null);
  const request = useRef<AbortController | null>(null);
  const readinessRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); readinessRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    if (session.status !== "ready") return;
    const controller = new AbortController(); readinessRequest.current = controller;
    void accountRequest("/api/strategy", strategyRuntimeResponseSchema, { signal: controller.signal }).then(({ availability }) => {
      if (!controller.signal.aborted && readinessRequest.current === controller && isCurrent(session)) setRuntime({ identity, availability });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || readinessRequest.current !== controller || !isCurrent(session)) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(session);
      else setRuntime({ identity, availability: null });
    });
    return () => {
      controller.abort();
      request.current?.abort(); request.current = null;
    };
  }, [session, identity, isCurrent, expire]);
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
  const pending = action?.identity === identity && action.pending;
  const checked = checkedRecovery?.key === recoveryKey ? checkedRecovery : null;
  const checkingRecovery = Boolean(recoveryDraftId) && (session.status === "checking" || !checked);
  const knownRecovery = Boolean(checked?.fenced || (recoveryDraftId && [...receipts.values()].some(receipt => receipt.draftId === recoveryDraftId)));
  const recovered = retained ?? checked?.receipt;
  const recovery = session.status === "ready" && recovered?.ownerId === session.userId ? recovered : null;
  const recoveryBlocked = checkingRecovery || Boolean(checked?.error) || Boolean(recovery && !recovery.projectId) || ((recoveryLocked || knownRecovery) && !recovery);
  const locked = Boolean(retained || checked?.receipt || checked?.error || recoveryLocked || knownRecovery || checkingRecovery);
  const message = action?.identity === identity ? action.message : "";
  const recoveryMessage = checkingRecovery ? "Checking the saved prompt's recovery status before editing or sending…"
    : recovery?.projectId ? "Your account copy is saved. Open it below to check the original request."
    : recovery ? "The earlier account save is not confirmed. Your original prompt is kept; check account brands before continuing."
    : recoveryLocked || knownRecovery ? "This prompt is locked to an earlier account save. Verify the same account before continuing. No new request has been sent." : "";


  async function verifySession(account: VerifiedAccount, controller: AbortController) {
    const { user } = await accountRequest("/api/session", accountSessionSchema, { signal: controller.signal });
    if (!mounted.current || controller.signal.aborted || !isCurrent(account)) return false;
    if (user.id !== account.userId) { expire(account); return false; }
    return true;
  }
  async function readReadiness(account: VerifiedAccount, controller: AbortController) {
    const { availability } = await accountRequest("/api/strategy", strategyRuntimeResponseSchema, { signal: controller.signal });
    if (!mounted.current || controller.signal.aborted || !isCurrent(account)) return null;
    setRuntime({ identity, availability });
    return availability;
  }
  async function recheck() {
    if (request.current) return;
    if (session.status !== "ready" || !isCurrent(session)) { refresh(); return; }
    const account = session, controller = new AbortController();
    request.current = controller; readinessRequest.current?.abort();
    setAction({ identity, pending: true, message: "" });
    try {
      const availability = await verifySession(account, controller) ? await readReadiness(account, controller) : null;
      if (availability) setAction({ identity, pending: false, message: promptStrategyPlan(availability) ? "AI is available. Review the limits below, then Send to request a response." : strategyAvailabilityMessage(availability) });
    } catch (error: unknown) {
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else { setRuntime({ identity, availability: null }); setAction({ identity, pending: false, message: "AI availability could not be confirmed. Your prompt is kept; recheck your connection." }); }
    } finally {
      if (request.current === controller) request.current = null;
      if (mounted.current && isCurrent(account)) setAction(previous => previous?.identity === identity ? { ...previous, pending: false } : previous);
    }
  }

  async function start(draft: LocalDraft): Promise<boolean> {
    if (request.current || session.status !== "ready" || !isCurrent(session) || (draft.id === recoveryDraftId && recoveryBlocked)) return false;
    const account = session, controller = new AbortController();
    request.current = controller; readinessRequest.current?.abort();
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
        if (receipt.projectId) { router.push(`/brands/account/${receipt.projectId}`); return true; }
        setAction({ identity, pending: false, message: "The earlier account save is not confirmed. Check account brands before trying another account save." });
        return false;
      }
      const availability = await readReadiness(account, controller);
      if (!current() || !availability) return false;
      // Another mounted view may have started this exact browser draft while
      // readiness was being checked. Never create a second account copy.
      receipt = readReceipt(account.userId, draft.id);
      if (receipt) { setRetained(receipt); setAction({ identity, pending: false, message: "This draft already has an account save to check. Use its recovery link below." }); return false; }
      const freshPlan = promptStrategyPlan(availability);
      if (!freshPlan) { setAction({ identity, pending: false, message: strategyAvailabilityMessage(availability) }); return false; }
      if (!plan || freshPlan.kind !== plan.kind || !strategyAllowanceWithin(freshPlan.reformulation, plan.reformulation)
        || (freshPlan.kind === "response_and_competitors" && plan.kind === "response_and_competitors" && !strategyAllowanceWithin(freshPlan.competitors, plan.competitors))) {
        setAction({ identity, pending: false, message: "AI readiness or request limits changed. Review the limits below, then Send again. No AI request was sent." }); return false;
      }
      const input = createAccountInput(draft);
      const pendingReceipt = { ownerId: account.userId, draftId: draft.id, projectId: null };
      rememberReceipt(pendingReceipt); // Capacity errors happen before an attempted save is recorded.
      // Persist the Home edit fence before the first non-idempotent account save.
      // The running tab's existing receipt guard remains authoritative if storage fails.
      try { rememberPromptForSignIn(draft.id, true); }
      catch { /* The in-memory receipt still fences this draft across component remounts. */ }
      receipt = pendingReceipt; setRetained(receipt);
      setAction({ identity, pending: true, message: "Saving an account copy of your prompt…" });
      let project;
      try {
        ({ project } = await accountRequest("/api/projects", accountProjectResponseSchema, { method: "POST", body: input, signal: controller.signal }));
      } catch (error: unknown) {
        // A known validation/auth rejection cannot have committed a project. Lost
        // acknowledgements and server errors remain uncertain, with no retry POST.
        if (error instanceof AccountRequestError && [400, 401, 403, 413, 422, 429].includes(error.status)) {
          forgetReceipt(receipt); receipt = null; if (current()) setRetained(null);
          try { rememberPromptForSignIn(draft.id); } catch { /* Keep the stricter durable fence if storage became unavailable. */ }
        }
        throw error;
      }
      if (!current()) return false;
      if (project.owner_id !== account.userId) { expire(account); return false; }
      if (project.current_revision !== 1 || project.scope !== input.scope || project.title !== input.title || JSON.stringify(project.context) !== JSON.stringify(input.context)) throw new AccountRequestError(502);
      receipt = { ...receipt, projectId: project.id }; rememberReceipt(receipt); setRetained(receipt);
      rememberStrategyPlan({ ownerId: account.userId, projectId: project.id, revision: project.current_revision }, plan);
      setAction({ identity, pending: true, message: "Submitting your AI response request…" });
      try {
        const { job } = await accountRequest(`/api/projects/${project.id}/strategy`, strategyJobResponseSchema, {
          method: "POST", signal: controller.signal,
          body: strategyRequestPayload(project.id, project.current_revision, "strategy.reformulate", plan.reformulation),
        });
        if (!current()) return false;
        if (!verifyStrategyJobs([job], account.userId, project.id)) { expire(account); return false; }
        if (!strategyJobMatchesRequest(job, "strategy.reformulate", project.current_revision, plan.reformulation)) {
          forgetStrategyIntent(account.userId, project.id, project.current_revision);
          throw new AccountRequestError(502);
        }
      } catch (error: unknown) {
        if (!current()) return false;
        if (error instanceof AccountRequestError && error.status === 401) { expire(account); return false; }
        setAction({ identity, pending: false, message: "Your account copy is saved, but the AI request is not confirmed. Open the saved project to check its status or explicitly retry there." });
        return false;
      }
      if (current()) router.push(`/brands/account/${project.id}`);
      return true;
    } catch (error: unknown) {
      if (!current()) return false;
      if (error instanceof AccountRequestError && error.status === 401) { expire(account); return false; }
      if (error instanceof StartReceiptRecoveryError) { setAction({ identity, pending: false, message: error.message, recoveryBlocked: true }); return false; }
      setAction({ identity, pending: false, message: receipt ? "The account save is not confirmed. Check account brands before trying another account save. Your browser draft is kept." : `${accountErrorMessage(error)} No AI request was sent. Your browser draft is kept.` });
      return false;
    } finally {
      if (request.current === controller) request.current = null;
      if (mounted.current && isCurrent(account)) setAction(previous => previous?.identity === identity ? { ...previous, pending: false } : previous);
    }
  }
  const notice = <div>
    {checked?.error && <p className="form-error" role="alert">{checked.error}</p>}
    <p className="field-hint" role="status">{pending ? message || "Checking your account and AI readiness…" : message || recoveryMessage || (session.status === "checking"
      ? "Checking your account. Your prompt is kept; send once verification finishes."
      : session.status === "signed_out" ? "Sign in to request an AI response. Your prompt is kept. You can also save a browser draft."
      : session.status !== "ready" ? "Your account could not be verified. Recheck your account before requesting AI. Your prompt is kept."
      : !currentRuntime ? "Checking AI availability. Send rechecks readiness and keeps your prompt here if AI cannot start."
      : !plan ? strategyAvailabilityMessage(currentRuntime.availability) : "AI is available. Send requests a response using the limits below.")}</p>
    {plan && <p className="field-hint">{plan.billingMode === "chatgpt_subscription"
      ? "Sending saves an account copy and uses your ChatGPT plan for a response. Competitor research starts after you apply the response. Your plan limits apply. A browser copy is kept."
      : plan.kind === "response_only"
        ? `Sending saves an account copy and requests a response, up to ${formatStrategyCap(plan.reformulation.maximumCostMicrousd)}. Competitor research is unavailable. A browser copy is kept.`
      : `Sending saves an account copy and uses OpenAI for a response and competitor research, up to ${formatStrategyCap(plan.reformulation.maximumCostMicrousd + plan.competitors.maximumCostMicrousd)} total. Competitor research starts after you apply the response. A browser copy is kept.`}</p>}
    {plan?.billingMode === "chatgpt_subscription" && <div>
      <p className="field-hint" aria-label="Response usage limits">Response: {subscriptionLimitsLabel(plan.reformulation)}</p>
      <p className="field-hint" aria-label="Competitor research usage limits">Competitor research: {subscriptionLimitsLabel(plan.competitors)}</p>
      <p className="field-hint">These are Fluid request limits, not your remaining ChatGPT plan quota.</p>
    </div>}
    {action?.identity === identity && action.recoveryBlocked && <p className="field-hint"><Link className="text-link" href="/brands">Check account brands</Link></p>}
    {recovery && <p className="field-hint">{recovery.projectId
      ? <Link className="text-link" href={`/brands/account/${recovery.projectId}`}>Open saved account project and check AI status</Link>
      : <>The earlier account save is not confirmed. <Link className="text-link" href="/brands">Check account brands</Link> before trying another account save. Your browser draft is kept.</>}</p>}
    <div className="account-strategy-actions">
      {session.status === "signed_out" && <Link className="text-link" href="/sign-in" onClick={event => { if (beforeSignIn && !beforeSignIn(locked)) event.preventDefault(); }}>Sign in</Link>}
      <button type="button" className="text-link" disabled={pending || session.status === "checking"} onClick={() => void recheck()}>{session.status === "ready" ? "Recheck AI availability" : "Recheck account"}</button>
    </div>
  </div>;
  return { notice, pending, start, locked, checkingRecovery, recoveryBlocked, recoveryProjectId: recovery?.projectId ?? null };
}
