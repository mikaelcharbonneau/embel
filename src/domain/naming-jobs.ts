import { z } from "zod";
import { jobStatusSchema } from "./jobs";
import { accountProjectSchema } from "./project-api";
import { contextSnapshotSchema } from "./projects";
import { subscriptionLimitsSchema, subscriptionPolicyIdentitySchema, subscriptionUsageSchema } from "./strategy-jobs";
import {
  acceptedGeneratedNameSchema,
  currentNameSelectionSchema,
  emptyNamingRejectionCounts,
  getNamingReadiness,
  NAMING_MAX_BATCH_SIZE,
  NAMING_MAX_PAGE_SIZE,
  NAMING_MAX_SNAPSHOT_ENTRIES,
  nameIdentityKeySchema,
  namingBatchSchema,
  isNamingBatchTargetCompatible,
  namingCursorSchema,
  namingExclusionSnapshotSchema,
  namingPreferenceRevisionSchema,
  namingReadinessSchema,
  namingRejectionCountsSchema,
  namingSessionSchema,
  namingStrategyBasisSchema,
  namingStrategyKey,
  namingStrategyKeyFromBasis,
  namingTargetCountSchema,
  projectNamePageSchema,
  legacyNamingBatchSchema,
  type NamingRejectionCounts,
  type NamingTargetCount,
} from "./project-naming";

export const NAMING_JOB_MUTATION_MAX_BYTES = 2_048;
export const namingOperationSchema = z.literal("naming.generate");
export type NamingOperation = z.infer<typeof namingOperationSchema>;
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const counterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime({ offset: true });
const ownershipFields = { ownerId: z.uuid(), projectId: z.uuid() };
const sameScope = (left: { ownerId: string; projectId: string }, right: { ownerId: string; projectId: string }) =>
  left.ownerId === right.ownerId && left.projectId === right.projectId;

function freezeSnapshot<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeSnapshot(item);
    Object.freeze(value);
  }
  return value;
}

/** expectedBatchSequence is the current head (zero before the initial intent). */
export const enqueueNamingBatchSchema = z.strictObject({
  expectedProjectRevision: revisionSchema,
  expectedPreferencesVersion: revisionSchema,
  expectedBatchSequence: counterSchema,
  idempotencyKey: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  billingMode: z.literal("chatgpt_subscription"),
  acceptedPolicyIdentity: subscriptionPolicyIdentitySchema,
});
export type EnqueueNamingBatch = z.infer<typeof enqueueNamingBatchSchema>;

export const namingSubscriptionLimitsSchema = subscriptionLimitsSchema.extend({
  maxObservedWebSearchCalls: z.literal(0),
});
/** Operator-owned explicit model selection; absence stays unavailable. */
export const chatGPTNamingPolicySchema = z
  .strictObject({
    version: z.literal(1),
    billingMode: z.literal("chatgpt_subscription"),
    handlerVersion: z.literal("naming-chatgpt-v1"),
    registrationId: z.string().min(1).max(300),
    model: z.string().min(1).max(150),
    limits: namingSubscriptionLimitsSchema,
  })
  .transform(freezeSnapshot);
export type ChatGPTNamingPolicy = z.infer<typeof chatGPTNamingPolicySchema>;

// JSONB persistence need not serialize JS object keys. Only the internal worker
// input may omit this derived display/comparison key; a supplied wrong key fails.
const namingInputBatchSchema = z.preprocess((raw) => {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && !("strategyKey" in raw)) {
    const record = raw as Record<string, unknown>,
      basis = namingStrategyBasisSchema.safeParse(record.strategyBasis);
    if (basis.success) return { ...record, strategyKey: namingStrategyKeyFromBasis(basis.data) };
  }
  return raw;
}, legacyNamingBatchSchema);

