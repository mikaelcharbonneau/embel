import { z } from "zod";

/**
 * The old job state (`jobs.state`), declared once (docs/state-machines.md, R5).
 *
 * The database owns the truth: the CHECK constraint `jobs_state_check` lists the states and
 * `jobs_check3` says a job holds a lease exactly while it is running or cancel_requested. Jobs are
 * no longer the unit of work (generation runs are, see generation-run.ts); the app still writes one
 * for each Logo image and each Creative direction round, and still reads old ones for history.
 * tests/domain/jobs.test.ts fails when this file and the migrations disagree.
 *
 * New jobs are born `running` (start_identity_directions, a Creative direction round) or already
 * finished as `succeeded` or `failed` (the engine's Logo records). Nothing creates a `queued` job any
 * more, and nothing creates `needs_reconciliation` except project deletion stopping an old queued job,
 * so those two states appear only in old records.
 *
 * `partial` is a finished job that delivered some but not all of its results. Three readers treat it
 * otherwise, unchanged for now: the database's project guards and the `jobs_project_unsettled` index
 * count it as unsettled (JOB_UNSETTLED_STATES), `logo_job_observation` and the Logo request view report
 * it as failed, and the strategy screens poll it as if it were still working
 * (JOB_WORKING_OR_PARTIAL_STATES).
 *
 * `needs_reconciliation` is neither working nor finished: the outcome is not known.
 */
export const JOB_STATES = [
  "queued",
  "running",
  "partial",
  "cancel_requested",
  "cancelled",
  "succeeded",
  "failed",
  "needs_reconciliation",
] as const;
export const jobStatusSchema = z.enum(JOB_STATES);
export type JobState = (typeof JOB_STATES)[number];
type JobStatus = JobState;

/**
 * Which state may follow which today, and the SQL function that makes the move.
 *
 * queued               -> cancelled             request_job_cancel (also called by request_project_deletion)
 * queued               -> needs_reconciliation  request_project_deletion, when the job may already have spent
 * running              -> cancel_requested      request_job_cancel, engine_identity_cancel, request_project_deletion
 * queued, running,
 * cancel_requested     -> succeeded, cancelled, engine_identity_close_job, when the round's run ends
 *                         partial, failed       (identityRoundJobState in identity-jobs.ts)
 * needs_reconciliation -> failed                an operator's adjudication record for a Logo concept
 *                                               (record_logo_publication_failure_adjudication,
 *                                               record_logo_absent_publication_adjudication)
 *
 * engine_identity_close_job accepts a queued job, though the engine creates its job running. The moves
 * the retired workers made (queued -> running, a retry back to queued, running -> needs_reconciliation)
 * no longer exist. A stop request on a running Naming job or a needs_reconciliation job only sets
 * cancel_requested_at; the state stays.
 */
export const JOB_STATE_TRANSITIONS = Object.freeze({
  queued: ["cancelled", "needs_reconciliation", "succeeded", "partial", "failed"],
  running: ["cancel_requested", "succeeded", "cancelled", "partial", "failed"],
  cancel_requested: ["succeeded", "cancelled", "partial", "failed"],
  needs_reconciliation: ["failed"],
  partial: [],
  cancelled: [],
  succeeded: [],
  failed: [],
} as const satisfies Record<JobState, readonly JobState[]>);
export function canJobMove(from: JobState, to: JobState): boolean {
  return (JOB_STATE_TRANSITIONS[from] as readonly JobState[]).includes(to);
}

/*
 * One named set for each question the code asks. The "is it active?" lists disagree, and making
 * them agree would change behavior, so each caller keeps the list it had under an honest name.
 */

/** Holds a lease (`jobs_check3`): something is making it, or was asked to stop making it. */
export const JOB_LEASED_STATES = ["running", "cancel_requested"] as const satisfies readonly JobState[];
/** Waiting or being made, and nobody asked it to stop. */
export const JOB_WAITING_OR_RUNNING_STATES = ["queued", "running"] as const satisfies readonly JobState[];
/**
 * Still working from the person's point of view: waiting, being made or stopping.
 * Used by Naming (`namingRunActive`; its run has no partial or needs_reconciliation state, so the
 * choice among the "active" lists cannot be seen there) and by the Creative direction batch check
 * that fulfillment may be pending. In SQL: engine_identity_close_job closes exactly these, and
 * shared_identity_batch_state reports usage as pending for them.
 */
