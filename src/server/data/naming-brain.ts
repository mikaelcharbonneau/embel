import "server-only";
import { z } from "zod";
import { getNamingPreferencesReadiness, namingPreferencesV2Schema } from "@/domain/naming-brain-preferences";
import { ensureNamingRunIntentSchema, namingBrainRunSchema, namingFeedCursorSchema, namingFeedEnsureResultSchema, namingFeedSchema, namingProviderFailureSchema, namingRunAccountingSchema, steerNamingFeedIntentSchema, steerNamingFeedResponseSchema, stopNamingFeedIntentSchema, stopNamingFeedResponseSchema, type NamingFeed, type NamingFeedCursor } from "@/domain/naming-brain";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { getVerifiedProjectName, verifyProjectNameCandidates } from "./project-naming";
import { normalizeNamingBrain } from "./naming-brain-provenance";
import { isHostedNamingRuntime, isLocalPrototypeRuntime } from "../api-text/config";
import { isNamingProviderBudgetAvailable, NAMING_BUDGET_UNAVAILABLE, NAMING_BUDGET_UNAVAILABLE_MESSAGE } from "../ai/naming-brain/budget-availability";

const hostedNamingAvailabilitySchema = z.discriminatedUnion("status", [
 z.strictObject({ status: z.literal("available"), executionAuthority: z.literal("hosted_owner_v1") }),
 z.strictObject({ status: z.literal("unavailable"), executionAuthority: z.literal("hosted_owner_v1"), reason: z.enum(["runtime_disabled", "worker_unavailable"]) }),
]);

