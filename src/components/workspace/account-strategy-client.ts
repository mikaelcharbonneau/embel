import { z } from "zod";
import { subscriptionLimitsSchema, subscriptionPolicyIdentitySchema, type EnqueueStrategyJob, type StrategyJob, type StrategyJobApplication, type StrategyOperation, type StrategyOverview, type SubscriptionLimits } from "@/domain/strategy-jobs";
import { accountDraftChanged, type AccountWorkspace } from "./account-draft-memory";
import { AccountRequestError } from "./account-api";

export const strategyLabels: Record<StrategyOperation, string> = {
  "strategy.reformulate": "Response", "strategy.competitors": "Competitor research", "strategy.audience": "Audience proposal",
  "strategy.personality": "Personality proposal", "strategy.positioning": "Positioning proposal",
};
export function formatStrategyCap(microusd: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.ceil(microusd / 10_000) / 100);
}
export type StrategyBillingMode = "openai_api" | "chatgpt_subscription";
type APIAllowance = { billingMode: "openai_api"; maximumCostMicrousd: number };
type SubscriptionAllowance = { billingMode: "chatgpt_subscription"; limits: SubscriptionLimits; policyIdentity: string };
export type StrategyAllowance = APIAllowance | SubscriptionAllowance;
export type StrategyPromptPlan =
  | { kind: "response_only"; billingMode: "openai_api"; reformulation: APIAllowance }
  | { kind: "response_and_competitors"; billingMode: "openai_api"; reformulation: APIAllowance; competitors: APIAllowance }
  | { kind: "response_and_competitors"; billingMode: "chatgpt_subscription"; reformulation: SubscriptionAllowance; competitors: SubscriptionAllowance };
