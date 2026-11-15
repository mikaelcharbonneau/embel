import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strategyJobActive } from "@/components/workspace/account-strategy-client";
import { identityBatchStateSchema } from "@/domain/identity-jobs";
import { activeJobStates, jobActivityEntrySchema } from "@/domain/job-activity";
import {
  JOB_DELIVERED_STATES,
  JOB_FINISHED_STATES,
  JOB_LEASED_OR_PARTIAL_STATES,
  JOB_LEASED_STATES,
  JOB_RUNNING_OR_PARTIAL_STATES,
  JOB_STATES,
  JOB_STATE_TRANSITIONS,
  JOB_UNSETTLED_STATES,
  JOB_WAITING_OR_RUNNING_STATES,
  JOB_WORKING_OR_PARTIAL_STATES,
  JOB_WORKING_OR_UNCONFIRMED_STATES,
  JOB_WORKING_STATES,
  canJobMove,
  isJobFinished,
  isJobLeasedOrPartial,
  isJobRunningOrPartial,
  isJobUnsettled,
  isJobWaitingOrRunning,
  isJobWorking,
  isJobWorkingOrPartial,
  isJobWorkingOrUnconfirmed,
  jobDeliveredSomething,
  jobHoldsLease,
  jobStatusSchema,
  type JobState,
} from "@/domain/jobs";
import { namingRunActive, namingRunStateSchema } from "@/domain/naming-generation";
import type { StrategyJob } from "@/domain/strategy-jobs";

const migrations = join(process.cwd(), "supabase/migrations");
const sql = readdirSync(migrations)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(migrations, name), "utf8"));
const quoted = (text: string) => [...text.matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]!);
const sorted = (states: readonly string[]) => [...states].sort();
/** The newest text matching a pattern across the migrations. */
function latest(pattern: RegExp, label: string): string {
  const found = sql.flatMap((text) => text.match(pattern) ?? []);
  expect(found.length, label).toBeGreaterThan(0);
  return found.at(-1)!;
}
/** The newest definition of a function across the migrations, as its SQL text. */
const latestFunction = (name: string) =>
  latest(
    new RegExp(
      `create (?:or replace )?function ${name.replace(".", "\\.")}\\([\\s\\S]*?\\n(?:end|\\$\\$)[^\\n]*\\$_?\\$`,
      "giu",
    ),
    name,
  );

