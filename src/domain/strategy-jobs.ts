import { z } from "zod";
import { jobStatusSchema, moneySchema } from "./jobs";
import { audienceSegmentSchema, competitorSchema, contextSnapshotSchema, personalitySchema } from "./projects";
import { accountProjectResponseSchema } from "./project-api";

export const STRATEGY_JOB_MUTATION_MAX_BYTES = 2_048;
export const strategyOperationSchema = z.enum(["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality", "strategy.positioning"]);
export type StrategyOperation = z.infer<typeof strategyOperationSchema>;

/** Operator-owned policy, copied into immutable job input. Never browser input. */
export const strategyJobPolicySchema = z.strictObject({
  version: z.literal(1),
  pricingVersion: z.literal("2026-10-03"),
  handlerVersion: z.literal("strategy-openai-v1"),
  model: z.string().min(1).max(150),
  maxInputTokens: z.number().int().positive().max(1_000_000),
  maxOutputTokens: z.number().int().positive().max(100_000),
  maxWebSearchCalls: z.number().int().nonnegative().max(10),
  inputMicrousdPerMillionTokens: moneySchema,
  cachedInputMicrousdPerMillionTokens: moneySchema,
  cacheWriteMicrousdPerMillionTokens: moneySchema,
  outputMicrousdPerMillionTokens: moneySchema,
  webSearchMicrousdPerCall: moneySchema,
  maximumCostMicrousd: moneySchema,
});
export type StrategyJobPolicy = z.infer<typeof strategyJobPolicySchema>;

export const strategyJobInputSchema = z.strictObject({
  version: z.literal(1),
  context: contextSnapshotSchema,
  policy: strategyJobPolicySchema,
  acceptedMaxCostMicrousd: moneySchema,
}).refine(input => input.acceptedMaxCostMicrousd >= input.policy.maximumCostMicrousd, {
  message: "Accepted cost must cover the approved reservation", path: ["acceptedMaxCostMicrousd"],
});
export type StrategyJobInput = z.infer<typeof strategyJobInputSchema>;

/** Application stop/rate limits; these do not claim remaining ChatGPT plan quota. */
export const subscriptionLimitsSchema = z.strictObject({
  maxInputBytes: z.number().int().min(1024).max(1_048_576),
  maxOutputBytes: z.number().int().min(1024).max(1_048_576),
  deadlineMs: z.number().int().min(1000).max(300_000),
  maxObservedWebSearchCalls: z.number().int().min(0).max(10),
  maxRequestsPerHour: z.number().int().min(1).max(100),
  maxQueuedJobs: z.number().int().min(1).max(10),
});
export type SubscriptionLimits = z.infer<typeof subscriptionLimitsSchema>;
export const DEFAULT_SUBSCRIPTION_LIMITS: SubscriptionLimits = {
  maxInputBytes: 131_072, maxOutputBytes: 262_144, deadlineMs: 240_000,
  maxObservedWebSearchCalls: 2, maxRequestsPerHour: 20, maxQueuedJobs: 3,
};
export const chatGPTStrategyPolicySchema = z.strictObject({
  version: z.literal(1), billingMode: z.literal("chatgpt_subscription"), handlerVersion: z.literal("strategy-chatgpt-v1"),
  registrationId: z.string().min(1).max(300), model: z.string().min(1).max(150), limits: subscriptionLimitsSchema,
});
export type ChatGPTStrategyPolicy = z.infer<typeof chatGPTStrategyPolicySchema>;

const enqueueAPIJobSchema = z.strictObject({
  operation: strategyOperationSchema,
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  acceptedMaxCostMicrousd: moneySchema,
  billingMode: z.literal("openai_api").optional(),
});
export const subscriptionPolicyIdentitySchema = z.string().regex(/^[0-9a-f]{64}$/);
export const enqueueSubscriptionJobSchema = z.strictObject({
  operation: strategyOperationSchema, expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/), billingMode: z.literal("chatgpt_subscription"),
  acceptedPolicyIdentity: subscriptionPolicyIdentitySchema,
});
export const enqueueStrategyJobSchema = z.union([enqueueAPIJobSchema, enqueueSubscriptionJobSchema]);
export type EnqueueStrategyJob = z.infer<typeof enqueueStrategyJobSchema>;