/** Server/DB-derived immutable input; none of these snapshots are browser writes. */
export const chatGPTNamingJobInputSchema = z
  .strictObject({
    version: z.literal(1),
    billingMode: z.literal("chatgpt_subscription"),
    context: contextSnapshotSchema,
    policy: chatGPTNamingPolicySchema,
    batch: namingInputBatchSchema,
    exclusionSnapshot: namingExclusionSnapshotSchema,
    exclusionKeys: z
      .array(nameIdentityKeySchema.refine((value) => value.length > 0, "Exclusion identities must be nonempty"))
      .max(NAMING_MAX_SNAPSHOT_ENTRIES),
  })
  .superRefine((input, ctx) => {
    const context = contextSnapshotSchema.safeParse(input.context);
    if (context.success && namingStrategyKey(context.data) !== input.batch.strategyKey)
      ctx.addIssue({
        code: "custom",
        path: ["batch", "strategyBasis"],
        message: "Frozen strategy basis must match the saved context",
      });
    if (new Set(input.exclusionKeys).size !== input.exclusionKeys.length)
      ctx.addIssue({ code: "custom", path: ["exclusionKeys"], message: "Exclusion identities must be unique" });
    const expectedKeys = new Set(input.exclusionSnapshot.map((row) => row.identityKey).filter((key) => key.length > 0));
    if (expectedKeys.size !== input.exclusionKeys.length || input.exclusionKeys.some((key) => !expectedKeys.has(key)))
      ctx.addIssue({
        code: "custom",
        path: ["exclusionKeys"],
        message: "Exclusion identities must match the complete frozen name-value snapshot",
      });
    // The adapter must also bound the final provider request, including instructions.
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > input.policy.limits.maxInputBytes)
      ctx.addIssue({ code: "custom", message: "Frozen naming input exceeds its accepted byte limit" });
  })
  .transform(freezeSnapshot);
export type ChatGPTNamingJobInput = z.infer<typeof chatGPTNamingJobInputSchema>;

export const namingFulfillmentSchema = z
  .strictObject({
    status: z.enum(["pending", "complete", "partial", "none"]),
    targetCount: namingTargetCountSchema,
    acceptedCount: z.number().int().min(0).max(NAMING_MAX_BATCH_SIZE),
    rejections: namingRejectionCountsSchema,
    message: z.string().trim().min(1).max(2000).nullable(),
  })
  .superRefine((value, ctx) => {
    const { over_target: overflow, ...inside } = value.rejections;
    const rejectedInside = Object.values(inside).reduce((sum, count) => sum + count, 0);
    const expected =
      value.acceptedCount === value.targetCount ? "complete" : value.acceptedCount > 0 ? "partial" : "none";
    const pending = value.status === "pending";
    if (
      value.acceptedCount > value.targetCount ||
      value.acceptedCount + rejectedInside > value.targetCount ||
      (pending
        ? value.acceptedCount !== 0 || rejectedInside !== 0 || overflow !== 0 || value.message !== null
        : value.status !== expected || (expected === "complete" ? value.message !== null : value.message === null))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Fulfillment must report the actual accepted count and explain a finished shortfall",
      });
    }
  })
  .transform(freezeSnapshot);
export type NamingFulfillment = z.infer<typeof namingFulfillmentSchema>;

export function getNamingFulfillment(
  targetCount: NamingTargetCount,
  acceptedCount: number,
  rejections: NamingRejectionCounts,
): NamingFulfillment {
  return namingFulfillmentSchema.parse({
    status: acceptedCount === targetCount ? "complete" : acceptedCount > 0 ? "partial" : "none",
    targetCount,
    acceptedCount,
    rejections,
    message:
      acceptedCount === targetCount
        ? null
        : `${acceptedCount} of ${targetCount} requested names passed validation and project-history checks. No names were added to fill the shortfall.`,
  });
}
export function pendingNamingFulfillment(targetCount: NamingTargetCount): NamingFulfillment {
  return namingFulfillmentSchema.parse({
    status: "pending",
    targetCount,
    acceptedCount: 0,
    rejections: emptyNamingRejectionCounts(),
    message: null,
  });
}