describe("old job state: the database agrees", () => {
  it("lists the states the database allows", () => {
    const check = latest(/CONSTRAINT jobs_state_check CHECK \(\(state = ANY \(ARRAY\[[^\]]+\]/gu, "jobs_state_check");
    expect(sorted(quoted(check))).toEqual(sorted(JOB_STATES));
    expect(jobStatusSchema.options).toEqual([...JOB_STATES]);
  });

  it("holds a lease exactly where the database requires one", () => {
    const check = latest(
      /CONSTRAINT jobs_check3 CHECK \(\(\(state = ANY \(ARRAY\[[^\]]+\]\)\) = \(lease_token IS NOT NULL\)\)\)/gu,
      "jobs_check3",
    );
    expect(sorted(quoted(check))).toEqual(sorted(JOB_LEASED_STATES));
  });

  it("calls a job unsettled exactly where the database's guards and index do", () => {
    const unsettled = sorted(JOB_UNSETTLED_STATES);
    const admission = latestFunction("fluid_private.guard_project_job_admission").match(
      /NEW\.state in \(([^)]+)\) and OLD\.state in \(([^)]+)\)/u,
    );
    expect(sorted(quoted(admission![1]!))).toEqual(unsettled);
    // What the guard calls settled is every other state.
    expect(sorted(quoted(admission![2]!))).toEqual(sorted(JOB_STATES.filter((state) => !isJobUnsettled(state))));
    const lifecycle = latestFunction("fluid_private.guard_project_lifecycle_change").match(
      /from public\.jobs where project_id=OLD\.id and owner_id=OLD\.owner_id\s+and state in \(([^)]+)\)/u,
    );
    expect(sorted(quoted(lifecycle![1]!))).toEqual(unsettled);
    const index = latest(/CREATE INDEX jobs_project_unsettled ON public\.jobs [^;]+;/gu, "jobs_project_unsettled");
    expect(sorted(quoted(index))).toEqual(unsettled);
  });

  it("calls a job finished, working, or working-or-unconfirmed where the database does", () => {
    const batch = latestFunction("fluid_private.shared_identity_batch_state");
    const terminal = batch.match(/terminal:=j\.state in\(([^)]+)\)/u);
    expect(sorted(quoted(terminal![1]!))).toEqual(sorted(JOB_FINISHED_STATES));
    const pendingUsage = batch.match(/when j\.state in\(([^)]+)\) then 'pending'/u);
    expect(sorted(quoted(pendingUsage![1]!))).toEqual(sorted(JOB_WORKING_STATES));
    const close = latestFunction("fluid_private.engine_identity_close_job").match(/j\.state not in \(([^)]+)\)/u);
    expect(sorted(quoted(close![1]!))).toEqual(sorted(JOB_WORKING_STATES));
    const pendingRound = latestFunction("public.start_identity_directions").match(
      /operation = 'identity\.image'\s+and state in \(([^)]+)\)/u,
    );
    expect(sorted(quoted(pendingRound![1]!))).toEqual(sorted(JOB_WORKING_OR_UNCONFIRMED_STATES));
  });

  it("still reports partial as failed in the Logo observation (unchanged for now)", () => {
    expect(latestFunction("fluid_private.logo_job_observation")).toMatch(/when p_job\.state='partial' then 'failed'/u);
  });

  it("moves a job only the ways the remaining SQL functions do", () => {
    const cancel = latestFunction("public.request_job_cancel");
    expect(cancel).toMatch(/v_job\.state = 'queued' then[\s\S]*?set state = 'cancelled'/u);
    expect(cancel).toMatch(/v_job\.state = 'running' then\s+update public\.jobs set state = 'cancel_requested'/u);
    expect(quoted(cancel.match(/set state = '[a-z_]+'/gu)!.join(" "))).toEqual(["cancelled", "cancel_requested"]);
    expect(latestFunction("fluid_private.engine_identity_cancel")).toMatch(
      /set state = 'cancel_requested'[\s\S]*?j\.state = 'running'/u,
    );
    expect(latestFunction("public.request_project_deletion")).toMatch(
      /if j\.state='queued' then[\s\S]*?update public\.jobs set state='needs_reconciliation'/u,
    );
    for (const name of [
      "record_logo_publication_failure_adjudication",
      "record_logo_absent_publication_adjudication",
    ]) {
      const adjudication = latestFunction(`fluid_private.${name}`);
      expect(adjudication).toMatch(/j\.state is distinct from 'needs_reconciliation'/u);
      expect(adjudication).toMatch(/update public\.jobs set state='failed'/u);
    }
    // Every statement in the migrations that sets a job's state is one of the moves above.
    const writers = sql.flatMap(
      (text) => text.match(/update public\.jobs(?: j)?\s+set state\s*=\s*'?[a-z_]+'?/giu) ?? [],
    );
    expect(sorted([...new Set(writers.map((text) => text.replace(/\s+/gu, " ").toLowerCase()))])).toEqual([
      "update public.jobs j set state = 'cancel_requested'",
      "update public.jobs set state = 'cancel_requested'",
      "update public.jobs set state = 'cancelled'",
      "update public.jobs set state = v_state",
      "update public.jobs set state='failed'",
      "update public.jobs set state='needs_reconciliation'",
    ]);
  });
});

describe("old job state: the declaration", () => {
  it("lets nothing leave a finished state and only finished states end a move chain", () => {
    for (const state of JOB_FINISHED_STATES) expect(JOB_STATE_TRANSITIONS[state]).toEqual([]);
    for (const state of JOB_STATES) {
      if (isJobFinished(state)) continue;
      expect(JOB_STATE_TRANSITIONS[state].some((next) => isJobFinished(next))).toBe(true);
    }
    // engine_identity_close_job: every working state can end in each of its four results.
    for (const state of JOB_WORKING_STATES)
      for (const end of ["succeeded", "cancelled", "partial", "failed"] as const) {
        if (state === "queued" && end === "cancelled") continue; // also request_job_cancel
        expect(canJobMove(state, end)).toBe(true);
      }
    expect(canJobMove("running", "cancel_requested")).toBe(true);
    expect(canJobMove("queued", "needs_reconciliation")).toBe(true);
    expect(canJobMove("needs_reconciliation", "failed")).toBe(true);
    // The retired workers' moves are gone.
    expect(canJobMove("queued", "running")).toBe(false);
    expect(canJobMove("running", "queued")).toBe(false);
    expect(canJobMove("running", "needs_reconciliation")).toBe(false);
    expect(canJobMove("cancel_requested", "running")).toBe(false);
    // Nothing moves a job into a lease: leased jobs are created running.
    for (const state of JOB_STATES) expect(canJobMove(state, "running")).toBe(false);
  });

  it("relates the named sets the way their meanings say", () => {
    const without = (states: readonly JobState[], ...drop: JobState[]) => states.filter((s) => !drop.includes(s));
    expect(sorted(JOB_WORKING_STATES)).toEqual(sorted([...JOB_WAITING_OR_RUNNING_STATES, "cancel_requested"]));
    expect(sorted(without(JOB_WORKING_OR_UNCONFIRMED_STATES, "needs_reconciliation"))).toEqual(
      sorted(JOB_WORKING_STATES),
    );
    expect(sorted(without(JOB_WORKING_OR_PARTIAL_STATES, "partial"))).toEqual(sorted(JOB_WORKING_STATES));
    expect(sorted(without(JOB_UNSETTLED_STATES, "partial", "needs_reconciliation"))).toEqual(
      sorted(JOB_WORKING_STATES),
    );
    for (const state of JOB_STATES) {
      // Working and finished never overlap; needs_reconciliation alone is neither.
      expect(isJobWorking(state) && isJobFinished(state)).toBe(false);
      expect(!isJobWorking(state) && !isJobFinished(state)).toBe(state === "needs_reconciliation");
      // partial is the one state the database calls both finished and unsettled.
      expect(isJobFinished(state) && isJobUnsettled(state)).toBe(state === "partial");
      if (jobHoldsLease(state)) expect(isJobWorking(state)).toBe(true);
      if (jobDeliveredSomething(state)) expect(isJobFinished(state)).toBe(true);
    }
    expect([...JOB_DELIVERED_STATES]).toEqual(["succeeded", "partial"]);
    expect(sorted(JOB_LEASED_OR_PARTIAL_STATES)).toEqual(sorted([...JOB_LEASED_STATES, "partial"]));
    // The font check's list is the asset store's without a job that was asked to stop.
    expect(sorted(JOB_RUNNING_OR_PARTIAL_STATES)).toEqual(
      sorted(without(JOB_LEASED_OR_PARTIAL_STATES, "cancel_requested")),
    );
  });
});

