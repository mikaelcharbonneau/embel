import { z } from "zod";
import type { GenerationRun } from "@/domain/generations";
import {
  strategyJobResultSchema,
  strategyJobSchema,
  strategyOperationSchema,
  policyIdentitySchema,
  type StrategyJob,
  type StrategyJobApplication,
  type StrategyOperation,
  type StrategyOverview,
} from "@/domain/strategy-jobs";
import { accountDraftChanged, type AccountWorkspace } from "./account-draft-memory";
import { AccountRequestError } from "./account-api";
import { creditsMessage } from "./credits-message";
type BoundedAPIAllowance = { billingMode: "openai_api"; spendControl?: undefined; maximumCostMicrousd: number };
type UncappedAPIAllowance = { billingMode: "openai_api"; spendControl: "uncapped"; policyIdentity: string };
type APIAllowance = BoundedAPIAllowance | UncappedAPIAllowance;
export type StrategyAllowance = APIAllowance;
export type StrategyPromptPlan =
  | { kind: "response_only"; billingMode: "openai_api"; reformulation: APIAllowance }
  | {
      kind: "response_and_competitors";
      billingMode: "openai_api";
      reformulation: APIAllowance;
      competitors: APIAllowance;
    };
export function isUncappedStrategyAllowance(allowance: StrategyAllowance): allowance is UncappedAPIAllowance {
  return allowance.billingMode === "openai_api" && allowance.spendControl === "uncapped";
}
export function strategyAllowance(
  operation: StrategyOverview["availability"]["operations"][number] | undefined,
): StrategyAllowance | null {
  if (!operation) return null;
  if ("maximumCostMicrousd" in operation)
    return { billingMode: "openai_api", maximumCostMicrousd: operation.maximumCostMicrousd };
  return { billingMode: "openai_api", spendControl: "uncapped", policyIdentity: operation.policyIdentity };
}
export function promptStrategyPlan(availability: StrategyOverview["availability"] | null): StrategyPromptPlan | null {
  if (availability?.status !== "available") return null;
  const reformulation = strategyAllowance(
    availability.operations.find((item) => item.operation === "strategy.reformulate"),
  );
  const competitors = strategyAllowance(
    availability.operations.find((item) => item.operation === "strategy.competitors"),
  );
  if (
    reformulation?.billingMode === "openai_api" &&
    competitors?.billingMode === "openai_api" &&
    isUncappedStrategyAllowance(reformulation) === isUncappedStrategyAllowance(competitors)
  )
    return { kind: "response_and_competitors", billingMode: "openai_api", reformulation, competitors };
  if (reformulation?.billingMode === "openai_api" && !competitors)
    return { kind: "response_only", billingMode: "openai_api", reformulation };
  return null;
}
/** Only public readiness reasons are shown; project notices do not infer request history. */
export function strategyAvailabilityMessage(
  availability: StrategyOverview["availability"] | null,
  context: "prompt" | "project" = "prompt",
) {
  if (!availability)
    return context === "project"
      ? "AI availability could not be confirmed. Check existing request status before trying again. You can still edit and save your project."
      : "AI availability could not be confirmed. Recheck before sending. Your prompt is kept.";
  if (availability.status === "available")
    return context === "project"
      ? "AI replies are not enabled for this step. You can still edit and save your project."
      : "The response and competitor research operations are not both ready. Your prompt is kept.";
  const reasons: Record<NonNullable<StrategyOverview["availability"]["reason"]>, string> = {
    generation_unavailable:
      context === "project"
        ? "AI replies are unavailable right now."
        : "AI is unavailable right now. Try again shortly.",
    worker_unavailable:
      context === "project"
        ? "AI replies are unavailable right now."
        : "The AI worker is not ready. Recheck after it is connected.",
    runtime_disabled: "AI is not enabled in this workspace.",
    budget_unavailable: "No AI requests are available for this account.",
    quota_unavailable: "The current AI request limit is unavailable. Recheck when capacity is available.",
    request_unresolved:
      "A previous request needs review before another can start. Check its status before trying again.",
    request_active: "A request is already in progress. Wait for it to finish, then check status.",
  };
  return context === "project"
    ? `${reasons[availability.reason!]} You can still edit and save your project.`
    : `${reasons[availability.reason!]} No AI request was sent. Your prompt is kept.`;
}
export function strategyAllowanceWithin(current: StrategyAllowance, accepted: StrategyAllowance) {
  if (current.billingMode === "openai_api" && accepted.billingMode === "openai_api") {
    if (isUncappedStrategyAllowance(current) || isUncappedStrategyAllowance(accepted))
      return (
        isUncappedStrategyAllowance(current) &&
        isUncappedStrategyAllowance(accepted) &&
        current.policyIdentity === accepted.policyIdentity
      );
    return current.maximumCostMicrousd <= accepted.maximumCostMicrousd;
  }
  return false;
}
export function verifyStrategyJobs(jobs: StrategyJob[], ownerId: string, projectId: string) {
  return jobs.every((job) => job.owner_id === ownerId && job.project_id === projectId);
}
export function strategyJobMatchesRequest(
  job: StrategyJob,
  operation: StrategyOperation,
  revision: number,
  accepted: StrategyAllowance | number,
) {
  const allowance =
    typeof accepted === "number" ? { billingMode: "openai_api" as const, maximumCostMicrousd: accepted } : accepted;
  if (
    job.operation !== operation ||
    job.input_revision !== revision ||
    (job.billingMode ?? "openai_api") !== allowance.billingMode
  )
    return false;
  if (isUncappedStrategyAllowance(allowance))
    return "spendControl" in job && job.spendControl === "uncapped" && job.policyIdentity === allowance.policyIdentity;
  if ("spendControl" in job && job.spendControl === "uncapped") return false;
  return job.reserved_cost_microusd <= allowance.maximumCostMicrousd;
}
export function strategyJobActive(job: StrategyJob) {
  return ["queued", "running", "partial", "cancel_requested"].includes(job.state);
}
export function strategyApplicationMatchesResult(
  job: StrategyJob,
  stepKey: string,
  application: StrategyJobApplication,
) {
  return (
    application.jobId === job.id &&
    application.stepKey === stepKey &&
    application.inputRevision === job.input_revision &&
    application.appliedRevision === job.input_revision + 1 &&
    job.results.some((result) => result.stepKey === stepKey)
  );
}
export function strategyResultApplication(job: StrategyJob, stepKey: string) {
  const application = job.results.find((result) => result.stepKey === stepKey)?.application;
  return application && strategyApplicationMatchesResult(job, stepKey, application) ? application : null;
}
/** Engine requests: one per project revision and operation, like the old path. */
export function engineStrategyIdempotencyKey(projectId: string, revision: number, operation: StrategyOperation) {
  return `strategy.engine.v1:${projectId}:${revision}:${operation}`;
}
/**
 * An engine run in the shape the Strategy screens already read. The run's verified result
 * is its "result" output; other outputs only record attempts. The engine charges credits at
 * admission, so there is no cost reservation (zeros), and a cancel request has no separate
 * time (the run's own time marks it).
 */
