import { startRefusal, stepView, type RunPhase, type StepView } from "@/domain/generation-run";
import type { StrategyJob, StrategyOperation, StrategyOverview } from "@/domain/strategy-jobs";
import { AccountRequestError } from "./account-api";
import { strategyJobActive } from "./account-strategy-client";

/** Strategy job polling (docs/state-machines.md, J8): what `useStrategyJobs` holds about its own
 * requests, and the one function that turns it into what the hook reports. */

/** A start this tab sent, named so a later status check can recognise the run it made. */
export type StrategyEnqueueRequest = { epoch: number; operation: StrategyOperation; revision: number };

/** The last thing that went wrong with this tab's own request, with the sentence Strategy shows for it. */
export type StrategyProblem =
  /** The start was refused (`httpStatus`) or never answered (`null`). */
  | { during: "start"; httpStatus: number | null; sentence: string }
  | { during: "stop"; sentence: string }
  /** Nothing was sent: the draft changed first, or the page reported its own message. */
  | { during: "local"; sentence: string };

export type StrategyAction = {
  /** A request this tab sent that has not been answered yet. One at a time. */
  sending: "start" | "stop" | null;
  problem: StrategyProblem | null;
  /** A start that may have been admitted. Only a status check that finds exactly one matching run
   * clears its message; otherwise it stays until the person retries. */
  unconfirmed: StrategyEnqueueRequest | null;
};
export const idleStrategyAction: StrategyAction = { sending: null, problem: null, unconfirmed: null };

/** A failed start, read once: the status the server answered with, and whether a run may exist. */
export function strategyStartFailure(error: unknown): { httpStatus: number | null; uncertain: boolean } {
  const httpStatus = error instanceof AccountRequestError ? error.status : null;
  return { httpStatus, uncertain: httpStatus === null || startRefusal(httpStatus) === "uncertain" };
}

/** What the newest working request is doing, in the words the step screens share. Strategy polls a
 * `partial` old-system job as if it were still working (see jobs.ts), so it counts as running here. */
export function strategyRunPhase(jobs: readonly StrategyJob[]): RunPhase | null {
  const job = jobs.find(strategyJobActive);
  if (!job) return null;
  return job.state === "cancel_requested" ? "stopping" : job.state === "queued" ? "queued" : "running";
}

export type StrategyJobsSituation = {
  /** The last status the server gave, kept through a failed check; null before the first answer. */
  overview: StrategyOverview | null;
  /** The sentence for the last status check, when it failed. */
  readError: string | null;
  action: StrategyAction;
};

export type StrategyJobsReport = {
  overview: StrategyOverview | null;
  readError: string | null;
  /** The sentence for this tab's own failed request. */
  actionError: string | null;
  /** This tab's start or stop is on its way. */
  pending: boolean;
  pendingLabel: string;
  /** The same reading Naming, Logo and Creative direction use (`stepView`), with Strategy's sentence
   * for its `message`. */
  view: StepView & { sentence: string | null };
};

/** Everything the hook reports comes from here. What may be done is `stepView`'s answer; the sentences
 * are Strategy's own. */
export function strategyJobsReport({ overview, readError, action }: StrategyJobsSituation): StrategyJobsReport {
  const loaded = overview !== null;
  const own = action.problem;
  const view = stepView({
    phase: overview ? strategyRunPhase(overview.jobs) : null,
    loaded,
    sending: action.sending,
    problem:
      own?.during === "start"
        ? { during: "start", httpStatus: own.httpStatus }
        : own?.during === "stop"
          ? { during: "stop" }
          : readError
            ? { during: loaded ? "check" : "load" }
            : null,
  });
  const sentence =
    view.message === null
      ? own?.during === "local"
        ? own.sentence
        : null
      : view.message === "stopping"
        ? null
        : view.message === "updates_delayed" || view.message === "load_failed"
          ? readError
          : (own?.sentence ?? null);
  return {
    overview,
    readError,
    actionError: own?.sentence ?? null,
    pending: action.sending !== null,
    pendingLabel: "Submitting your request…",
    view: { ...view, sentence },
  };
}
