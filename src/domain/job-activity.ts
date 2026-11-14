import { z } from "zod";
import { jobStatusSchema } from "./jobs";
import { operationSchema } from "./providers";
import { projectStrategyHref } from "./project-handoff";

export const activeJobStates = ["queued", "running", "cancel_requested", "needs_reconciliation"] as const;
export const jobActivityEntrySchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.uuid(),
  projectId: z.uuid(),
  projectTitle: z.string().min(1).max(160),
  operation: operationSchema,
  state: jobStatusSchema,
  progress: z.number().int().min(0).max(100),
  createdAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type JobActivityEntry = z.infer<typeof jobActivityEntrySchema>;
export const jobActivitySchema = z
  .strictObject({
    ownerId: z.uuid(),
    active: z.array(jobActivityEntrySchema).max(20),
    recent: z.array(jobActivityEntrySchema).max(20),
  })
  .superRefine((value, ctx) => {
    const rows = [...value.active, ...value.recent];
    if (rows.some((row) => row.ownerId !== value.ownerId) || new Set(rows.map((row) => row.id)).size !== rows.length)
      ctx.addIssue({ code: "custom", message: "Activity must contain unique jobs from the verified owner" });
    if (value.active.some((row) => !activeJobStates.some((state) => state === row.state)))
      ctx.addIssue({ code: "custom", path: ["active"], message: "Active activity must represent unfinished work" });
  });
export type JobActivity = z.infer<typeof jobActivitySchema>;

type Operation = JobActivityEntry["operation"];
type State = JobActivityEntry["state"];

export function jobActivityHref(job: Pick<JobActivityEntry, "projectId" | "operation">) {
  if (job.operation.startsWith("strategy.")) return projectStrategyHref(job.projectId);
  const suffix: Partial<Record<Operation, string>> = {
    "naming.generate": "/naming",
    "identity.image": "/logo/directions",
    "identity.logo_concept": "/logo",
    "identity.logo_refine": "/logo",
    "identity.logo_vector_propose": "/logo",
    "identity.logo_vectorize": "/logo",
    "identity.logo_directions": "/logo/directions",
    "identity.logo_export": "/logo/deliverables",
    "identity.logo_style_note": "/logo",
  };
  return `/brands/account/${job.projectId}${suffix[job.operation] ?? ""}`;
}

const numberWords = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
/** "one" to "twelve", then digits: the words people read in a sentence. */
export const countWord = (count: number) => numberWords[count] ?? String(count);
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Results that come in a set of requests: one click makes several requests, so the label counts them. (A creative
 * directions request is one request that makes three boards, so its plain label already says three.) */
const countedLabels: Partial<Record<Operation, readonly [singular: string, plural: string]>> = {
  "identity.logo_concept": ["logo concept", "logo concepts"],
  "identity.logo_refine": ["logo change", "logo changes"],
};
/** The journey's own words for each kind of work, never the engine's operation names. */
const plainLabels: Record<Operation, string> = {
  "strategy.reformulate": "Brief",
  "strategy.competitors": "Competitors",
  "strategy.audience": "Audience",
  "strategy.personality": "Personality",
  "strategy.positioning": "Positioning",
  "strategy.slogan": "Slogan",
  "naming.generate": "Names",
  "ideas.explore": "Ideas",
  "identity.image": "Three creative directions",
  "identity.vector": "Vector logo",
  "brand.export": "Brand files",
  "identity.logo_concept": "Logo concepts",
  "identity.logo_refine": "Logo change",
  "identity.logo_vectorize": "Vector logo",
  "identity.logo_vector_propose": "Vector logo",
  "identity.logo_directions": "Three creative directions",
  "identity.logo_export": "Brand files",
  "identity.logo_style_note": "Notes on an image you liked",
};

/**
 * What one action made, in plain words: "Six logo concepts", "Three creative directions", "Logo change", "Names".
 * Without a count (the list's limit may have cut the action off) a set reads without a number.
 */
export function jobActionLabel(operation: Operation, count?: number) {
  const counted = countedLabels[operation];
  if (!counted || count === undefined || count < 1) return plainLabels[operation];
  if (count === 1) return operation === "identity.logo_refine" ? "Logo change" : capitalized(`one ${counted[0]}`);
  return capitalized(`${countWord(count)} ${counted[1]}`);
}

/** How one action stands, from the states of the requests it made. The first that applies wins. */
export type JobGroupStatus = "failed" | "unconfirmed" | "running" | "stopping" | "partial" | "stopped" | "done";
function statusFor(states: readonly State[]): JobGroupStatus {
  if (states.includes("failed")) return "failed";
  if (states.includes("needs_reconciliation")) return "unconfirmed";
  if (states.includes("running") || states.includes("queued")) return "running";
  if (states.includes("cancel_requested")) return "stopping";
  if (states.includes("partial")) return "partial";
  if (states.includes("cancelled")) return "stopped";
  return "done";
}
/** Statuses that need the person's eye: listed first, under "Running and failed". */
export const attentionStatuses: readonly JobGroupStatus[] = ["failed", "unconfirmed", "running", "stopping"];

