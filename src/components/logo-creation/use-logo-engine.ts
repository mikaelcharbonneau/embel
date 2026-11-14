"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { creditSummaryResponseSchema, generationRunResponseSchema, type GenerationRun } from "@/domain/generations";
import { isActiveLogoRun, latestLogoRun, logoEngineStatusSchema, type LogoEngineKind } from "@/domain/logo-engine";
import { AccountRequestError } from "../workspace/account-api";
import { boundedAccountRequest } from "../workspace/bounded-account-request";
import { creditsMessage } from "../workspace/credits-message";
import { useAccountSession, type VerifiedAccount } from "../workspace/account-session";

/** Status checks while Logo work runs on the engine. */
const ACTIVE_POLL_MS = 3_000;
const EMPTY: ReadonlySet<string> = new Set();

export type LogoEngine = {
  /** null until the first read: whether the Logo step draws on the generation engine. */
  engine: boolean | null;
  runs: GenerationRun[];
  /** Runs started from this page, or running when it opened: only these move the screen. */
  followed: ReadonlySet<string>;
  starting: boolean;
  error: string | null;
  active(kind: LogoEngineKind): GenerationRun | null;
  latest(kind: LogoEngineKind): GenerationRun | null;
  /** `quiet` keeps a refusal off the screen, for work the person didn't click (style notes). */
  start(
    kind: LogoEngineKind,
    input: Record<string, unknown>,
    options?: { quiet?: boolean },
  ): Promise<GenerationRun | null>;
  cancel(runId: string): Promise<void>;
  clearError(): void;
  refresh(): void;
};

/** Logo engine messages. Credits matter only once they run out; never a price. */
export function logoEngineErrorMessage(error: unknown, periodEnd: string | null = null) {
  if (error instanceof AccountRequestError) {
    if (error.status === 402) return creditsMessage(periodEnd, "Your logos are saved.");
    if (error.status === 409)
      return "Your logo details changed or a set is still being drawn. Your work is kept; try again in a moment.";
    if (error.status === 429) return "You’ve reached today’s limit for this. Your logos are saved. Try again tomorrow.";
    if (error.status === 503) return "Logo drawing is unavailable right now. Nothing has started and nothing was used.";
  }
  return "This request could not be confirmed. Your logos are kept; check again before trying once more.";
}

/**
 * The Logo step on the generation engine: whether it is on, the latest Logo
 * runs (checked every 3 s while one runs), and one deliberate start or stop.
 * Starting names only what to draw; the server freezes everything else.
 */
export function useLogoEngine(account: VerifiedAccount, projectId: string): LogoEngine {
  const { isCurrent } = useAccountSession();
  const identity = `${account.userId}:${account.generation}:${projectId}`;
  const [state, setState] = useState<{ identity: string; engine: boolean | null; runs: GenerationRun[] }>({
    identity,
    engine: null,
    runs: [],
  });
  const [action, setAction] = useState<{ identity: string; starting: boolean; error: string | null }>({
    identity,
    starting: false,
    error: null,
  });
  const [followed, setFollowed] = useState<{ identity: string; ids: ReadonlySet<string> }>({
    identity,
    ids: new Set(),
  });
  const [version, setVersion] = useState(0);
  const live = useRef(true);
  const current = useCallback(() => live.current && isCurrent(account), [account, isCurrent]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, [identity]);

  const view = state.identity === identity ? state : { identity, engine: null, runs: [] as GenerationRun[] };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const status = await boundedAccountRequest(`/api/projects/${projectId}/logo/engine`, logoEngineStatusSchema, {
          signal: controller.signal,
          expectedOwnerId: account.userId,
        });
        if (controller.signal.aborted || !current()) return;
        setState({ identity, engine: status.engine, runs: status.runs });
        // Runs already working when the page opened are followed too.
        const working = status.runs.filter(isActiveLogoRun).map((run) => run.id);
        if (working.length)
          setFollowed((previous) =>
            previous.identity === identity && working.every((id) => previous.ids.has(id))
              ? previous
              : { identity, ids: new Set([...(previous.identity === identity ? previous.ids : []), ...working]) },
          );
        if (status.runs.some(isActiveLogoRun)) timer = setTimeout(() => void read(), ACTIVE_POLL_MS);
      } catch {
        if (!controller.signal.aborted && current()) timer = setTimeout(() => void read(), ACTIVE_POLL_MS * 3);
      }
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [account.userId, current, identity, projectId, version]);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const start = useCallback(
    async (kind: LogoEngineKind, input: Record<string, unknown>, options: { quiet?: boolean } = {}) => {
      if (!current()) return null;
      const controller = new AbortController();
      setAction((previous) => ({
        identity,
        starting: true,
        error: options.quiet && previous.identity === identity ? previous.error : null,
      }));
      try {
        const { run } = await boundedAccountRequest(
          `/api/projects/${projectId}/generations`,
          generationRunResponseSchema,
          {
            method: "POST",
            signal: controller.signal,
            expectedOwnerId: account.userId,
            body: { kind, idempotencyKey: `logo:${kind}:${crypto.randomUUID()}`, input },
          },
        );
        if (!current()) return null;
        setFollowed((previous) => ({
          identity,
          ids: new Set([...(previous.identity === identity ? previous.ids : []), run.id]),
        }));
        setState((previous) =>
          previous.identity === identity
            ? { ...previous, runs: [run, ...previous.runs.filter((item) => item.id !== run.id)] }
            : previous,
        );
        setAction({ identity, starting: false, error: null });
        refresh();
        return run;
      } catch (error) {
        if (!current()) return null;
        let periodEnd: string | null = null;
        if (error instanceof AccountRequestError && error.status === 402) {
          try {
            periodEnd = (
              await boundedAccountRequest("/api/credits", creditSummaryResponseSchema, { signal: controller.signal })
            ).credits.periodEnd;
          } catch {
            /* The message stands without a date. */
          }
        }
        if (current())
          setAction((previous) => ({
            identity,
            starting: false,
            error: options.quiet
              ? previous.identity === identity
                ? previous.error
                : null
              : logoEngineErrorMessage(error, periodEnd),
          }));
        refresh();
        return null;
      }
    },
    [account.userId, current, identity, projectId, refresh],
  );
  const cancel = useCallback(
    async (runId: string) => {
      if (!current()) return;
      try {
        const { run } = await boundedAccountRequest(
          `/api/projects/${projectId}/generations/${runId}/cancel`,
          generationRunResponseSchema,
          { method: "POST", body: {}, signal: new AbortController().signal, expectedOwnerId: account.userId },
        );
        if (current())
          setState((previous) =>
            previous.identity === identity
              ? {
                  ...previous,
                  runs: previous.runs.map((item) =>
                    item.id === run.id ? { ...item, ...run, outputs: item.outputs } : item,
                  ),
                }
              : previous,
          );
      } catch {
        /* The next check shows whether it stopped. */
      }
      refresh();
    },
    [account.userId, current, identity, projectId, refresh],
  );

  const runs = view.runs,
    act = action.identity === identity ? action : { starting: false, error: null };
  const ids = followed.identity === identity ? followed.ids : EMPTY;
  return useMemo(
    () => ({
      engine: view.engine,
      runs,
      followed: ids,
      starting: act.starting,
      error: act.error,
      active: (kind) => runs.find((run) => run.kind === kind && isActiveLogoRun(run)) ?? null,
      latest: (kind) => latestLogoRun(runs, kind),
      start,
      cancel,
      refresh,
      clearError: () => setAction((previous) => ({ ...previous, error: null })),
    }),
    [act.error, act.starting, cancel, ids, refresh, runs, start, view.engine],
  );
}
