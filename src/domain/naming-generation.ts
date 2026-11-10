import { z } from "zod";
import { nameValueSchema } from "./naming";
import { namingApproachSchema, namingPreferencesV2Schema } from "./naming-brain-preferences";
import { namingStrategyBasisSchema, projectNameEntrySchema } from "./project-naming";

/**
 * Shared contract for Naming generation (November 2026 rebuild). One run is one
 * `naming.generate` job: up to three OpenAI rounds that together save at most
 * 100 cleaned names. The database stores clean names only; it never re-reads a
 * raw provider reply. See docs/naming-generation-contract.md.
 */
export const NAMING_RUN_TARGET = 100;
export const NAMING_MAX_ROUNDS = 3;
export const NAMING_LEASE_SECONDS = 120;
export const NAMING_HEARTBEAT_MS = 20_000;
export const NAMING_ROUND_TIMEOUT_MS = 180_000;
export const NAMING_RUN_DEADLINE_MS = 600_000;
export const NAMING_GENERATION_CAUTION = "Unchecked brainstorm. Research and screening are needed before use.";

const timestamp = z.iso.datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u);
const count = (max: number) => z.number().int().min(0).max(max);
const revision = z.number().int().positive();
const requestKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/u);

export const namingResponseIdSchema = z.string().regex(/^resp_[A-Za-z0-9_-]{1,194}$/u);
export const namingRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);

export const namingRunKindSchema = z.enum(["initial", "more", "steer"]);
export type NamingRunKind = z.infer<typeof namingRunKindSchema>;

/** The slot's approved policy for `naming.generate`. */
export const namingGenerationPolicySchema = z.strictObject({
  version: z.literal(2), operation: z.literal("naming.generate"),
  model: z.string().trim().min(1).max(150), reasoningEffort: z.enum(["low", "medium"]),
});
export type NamingGenerationPolicy = z.infer<typeof namingGenerationPolicySchema>;

/** Everything a run is asked, frozen by SQL when the run starts. */
export const namingBriefSchema = z.strictObject({
  version: z.literal(1),
  contextRevision: revision,
  preferencesVersion: revision,
  preferences: namingPreferencesV2Schema,
  strategyBasis: namingStrategyBasisSchema,
  likedExamples: z.array(z.strictObject({ value: z.string().min(1).max(160) })).max(20),
  strongSeeds: z.array(z.strictObject({ value: z.string().min(1).max(160), rationale: z.string().max(2000) })).max(5),
  recentExamples: z.array(z.strictObject({ value: z.string().min(1).max(160) })).max(50),
  steeringInstruction: z.string().trim().min(1).max(2000).nullable(),
});
export type NamingBrief = z.infer<typeof namingBriefSchema>;

/** `public.jobs.input` for a run. */
export const namingRunInputSchema = z.strictObject({
  version: z.literal(3), kind: namingRunKindSchema, runId: z.uuid(), target: z.literal(NAMING_RUN_TARGET),
  policyIdentity: hash, brief: namingBriefSchema,
});
export type NamingRunInput = z.infer<typeof namingRunInputSchema>;

export const namingUsageSchema = z.strictObject({ inputTokens: count(Number.MAX_SAFE_INTEGER), outputTokens: count(Number.MAX_SAFE_INTEGER), totalTokens: count(Number.MAX_SAFE_INTEGER) });
export type NamingUsage = z.infer<typeof namingUsageSchema>;

/** Known failure reasons. SQL and the worker only write these. */
export const namingRunErrorCodeSchema = z.enum([
  "send_interrupted", // the worker stopped between sending a request and saving its receipt number
  "provider_rejected", // OpenAI refused the request before generating
  "response_failed", // OpenAI ended the response as failed, incomplete or cancelled
  "response_timeout", // the response did not finish within a round's time limit
  "invalid_output", // the reply had no usable JSON names
  "save_failed", // names could not be saved after bounded retries
  "no_names", // the rounds finished but no name passed the checks
  "lease_expired", // the worker stopped and the job used all its attempts
  "deadline", // the run passed its overall deadline
]);
export type NamingRunErrorCode = z.infer<typeof namingRunErrorCodeSchema>;

export const namingRoundStateSchema = z.enum(["sending", "sent", "saved", "failed", "interrupted"]);
export const namingRoundSchema = z.strictObject({
  roundId: z.uuid(), round: z.number().int().min(1).max(NAMING_MAX_ROUNDS), state: namingRoundStateSchema,
  responseId: namingResponseIdSchema.nullable(), savedCount: count(NAMING_RUN_TARGET), errorCode: code.nullable(),
});
export type NamingRound = z.infer<typeof namingRoundSchema>;

