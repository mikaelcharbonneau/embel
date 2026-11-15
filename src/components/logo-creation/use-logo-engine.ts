"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canStopRun, GENERATION_UNAVAILABLE_CODE, startRefusal, type StepProblem } from "@/domain/generation-run";
import { creditSummaryResponseSchema, generationRunResponseSchema, type GenerationRun } from "@/domain/generations";
import {
  isActiveLogoRun,
  latestLogoRun,
  logoEngineStatusSchema,
  type LogoEngineKind,
  type LogoEngineStatus,
} from "@/domain/logo-engine";
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
  /** Why the last start was refused or couldn't be confirmed, in words. */
  error: string | null;
  /** What last went wrong, for `stepView` (docs/state-machines.md): a Stop that got no answer while its run
   * still works, else the start behind `error`, else a failed read. */
  problem: StepProblem | null;
  /** A start couldn't be confirmed and its request is kept: nothing else may start until Try again (which
   * repeats the same key) is answered or a check shows the run it started. */
  unconfirmed: boolean;
  /** A Stop request is on its way. */
  stopSending: boolean;
  active(kind: LogoEngineKind): GenerationRun | null;
  latest(kind: LogoEngineKind): GenerationRun | null;
  /** `quiet` keeps a refusal off the screen, for work the person didn't click (style notes). */
  start(
    kind: LogoEngineKind,
    input: Record<string, unknown>,
    options?: { quiet?: boolean },
  ): Promise<GenerationRun | null>;
  cancel(runId: string): Promise<void>;
  /** Try again: the Stop that got no answer, the unconfirmed start with its same key, or the failed read. */
  retry(): void;
  /** Takes the refusal off the screen. An unconfirmed start stays said until it is resolved. */
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
    // Switched off: the server sends this code only when nothing was admitted.
    if (error.code === GENERATION_UNAVAILABLE_CODE)
      return "Logo drawing is unavailable right now. Nothing has started and nothing was used.";
  }
  // Everything else, any other 503 included, may have admitted a run (startRefusal): never "nothing has started".
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
  const [action, setAction] = useState<{
    identity: string;
    starting: boolean;
    error: string | null;
    /** The HTTP status behind `error`: null for no answer, undefined when there is no error. */
    refused?: number | null;
    /** The error code the refusal carried, when it had one. */
    code?: string | null;
  }>({ identity, starting: false, error: null });
  /** The last read failed; the next good read clears it. */
  const [readFailed, setReadFailed] = useState<{ identity: string } | null>(null);
  /** Stop requests: the one on its way, and the run whose Stop got no answer. */
  const [stops, setStops] = useState<{ identity: string; sending: string | null; failed: string | null }>({
    identity,
    sending: null,
    failed: null,
  });
  /** A start that couldn't be confirmed keeps its key: asking for the same thing again repeats the key,
   * so the server returns the run it may have started instead of starting (and charging) a second one. */
  const unconfirmed = useRef<{
    identity: string;
    kind: LogoEngineKind;
    input: Record<string, unknown>;
    body: string;
    key: string;
  } | null>(null);
  /** Whether a request is kept, for the screen: the ref above is what `start` reads. */
  const [held, setHeld] = useState<string | null>(null);
  const keep = useCallback((request: typeof unconfirmed.current) => {
    unconfirmed.current = request;
    setHeld(request?.identity ?? null);
  }, []);
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
  const readStatus = useCallback(
    (signal: AbortSignal) =>
      boundedAccountRequest(`/api/projects/${projectId}/logo/engine`, logoEngineStatusSchema, {
        signal,
        expectedOwnerId: account.userId,
      }),
    [account.userId, projectId],
  );
  /** Takes a read as the truth: the runs, and which of them this page follows. */
  const adopt = useCallback(
    (status: LogoEngineStatus, alsoFollow: readonly string[] = []) => {
      setState({ identity, engine: status.engine, runs: status.runs });
      setReadFailed(null);
      // A check that shows the kept request's run working settles it: nothing is unconfirmed any more.
      const kept = unconfirmed.current;
      if (kept?.identity === identity && status.runs.some((run) => run.kind === kept.kind && isActiveLogoRun(run))) {
        keep(null);
        setAction((previous) =>
          previous.identity === identity ? { identity, starting: previous.starting, error: null } : previous,
        );
      }
      // Runs already working when the page opened are followed too.
      const working = [...status.runs.filter(isActiveLogoRun).map((run) => run.id), ...alsoFollow];
      if (working.length)
        setFollowed((previous) =>
          previous.identity === identity && working.every((id) => previous.ids.has(id))
            ? previous
            : { identity, ids: new Set([...(previous.identity === identity ? previous.ids : []), ...working]) },
        );
    },
    [identity, keep],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const status = await readStatus(controller.signal);
        if (controller.signal.aborted || !current()) return;
        adopt(status);
        if (status.runs.some(isActiveLogoRun)) timer = setTimeout(() => void read(), ACTIVE_POLL_MS);
      } catch {
        if (controller.signal.aborted || !current()) return;
        // Said on the screen (updates are delayed, or the first load failed), and checked again.
        setReadFailed({ identity });
        timer = setTimeout(() => void read(), ACTIVE_POLL_MS * 3);
      }
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [adopt, current, identity, readStatus, version]);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const start = useCallback(
    async (kind: LogoEngineKind, input: Record<string, unknown>, options: { quiet?: boolean } = {}) => {
      if (!current()) return null;
      // The same request as one that couldn't be confirmed repeats its key. While one is kept, nothing else the
      // person clicks starts: a new key could draw (and charge) a second time while the first may be admitted.
      // Work the person didn't click (quiet) keeps nothing: it is simply asked again later.
      const body = JSON.stringify([kind, input]),
        kept = options.quiet ? null : unconfirmed.current?.identity === identity ? unconfirmed.current : null;
      if (kept && kept.body !== body) return null;
      const controller = new AbortController();
      setAction((previous) =>
        options.quiet && previous.identity === identity
          ? { ...previous, starting: true }
          : { identity, starting: true, error: null },
      );
      const key = kept ? kept.key : `logo:${kind}:${crypto.randomUUID()}`;
      const started = (run: GenerationRun) => {
        if (unconfirmed.current?.key === key) keep(null);
        setFollowed((previous) => ({
          identity,
          ids: new Set([...(previous.identity === identity ? previous.ids : []), run.id]),
        }));
        setAction((previous) =>
          options.quiet && previous.identity === identity
            ? { ...previous, starting: false }
            : { identity, starting: false, error: null },
        );
        return run;
      };
      try {
        const { run } = await boundedAccountRequest(
          `/api/projects/${projectId}/generations`,
          generationRunResponseSchema,
          {
            method: "POST",
            signal: controller.signal,
            expectedOwnerId: account.userId,
            body: { kind, idempotencyKey: key, input },
          },
        );
        if (!current()) return null;
        setState((previous) =>
          previous.identity === identity
            ? { ...previous, runs: [run, ...previous.runs.filter((item) => item.id !== run.id)] }
            : previous,
        );
        started(run);
        refresh();
        return run;
      } catch (error) {
        if (!current()) return null;
        const refused = error instanceof AccountRequestError ? error.status : null,
          code = error instanceof AccountRequestError ? (error.code ?? null) : null;
        if (refused !== null && startRefusal(refused, code) === "final") {
          if (unconfirmed.current?.key === key) keep(null);
        } else if (!options.quiet) {
          // A run may exist. Keep the request's key, and look the run up before anything is offered again.
          keep({ identity, kind, input, body, key });
          try {
            const status = await readStatus(controller.signal);
            if (!current()) return null;
            const run = status.runs.find((item) => item.kind === kind && isActiveLogoRun(item));
            adopt(status, run ? [run.id] : []);
            if (run) {
              refresh();
              return started(run);
            }
          } catch {
            /* Still unconfirmed: Try again repeats the same key. */
          }
          if (!current()) return null;
        }
        let periodEnd: string | null = null;
        if (refused === 402) {
          try {
            periodEnd = (
              await boundedAccountRequest("/api/credits", creditSummaryResponseSchema, { signal: controller.signal })
            ).credits.periodEnd;
          } catch {
            /* The message stands without a date. */
          }
        }
        if (current())
          setAction((previous) =>
            options.quiet
              ? previous.identity === identity
                ? { ...previous, starting: false }
                : { identity, starting: false, error: null }
              : { identity, starting: false, error: logoEngineErrorMessage(error, periodEnd), refused, code },
          );
        refresh();
        return null;
      }
    },
    [account.userId, adopt, current, identity, keep, projectId, readStatus, refresh],
  );
  const cancel = useCallback(
    async (runId: string) => {
      if (!current()) return;
      setStops({ identity, sending: runId, failed: null });
      try {
        const { run } = await boundedAccountRequest(
          `/api/projects/${projectId}/generations/${runId}/cancel`,
          generationRunResponseSchema,
          { method: "POST", body: {}, signal: new AbortController().signal, expectedOwnerId: account.userId },
        );
        if (current()) {
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
          setStops({ identity, sending: null, failed: null });
        }
      } catch {
        // Said on the screen with Try again; the next check also shows whether it stopped.
        if (current()) setStops({ identity, sending: null, failed: runId });
      }
      refresh();
    },
    [account.userId, current, identity, projectId, refresh],
  );

  const runs = view.runs,
    act = action.identity === identity ? action : { starting: false, error: null, refused: undefined, code: null };
  const ids = followed.identity === identity ? followed.ids : EMPTY;
  const stop = stops.identity === identity ? stops : { sending: null, failed: null };
  // A Stop that got no answer matters only while its run still works and no Stop reached it.
  const stopFailedRun = runs.find((run) => run.id === stop.failed && canStopRun(run)) ?? null;
  const problem: StepProblem | null = stopFailedRun
    ? { during: "stop" }
    : act.error !== null && act.refused !== undefined
      ? { during: "start", httpStatus: act.refused, code: act.code ?? null }
      : readFailed?.identity === identity
        ? { during: view.engine === null ? "load" : "check" }
        : null;
  const retry = useCallback(() => {
    if (stopFailedRun) void cancel(stopFailedRun.id);
    else if (act.error !== null && unconfirmed.current?.identity === identity)
      void start(unconfirmed.current.kind, unconfirmed.current.input);
    else refresh();
  }, [act.error, cancel, identity, refresh, start, stopFailedRun]);
  const problemKey = JSON.stringify(problem);
  return useMemo(
    () => ({
      engine: view.engine,
      runs,
      followed: ids,
      starting: act.starting,
      error: act.error,
      problem: JSON.parse(problemKey) as StepProblem | null,
      unconfirmed: held === identity,
      stopSending: stop.sending !== null,
      active: (kind) => runs.find((run) => run.kind === kind && isActiveLogoRun(run)) ?? null,
      latest: (kind) => latestLogoRun(runs, kind),
      start,
      cancel,
      retry,
      refresh,
      clearError: () =>
        setAction((previous) =>
          unconfirmed.current?.identity === previous.identity
            ? previous
            : { identity: previous.identity, starting: previous.starting, error: null },
        ),
    }),
    [
      act.error,
      act.starting,
      cancel,
      held,
      identity,
      ids,
      problemKey,
      refresh,
      retry,
      runs,
      start,
      stop.sending,
      view.engine,
    ],
  );
}