export function strategyIdempotencyKey(projectId: string, revision: number, operation: StrategyOperation, billingMode: StrategyBillingMode = "openai_api") {
  const prefix = billingMode === "chatgpt_subscription" ? "strategy.chatgpt.v1" : "strategy.v1";
  return `${prefix}:${projectId}:${revision}:${operation}`;
}
export function strategyAllowance(operation: StrategyOverview["availability"]["operations"][number] | undefined): StrategyAllowance | null {
  if (!operation) return null;
  return operation.billingMode === "chatgpt_subscription" ? { billingMode: operation.billingMode, limits: operation.limits, policyIdentity: operation.policyIdentity } : { billingMode: "openai_api", maximumCostMicrousd: operation.maximumCostMicrousd };
}
export function promptStrategyPlan(availability: StrategyOverview["availability"] | null): StrategyPromptPlan | null {
  if (availability?.status !== "available") return null;
  const reformulation = strategyAllowance(availability.operations.find(item => item.operation === "strategy.reformulate"));
  const competitors = strategyAllowance(availability.operations.find(item => item.operation === "strategy.competitors"));
  if (reformulation?.billingMode === "chatgpt_subscription" && competitors?.billingMode === "chatgpt_subscription") return { kind: "response_and_competitors", billingMode: "chatgpt_subscription", reformulation, competitors };
  if (reformulation?.billingMode === "openai_api" && competitors?.billingMode === "openai_api") return { kind: "response_and_competitors", billingMode: "openai_api", reformulation, competitors };
  if (reformulation?.billingMode === "openai_api" && !competitors) return { kind: "response_only", billingMode: "openai_api", reformulation };
  return null;
}
/** Only public readiness reasons are shown; project notices do not infer request history. */
export function strategyAvailabilityMessage(availability: StrategyOverview["availability"] | null, context: "prompt" | "project" = "prompt") {
  if (!availability) return context === "project"
    ? "AI availability could not be confirmed. Check existing request status before trying again. You can still edit and save your project."
    : "AI availability could not be confirmed. Recheck before sending. Your prompt is kept.";
  if (availability.status === "available") return context === "project"
    ? "AI replies are not enabled for this step. You can still edit and save your project."
    : "The response and competitor research operations are not both ready. Your prompt is kept.";
  const reasons: Record<NonNullable<StrategyOverview["availability"]["reason"]>, string> = {
    worker_unavailable: context === "project" ? "AI replies are unavailable right now." : "The AI worker is not ready. Recheck after it is connected.",
    runtime_disabled: "AI is not enabled in this workspace.",
    budget_unavailable: "No AI requests are available for this account.",
    subscription_unavailable: "The ChatGPT connection is unavailable.",
    quota_unavailable: "The current AI request limit is unavailable. Recheck when capacity is available.",
  };
  return context === "project"
    ? `${reasons[availability.reason!]} You can still edit and save your project.`
    : `${reasons[availability.reason!]} No AI request was sent. Your prompt is kept.`;
}
export function strategyRequestPayload(projectId: string, revision: number, operation: StrategyOperation, allowance: StrategyAllowance): EnqueueStrategyJob {
  const common = { operation, expectedRevision: revision, idempotencyKey: strategyIdempotencyKey(projectId, revision, operation, allowance.billingMode) };
  return allowance.billingMode === "chatgpt_subscription" ? { ...common, billingMode: "chatgpt_subscription", acceptedPolicyIdentity: allowance.policyIdentity } : { ...common, acceptedMaxCostMicrousd: allowance.maximumCostMicrousd };
}
export function strategyAllowanceLabel(allowance: StrategyAllowance) {
  return allowance.billingMode === "chatgpt_subscription"
    ? `ChatGPT plan limits apply. Embel allows up to ${allowance.limits.maxRequestsPerHour} requests per hour and ${allowance.limits.maxQueuedJobs} queued requests.`
    : `OpenAI · up to ${formatStrategyCap(allowance.maximumCostMicrousd)}`;
}
export function strategyAllowanceWithin(current: StrategyAllowance, accepted: StrategyAllowance) {
  if (current.billingMode === "openai_api" && accepted.billingMode === "openai_api") return current.maximumCostMicrousd <= accepted.maximumCostMicrousd;
  if (current.billingMode !== "chatgpt_subscription" || accepted.billingMode !== "chatgpt_subscription" || current.policyIdentity !== accepted.policyIdentity) return false;
  return (Object.keys(current.limits) as (keyof SubscriptionLimits)[]).every(key => current.limits[key] <= accepted.limits[key]);
}
export function verifyStrategyJobs(jobs: StrategyJob[], ownerId: string, projectId: string) {
  return jobs.every(job => job.owner_id === ownerId && job.project_id === projectId);
}
export function strategyJobMatchesRequest(job: StrategyJob, operation: StrategyOperation, revision: number, accepted: StrategyAllowance | number) {
  const allowance = typeof accepted === "number" ? { billingMode: "openai_api" as const, maximumCostMicrousd: accepted } : accepted;
  if (job.operation !== operation || job.input_revision !== revision || (job.billingMode ?? "openai_api") !== allowance.billingMode) return false;
  return allowance.billingMode === "chatgpt_subscription"
    ? job.billingMode === "chatgpt_subscription" && job.policyIdentity === allowance.policyIdentity
    : job.billingMode !== "chatgpt_subscription" && job.reserved_cost_microusd <= allowance.maximumCostMicrousd;
}
export function strategyJobActive(job: StrategyJob) {
  return ["queued", "running", "partial", "cancel_requested"].includes(job.state);
}
export function strategyApplicationMatchesResult(job: StrategyJob, stepKey: string, application: StrategyJobApplication) {
  return application.jobId === job.id && application.stepKey === stepKey && application.inputRevision === job.input_revision
    && application.appliedRevision === job.input_revision + 1 && job.results.some(result => result.stepKey === stepKey);
}
export function strategyResultApplication(job: StrategyJob, stepKey: string) {
  const application = job.results.find(result => result.stepKey === stepKey)?.application;
  return application && strategyApplicationMatchesResult(job, stepKey, application) ? application : null;
}
export function strategyErrorMessage(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "The saved version or request changed. Your edits are still here. Load the latest version before requesting a new proposal.";
    if (error.status === 503) return "OpenAI is unavailable right now. Your draft is kept here; no new job was confirmed. You can continue editing.";
    if (error.status === 422) return "This request could not be accepted. Review the current request limits and your project details.";
    if (error.status === 429) return "The current request limit was reached. Your draft is kept here. Try again when capacity is available.";
    if (error.status === 404) return "This strategy result is not available to your account.";
    if (error.status === 502) return "The strategy response could not be verified. No result was added to your brief.";
  }
  return "The strategy request could not be confirmed. Check its status before trying again; your edits are still here.";
}