export const JOB_WORKING_STATES = ["queued", "running", "cancel_requested"] as const satisfies readonly JobState[];
/**
 * Working, or ended without a known outcome: everything the activity list shows as unfinished.
 * Used by `activeJobStates` in job-activity.ts (its schema calls this "unfinished work"). In SQL:
 * start_identity_directions refuses a new round while a job is in one of these, and the
 * `shared_logo_proposal_pending_jobs` index covers them. Why partial is left out here but kept in
 * JOB_UNSETTLED_STATES: reason not recorded.
 */
export const JOB_WORKING_OR_UNCONFIRMED_STATES = [
  "queued",
  "running",
  "cancel_requested",
  "needs_reconciliation",
] as const satisfies readonly JobState[];
/**
 * Working, or finished with only part of its results: what the strategy screens keep polling.
 * Used by `strategyJobActive` in account-strategy-client.ts only. Why partial counts as active and
 * needs_reconciliation does not: reason not recorded.
 */
export const JOB_WORKING_OR_PARTIAL_STATES = [
  "queued",
  "running",
  "partial",
  "cancel_requested",
] as const satisfies readonly JobState[];
/**
 * Unsettled, the database's guard meaning: a project with such a job cannot be deleted directly
 * (guard_project_lifecycle_change), and a settled job cannot return to one of these in a deleted
 * project (guard_project_job_admission). Also the `jobs_project_unsettled` index. No TypeScript
 * caller yet; declared so the guards' list has a name.
 */
export const JOB_UNSETTLED_STATES = [
  "queued",
  "running",
  "partial",
  "cancel_requested",
  "needs_reconciliation",
] as const satisfies readonly JobState[];
/**
 * Finished: nothing moves it again. Used by the Creative direction batch's `terminal` flag, which
 * mirrors shared_identity_batch_state. needs_reconciliation is not finished.
 */
export const JOB_FINISHED_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "partial",
] as const satisfies readonly JobState[];
/** Finished with at least one result delivered. Used by the activity list ("Some couldn’t be made"). */
export const JOB_DELIVERED_STATES = ["succeeded", "partial"] as const satisfies readonly JobState[];

const among = (states: readonly JobState[]) => (state: JobState) => states.includes(state);
export const jobHoldsLease = among(JOB_LEASED_STATES);
export const isJobWaitingOrRunning = among(JOB_WAITING_OR_RUNNING_STATES);
export const isJobWorking = among(JOB_WORKING_STATES);
export const isJobWorkingOrUnconfirmed = among(JOB_WORKING_OR_UNCONFIRMED_STATES);
export const isJobWorkingOrPartial = among(JOB_WORKING_OR_PARTIAL_STATES);
export const isJobUnsettled = among(JOB_UNSETTLED_STATES);
export const isJobFinished = among(JOB_FINISHED_STATES);
export const jobDeliveredSomething = among(JOB_DELIVERED_STATES);

export const moneySchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const stepOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    result: z.json(),
    costMicrousd: moneySchema,
    providerRequestId: z.string().max(200).nullable().default(null),
  }),
  z.strictObject({
    status: z.literal("failed"),
    code: z.string().max(100),
    result: z.json().optional(),
    costMicrousd: moneySchema,
    providerRequestId: z.string().max(200).nullable().default(null),
  }),
  z.strictObject({
    status: z.literal("needs_reconciliation"),
    code: z.string().max(100),
    result: z.json().optional(),
    costMicrousd: moneySchema,
    providerRequestId: z.string().max(200).nullable().default(null),
  }),
]);
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

export type ClaimedJob = {
  id: string;
  ownerId: string;
  projectId: string;
  operation: string;
  input: unknown;
  inputRevision: number;
  leaseToken: string;
  status: JobStatus;
  reservedCostMicrousd: number;
  actualCostMicrousd: number;
};