/** Trusted only after the worker completion boundary persists this exact step. */
export const namingJobResultSchema = z
  .strictObject({
    version: z.literal(1),
    operation: namingOperationSchema,
    provider: z.literal("openai"),
    billingMode: z.literal("chatgpt_subscription"),
    model: z.string().min(1).max(150),
    responseId: z.string().min(1).max(300),
    requestId: z.string().min(1).max(300).nullable(),
    generatedAt: timestampSchema,
    usage: subscriptionUsageSchema.nullable(),
    batchId: z.uuid(),
    sequence: revisionSchema,
    targetCount: namingTargetCountSchema,
    accepted: z.array(acceptedGeneratedNameSchema).max(NAMING_MAX_BATCH_SIZE),
    fulfillment: namingFulfillmentSchema,
  })
  .superRefine((result, ctx) => {
    if (!isNamingBatchTargetCompatible(result.sequence, result.targetCount))
      ctx.addIssue({ code: "custom", path: ["targetCount"], message: "Result target must match its batch sequence" });
    if (
      result.fulfillment.status === "pending" ||
      result.fulfillment.targetCount !== result.targetCount ||
      result.fulfillment.acceptedCount !== result.accepted.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["fulfillment"],
        message: "Completed result must count exactly its accepted names",
      });
    if (new Set(result.accepted.map((row) => row.identityKey)).size !== result.accepted.length)
      ctx.addIssue({
        code: "custom",
        path: ["accepted"],
        message: "Completed generated names must have unique identities",
      });
  })
  .transform(freezeSnapshot);
export type NamingJobResult = z.infer<typeof namingJobResultSchema>;
export const chatGPTNamingResultSchema = namingJobResultSchema;
export type ChatGPTNamingResult = NamingJobResult;

export const namingBatchResultSchema = z
  .strictObject({
    ...ownershipFields,
    batchId: z.uuid(),
    jobId: z.uuid(),
    stepKey: z.string().min(1).max(200),
    candidateIds: z.array(z.uuid()).max(NAMING_MAX_BATCH_SIZE),
    fulfillment: namingFulfillmentSchema,
    completedAt: timestampSchema,
  })
  .refine(
    (value) =>
      value.fulfillment.status !== "pending" &&
      value.candidateIds.length === value.fulfillment.acceptedCount &&
      new Set(value.candidateIds).size === value.candidateIds.length,
    { message: "Published result must count its unique immutable candidates" },
  )
  .transform(freezeSnapshot);
export type NamingBatchResult = z.infer<typeof namingBatchResultSchema>;
// Read-only shape of batches published by the retired version 2 Naming engine,
// which saved projects can still list.
const visibleTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (value) =>
      !/[\p{Cc}\p{Bidi_Control}]/u.test(value) &&
      /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Mark}\u2800]/u.test(value),
    "Text must be visible and contain no controls",
  );
const namingBrainFulfillmentSchema = z
  .strictObject({
    status: z.enum(["complete", "partial", "none"]),
    targetCount: z.literal(100),
    acceptedCount: z.number().int().min(0).max(100),
    missingCount: z.number().int().min(0).max(100),
    coverageSatisfied: z.boolean(),
    message: visibleTextSchema.nullable(),
  })
  .refine(
    (value) =>
      (value.status === "complete" ? value.message === null : value.message !== null) &&
      value.missingCount === 100 - value.acceptedCount &&
      value.status ===
        (value.acceptedCount === 0
          ? "none"
          : value.acceptedCount === 100 && value.coverageSatisfied
            ? "complete"
            : "partial"),
    "Fulfillment reports both actual count and genuine primary coverage",
  );
const preparedNamingBrainBatchResultSchema = z
  .strictObject({
    version: z.literal(2),
    ...ownershipFields,
    batchId: z.uuid(),
    jobId: z.uuid(),
    runId: z.uuid(),
    preparedSetId: z.uuid(),
    stepKey: z.literal("prepare"),
    candidateIds: z.array(z.uuid()).max(100),
    fulfillment: namingBrainFulfillmentSchema,
    completedAt: timestampSchema,
  })
  .refine(
    (value) =>
      value.candidateIds.length === value.fulfillment.acceptedCount &&
      new Set(value.candidateIds).size === value.candidateIds.length,
    "Managed publication counts the exact unique prepared membership",
  )
  .transform(freezeSnapshot);