export function engineStrategyJob(run: GenerationRun, ownerId: string, projectId: string): StrategyJob | null {
  const operation = strategyOperationSchema.safeParse(run.kind);
  if (!operation.success || run.inputRevision === null) return null;
  const results =
    run.status === "succeeded"
      ? run.outputs.flatMap((item) => {
          const output = strategyJobResultSchema.safeParse(item.output);
          return item.key === "result" && output.success && output.data.operation === operation.data
            ? [{ stepKey: item.key, output: output.data }]
            : [];
        })
      : [];
  const active = run.status === "queued" || run.status === "running";
  const job = strategyJobSchema.safeParse({
    id: run.id,
    owner_id: ownerId,
    project_id: projectId,
    operation: operation.data,
    input_revision: run.inputRevision,
    state: active && run.cancelRequested ? "cancel_requested" : run.status,
    progress: run.status === "succeeded" ? 100 : 0,
    error_code: run.errorCode && /^[a-z][a-z0-9_]{0,79}$/.test(run.errorCode) ? run.errorCode : null,
    cancel_requested_at: run.cancelRequested ? (run.finishedAt ?? run.createdAt) : null,
    created_at: run.createdAt,
    finished_at: run.finishedAt,
    billingMode: "openai_api",
    reserved_cost_microusd: 0,
    actual_cost_microusd: 0,
    results,
  });
  return job.success ? job.data : null;
}
/** Remaining credits matter only once they run out. Never a price. */
export function strategyCreditsMessage(periodEnd: string | null) {
  return creditsMessage(periodEnd, "Your conversation is saved.");
}