export const strategyUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cachedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cacheWriteInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  webSearchCalls: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).refine(usage => usage.cachedInputTokens + usage.cacheWriteInputTokens <= usage.inputTokens, {
  message: "Cached and cache-write tokens must be part of input usage",
});

export const reformulationProposalSchema = z.strictObject({
  message: z.string().trim().min(1).max(6000),
  activity: z.string().trim().max(2000),
  offering: z.string().trim().max(2000),
  knownAudience: z.string().trim().max(2000),
  questions: z.array(z.string().trim().min(1).max(1000)).max(8),
});
export const competitorsProposalSchema = z.strictObject({
  message: z.string().trim().min(1).max(6000),
  competitors: z.array(competitorSchema).max(20),
}).superRefine((proposal, ctx) => {
  const ids = new Set<string>();
  proposal.competitors.forEach((competitor, index) => {
    if (competitor.origin !== "research" || competitor.selected || ids.has(competitor.id)) {
      ctx.addIssue({ code: "custom", path: ["competitors", index], message: "Research proposals must have unique IDs and require user selection" });
    }
    ids.add(competitor.id);
  });
});

export const audienceProposalSchema = z.strictObject({
  message: z.string().trim().min(1).max(6000),
  segments: z.array(audienceSegmentSchema).min(1).max(12),
}).superRefine((proposal, ctx) => {
  const ids = new Set<string>();
  proposal.segments.forEach((segment, index) => {
    if (segment.origin !== "proposal" || segment.selected || segment.sources.length || ids.has(segment.id)) {
      ctx.addIssue({ code: "custom", path: ["segments", index], message: "Audience proposals require unique IDs, user selection and no invented research" });
    }
    ids.add(segment.id);
  });
});
export const personalityProposalSchema = z.strictObject({ message: z.string().trim().min(1).max(6000), personality: personalitySchema });
export const positioningProposalSchema = z.strictObject({ message: z.string().trim().min(1).max(6000), positioning: z.string().trim().min(1).max(5000) });

const resultCommon = {
  version: z.literal(1), provider: z.literal("openai"),
  model: z.string().min(1).max(150),
  responseId: z.string().min(1).max(300),
  requestId: z.string().min(1).max(300).nullable(),
  generatedAt: z.iso.datetime({ offset: true }),
  usage: strategyUsageSchema,
};
/** These values are trusted only after being read from owner-scoped job_steps. */
const apiStrategyJobResultSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...resultCommon, operation: z.literal("strategy.reformulate"), proposal: reformulationProposalSchema }),
  z.strictObject({ ...resultCommon, operation: z.literal("strategy.competitors"), proposal: competitorsProposalSchema }),
  z.strictObject({ ...resultCommon, operation: z.literal("strategy.audience"), proposal: audienceProposalSchema }),
  z.strictObject({ ...resultCommon, operation: z.literal("strategy.personality"), proposal: personalityProposalSchema }),
  z.strictObject({ ...resultCommon, operation: z.literal("strategy.positioning"), proposal: positioningProposalSchema }),
]);
export const subscriptionUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).refine(value => value.inputTokens + value.outputTokens === value.totalTokens, { message: "Token totals must match provider usage" });
const subscriptionResultCommon = {
  version: z.literal(1), provider: z.literal("openai"), billingMode: z.literal("chatgpt_subscription"),
  model: z.string().min(1).max(150), responseId: z.string().min(1).max(300), requestId: z.string().min(1).max(300).nullable(),
  generatedAt: z.iso.datetime({ offset: true }), usage: subscriptionUsageSchema.nullable(),
};
export const chatGPTStrategyResultSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...subscriptionResultCommon, operation: z.literal("strategy.reformulate"), proposal: reformulationProposalSchema }),
  z.strictObject({ ...subscriptionResultCommon, operation: z.literal("strategy.competitors"), proposal: competitorsProposalSchema }),
  z.strictObject({ ...subscriptionResultCommon, operation: z.literal("strategy.audience"), proposal: audienceProposalSchema }),
  z.strictObject({ ...subscriptionResultCommon, operation: z.literal("strategy.personality"), proposal: personalityProposalSchema }),
  z.strictObject({ ...subscriptionResultCommon, operation: z.literal("strategy.positioning"), proposal: positioningProposalSchema }),
]);
export type ChatGPTStrategyResult = z.infer<typeof chatGPTStrategyResultSchema>;
export const strategyJobResultSchema = z.union([apiStrategyJobResultSchema, chatGPTStrategyResultSchema]);
export type StrategyJobResult = z.infer<typeof strategyJobResultSchema>;