export const namingBrainBatchResultSchema = z.union([
  preparedNamingBrainBatchResultSchema,
  z
    .strictObject({
      version: z.literal(2),
      localPipelineVersion: z.literal(2),
      ...ownershipFields,
      batchId: z.uuid(),
      jobId: z.uuid(),
      runId: z.uuid(),
      completionId: z.uuid(),
      stepKey: z.literal("prepare"),
      candidateIds: z
        .array(z.uuid())
        .length(100)
        .refine((rows) => new Set(rows).size === rows.length),
      fulfillment: namingBrainFulfillmentSchema,
      completedAt: timestampSchema,
    })
    .refine(
      (value) =>
        value.fulfillment.status === "complete" &&
        value.fulfillment.acceptedCount === 100 &&
        value.fulfillment.coverageSatisfied,
    )
    .transform(freezeSnapshot),
]);
export type NamingBrainBatchResult = z.infer<typeof namingBrainBatchResultSchema>;
export const namingAnyBatchResultSchema = z.union([namingBatchResultSchema, namingBrainBatchResultSchema]);

export const namingBatchEntrySchema = z
  .strictObject({ batch: namingBatchSchema, result: namingAnyBatchResultSchema.nullable() })
  .refine(
    (value) =>
      value.result === null ||
      (sameScope(value.batch, value.result) &&
        value.result.batchId === value.batch.id &&
        value.result.jobId === value.batch.jobId &&
        value.result.fulfillment.targetCount === value.batch.targetCount &&
        ("version" in value.batch
          ? "version" in value.result && value.result.runId === value.batch.runId
          : !("version" in value.result))),
    { message: "Published result must match its owned batch and job" },
  );
export type NamingBatchEntry = z.infer<typeof namingBatchEntrySchema>;
export const namingBatchPageSchema = z
  .strictObject({
    ...ownershipFields,
    items: z.array(namingBatchEntrySchema).max(NAMING_MAX_PAGE_SIZE),
    nextCursor: namingCursorSchema.nullable(),
  })
  .superRefine((page, ctx) => {
    if (
      page.items.some((row) => !sameScope(page, row.batch)) ||
      new Set(page.items.map((row) => row.batch.id)).size !== page.items.length ||
      new Set(page.items.map((row) => row.batch.sequence)).size !== page.items.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Batch rows and sequences must be unique and belong to this owner and project",
      });
    const last = page.items.at(-1)?.batch;
    if (page.nextCursor && (!last || last.id !== page.nextCursor.id || last.createdAt !== page.nextCursor.createdAt))
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "Continuation cursor must anchor the final returned batch",
      });
  });
export type NamingBatchPage = z.infer<typeof namingBatchPageSchema>;

const namingJobFields = {
  id: z.uuid(),
  owner_id: z.uuid(),
  project_id: z.uuid(),
  operation: namingOperationSchema,
  input_revision: revisionSchema,
  state: jobStatusSchema,
  progress: z.number().int().min(0).max(100),
  error_code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,79}$/)
    .nullable(),
  cancel_requested_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  finished_at: timestampSchema.nullable(),
  billingMode: z.literal("chatgpt_subscription"),
  policyIdentity: subscriptionPolicyIdentitySchema,
  batchId: z.uuid(),
  sequence: revisionSchema,
  targetCount: namingTargetCountSchema,
};
export const namingJobSummarySchema = z
  .strictObject(namingJobFields)
  .refine((value) => isNamingBatchTargetCompatible(value.sequence, value.targetCount), {
    message: "Job target must match its batch sequence",
  });
export type NamingJobSummary = z.infer<typeof namingJobSummarySchema>;
export const namingJobSchema = z
  .strictObject({
    ...namingJobFields,
    // Retained recovery material only. Incomplete streamed JSON is never a candidate list.
    partialText: z.string().max(1_048_576).optional(),
    results: z.array(z.strictObject({ stepKey: z.string().min(1).max(200), output: namingJobResultSchema })).max(1),
  })
  .superRefine((job, ctx) => {
    if (!isNamingBatchTargetCompatible(job.sequence, job.targetCount))
      ctx.addIssue({ code: "custom", path: ["targetCount"], message: "Job target must match its batch sequence" });
    if (job.state === "succeeded" && job.results.length !== 1)
      ctx.addIssue({
        code: "custom",
        path: ["results"],
        message: "Succeeded transport requires its persisted completed result",
      });
    if (
      job.results.some(
        ({ output }) =>
          output.batchId !== job.batchId || output.sequence !== job.sequence || output.targetCount !== job.targetCount,
      )
    )
      ctx.addIssue({ code: "custom", path: ["results"], message: "Result must bind the job's immutable batch" });
  });
