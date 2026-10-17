import "server-only";
import { z } from "zod";
import { getNamingPreferencesReadiness, namingPreferencesV2Schema } from "@/domain/naming-brain-preferences";
import { ensureNamingRunIntentSchema, namingBrainRunSchema, namingFeedCursorSchema, namingFeedEnsureResultSchema, namingFeedSchema, namingRunAccountingSchema, steerNamingFeedIntentSchema, steerNamingFeedResponseSchema, stopNamingFeedIntentSchema, stopNamingFeedResponseSchema, type NamingFeed, type NamingFeedCursor } from "@/domain/naming-brain";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { getVerifiedProjectName, verifyProjectNameCandidates } from "./project-naming";
import { normalizeNamingBrain } from "./naming-brain-provenance";

function id(value: string) { if (!z.uuid().safeParse(value).success) throw new ApiError("not_found"); return value; }
function parse<T>(schema: z.ZodType<T>, value: unknown, stored = false): T {
 const result = schema.safeParse(value); if (!result.success) throw new ApiError(stored ? "integration_unavailable" : "invalid_input"); return result.data;
}
async function rpc<T>(auth: AuthenticatedContext, name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
 const { data, error } = await auth.client.rpc(name, args);
 if (error) {
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
 return feed;
}
export async function getNamingFeed(auth: AuthenticatedContext, projectId: string, cursor?: NamingFeedCursor, limit = 100) {
 id(projectId); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError("invalid_input");
 const feed = await rpc(auth, "get_naming_feed", { p_project_id: projectId, p_query: { limit, ...(cursor ? { cursor: parse(namingFeedCursorSchema, cursor) } : {}) } }, namingFeedSchema);
 return verifyFeed(auth, projectId, feed);
}
export async function ensureNextNamingRun(auth: AuthenticatedContext, projectId: string, intent: unknown) {
 id(projectId); const parsed = parse(ensureNamingRunIntentSchema, intent);
 const saved = await auth.client.from("naming_preferences").select("owner_id,project_id,version,preferences")
  .eq("owner_id",auth.userId).eq("project_id",projectId).eq("version",parsed.expectedPreferencesVersion).maybeSingle();
 if(saved.error)throw new ApiError("integration_unavailable");
 if(!saved.data || saved.data.owner_id!==auth.userId || saved.data.project_id!==projectId || saved.data.version!==parsed.expectedPreferencesVersion)throw new ApiError("conflict");
 const preferences=namingPreferencesV2Schema.safeParse(saved.data.preferences);
 if(!preferences.success || !getNamingPreferencesReadiness(preferences.data).ready) return parse(namingFeedEnsureResultSchema,{
  status:"blocked",feed:await getNamingFeed(auth,projectId),code:"preferences_incomplete",message:"Review your saved naming approaches, directness, text constraints and length limits before continuing.",action:"review_preferences"});
 const result = await rpc(auth, "ensure_naming_brain_run", { p_project_id: projectId, p_intent: parsed }, namingFeedEnsureResultSchema);
 await verifyFeed(auth, projectId, result.feed);
 return result;
}
export async function stopNamingFeed(auth: AuthenticatedContext, projectId: string, intent: unknown) {
 id(projectId); const parsed = parse(stopNamingFeedIntentSchema, intent);
 const result = await rpc(auth, "stop_naming_feed", { p_project_id: projectId, p_intent: parsed }, stopNamingFeedResponseSchema);
 await verifyFeed(auth, projectId, result.feed); return result;
}
export async function steerNamingFeed(auth: AuthenticatedContext, projectId: string, intent: unknown) {
 id(projectId); const parsed = parse(steerNamingFeedIntentSchema, intent);
 for (const candidateId of parsed.candidateIds) await getVerifiedProjectName(auth, projectId, candidateId);
 const result = await rpc(auth, "steer_naming_feed", { p_project_id: projectId, p_intent: parsed }, steerNamingFeedResponseSchema);
 await verifyFeed(auth, projectId, result.feed); return result;
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