const intentScope = {
  ownerId: z.uuid(), projectId: z.uuid(), revision: z.number().int().positive(),
};
const intentSchema = z.union([z.strictObject({
  ...intentScope, kind: z.literal("response_and_competitors").optional(), billingMode: z.literal("openai_api").optional(),
  reformulationCap: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  competitorsCap: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}), z.strictObject({
  ...intentScope, kind: z.literal("response_only"), billingMode: z.literal("openai_api"),
  reformulationCap: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}), z.strictObject({ ...intentScope, kind: z.literal("response_and_competitors").optional(), billingMode: z.literal("chatgpt_subscription"), reformulationLimits: subscriptionLimitsSchema, competitorsLimits: subscriptionLimitsSchema, reformulationPolicyIdentity: subscriptionPolicyIdentitySchema, competitorsPolicyIdentity: subscriptionPolicyIdentitySchema })]);
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
  } catch { return []; }
}
/** Usage consent only: never stores prompts, account drafts, credentials, or provider output. */
export function rememberStrategyIntent(intent: StrategyIntent) {
  const valid = intentSchema.parse(intent);
  const key = intentKey(valid.ownerId, valid.projectId, valid.revision);
  revokedIntents.delete(key);
  inMemoryIntents.set(key, valid);
  if (inMemoryIntents.size > 50) inMemoryIntents.delete(inMemoryIntents.keys().next().value!);
  const entries = storedIntents().filter(item => intentKey(item.ownerId, item.projectId, item.revision) !== key);
  try { window.sessionStorage.setItem(intentStorageKey, JSON.stringify([...entries.slice(-49), valid])); } catch { /* This tab retains consent while mounted. */ }
}
export function strategyIntentPlan(intent: StrategyIntent): StrategyPromptPlan {
  if (intent.kind === "response_only") return { kind: "response_only", billingMode: "openai_api", reformulation: { billingMode: "openai_api", maximumCostMicrousd: intent.reformulationCap } };
  return intent.billingMode === "chatgpt_subscription"
    ? { kind: "response_and_competitors", billingMode: "chatgpt_subscription", reformulation: { billingMode: "chatgpt_subscription", limits: intent.reformulationLimits, policyIdentity: intent.reformulationPolicyIdentity }, competitors: { billingMode: "chatgpt_subscription", limits: intent.competitorsLimits, policyIdentity: intent.competitorsPolicyIdentity } }
    : { kind: "response_and_competitors", billingMode: "openai_api", reformulation: { billingMode: "openai_api", maximumCostMicrousd: intent.reformulationCap }, competitors: { billingMode: "openai_api", maximumCostMicrousd: intent.competitorsCap } };
}
export function rememberStrategyPlan(scope: { ownerId: string; projectId: string; revision: number }, plan: StrategyPromptPlan) {
  if (plan.kind === "response_only") {
    rememberStrategyIntent({ ...scope, kind: "response_only", billingMode: "openai_api", reformulationCap: plan.reformulation.maximumCostMicrousd });
    return;
  }
  rememberStrategyIntent(plan.billingMode === "chatgpt_subscription"
    ? { ...scope, billingMode: plan.billingMode, reformulationLimits: plan.reformulation.limits, competitorsLimits: plan.competitors.limits, reformulationPolicyIdentity: plan.reformulation.policyIdentity, competitorsPolicyIdentity: plan.competitors.policyIdentity }
    : { ...scope, billingMode: plan.billingMode, reformulationCap: plan.reformulation.maximumCostMicrousd, competitorsCap: plan.competitors.maximumCostMicrousd });
}
export function readStrategyIntent(ownerId: string, projectId: string, revision: number): StrategyIntent | null {
  const key = intentKey(ownerId, projectId, revision);
  if (revokedIntents.has(key)) return null;
  return inMemoryIntents.get(key) ?? storedIntents().find(item => item.ownerId === ownerId && item.projectId === projectId && item.revision === revision) ?? null;
}
export function forgetStrategyIntent(ownerId: string, projectId: string, revision: number) {
  const key = intentKey(ownerId, projectId, revision);
  revokedIntents.add(key);
  inMemoryIntents.delete(key);
  try { window.sessionStorage.setItem(intentStorageKey, JSON.stringify(storedIntents().filter(item => intentKey(item.ownerId, item.projectId, item.revision) !== key))); } catch { /* Removal is still effective for this mounted session. */ }
}
export function canContinueStrategy(intent: StrategyIntent | null, workspace: AccountWorkspace | null, overview: StrategyOverview) {
  if (!intent || !workspace || workspace.conflict || accountDraftChanged(workspace)) return false;
  // Consent remains attached to the user's original message. Only the exact accepted
  // result may advance it once, onto the new version created by that acceptance.
  const revision = intent.revision + 1;
  if (workspace.ownerId !== intent.ownerId || workspace.saved.owner_id !== intent.ownerId || workspace.saved.id !== intent.projectId || workspace.saved.current_revision !== revision) return false;
  if (!verifyStrategyJobs(overview.jobs, intent.ownerId, intent.projectId) || overview.availability.status !== "available") return false;
  const current = strategyAllowance(overview.availability.operations.find(item => item.operation === "strategy.competitors"));
  const plan = strategyIntentPlan(intent);
  if (plan.kind === "response_only" || !current || !strategyAllowanceWithin(current, plan.competitors)) return false;
  if (plan.billingMode === "chatgpt_subscription") {
    const currentResponse = strategyAllowance(overview.availability.operations.find(item => item.operation === "strategy.reformulate"));
    if (!currentResponse || !strategyAllowanceWithin(currentResponse, plan.reformulation)) return false;
  }
  return overview.jobs.some(job => strategyJobMatchesRequest(job, "strategy.reformulate", intent.revision, plan.reformulation)
    && job.state === "succeeded" && !job.cancel_requested_at
    && job.results.some(result => strategyResultApplication(job, result.stepKey)?.appliedRevision === revision))
    && !overview.jobs.some(job => job.input_revision === revision && job.operation === "strategy.competitors");
}