export type NamingJob = z.infer<typeof namingJobSchema>;
export const namingJobResponseSchema = z.strictObject({ job: namingJobSchema });
export const enqueueNamingBatchResponseSchema = z
  .strictObject({ batch: legacyNamingBatchSchema, job: namingJobSchema, session: namingSessionSchema })
  .superRefine((value, ctx) => {
    if (
      !sameScope(value.batch, value.session) ||
      value.batch.ownerId !== value.job.owner_id ||
      value.batch.projectId !== value.job.project_id ||
      value.batch.jobId !== value.job.id ||
      value.batch.id !== value.job.batchId ||
      value.batch.contextRevision !== value.job.input_revision ||
      value.batch.sequence !== value.job.sequence ||
      value.batch.targetCount !== value.job.targetCount ||
      value.batch.acceptedPolicyIdentity !== value.job.policyIdentity ||
      value.session.latestBatchSequence < value.batch.sequence
    )
      ctx.addIssue({ code: "custom", message: "Enqueue response must bind one owned batch, job and session" });
  });
export type EnqueueNamingBatchResponse = z.infer<typeof enqueueNamingBatchResponseSchema>;
export const namingBatchDetailResponseSchema = z
  .strictObject({ batch: legacyNamingBatchSchema, job: namingJobSchema, result: namingBatchResultSchema.nullable() })
  .superRefine((value, ctx) => {
    const { batch, job, result } = value;
    if (
      batch.ownerId !== job.owner_id ||
      batch.projectId !== job.project_id ||
      batch.id !== job.batchId ||
      batch.jobId !== job.id ||
      batch.contextRevision !== job.input_revision ||
      batch.sequence !== job.sequence ||
      batch.targetCount !== job.targetCount ||
      batch.acceptedPolicyIdentity !== job.policyIdentity
    )
      ctx.addIssue({ code: "custom", message: "Batch detail must bind the owned job and frozen admission" });
    const output = job.results[0];
    if (
      result
        ? !sameScope(batch, result) ||
          result.batchId !== batch.id ||
          result.jobId !== job.id ||
          !output ||
          result.stepKey !== output.stepKey ||
          JSON.stringify(result.fulfillment) !== JSON.stringify(output.output.fulfillment)
        : output !== undefined
    )
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "Publication must match the job's exact completed step and fulfillment",
      });
  });
export type NamingBatchDetailResponse = z.infer<typeof namingBatchDetailResponseSchema>;

export const namingAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    operation: namingOperationSchema,
    billingMode: z.literal("chatgpt_subscription"),
    policyIdentity: subscriptionPolicyIdentitySchema,
    limits: namingSubscriptionLimitsSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    operation: namingOperationSchema,
    reason: z.enum([
      "runtime_disabled",
      "naming_policy_unavailable",
      "worker_unavailable",
      "subscription_unavailable",
      "quota_unavailable",
      "scope_unavailable",
      "strategy_incomplete",
    ]),
  }),
]);
export type NamingAvailability = z.infer<typeof namingAvailabilitySchema>;
export const namingRuntimeResponseSchema = z.strictObject({ availability: namingAvailabilitySchema });

const unavailableScreeningSchema = z.strictObject({
  status: z.literal("not_checked"),
  reason: z.literal("integration_unavailable"),
});
export const namingScreeningSchema = z.strictObject({
  domains: unavailableScreeningSchema,
  handles: unavailableScreeningSchema,
  trademarks: unavailableScreeningSchema,
});
export type NamingScreening = z.infer<typeof namingScreeningSchema>;