function id(value: string) { if (!z.uuid().safeParse(value).success) throw new ApiError("not_found"); return value; }
function parse<T>(schema: z.ZodType<T>, value: unknown, stored = false): T {
 const result = schema.safeParse(value); if (!result.success) throw new ApiError(stored ? "integration_unavailable" : "invalid_input"); return result.data;
}
async function rpc<T>(auth: AuthenticatedContext, name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
 const { data, error } = await auth.client.rpc(name, args);
 if (error) {
  if (["PGRST301", "PGRST302", "PGRST303", "42501"].includes(error.code)) throw new ApiError("unauthenticated");
  if (["P0002", "PGRST116"].includes(error.code)) throw new ApiError("not_found");
  if (["PT409", "23505", "40001"].includes(error.code)) throw new ApiError("conflict");
  if (["22023", "23514", "22P02", "23502"].includes(error.code)) throw new ApiError("invalid_input");
  throw new ApiError("integration_unavailable");
 }
 return parse(schema, normalizeNamingBrain(data, auth.userId), true);
}
async function verifyFeed(auth: AuthenticatedContext, projectId: string, feed: NamingFeed) {
 if (feed.ownerId !== auth.userId || feed.projectId !== projectId) throw new ApiError("not_found");
 await verifyProjectNameCandidates(auth, projectId, feed.entries.map(entry => entry.entry.candidate));
 const verified = { ...feed };
 delete verified.canResumeOnScroll;
 delete verified.canPrefetchOnScroll;
 delete verified.failure;
 // Only fixed safe classifications leave the owned persisted step. Never expose
 // provider payloads, private diagnostic text or an unvalidated error string.
 if (feed.activeRun && ["failed", "partial", "needs_reconciliation"].includes(feed.activeRun.state)) {
  const result = await auth.client.from("job_steps").select("owner_id,project_id,job_id,output")
   .eq("owner_id", auth.userId).eq("project_id", projectId).eq("job_id", feed.activeRun.jobId).in("state", ["failed", "ambiguous"]).limit(7);
  if (!result.error && Array.isArray(result.data)) {
   for (const row of result.data) {
    if (row.owner_id !== auth.userId || row.project_id !== projectId || row.job_id !== feed.activeRun.jobId) throw new ApiError("not_found");
    const output = z.object({ errorCode: z.string().optional(), partialArtifacts: z.array(z.unknown()).max(300).optional() }).safeParse(row.output);
    if (!output.success) continue;
    for (const partial of output.data.partialArtifacts ?? []) {
     const marker = z.strictObject({ type: z.literal("provider_failure"), ...namingProviderFailureSchema.shape }).safeParse(partial);
     if (marker.success) verified.failure = { code: marker.data.code, retryable: false };
    }
    if (!verified.failure && output.data.errorCode === "provider_request_rejected") verified.failure = { code: "provider_request_rejected", retryable: false };
   }
  }
 }
 let executionAvailable = isLocalPrototypeRuntime();
 if (isHostedNamingRuntime()) {
  try {
   const hosted = await rpc(auth, "get_hosted_naming_availability", { p_project_id: projectId }, hostedNamingAvailabilitySchema);
   executionAvailable = hosted.status === "available";
  } catch (error) {
   // The saved feed was already owner-checked and replayed. A readiness outage
   // disables new exploration without making those saved names unreadable.
   if (error instanceof ApiError && ["not_found", "unauthenticated"].includes(error.code)) throw error;
   executionAvailable = false;
  }
  if (!executionAvailable) verified.availability = { status: "unavailable", code: "naming_runtime_unavailable" };
 }
 if (!isNamingProviderBudgetAvailable()) {
  executionAvailable = false;
  verified.availability = { status: "unavailable", code: NAMING_BUDGET_UNAVAILABLE };
 }
 const executionCurrent = executionAvailable && feed.activeRun
  && feed.activeRun.projectRevision === feed.projectRevision && feed.activeRun.preferencesVersion === feed.preferencesVersion && feed.activeRun.steeringRevision === feed.steeringRevision
  && !feed.paused && feed.state === "active" && feed.availability.status === "available";
 if (executionCurrent && feed.activeRun?.canResume && ["partial", "failed"].includes(feed.activeRun.state) && feed.activeRun.fulfillment?.status !== "complete") verified.canResumeOnScroll = true;
 if (executionCurrent && feed.activeRun?.state === "succeeded" && feed.activeRun.fulfillment?.status === "complete" && (feed.activeRun.localPipelineVersion === 2 ? feed.activeRun.progressiveCompletionId : feed.activeRun.preparedSetId !== null)) verified.canPrefetchOnScroll = true;
 return verified;
}
export async function getNamingFeed(auth: AuthenticatedContext, projectId: string, cursor?: NamingFeedCursor, limit = 100) {
 id(projectId); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError("invalid_input");
 const feed = await rpc(auth, "get_naming_feed", { p_project_id: projectId, p_query: { limit, ...(cursor ? { cursor: parse(namingFeedCursorSchema, cursor) } : {}) } }, namingFeedSchema);
 return verifyFeed(auth, projectId, feed);
}
export async function ensureNextNamingRun(auth: AuthenticatedContext, projectId: string, intent: unknown) {
 id(projectId); const parsed = parse(ensureNamingRunIntentSchema, intent);
 if (!isNamingProviderBudgetAvailable()) {
  const feed = await getNamingFeed(auth, projectId);
  // An exact server-qualified saved-membership resume is a free read/append,
  // never permission to restart incomplete or uncertain generation.
  if (!(parsed.reason === "resume" && feed.activeRun?.canResumeSaved && feed.activeRun.runId === parsed.resumeOfRunId && feed.activeRun.revision === parsed.expectedRunRevision))
   return parse(namingFeedEnsureResultSchema, { status: "blocked", feed, code: NAMING_BUDGET_UNAVAILABLE, message: NAMING_BUDGET_UNAVAILABLE_MESSAGE, action: "configure" });
 }
 const saved = await auth.client.from("naming_preferences").select("owner_id,project_id,version,preferences")
  .eq("owner_id",auth.userId).eq("project_id",projectId).eq("version",parsed.expectedPreferencesVersion).maybeSingle();
 if(saved.error)throw new ApiError("integration_unavailable");
 if(!saved.data || saved.data.owner_id!==auth.userId || saved.data.project_id!==projectId || saved.data.version!==parsed.expectedPreferencesVersion)throw new ApiError("conflict");
 const preferences=namingPreferencesV2Schema.safeParse(saved.data.preferences);
 if(!preferences.success || !getNamingPreferencesReadiness(preferences.data).ready) return parse(namingFeedEnsureResultSchema,{
  status:"blocked",feed:await getNamingFeed(auth,projectId),code:"preferences_incomplete",message:"Review your saved naming approaches, directness, text constraints and length limits before continuing.",action:"review_preferences"});
 const admission = isLocalPrototypeRuntime() ? "ensure_local_naming_brain_run" : isHostedNamingRuntime() ? "ensure_hosted_naming_brain_run" : "ensure_naming_brain_run";
 const result = await rpc(auth, admission, { p_project_id: projectId, p_intent: parsed }, namingFeedEnsureResultSchema);
 return { ...result, feed: await verifyFeed(auth, projectId, result.feed) };
}
export async function stopNamingFeed(auth: AuthenticatedContext, projectId: string, intent: unknown) {
 id(projectId); const parsed = parse(stopNamingFeedIntentSchema, intent);
 const result = await rpc(auth, "stop_naming_feed", { p_project_id: projectId, p_intent: parsed }, stopNamingFeedResponseSchema);
 return { ...result, feed: await verifyFeed(auth, projectId, result.feed) };
}
export async function steerNamingFeed(auth: AuthenticatedContext, projectId: string, intent: unknown) {
 id(projectId); const parsed = parse(steerNamingFeedIntentSchema, intent);
 for (const candidateId of parsed.candidateIds) await getVerifiedProjectName(auth, projectId, candidateId);
 const result = await rpc(auth, "steer_naming_feed", { p_project_id: projectId, p_intent: parsed }, steerNamingFeedResponseSchema);
 return { ...result, feed: await verifyFeed(auth, projectId, result.feed) };
}
export async function getNamingBrainRun(auth: AuthenticatedContext, projectId: string, runId: string) {
 const run = await rpc(auth, "get_naming_brain_run", { p_project_id: id(projectId), p_run_id: id(runId) }, namingBrainRunSchema);
 if (run.ownerId !== auth.userId || run.projectId !== projectId || run.runId !== runId) throw new ApiError("not_found");
 return run;
}
export async function cancelNamingBrainRun(auth: AuthenticatedContext, projectId: string, runId: string) {
 const run = await getNamingBrainRun(auth, projectId, runId);
 const { error } = await auth.client.rpc("request_job_cancel", { p_job_id: run.jobId });
 if (error) throw new ApiError(error.code === "P0002" ? "not_found" : "integration_unavailable");
 return getNamingBrainRun(auth, projectId, runId);
}
export async function getNamingBrainJobAccounting(auth: AuthenticatedContext, jobId: string) {
 return rpc(auth, "get_naming_brain_job_accounting", { p_job_id: id(jobId) }, namingRunAccountingSchema.nullable());
}
export function readNamingFeedQuery(request: Request) {
 const params = new URL(request.url).searchParams;
 for (const key of params.keys()) if (!["cursorEntryId", "cursorPosition", "limit"].includes(key) || params.getAll(key).length !== 1) throw new ApiError("invalid_input");
 const cursor = params.has("cursorEntryId") || params.has("cursorPosition") ? parse(namingFeedCursorSchema, { entryId: params.get("cursorEntryId"), position: Number(params.get("cursorPosition")) }) : undefined;
 const limit = params.has("limit") ? Number(params.get("limit")) : 100;
 if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError("invalid_input");
 return { cursor, limit };
}