export type JobActivityGroup = {
  /** The first request's id: stable while the action runs. */
  id: string;
  projectId: string;
  projectTitle: string;
  operation: Operation;
  jobs: JobActivityEntry[];
  status: JobGroupStatus;
  /** True when at least one request of the action produced something. */
  someMade: boolean;
  /** False when the list's limit may have cut this action off, so its size is not known. */
  complete: boolean;
  label: string;
  href: string;
  startedAt: string;
  /** The latest finish, once every request has finished. */
  finishedAt: string | null;
};

/** Requests made by one click arrive within moments of each other. */
export const JOB_GROUP_WINDOW_MS = 2 * 60_000;
const ACTIVITY_LIMIT = 20;
const time = (row: Pick<JobActivityEntry, "createdAt">) => Date.parse(row.createdAt);

/**
 * One row per action: requests for the same project and the same kind of work, started within two minutes of the
 * action's first request, are one action (one click on "Explore six concepts" makes six requests). A list that
 * reached its limit may have cut off its oldest action, which then reads without a count.
 */
export function groupJobActivity(activity: Pick<JobActivity, "active" | "recent">): JobActivityGroup[] {
  // A request can appear in both lists while it finishes; the active observation is kept.
  const rows = [...new Map([...activity.recent, ...activity.active].map((row) => [row.id, row])).values()];
  rows.sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
  const cutOff = new Set(
    [activity.active, activity.recent]
      .filter((list) => list.length >= ACTIVITY_LIMIT)
      .map((list) => list.reduce((oldest, row) => (time(row) < time(oldest) ? row : oldest)).id),
  );
  const groups: JobActivityEntry[][] = [];
  const latest = new Map<string, JobActivityEntry[]>();
  for (const row of rows) {
    const key = `${row.projectId}:${row.operation}`;
    const group = latest.get(key);
    if (group && time(row) - time(group[0]!) <= JOB_GROUP_WINDOW_MS) group.push(row);
    else {
      const next = [row];
      groups.push(next);
      latest.set(key, next);
    }
  }
  return groups
    .map((jobs): JobActivityGroup => {
      const first = jobs[0]!;
      const states = jobs.map((job) => job.state);
      const complete = !jobs.some((job) => cutOff.has(job.id));
      const finishes = jobs.map((job) => job.finishedAt);
      const finishedAt = finishes.every((value) => value !== null)
        ? finishes.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
        : null;
      return {
        id: first.id,
        projectId: first.projectId,
        projectTitle: jobs.at(-1)!.projectTitle,
        operation: first.operation,
        jobs,
        status: statusFor(states),
        someMade: states.some((state) => state === "succeeded" || state === "partial"),
        complete,
        label: jobActionLabel(first.operation, complete ? jobs.length : undefined),
        href: jobActivityHref(first),
        startedAt: first.createdAt,
        finishedAt,
      };
    })
    .sort((a, b) => time({ createdAt: b.startedAt }) - time({ createdAt: a.startedAt }) || a.id.localeCompare(b.id));
}

/** Running and failed actions first, then everything that finished; newest first in each. */
export function splitJobActivity(groups: readonly JobActivityGroup[]) {
  return {
    attention: groups.filter((group) => attentionStatuses.includes(group.status)),
    finished: groups.filter((group) => !attentionStatuses.includes(group.status)),
  };
}

/** One true sentence about what is running and what failed: "One thing is running and one failed." */
export function jobActivitySummary(groups: readonly JobActivityGroup[]) {
  const count = (...statuses: JobGroupStatus[]) => groups.filter((group) => statuses.includes(group.status)).length;
  const running = count("running", "stopping"),
    failed = count("failed"),
    unconfirmed = count("unconfirmed");
  const runningPart = running
    ? `${countWord(running)} ${running === 1 ? "thing is" : "things are"} running`
    : "nothing is running";
  const sentence = `${capitalized(runningPart)} and ${failed ? `${countWord(failed)} failed` : "nothing failed"}.`;
  if (!unconfirmed) return sentence;
  const results = unconfirmed === 1 ? "result" : "results";
  return `${sentence} ${capitalized(countWord(unconfirmed))} ${results} couldn’t be confirmed.`;
}

/** "just now", "12 minutes ago", "1 hour ago", "yesterday", "3 days ago", then a date. */
export function activityTimeAgo(dateTime: string, now: number) {
  const timestamp = Date.parse(dateTime);
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

/** The line under an action's title: when it started or finished, and what went wrong, in plain words. */
export function jobActivityDetail(group: JobActivityGroup, now: number) {
  const started = activityTimeAgo(group.startedAt, now);
  const ended = activityTimeAgo(group.finishedAt ?? group.startedAt, now);
  switch (group.status) {
    case "running":
      return group.jobs.some((job) => job.state === "running") ? `Started ${started}` : `Waiting to start, ${started}`;
    case "stopping":
      return `Stopping, started ${started}`;
    case "failed":
      // Part of a set can fail while the rest is still being made or already made.
      if (group.jobs.some((job) => job.state === "running" || job.state === "queued"))
        return "Some couldn’t be made, the rest is still running";
      return `${group.someMade ? "Some couldn’t be made" : "Couldn’t be made"}, ${ended}`;
    case "unconfirmed":
      return "We couldn’t confirm this result. Open the project to continue.";
    case "partial":
      return `Partly made, ${ended}`;
    case "stopped":
      return `Stopped, ${ended}`;
    case "done":
      return capitalized(ended);
  }
}