export const namingRunStateSchema = z.enum(["queued", "running", "cancel_requested", "succeeded", "failed", "cancelled"]);
export type NamingRunState = z.infer<typeof namingRunStateSchema>;
export const namingRunSchema = z.strictObject({
  runId: z.uuid(), jobId: z.uuid(), kind: namingRunKindSchema, state: namingRunStateSchema,
  target: z.literal(NAMING_RUN_TARGET), savedCount: count(NAMING_RUN_TARGET), errorCode: code.nullable(),
  usage: namingUsageSchema.nullable(), createdAt: timestamp, finishedAt: timestamp.nullable(),
});
export type NamingRun = z.infer<typeof namingRunSchema>;
export const namingRunActive = (run: Pick<NamingRun, "state"> | null | undefined) => !!run && ["queued", "running", "cancel_requested"].includes(run.state);

/** One cleaned name sent by the worker to `round_saved`. */
export const namingSavedCandidateSchema = z.strictObject({
  value: nameValueSchema, rationale: z.string().min(1).max(600), primaryApproach: namingApproachSchema, identityKey: z.string().min(1).max(320),
});
export type NamingSavedCandidate = z.infer<typeof namingSavedCandidateSchema>;

/** What the worker's `claim` action returns with the execution envelope. */
export const namingClaimSchema = z.strictObject({
  job: z.strictObject({ id: z.uuid(), owner_id: z.uuid(), project_id: z.uuid(), lease_token: z.uuid(), operation: z.literal("naming.generate"), attempts: z.number().int().min(1), max_attempts: z.number().int().min(1) }),
  run: namingRunSchema, input: namingRunInputSchema, rounds: z.array(namingRoundSchema).max(NAMING_MAX_ROUNDS),
  identities: z.array(z.string().min(1).max(320)).max(5000),
});
export type NamingClaim = z.infer<typeof namingClaimSchema>;

/* Web contract. */
export const namingAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available") }),
  z.strictObject({ status: z.literal("unavailable"), code }),
]);
export const namingFeedCursorSchema = z.strictObject({ createdAt: timestamp, id: z.uuid() });
export type NamingFeedCursor = z.infer<typeof namingFeedCursorSchema>;
export const namingFeedEntrySchema = z.strictObject({ entry: projectNameEntrySchema, runId: z.uuid(), primaryApproach: namingApproachSchema.nullable() });
export type NamingFeedEntry = z.infer<typeof namingFeedEntrySchema>;
export const namingGenerationFeedSchema = z.strictObject({
  version: z.literal(2), projectId: z.uuid(), availability: namingAvailabilitySchema, run: namingRunSchema.nullable(),
  entries: z.array(namingFeedEntrySchema).max(100), nextCursor: namingFeedCursorSchema.nullable(),
  /** Present while Naming runs on the generation engine (docs/generation-engine.md, step 3). */
  engine: z.literal(true).optional(),
});
export type NamingGenerationFeed = z.infer<typeof namingGenerationFeedSchema>;

export const startNamingRunRequestSchema = z.strictObject({
  version: z.literal(2), kind: namingRunKindSchema, expectedProjectRevision: revision, expectedPreferencesVersion: revision,
  seedIds: z.array(z.uuid()).max(5), instruction: z.string().trim().min(1).max(2000).nullable(), idempotencyKey: requestKey,
}).refine(value => value.kind === "steer" ? value.seedIds.length > 0 || value.instruction !== null : value.seedIds.length === 0 && value.instruction === null,
  "Only a steered run carries seed names or an instruction")
  .refine(value => new Set(value.seedIds).size === value.seedIds.length, "Seed names must be distinct");
export type StartNamingRunRequest = z.infer<typeof startNamingRunRequestSchema>;
export const startNamingRunResultSchema = z.strictObject({ run: namingRunSchema, reused: z.boolean() });
export const namingStartErrorCodeSchema = z.enum(["naming_active", "project_revision_changed", "preferences_changed", "preferences_incomplete", "naming_unavailable"]);
export type NamingStartErrorCode = z.infer<typeof namingStartErrorCodeSchema>;

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Repair one piece of explanatory text the AI wrote before any check or save.
 * On November 9 a reply carried an invisible NUL character (U+0000) inside an
 * explanation; JavaScript accepted it, Postgres refused to store it, and the
 * whole worker stopped. Line breaks become spaces; NUL, other control
 * characters, zero-width and bidirectional marks and unpaired surrogates are
 * removed; the result is NFC-normalized with single spaces.
 */
export function cleanGeneratedText(value: string): string {
  return value.replace(loneSurrogate, "").normalize("NFC")
    .replace(/[\t\n\r\f\v\u2028\u2029]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s{2,}/gu, " ").trim();
}

/** Prepare one raw AI candidate for validation. Explanations are repaired, so a
 * glitch in a rationale never costs a good name. The name itself is only
 * NFC-normalized and trimmed: a name with an invisible character is left for the
 * name check to reject, so a damaged spelling is never shown. Other fields and
 * non-object values pass through unchanged. */
export function cleanGeneratedCandidate(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const item = raw as Record<string, unknown>, repair = (field: unknown) => typeof field === "string" ? cleanGeneratedText(field) : field;
  return {
    ...item, value: typeof item.value === "string" ? item.value.normalize("NFC").trim() : item.value, rationale: repair(item.rationale),
    ...(Array.isArray(item.construction) ? { construction: item.construction.map(repair) } : {}),
  };
}