/** Each list as it was written by hand before this declaration, against the predicate that replaced it. */
describe("old job state: every replaced copy answers the same for all eight states", () => {
  const cases: [site: string, old: readonly string[], now: (state: JobState) => boolean][] = [
    [
      "job-activity.ts activeJobStates",
      ["queued", "running", "cancel_requested", "needs_reconciliation"],
      (state) => (activeJobStates as readonly JobState[]).includes(state),
    ],
    [
      "job-activity.ts jobActivitySchema active rows",
      ["queued", "running", "cancel_requested", "needs_reconciliation"],
      isJobWorkingOrUnconfirmed,
    ],
    [
      "job-activity.ts statusFor and jobActivityDetail (running or queued)",
      ["running", "queued"],
      isJobWaitingOrRunning,
    ],
    ["job-activity.ts someMade", ["succeeded", "partial"], jobDeliveredSomething],
    [
      "naming-generation.ts namingRunActive (as a job-state question)",
      ["queued", "running", "cancel_requested"],
      isJobWorking,
    ],
    [
      "account-strategy-client.ts strategyJobActive",
      ["queued", "running", "partial", "cancel_requested"],
      (state) => strategyJobActive({ state } as StrategyJob),
    ],
    [
      "account-strategy-client.ts (the predicate itself)",
      ["queued", "running", "partial", "cancel_requested"],
      isJobWorkingOrPartial,
    ],
    ["identity-jobs.ts pending fulfillment", ["queued", "running", "cancel_requested"], isJobWorking],
    ["identity-jobs.ts terminal", ["succeeded", "failed", "cancelled", "partial"], isJobFinished],
    ["identity-asset-store.ts leased", ["running", "partial", "cancel_requested"], isJobLeasedOrPartial],
    ["identity-directions fonts.ts font check", ["running", "partial"], isJobRunningOrPartial],
    [
      "job-activity.ts listJobActivity active rows",
      ["queued", "running", "cancel_requested", "needs_reconciliation"],
      isJobWorkingOrUnconfirmed,
    ],
  ];
  it.each(cases)("%s", (_site, old, now) => {
    expect(JOB_STATES.length).toBe(8);
    for (const state of JOB_STATES) expect(now(state), state).toBe(old.includes(state));
  });

  it("namingRunActive answers as before for every state a Naming run can have, and for no run", () => {
    for (const state of namingRunStateSchema.options)
      expect(namingRunActive({ state }), state).toBe(["queued", "running", "cancel_requested"].includes(state));
    expect(namingRunActive(null)).toBe(false);
    expect(namingRunActive(undefined)).toBe(false);
  });

  it("the schemas that carry a job state accept exactly the declared states", () => {
    expect(jobActivityEntrySchema.shape.state.options).toEqual([...JOB_STATES]);
    expect(identityBatchStateSchema.in.shape.status.options).toEqual([...JOB_STATES]);
    for (const state of namingRunStateSchema.options) expect(JOB_STATES).toContain(state);
  });
});
