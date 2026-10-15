import { z } from "zod";
import { nameValueSchema } from "./naming";
import { nameIdentityKey } from "./project-naming";
import { chatGPTNamingPolicySchema } from "./naming-jobs";
import { subscriptionPolicyIdentitySchema, subscriptionUsageSchema } from "./strategy-jobs";

export const STANDALONE_NAMES_COUNT = 20;
export const STANDALONE_NAMES_MAX_BYTES = 24_576;
export const STANDALONE_NAMES_MAX_DEPTH = 5;
export const standaloneNamesBriefSchema = z.strictObject({
  description: z.string().trim().min(1).max(3000),
  direction: z.string().trim().max(1000),
  language: z.string().trim().min(1).max(80),
});
export type StandaloneNamesBrief = z.infer<typeof standaloneNamesBriefSchema>;
const indexes = z.array(z.number().int().min(0).max(STANDALONE_NAMES_COUNT - 1)).max(STANDALONE_NAMES_COUNT)
  .refine(value => new Set(value).size === value.length, "Choose each name once");
const refinementSchema = z.strictObject({ sourceJobId: z.uuid(), candidateIndexes: indexes.refine(value => value.length > 0 && value.length <= 5), instruction: z.string().trim().min(1).max(1000) });
export const enqueueStandaloneNamesSchema = z.strictObject({
  brief: standaloneNamesBriefSchema, refinement: refinementSchema.nullable(),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  acceptedPolicyIdentity: subscriptionPolicyIdentitySchema,
  acceptSubscriptionUsage: z.literal(true),
});
export type EnqueueStandaloneNames = z.infer<typeof enqueueStandaloneNamesSchema>;
export const standaloneNameSchema = z.strictObject({ value: nameValueSchema, rationale: z.string().trim().min(1).max(800), caution: z.string().trim().min(1).max(400).nullable() });
export type StandaloneName = z.infer<typeof standaloneNameSchema>;
export const standaloneNamesResultSchema = z.strictObject({
  version: z.literal(1), provider: z.literal("openai"), billingMode: z.literal("chatgpt_subscription"),
  model: z.string().min(1).max(150), responseId: z.string().min(1).max(300), requestId: z.string().min(1).max(300).nullable(),
  generatedAt: z.iso.datetime({ offset: true }), usage: subscriptionUsageSchema.nullable(),
  candidates: z.array(standaloneNameSchema).max(STANDALONE_NAMES_COUNT),
  rejectedCount: z.number().int().min(0).max(STANDALONE_NAMES_COUNT),
}).superRefine((result, ctx) => {
  const keys = result.candidates.map(row => nameIdentityKey(row.value));
  if (keys.some(key => !key) || new Set(keys).size !== keys.length || result.candidates.length + result.rejectedCount > STANDALONE_NAMES_COUNT) {
    ctx.addIssue({ code: "custom", message: "Names must have unique, visible identities and a bounded count" });
  }
});
export type StandaloneNamesResult = z.infer<typeof standaloneNamesResultSchema>;
export const standaloneNamesStateSchema = z.enum(["queued", "running", "cancel_requested", "cancelled", "succeeded", "failed", "needs_reconciliation"]);
export const standaloneNamesJobSchema = z.strictObject({
  id: z.uuid(), ownerId: z.uuid(), brief: standaloneNamesBriefSchema,
  refinement: refinementSchema.extend({ sourceNames: z.array(nameValueSchema).min(1).max(5) }).nullable(),
  depth: z.number().int().min(0).max(STANDALONE_NAMES_MAX_DEPTH),
  state: standaloneNamesStateSchema, errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).nullable(),
  createdAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).nullable(),
  result: standaloneNamesResultSchema.nullable(), likedIndexes: indexes, savedIndexes: indexes,
}).superRefine((job, ctx) => {
  if ((job.state === "succeeded") !== (job.result !== null) ||
      (["queued", "running", "cancel_requested"].includes(job.state) !== (job.finishedAt === null)) ||
      [...job.likedIndexes, ...job.savedIndexes].some(index => !job.result?.candidates[index]) ||
      (job.refinement === null ? job.depth !== 0 : job.depth === 0 || job.refinement.candidateIndexes.length !== job.refinement.sourceNames.length)) {
    ctx.addIssue({ code: "custom", message: "Job result, retained names and refinement must match their immutable job" });
  }
});
export type StandaloneNamesJob = z.infer<typeof standaloneNamesJobSchema>;
export const standaloneNamesAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), billingMode: z.literal("chatgpt_subscription"), policyIdentity: subscriptionPolicyIdentitySchema, model: z.string().min(1).max(150), maxNames: z.literal(STANDALONE_NAMES_COUNT), maxRequestsPerHour: z.number().int().min(1).max(100), deadlineMs: z.number().int().min(1000).max(240000) }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.enum(["local_runtime_required", "setup_required", "worker_unavailable", "quota_unavailable"]) }),
]);
export type StandaloneNamesAvailability = z.infer<typeof standaloneNamesAvailabilitySchema>;
export const standaloneNamesOverviewSchema = z.strictObject({
  ownerId: z.uuid(), availability: standaloneNamesAvailabilitySchema,
  jobs: z.array(standaloneNamesJobSchema).max(50), hasMore: z.boolean(),
}).refine(value => value.jobs.every(job => job.ownerId === value.ownerId) && new Set(value.jobs.map(job => job.id)).size === value.jobs.length, "Owned unique jobs required");
export type StandaloneNamesOverview = z.infer<typeof standaloneNamesOverviewSchema>;
export const standaloneNamesJobResponseSchema = z.strictObject({ job: standaloneNamesJobSchema });
export const standaloneNamesRetentionSchema = z.strictObject({ candidateIndex: z.number().int().min(0).max(STANDALONE_NAMES_COUNT - 1), liked: z.boolean(), saved: z.boolean() });
export const standaloneNamesWorkerInputSchema = z.strictObject({
  job: standaloneNamesJobSchema, leaseToken: z.uuid(), policy: chatGPTNamingPolicySchema,
}).refine(value => value.job.state === "running", "Only a freshly leased job may dispatch");
export type StandaloneNamesWorkerInput = z.infer<typeof standaloneNamesWorkerInputSchema>;
export function standaloneNamesActive(state: StandaloneNamesJob["state"]) { return ["queued", "running", "cancel_requested"].includes(state); }

/** Validate every proposal independently; never fabricate replacements for rejects. */
export function validateStandaloneNames(raw: readonly unknown[], sourceNames: readonly string[] = []) {
  const keys = new Set(sourceNames.map(nameIdentityKey));
  const candidates: StandaloneName[] = [];
  let rejectedCount = 0;
  for (const value of raw.slice(0, STANDALONE_NAMES_COUNT)) {
    const parsed = standaloneNameSchema.safeParse(value);
    const key = parsed.success ? nameIdentityKey(parsed.data.value) : "";
    if (!parsed.success || !key || keys.has(key)) { rejectedCount++; continue; }
    keys.add(key); candidates.push(parsed.data);
  }
  return { candidates, rejectedCount };
}