export function strategyErrorMessage(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.status === 402) return strategyCreditsMessage(null);
    if (error.status === 409)
      return "The saved version or request changed. Your edits are still here. Load the latest version before requesting a new proposal.";
    if (error.status === 503)
      return "OpenAI is unavailable right now. Your draft is kept here; no new job was confirmed. You can continue editing.";
    if (error.status === 422)
      return "This request could not be accepted. Review the current request limits and your project details.";
    if (error.status === 429)
      return "The current request limit was reached. Your draft is kept here. Try again when capacity is available.";
    if (error.status === 404) return "This strategy result is not available to your account.";
    if (error.status === 502) return "The strategy response could not be verified. No result was added to your brief.";
  }
  return "The strategy request could not be confirmed. Check its status before trying again; your edits are still here.";
}

const intentScope = {
  ownerId: z.uuid(),
  projectId: z.uuid(),
  revision: z.number().int().positive(),
};
const uncappedIntent = z.strictObject({
  ...intentScope,
  billingMode: z.literal("openai_api"),
  spendControl: z.literal("uncapped"),
  kind: z.literal("response_and_competitors"),
  reformulationPolicyIdentity: policyIdentitySchema,
  competitorsPolicyIdentity: policyIdentitySchema,
});
const uncappedResponseIntent = z.strictObject({
  ...intentScope,
  billingMode: z.literal("openai_api"),
  spendControl: z.literal("uncapped"),
  kind: z.literal("response_only"),
  reformulationPolicyIdentity: policyIdentitySchema,
});
const intentSchema = z.union([
  uncappedIntent,
  uncappedResponseIntent,
  z.strictObject({
    ...intentScope,
    kind: z.literal("response_and_competitors").optional(),
    billingMode: z.literal("openai_api").optional(),
    reformulationCap: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    competitorsCap: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    ...intentScope,
    kind: z.literal("response_only"),
    billingMode: z.literal("openai_api"),
    reformulationCap: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
]);
export type StrategyIntent = z.infer<typeof intentSchema>;
const intentListSchema = z.array(intentSchema).max(50);
const intentStorageKey = "fluid.strategy-consent.v1";
const inMemoryIntents = new Map<string, StrategyIntent>();
const revokedIntents = new Set<string>();
const intentKey = (ownerId: string, projectId: string, revision: number) => `${ownerId}:${projectId}:${revision}`;
function storedIntents() {
  try {
    const result = intentListSchema.safeParse(JSON.parse(window.sessionStorage.getItem(intentStorageKey) ?? "[]"));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}
/** Usage consent only: never stores prompts, account drafts, credentials, or provider output. */
export function rememberStrategyIntent(intent: StrategyIntent) {
  const valid = intentSchema.parse(intent);
  const key = intentKey(valid.ownerId, valid.projectId, valid.revision);
  revokedIntents.delete(key);
  inMemoryIntents.set(key, valid);
  if (inMemoryIntents.size > 50) inMemoryIntents.delete(inMemoryIntents.keys().next().value!);
  const entries = storedIntents().filter((item) => intentKey(item.ownerId, item.projectId, item.revision) !== key);
  try {
    window.sessionStorage.setItem(intentStorageKey, JSON.stringify([...entries.slice(-49), valid]));
  } catch {
    /* This tab retains consent while mounted. */
  }
}
export function strategyIntentPlan(intent: StrategyIntent): StrategyPromptPlan {
  if ("spendControl" in intent) {
    const reformulation: UncappedAPIAllowance = {
      billingMode: "openai_api",
      spendControl: "uncapped",
      policyIdentity: intent.reformulationPolicyIdentity,
    };
    return intent.kind === "response_only"
      ? { kind: "response_only", billingMode: "openai_api", reformulation }
      : {
          kind: "response_and_competitors",
          billingMode: "openai_api",
          reformulation,
          competitors: {
            billingMode: "openai_api",
            spendControl: "uncapped",
            policyIdentity: intent.competitorsPolicyIdentity,
          },
        };
  }
  if (intent.kind === "response_only")
    return {
      kind: "response_only",
      billingMode: "openai_api",
      reformulation: { billingMode: "openai_api", maximumCostMicrousd: intent.reformulationCap },
    };
  return {
    kind: "response_and_competitors",
    billingMode: "openai_api",
    reformulation: { billingMode: "openai_api", maximumCostMicrousd: intent.reformulationCap },
    competitors: { billingMode: "openai_api", maximumCostMicrousd: intent.competitorsCap },
  };
}
export function rememberStrategyPlan(
  scope: { ownerId: string; projectId: string; revision: number },
  plan: StrategyPromptPlan,
) {
  if (plan.billingMode === "openai_api" && isUncappedStrategyAllowance(plan.reformulation)) {
    if (plan.kind === "response_only")
      rememberStrategyIntent({
        ...scope,
        kind: "response_only",
        billingMode: "openai_api",
        spendControl: "uncapped",
        reformulationPolicyIdentity: plan.reformulation.policyIdentity,
      });
    else if (isUncappedStrategyAllowance(plan.competitors))
      rememberStrategyIntent({
        ...scope,
        kind: "response_and_competitors",
        billingMode: "openai_api",
        spendControl: "uncapped",
        reformulationPolicyIdentity: plan.reformulation.policyIdentity,
        competitorsPolicyIdentity: plan.competitors.policyIdentity,
      });
    return;
  }
  if (plan.kind === "response_only") {
    if ("maximumCostMicrousd" in plan.reformulation)
      rememberStrategyIntent({
        ...scope,
        kind: "response_only",
        billingMode: "openai_api",
        reformulationCap: plan.reformulation.maximumCostMicrousd,
      });
    return;
  }
  if ("maximumCostMicrousd" in plan.reformulation && "maximumCostMicrousd" in plan.competitors)
    rememberStrategyIntent({
      ...scope,
      billingMode: plan.billingMode,
      reformulationCap: plan.reformulation.maximumCostMicrousd,
      competitorsCap: plan.competitors.maximumCostMicrousd,
    });
}
export function readStrategyIntent(ownerId: string, projectId: string, revision: number): StrategyIntent | null {
  const key = intentKey(ownerId, projectId, revision);
  if (revokedIntents.has(key)) return null;
  return (
    inMemoryIntents.get(key) ??
    storedIntents().find(
      (item) => item.ownerId === ownerId && item.projectId === projectId && item.revision === revision,
    ) ??
    null
  );
}
export function forgetStrategyIntent(ownerId: string, projectId: string, revision: number) {
  const key = intentKey(ownerId, projectId, revision);
  revokedIntents.add(key);
  inMemoryIntents.delete(key);
  try {
    window.sessionStorage.setItem(
      intentStorageKey,
      JSON.stringify(storedIntents().filter((item) => intentKey(item.ownerId, item.projectId, item.revision) !== key)),
    );
  } catch {
    /* Removal is still effective for this mounted session. */
  }
}
export function canContinueStrategy(
  intent: StrategyIntent | null,
  workspace: AccountWorkspace | null,
  overview: StrategyOverview,
) {
  if (!intent || !workspace || workspace.conflict || accountDraftChanged(workspace)) return false;
  // Consent remains attached to the user's original message. Only the exact accepted
  // result may advance it once, onto the new version created by that acceptance.
  const revision = intent.revision + 1;
  if (
    workspace.ownerId !== intent.ownerId ||
    workspace.saved.owner_id !== intent.ownerId ||
    workspace.saved.id !== intent.projectId ||
    workspace.saved.current_revision !== revision
  )
    return false;
  if (
    !verifyStrategyJobs(overview.jobs, intent.ownerId, intent.projectId) ||
    overview.availability.status !== "available"
  )
    return false;
  const current = strategyAllowance(
    overview.availability.operations.find((item) => item.operation === "strategy.competitors"),
  );
  const plan = strategyIntentPlan(intent);
  if (plan.kind === "response_only" || !current || !strategyAllowanceWithin(current, plan.competitors)) return false;
  return (
    overview.jobs.some(
      (job) =>
        strategyJobMatchesRequest(job, "strategy.reformulate", intent.revision, plan.reformulation) &&
        job.state === "succeeded" &&
        !job.cancel_requested_at &&
        job.results.some((result) => strategyResultApplication(job, result.stepKey)?.appliedRevision === revision),
    ) && !overview.jobs.some((job) => job.input_revision === revision && job.operation === "strategy.competitors")
  );
}