export const STRATEGY_ASSISTANT_HISTORY_MAX_ENTRIES = 5;
export const STRATEGY_ASSISTANT_HISTORY_MAX_BYTES = 32_768;
/** Frozen by the owner-scoped enqueue RPC; never accepted from the browser. */
export const strategyAssistantHistorySchema = z.strictObject({
  entries: z.array(z.strictObject({
    jobId: z.uuid(), ownerId: z.uuid(), projectId: z.uuid(), stepKey: z.string().min(1).max(200),
    inputRevision: z.number().int().positive(), completedAt: z.iso.datetime({ offset: true }), output: strategyJobResultSchema,
  })).max(STRATEGY_ASSISTANT_HISTORY_MAX_ENTRIES),
  truncated: z.boolean(),
}).superRefine((history, ctx) => {
  if (new Set(history.entries.map(entry => `${entry.jobId}:${entry.stepKey}`)).size !== history.entries.length) {
    ctx.addIssue({ code: "custom", path: ["entries"], message: "Assistant history sources must be unique" });
  }
  if (history.entries.some((entry, index) => index > 0 && Date.parse(entry.completedAt) > Date.parse(history.entries[index - 1]!.completedAt))) {
    ctx.addIssue({ code: "custom", path: ["entries"], message: "Assistant history must be newest first" });
  }
  if (new TextEncoder().encode(JSON.stringify(history)).byteLength > STRATEGY_ASSISTANT_HISTORY_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: "Assistant history exceeds its byte limit" });
  }
});
export type StrategyAssistantHistory = z.infer<typeof strategyAssistantHistorySchema>;
const subscriptionJobInputFields = { billingMode: z.literal("chatgpt_subscription"), context: contextSnapshotSchema, policy: chatGPTStrategyPolicySchema };
export const chatGPTStrategyJobInputSchema = z.union([
  z.strictObject({ version: z.literal(1), ...subscriptionJobInputFields })
    .transform(input => ({ ...input, assistantHistory: { entries: [], truncated: false } as StrategyAssistantHistory })),
  z.strictObject({ version: z.literal(2), ...subscriptionJobInputFields, assistantHistory: strategyAssistantHistorySchema }),
]);
export type ChatGPTStrategyJobInput = z.infer<typeof chatGPTStrategyJobInputSchema>;