export const projectNamingOverviewSchema = z
  .strictObject({
    project: accountProjectSchema.strict(),
    readiness: namingReadinessSchema,
    session: namingSessionSchema.nullable(),
    preferences: namingPreferenceRevisionSchema.nullable(),
    currentSelection: currentNameSelectionSchema.nullable(),
    batches: namingBatchPageSchema,
    candidates: projectNamePageSchema,
    availability: namingAvailabilitySchema,
    jobs: z.array(namingJobSchema).max(20),
    screening: namingScreeningSchema,
  })
  .superRefine((overview, ctx) => {
    const { project, session, preferences, currentSelection } = overview;
    const scope = { ownerId: project.owner_id, projectId: project.id };
    const expectedReadiness = getNamingReadiness(project.context, project.scope);
    if (JSON.stringify(overview.readiness) !== JSON.stringify(expectedReadiness))
      ctx.addIssue({
        code: "custom",
        path: ["readiness"],
        message: "Readiness must describe this saved project and scope",
      });
    if (
      ![
        overview.batches,
        overview.candidates,
        ...(session ? [session] : []),
        ...(preferences ? [preferences] : []),
        ...(currentSelection ? [currentSelection.selection] : []),
      ].every((row) => sameScope(scope, row)) ||
      overview.jobs.some((job) => job.owner_id !== scope.ownerId || job.project_id !== scope.projectId)
    )
      ctx.addIssue({ code: "custom", message: "Every overview row must belong to this project and owner" });
    if (new Set(overview.jobs.map((job) => job.id)).size !== overview.jobs.length)
      ctx.addIssue({ code: "custom", path: ["jobs"], message: "Overview jobs must be unique" });
    if (!session) {
      if (
        preferences ||
        currentSelection ||
        overview.batches.items.length ||
        overview.candidates.items.length ||
        overview.jobs.length
      )
        ctx.addIssue({ code: "custom", path: ["session"], message: "Persisted naming records require a session" });
    } else {
      if (
        (preferences?.version ?? 0) !== session.currentPreferencesVersion ||
        (currentSelection?.selection.id ?? null) !== session.currentSelectionId
      )
        ctx.addIssue({
          code: "custom",
          path: ["session"],
          message: "Session pointers must match current preferences and selection",
        });
      if (
        (session.currentPreferencesVersion === 0 &&
          (session.latestBatchSequence !== 0 || overview.batches.items.length || overview.jobs.length)) ||
        overview.batches.items.some((row) => row.batch.sequence > session.latestBatchSequence) ||
        overview.jobs.some((job) => job.sequence > session.latestBatchSequence)
      )
        ctx.addIssue({
          code: "custom",
          path: ["session"],
          message: "Generation requires an explicitly saved preference version and admitted sequence",
        });
    }
    if (
      currentSelection &&
      (project.context.selectedName !== currentSelection.candidate.value ||
        project.context.intake.suppliedName !== currentSelection.candidate.value ||
        currentSelection.selection.projectRevision > project.current_revision)
    )
      ctx.addIssue({
        code: "custom",
        path: ["currentSelection"],
        message: "Current selected name must match both project fields and a saved revision",
      });
    if (overview.availability.status === "available" && !overview.readiness.ready)
      ctx.addIssue({
        code: "custom",
        path: ["availability"],
        message: "Generation cannot be available before project readiness",
      });
    for (const job of overview.jobs) {
      const batch = overview.batches.items.find((row) => row.batch.id === job.batchId)?.batch;
      if (
        batch &&
        (batch.jobId !== job.id ||
          batch.contextRevision !== job.input_revision ||
          batch.acceptedPolicyIdentity !== job.policyIdentity ||
          batch.sequence !== job.sequence ||
          batch.targetCount !== job.targetCount)
      )
        ctx.addIssue({
          code: "custom",
          path: ["jobs"],
          message: "Loaded jobs must match their loaded immutable batches",
        });
    }
  });
export type ProjectNamingOverview = z.infer<typeof projectNamingOverviewSchema>;
export const projectNamingOverviewResponseSchema = projectNamingOverviewSchema;
