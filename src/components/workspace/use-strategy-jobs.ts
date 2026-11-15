"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  creditSummaryResponseSchema,
  generationListResponseSchema,
  generationRunResponseSchema,
} from "@/domain/generations";
import {
  strategyJobResponseSchema,
  strategyOverviewResponseSchema,
  type StrategyJob,
  type StrategyOperation,
  type StrategyOverview,
} from "@/domain/strategy-jobs";
import { AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { accountDraftChanged, type AccountWorkspace } from "./account-draft-memory";
import {
  engineStrategyIdempotencyKey,
  engineStrategyJob,
  forgetStrategyIntent,
  strategyCreditsMessage,
  strategyErrorMessage,
  strategyJobActive,
  verifyStrategyJobs,
  type StrategyAllowance,
} from "./account-strategy-client";
import {
  idleStrategyAction,
  strategyJobsReport,
  strategyStartFailure,
  type StrategyAction,
  type StrategyEnqueueRequest,
} from "./strategy-jobs-view";

type ReadState = { identity: string; overview: StrategyOverview | null; error: string | null };
type EnqueueRequest = StrategyEnqueueRequest;
type ActionState = StrategyAction & { identity: string };
/** Status checks: every 3 s while a request runs, otherwise every 15 s. */
const ACTIVE_POLL_MS = 3_000,
  IDLE_POLL_MS = 15_000;
const byNewest = (a: StrategyJob, b: StrategyJob) => Date.parse(b.created_at) - Date.parse(a.created_at);

/**
 * The guided Strategy conversation's requests. New requests are generation engine runs,
 * read from /generations; the project's earlier requests from the old job system still
 * come from the Strategy overview, which also says whether the step is available.
 */
export function useStrategyJobs({
  account,
  workspace,
}: {
  account: VerifiedAccount;
  workspace: AccountWorkspace;
  blocked?: boolean;
  guided?: boolean;
}) {
  const { isCurrent, expire, drafts } = useAccountSession();
  const projectId = workspace.saved.id;
  const identity = `${account.userId}:${account.generation}:${projectId}`;
  const [read, setRead] = useState<ReadState | null>(null);
  const [action, setActionState] = useState<ActionState | null>(null);
  // The same value, readable in the turn it was set: a second press in that turn sees the first request.
  const latestAction = useRef<ActionState | null>(null);
  const setAction = useCallback((next: ActionState) => {
    latestAction.current = next;
    setActionState(next);
  }, []);
  /** Ends a request that returned without an answer to show, so it never looks like it is still on its way. */
  const settle = useCallback(
    (started: ActionState) => {
      if (latestAction.current === started) setAction({ ...started, sending: null });
    },
    [setAction],
  );
  const [refreshVersion, setRefreshVersion] = useState(0);
  const live = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const mutationEpoch = useRef(0);
  /** Whether the last answered status check found a request working, so a failed check keeps its pace. */
  const working = useRef<{ identity: string; active: boolean } | null>(null);
  const engineRuns = useRef(new Set<string>());
  const restarted = useRef(new Set<string>());
  const legacy = useRef<{ identity: string; overview: StrategyOverview } | null>(null);
  const legacyDue = useRef(true);
  const refresh = useCallback(() => {
    legacyDue.current = true;
    setRefreshVersion((value) => value + 1);
  }, []);
  const matchesRequest = useCallback(
    (job: StrategyJob, request: EnqueueRequest) =>
      engineRuns.current.has(job.id) && job.operation === request.operation && job.input_revision === request.revision,
    [],
  );
  const getWorkspace = useCallback(() => {
    if (!live.current || !isCurrent(account)) return null;
    const current = drafts.get(projectId);
    return current?.ownerId === account.userId &&
      current.generation === account.generation &&
      current.saved.id === projectId
      ? current
      : null;
  }, [account, drafts, isCurrent, projectId]);
  useEffect(() => {
    live.current = true;
    const pending = controllers.current;
    return () => {
      live.current = false;
      for (const controller of pending) controller.abort();
      pending.clear();
    };
  }, [identity]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const epoch = mutationEpoch.current;
      let soon = false;
      try {
        // While only engine runs are active, their status comes from /generations alone.
        const cached = legacy.current?.identity === identity && !legacyDue.current ? legacy.current.overview : null;
        const saved =
          cached ??
          (await boundedAccountRequest(`/api/projects/${projectId}/strategy`, strategyOverviewResponseSchema, {
            signal: controller.signal,
          }));
        if (controller.signal.aborted || !getWorkspace()) return;
        if (!verifyStrategyJobs(saved.jobs, account.userId, projectId)) {
          expire(account);
          return;
        }
        const { runs } = await boundedAccountRequest(
          `/api/projects/${projectId}/generations?step=strategy`,
          generationListResponseSchema,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || !getWorkspace()) return;
        const jobs = runs.flatMap((run) => engineStrategyJob(run, account.userId, projectId) ?? []);
        engineRuns.current = new Set(jobs.map((job) => job.id));
        // A run admitted while its workflow failed to start stays queued. Sending the same
        // request again (same key) starts it once; it never creates a second run.
        for (const job of jobs) {
          if (
            job.state !== "queued" ||
            Date.now() - Date.parse(job.created_at) < 20_000 ||
            restarted.current.has(job.id)
          )
            continue;
          restarted.current.add(job.id);
          void boundedAccountRequest(`/api/projects/${projectId}/generations`, generationRunResponseSchema, {
            method: "POST",
            signal: controller.signal,
            body: {
              kind: job.operation,
              idempotencyKey: engineStrategyIdempotencyKey(projectId, job.input_revision, job.operation),
              input: { expectedRevision: job.input_revision },
            },
          }).catch(() => undefined);
        }
        const overview = { ...saved, jobs: [...jobs, ...saved.jobs].sort(byNewest).slice(0, 64) };
        legacy.current = { identity, overview: saved };
        legacyDue.current = !jobs.some(strategyJobActive) || saved.jobs.some(strategyJobActive);
        soon = overview.jobs.some(strategyJobActive);
        working.current = { identity, active: soon };
        if (epoch === mutationEpoch.current) {
          setRead({ identity, overview, error: null });
          const previous = latestAction.current;
          const request = previous?.unconfirmed;
          // Confirm the saved operation only from one matching owned run;
          // ambiguous history cannot resolve an unknown acknowledgement.
          if (
            previous?.identity === identity &&
            !previous.sending &&
            request?.epoch === epoch &&
            overview.jobs.filter((job) => matchesRequest(job, request)).length === 1
          )
            setAction({ identity, ...idleStrategyAction });
        }
      } catch (error: unknown) {
        if (controller.signal.aborted || !getWorkspace()) return;
        legacyDue.current = true;
        // A failed check while a request works keeps checking at the working pace.
        soon = working.current?.identity === identity && working.current.active;
        if (epoch === mutationEpoch.current) {
          if (error instanceof AccountRequestError && error.status === 401) {
            expire(account);
            return;
          }
          setRead((previous) => ({
            identity,
            overview: previous?.identity === identity ? previous.overview : null,
            error: strategyErrorMessage(error),
          }));
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), soon ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [account, expire, getWorkspace, identity, matchesRequest, projectId, refreshVersion, setAction]);

  // Answers kept for another account, session or project are not this one's.
  const { overview, readError, actionError, pending, pendingLabel, view } = strategyJobsReport({
    overview: read?.identity === identity ? read.overview : null,
    readError: read?.identity === identity ? read.error : null,
    action: action?.identity === identity ? action : idleStrategyAction,
  });
  const report = useCallback(
    (message: string) =>
      setAction({ identity, ...idleStrategyAction, problem: { during: "local", sentence: message } }),
    [identity, setAction],
  );

  // The guided turn passes its accepted availability; the server freezes the request itself.
  const enqueue = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async (operation: StrategyOperation, revision: number, _allowance?: StrategyAllowance) => {
      const current = getWorkspace();
      if (!current || latestAction.current?.sending) return null;
      if (current.conflict || accountDraftChanged(current) || current.saved.current_revision !== revision) {
        report(
          "Your draft changed before the request was submitted. Save your current edits before requesting a proposal.",
        );
        return null;
      }
      const controller = new AbortController();
      controllers.current.add(controller);
      const epoch = ++mutationEpoch.current;
      const started: ActionState = { identity, ...idleStrategyAction, sending: "start" };
      setAction(started);
      try {
        // The server freezes the request from this saved revision; the browser only names it.
        const { run } = await boundedAccountRequest(
          `/api/projects/${projectId}/generations`,
          generationRunResponseSchema,
          {
            method: "POST",
            signal: controller.signal,
            body: {
              kind: operation,
              idempotencyKey: engineStrategyIdempotencyKey(projectId, revision, operation),
              input: { expectedRevision: revision },
            },
          },
        );
        const job = engineStrategyJob(run, account.userId, projectId);
        if (job) engineRuns.current.add(job.id);
        if (controller.signal.aborted || !getWorkspace()) return null;
        if (!job) throw new AccountRequestError(502);
        if (!verifyStrategyJobs([job], account.userId, projectId)) {
          expire(account);
          return null;
        }
        if (!matchesRequest(job, { epoch, operation, revision })) throw new AccountRequestError(502);
        setRead((previous) =>
          previous?.identity === identity && previous.overview
            ? {
                ...previous,
                overview: {
                  ...previous.overview,
                  jobs: [job, ...previous.overview.jobs.filter((item) => item.id !== job.id)].slice(0, 64),
                },
              }
            : previous,
        );
        working.current = { identity, active: true };
        setAction({ identity, ...idleStrategyAction });
        refresh();
        return job;
      } catch (error: unknown) {
        if (controller.signal.aborted || !getWorkspace()) return null;
        if (error instanceof AccountRequestError && error.status === 401) expire(account);
        else if (error instanceof AccountRequestError && error.status === 402) {
          // Out of credits: say when they renew. A failed lookup still explains the refusal.
          let periodEnd: string | null = null;
          try {
            periodEnd = (
              await boundedAccountRequest("/api/credits", creditSummaryResponseSchema, { signal: controller.signal })
            ).credits.periodEnd;
          } catch {
            /* The message stands without a date. */
          }
          if (controller.signal.aborted || !getWorkspace()) return null;
          setAction({
            identity,
            ...idleStrategyAction,
            problem: { during: "start", httpStatus: 402, sentence: strategyCreditsMessage(periodEnd) },
          });
        } else {
          // A start that may have been admitted is kept: sending it again uses the same key, so it
          // returns the run it made and never a second one.
          const { httpStatus, uncertain } = strategyStartFailure(error);
          setAction({
            identity,
            sending: null,
            problem: { during: "start", httpStatus, sentence: strategyErrorMessage(error) },
            unconfirmed: uncertain ? { epoch, operation, revision } : null,
          });
        }
        refresh();
        return null;
      } finally {
        controllers.current.delete(controller);
        settle(started);
      }
    },
    [account, expire, getWorkspace, identity, matchesRequest, projectId, refresh, report, setAction, settle],
  );

  const cancel = useCallback(
    async (job: StrategyJob) => {
      if (!getWorkspace() || latestAction.current?.sending || !strategyJobActive(job)) return;
      forgetStrategyIntent(account.userId, projectId, job.input_revision);
      if (job.operation === "strategy.competitors")
        forgetStrategyIntent(account.userId, projectId, job.input_revision - 1);
      // Stop was already asked, here or in another tab: it is not asked again.
      if (job.state === "cancel_requested") return;
      const controller = new AbortController();
      controllers.current.add(controller);
      mutationEpoch.current += 1;
      const started: ActionState = { identity, ...idleStrategyAction, sending: "stop" };
      setAction(started);
      try {
        // An engine run stops before its next paid step and cancels its open OpenAI response.
        // An earlier old-system request that never finished is marked cancelled.
        const updated = engineRuns.current.has(job.id)
          ? engineStrategyJob(
              (
                await boundedAccountRequest(
                  `/api/projects/${projectId}/generations/${job.id}/cancel`,
                  generationRunResponseSchema,
                  { method: "POST", body: {}, signal: controller.signal },
                )
              ).run,
              account.userId,
              projectId,
            )
          : (
              await boundedAccountRequest(`/api/projects/${projectId}/strategy/${job.id}`, strategyJobResponseSchema, {
                method: "DELETE",
                signal: controller.signal,
              })
            ).job;
        if (controller.signal.aborted || !getWorkspace()) return;
        if (!updated) throw new AccountRequestError(502);
        if (!verifyStrategyJobs([updated], account.userId, projectId)) {
          expire(account);
          return;
        }
        if (
          updated.id !== job.id ||
          updated.operation !== job.operation ||
          updated.input_revision !== job.input_revision
        )
          throw new AccountRequestError(502);
        // The cancel response carries no outputs; a run that already finished keeps its result.
        setRead((previous) =>
          previous?.identity === identity && previous.overview
            ? {
                ...previous,
                overview: {
                  ...previous.overview,
                  jobs: previous.overview.jobs.map((item) =>
                    item.id === job.id
                      ? { ...updated, results: updated.results.length ? updated.results : item.results }
                      : item,
                  ),
                },
              }
            : previous,
        );
        setAction({ identity, ...idleStrategyAction });
        refresh();
      } catch (error: unknown) {
        if (controller.signal.aborted || !getWorkspace()) return;
        if (error instanceof AccountRequestError && error.status === 401) expire(account);
        else
          setAction({
            identity,
            ...idleStrategyAction,
            problem: { during: "stop", sentence: strategyErrorMessage(error) },
          });
      } finally {
        controllers.current.delete(controller);
        settle(started);
      }
    },
    [account, expire, getWorkspace, identity, projectId, refresh, setAction, settle],
  );

  return { overview, readError, actionError, pending, pendingLabel, view, enqueue, cancel, refresh, report };
}
