"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import {
  accountSessionSchema,
  accountProjectResponseSchema,
  accountRevisionResponseSchema,
} from "@/domain/project-api";
import { strategyRuntimeResponseSchema, strategyOverviewResponseSchema } from "@/domain/strategy-jobs";
import { AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { createAccountInput } from "./project-draft-adapter";
import type { LocalDraft } from "./local-drafts";
import {
  StartReceiptRecoveryError,
  readReceipt,
  readDraftFence,
  hasDraftReceipt,
  type StartReceipt,
} from "./account-project-start-recovery";
import { promptStrategyPlan, strategyAvailabilityMessage, verifyStrategyJobs } from "./account-strategy-client";
import { rememberPromptForSignIn } from "./prompt-recovery";
import { guidedAllowance, initialGuidedContext } from "./guided-interview-client";
import { finishLocalDraftRecovery, saveLocalDraftToAccount } from "./save-local-draft-to-account";
import { projectStartHref, prepareProjectStart } from "./project-start-draft";

type Availability = z.infer<typeof strategyRuntimeResponseSchema>["availability"];

/** Saves an owned project before any separately authorized AI request. */
export function useAccountStrategyStart({
  beforeSignIn,
  recoveryDraftId = null,
  recoveryLocked = false,
  guided = false,
}: {
  guided?: boolean;
  beforeSignIn?: (locked: boolean) => boolean;
  recoveryDraftId?: string | null;
  recoveryLocked?: boolean;
} = {}) {
  const { session, isCurrent, expire, refresh, drafts } = useAccountSession();
  const router = useRouter();
  const [, startNavigation] = useTransition();
  const destination = useRef<{ identity: string; href: string } | null>(null);
  // The same destination for rendering; the ref guards requests synchronously.
  const [openingDestination, setOpeningDestination] = useState<{ identity: string; href: string } | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState<string | null>(null);
  const identity =
    session.status === "ready" ? `${session.userId}:${session.generation}` : `unverified:${session.generation}`;
  const [runtime, setRuntime] = useState<{ identity: string; availability: Availability | null } | null>(null);
  const [action, setAction] = useState<{
    identity: string;
    pending: boolean;
    message: string;
    recoveryBlocked?: boolean;
  } | null>(null);
  const [retained, setRetained] = useState<StartReceipt | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const recoveryKey = `${identity}:${recoveryDraftId ?? ""}`;
  const [checkedRecovery, setCheckedRecovery] = useState<{
    key: string;
    receipt: StartReceipt | null;
    fenced: boolean;
    error: string | null;
  } | null>(null);
  const request = useRef<AbortController | null>(null);
  const readinessRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      readinessRequest.current?.abort();
    };
  }, []);
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
      readinessRequest.current?.abort();
      readinessRequest.current = null;
      destination.current = null;
    },
    [identity],
  );
  useEffect(() => {
    if (session.status !== "ready") return;
    const controller = new AbortController();
    readinessRequest.current = controller;
    void boundedAccountRequest("/api/strategy", strategyRuntimeResponseSchema, { signal: controller.signal })
      .then(({ availability }) => {
        if (!controller.signal.aborted && readinessRequest.current === controller && isCurrent(session))
          setRuntime({ identity, availability });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || readinessRequest.current !== controller || !isCurrent(session)) return;
        if (error instanceof AccountRequestError && error.status === 401) expire(session);
        else setRuntime({ identity, availability: null });
      });
    return () => {
      controller.abort();
      readinessRequest.current?.abort();
      readinessRequest.current = null;
    };
  }, [session, identity, isCurrent, expire]);
  useEffect(() => {
    if (!recoveryDraftId) return;
    let receipt: StartReceipt | null = null,
      error: string | null = null,
      fenced = false;
    try {
      if (session.status === "ready" && isCurrent(session)) receipt = readReceipt(session.userId, recoveryDraftId);
      fenced = Boolean(receipt) || readDraftFence(recoveryDraftId);
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Saved recovery records could not be verified. Check account brands before continuing.";
    }
    // Receipt hydration is read-only with respect to account/project requests.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCheckedRecovery({ key: recoveryKey, receipt, fenced, error });
  }, [recoveryDraftId, recoveryKey, session, isCurrent]);
  const currentRuntime = runtime?.identity === identity ? runtime : null;
  const needsProjectAdmission =
    currentRuntime?.availability?.reason === "request_unresolved" ||
    currentRuntime?.availability?.reason === "request_active";
  const pending = action?.identity === identity && action.pending;
  const checked = checkedRecovery?.key === recoveryKey ? checkedRecovery : null;
  const checkingRecovery = Boolean(recoveryDraftId) && (session.status === "checking" || !checked);
  const knownRecovery = Boolean(checked?.fenced || (recoveryDraftId && hasDraftReceipt(recoveryDraftId)));
  const recovered = retained ?? checked?.receipt;
  const recovery = session.status === "ready" && recovered?.ownerId === session.userId ? recovered : null;
  const recoveryBlocked =
    checkingRecovery ||
    Boolean(checked?.error) ||
    Boolean(recovery && !recovery.projectId && !recovery.request) ||
    ((recoveryLocked || knownRecovery) && !recovery);
  const locked = Boolean(
    retained || checked?.receipt || checked?.error || recoveryLocked || knownRecovery || checkingRecovery,
  );
  const message = action?.identity === identity ? action.message : "";
  const recoveryMessage = checkingRecovery
    ? "Checking the saved prompt's recovery status before editing or sending…"
    : recovery?.projectId
      ? "Your project is saved. Open it below to check the original request."
      : recovery
        ? "The earlier save is not confirmed. Your original prompt is kept; check and retry the same save."
        : recoveryLocked || knownRecovery
          ? "This prompt is locked to an earlier account save. Verify the same account before continuing. No new request has been sent."
          : "";

  async function verifySession(account: VerifiedAccount, controller: AbortController) {
    const { user } = await boundedAccountRequest("/api/session", accountSessionSchema, { signal: controller.signal });
    if (!mounted.current || controller.signal.aborted || !isCurrent(account)) return false;
    if (user.id !== account.userId) {
      expire(account);
      return false;
    }
    return true;
  }
  async function readReadiness(account: VerifiedAccount, controller: AbortController) {
    const { availability } = await boundedAccountRequest("/api/strategy", strategyRuntimeResponseSchema, {
      signal: controller.signal,
    });
    if (!mounted.current || controller.signal.aborted || !isCurrent(account)) return null;
    setRuntime({ identity, availability });
    return availability;
  }
  function stopReadinessCheck() {
    readinessRequest.current?.abort();
    readinessRequest.current = null;
    setCheckingAvailability(null);
  }
  async function recheck() {
    if (request.current || destination.current || checkingAvailability === identity) return;
    if (session.status !== "ready" || !isCurrent(session)) {
      refresh();
      return;
    }
    const account = session,
      controller = new AbortController();
    readinessRequest.current?.abort();
    readinessRequest.current = controller;
    const current = () =>
      mounted.current &&
      !controller.signal.aborted &&
      readinessRequest.current === controller &&
      !request.current &&
      !destination.current &&
      isCurrent(account);
    setCheckingAvailability(identity);
    setAction({ identity, pending: false, message: "Checking AI availability. You can keep editing your prompt." });
    try {
      const availability = (await verifySession(account, controller)) ? await readReadiness(account, controller) : null;
      if (availability && current())
        setAction({
          identity,
          pending: false,
          message: guided
            ? guidedAllowance(availability, "strategy.competitors")
              ? "Competitor research is ready. Send your prompt to begin."
              : availability.reason === "request_unresolved" || availability.reason === "request_active"
                ? "An earlier request is pending. Sending checks availability for your new project."
                : "Competitor research is unavailable right now. Your prompt is kept."
            : promptStrategyPlan(availability)
              ? "AI is available. Review the request details below, then Send to request a response."
              : strategyAvailabilityMessage(availability),
        });
    } catch (error: unknown) {
      if (!current()) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else {
        setRuntime({ identity, availability: null });
        setAction({
          identity,
          pending: false,
          message: "AI availability could not be confirmed. Your prompt is kept; recheck your connection.",
        });
      }
    } finally {
      if (readinessRequest.current === controller) {
        readinessRequest.current = null;
        if (mounted.current && isCurrent(account)) setCheckingAvailability(null);
      }
    }
  }

  function openProject(href: string) {
    destination.current = { identity, href };
    setOpeningDestination({ identity, href });
    setOpening(identity);
    setAction({ identity, pending: true, message: "Project saved. Opening your project…" });
    try {
      startNavigation(() => router.push(href));
    } catch (cause) {
      destination.current = null;
      setOpeningDestination(null);
      throw cause;
    }
  }

  async function startGuided(draft: LocalDraft): Promise<boolean> {
    if (
      request.current ||
      destination.current ||
      session.status !== "ready" ||
      !isCurrent(session) ||
      (draft.id === recoveryDraftId && recoveryBlocked)
    )
      return false;
    const account = session,
      controller = new AbortController();
    request.current = controller;
    stopReadinessCheck();
    setOpening(identity);
    setAction({ identity, pending: true, message: "Saving your project…" });
    const current = () => mounted.current && !controller.signal.aborted && isCurrent(account);
    try {
      // A quick Send can beat the background readiness read. Resolve that read
      // within this explicit submit, before atomically saving its research turn.
      // Never dispatch later merely because an unavailable runtime becomes ready.
      let submittedAvailability = currentRuntime?.availability ?? null;
      if (!submittedAvailability && !readReceipt(account.userId, draft.id)) {
        try {
          submittedAvailability = await readReadiness(account, controller);
        } catch (cause) {
          if (cause instanceof AccountRequestError && cause.status === 401) throw cause;
        }
        if (!current()) return false;
      }
      const accepted = guidedAllowance(submittedAvailability, "strategy.competitors");
      const input = createAccountInput(draft);
      // Save the initial intent atomically with the project. The destination
      // resumes this exact turn under fresh readiness and the accepted allowance;
      // no work or admission is owned by the outgoing page's lifetime.
      if (accepted && !readReceipt(account.userId, draft.id)) input.context = initialGuidedContext(input.context, 1);
      const created = await saveLocalDraftToAccount({
        account,
        draft,
        input,
        signal: controller.signal,
        isCurrent,
        expire,
        onReceipt: (value) => {
          if (current()) setRetained(value);
          try {
            rememberPromptForSignIn(draft.id, Boolean(value), draft);
          } catch {
            /* The exact account request remains in its recovery receipt. */
          }
        },
      });
      if (!created?.receipt.projectId || !current()) return false;
      // Account-level availability is not project admission. A historical hold
      // may block Home while this newly owned project is eligible. Resolve the
      // exact project within this explicit Send, never on a later focus event.
      let acknowledged = created.project;
      if (!accepted) {
        let project = acknowledged;
        if (!project)
          project = (
            await boundedAccountRequest(`/api/projects/${created.receipt.projectId}`, accountProjectResponseSchema, {
              signal: controller.signal,
            })
          ).project;
        if (!current()) return false;
        if (project.owner_id !== account.userId || project.id !== created.receipt.projectId) {
          expire(account);
          return false;
        }
        if (project.current_revision === 1 && !project.context.intake.guidedInterview?.turns.length) {
          // The project save is already verified. Readiness is optional: an outage
          // must not turn a successful save into an apparent save failure. Keep
          // auth/not-found failures visible, and never swallow a later PATCH.
          let overview: z.infer<typeof strategyOverviewResponseSchema> | null = null;
          try {
            overview = await boundedAccountRequest(
              `/api/projects/${project.id}/strategy`,
              strategyOverviewResponseSchema,
              { signal: controller.signal },
            );
          } catch (cause) {
            if (cause instanceof AccountRequestError && [401, 403, 404].includes(cause.status)) throw cause;
          }
          if (!current()) return false;
          if (overview && !verifyStrategyJobs(overview.jobs, account.userId, project.id)) {
            expire(account);
            return false;
          }
          const projectAllowance = guidedAllowance(overview?.availability ?? null, "strategy.competitors");
          if (projectAllowance && overview && !overview.jobs.length) {
            const next = initialGuidedContext(project.context, 2);
            const { revision } = await boundedAccountRequest(
              `/api/projects/${project.id}`,
              accountRevisionResponseSchema,
              {
                method: "PATCH",
                signal: controller.signal,
                body: { expectedRevision: 1, context: next },
              },
            );
            if (!current()) return false;
            if (revision.owner_id !== account.userId || revision.project_id !== project.id || revision.revision !== 2) {
              expire(account);
              return false;
            }
            acknowledged = { ...project, current_revision: revision.revision, context: revision.context };
          }
        }
      }
      openProject(
        prepareProjectStart(created.receipt.projectId, created.newProject ? acknowledged : null, account, drafts),
      );
      finishLocalDraftRecovery(draft.id, account.userId, created.receipt.projectId);
      return true;
    } catch (cause) {
      if (!current()) return false;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else
        setAction({
          identity,
          pending: false,
          message:
            cause instanceof StartReceiptRecoveryError
              ? cause.message
              : "Your project could not be confirmed. Its original content is kept; check and retry the same save.",
        });
      return false;
    } finally {
      if (request.current === controller) request.current = null;
      if (current() && !destination.current) {
        setAction((previous) => (previous?.identity === identity ? { ...previous, pending: false } : previous));
        setOpening(null);
      }
    }
  }

  async function save(draft: LocalDraft): Promise<boolean> {
    if (
      request.current ||
      destination.current ||
      session.status !== "ready" ||
      !isCurrent(session) ||
      (draft.id === recoveryDraftId && recoveryBlocked)
    )
      return false;
    const account = session,
      controller = new AbortController();
    request.current = controller;
    stopReadinessCheck();
    if (guided) setOpening(identity);
    setAction({ identity, pending: true, message: "Saving your project…" });
    const current = () => mounted.current && !controller.signal.aborted && isCurrent(account);
    try {
      const result = await saveLocalDraftToAccount({
        account,
        draft,
        signal: controller.signal,
        isCurrent,
        expire,
        onReceipt: (receipt) => {
          if (current()) setRetained(receipt);
          try {
            rememberPromptForSignIn(draft.id, Boolean(receipt), draft);
          } catch {
            /* The exact save remains in the owner-bound receipt. */
          }
        },
      });
      if (!result?.receipt.projectId || !current()) return false;
      openProject(
        prepareProjectStart(result.receipt.projectId, result.newProject ? result.project : null, account, drafts),
      );
      finishLocalDraftRecovery(draft.id, account.userId, result.receipt.projectId);
      return true;
    } catch (cause) {
      if (!current()) return false;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else
        setAction({
          identity,
          pending: false,
          message:
            cause instanceof StartReceiptRecoveryError
              ? cause.message
              : "Your project could not be confirmed. Its original content is kept; check and retry the same save.",
        });
      return false;
    } finally {
      if (request.current === controller) request.current = null;
      if (current() && !destination.current) {
        setAction((previous) => (previous?.identity === identity ? { ...previous, pending: false } : previous));
        setOpening(null);
      }
    }
  }
  const guidedNotice = (
    <div>
      {message && (
        <p className="field-hint" role="status">
          {message}
        </p>
      )}
      {recoveryMessage && <p className="field-hint">{recoveryMessage}</p>}
      {checked?.error && <p role="alert">{checked.error}</p>}
      {session.status === "signed_out" && (
        <p className="field-hint">
          <Link
            href="/sign-in"
            className="text-link"
            onClick={(event) => {
              if (beforeSignIn && !beforeSignIn(locked)) event.preventDefault();
            }}
          >
            Sign in
          </Link>{" "}
          to save your project. Your prompt is kept.
        </p>
      )}
      {session.status === "ready" &&
        currentRuntime &&
        !guidedAllowance(currentRuntime.availability, "strategy.competitors") && (
          <p className="field-hint">
            {needsProjectAdmission
              ? "Sending checks AI availability for your new project. Earlier requests keep their own status."
              : "AI is unavailable right now. Continue to save your brief and edit your project."}
          </p>
        )}
      {recovery?.projectId ? (
        <Link className="text-link" href={projectStartHref(recovery.projectId)}>
          Open saved project
        </Link>
      ) : (
        recovery && (
          <Link className="text-link" href="/brands">
            Check account brands
          </Link>
        )
      )}
      {!pending && (message || !guidedAllowance(currentRuntime?.availability, "strategy.competitors")) && (
        <button
          type="button"
          className="text-link"
          disabled={checkingAvailability === identity}
          onClick={() => void recheck()}
        >
          {checkingAvailability === identity ? "Checking AI availability…" : "Check AI availability"}
        </button>
      )}
    </div>
  );
  function detachPrompt() {
    if (request.current || destination.current) return;
    setRetained(null);
    setCheckedRecovery(null);
    setAction(null);
    setOpening(null);
  }
  return {
    notice: guidedNotice,
    pending,
    starting: opening === identity && pending,
    startMessage: message,
    openingHref: openingDestination?.identity === identity ? openingDestination.href : null,
    start: startGuided,
    save,
    detachPrompt,
    locked,
    checkingRecovery,
    recoveryBlocked,
    recoveryProjectId: recovery?.projectId ?? null,
  };
}