const jobSummaryFields = {
  id: z.uuid(), owner_id: z.uuid(), project_id: z.uuid(),
  operation: strategyOperationSchema,
  input_revision: z.number().int().positive(), state: jobStatusSchema,
  progress: z.number().int().min(0).max(100),
  error_code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).nullable(),
  cancel_requested_at: z.string().nullable(),
  created_at: z.string(), finished_at: z.string().nullable(),
};
const apiJobSummarySchema = z.object({ ...jobSummaryFields, dispatchState: z.enum(["published", "dispatch_pending", "already_processing"]).optional(), billingMode: z.literal("openai_api").optional(), reserved_cost_microusd: moneySchema, actual_cost_microusd: moneySchema });
const subscriptionJobSummarySchema = z.object({ ...jobSummaryFields, billingMode: z.literal("chatgpt_subscription"), policyIdentity: subscriptionPolicyIdentitySchema, partialText: z.string().max(1_048_576).optional() });
export const strategyJobSummarySchema = z.union([apiJobSummarySchema, subscriptionJobSummarySchema]);
/** Server-owned proof of the exact immutable result accepted into a revision. */
export const strategyJobApplicationSchema = z.strictObject({
  jobId: z.uuid(), stepKey: z.string().min(1).max(200),
  inputRevision: z.number().int().positive(), appliedRevision: z.number().int().positive(),
  appliedAt: z.iso.datetime({ offset: true }),
}).refine(value => value.appliedRevision === value.inputRevision + 1, {
  message: "Application must create the next input revision", path: ["appliedRevision"],
});
export type StrategyJobApplication = z.infer<typeof strategyJobApplicationSchema>;
const resultFields = {
  results: z.array(z.strictObject({ stepKey: z.string().min(1).max(200), output: strategyJobResultSchema, application: strategyJobApplicationSchema.optional() })).max(20),
};
export const strategyJobSchema = z.union([apiJobSummarySchema.extend(resultFields), subscriptionJobSummarySchema.extend(resultFields)]).superRefine((job, ctx) => {
  if (job.results.some(result => result.output.operation !== job.operation)) {
    ctx.addIssue({ code: "custom", path: ["results"], message: "Result operation must match the job" });
  }
  if (new Set(job.results.map(result => result.stepKey)).size !== job.results.length) {
    ctx.addIssue({ code: "custom", path: ["results"], message: "Duplicate result step" });
  }
  if (job.results.some(result => ("billingMode" in result.output ? result.output.billingMode : "openai_api") !== (job.billingMode ?? "openai_api"))) {
    ctx.addIssue({ code: "custom", path: ["results"], message: "Result billing mode must match the job" });
  }
  if (job.results.some(result => result.application && (result.application.jobId !== job.id || result.application.stepKey !== result.stepKey || result.application.inputRevision !== job.input_revision))) {
    ctx.addIssue({ code: "custom", path: ["results"], message: "Application must match its job, step and input revision" });
  }
});
export type StrategyJob = z.infer<typeof strategyJobSchema>;
export const strategyJobResponseSchema = z.strictObject({ job: strategyJobSchema });

export const strategyAvailabilitySchema = z.strictObject({
  status: z.enum(["available", "unavailable"]),
  operations: z.array(z.union([
    z.strictObject({ operation: strategyOperationSchema, maximumCostMicrousd: moneySchema, billingMode: z.literal("openai_api").optional() }),
    z.strictObject({ operation: strategyOperationSchema, billingMode: z.literal("chatgpt_subscription"), policyIdentity: subscriptionPolicyIdentitySchema, limits: subscriptionLimitsSchema }),
  ])).max(5),
  reason: z.enum(["runtime_disabled", "worker_unavailable", "budget_unavailable", "subscription_unavailable", "quota_unavailable"]).optional(),
}).refine(value => value.status === "available" ? value.operations.length > 0 && value.reason === undefined : value.operations.length === 0 && value.reason !== undefined, {
  message: "Availability must describe configured, ready and affordable operations",
});
export const strategyOverviewResponseSchema = z.strictObject({
  availability: strategyAvailabilitySchema,
  jobs: z.array(strategyJobSchema).max(20),
});
export type StrategyOverview = z.infer<typeof strategyOverviewResponseSchema>;
export const strategyRuntimeResponseSchema = z.strictObject({ availability: strategyAvailabilitySchema });

export const applyStrategyJobSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  stepKey: z.string().min(1).max(200),
});
export const applyStrategyJobResponseSchema = accountProjectResponseSchema.extend({ application: strategyJobApplicationSchema }).refine(
  value => value.project.current_revision === value.application.appliedRevision,
  { message: "Applied project revision must match its receipt", path: ["application", "appliedRevision"] },
);
