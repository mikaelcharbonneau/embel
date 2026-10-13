import "server-only";
import { z } from "zod";
import {
  enqueueStandaloneNamesSchema, standaloneNamesJobResponseSchema, standaloneNamesOverviewSchema,
  standaloneNamesRetentionSchema, type StandaloneNamesOverview,
} from "@/domain/standalone-names";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { localRuntimeEnabled } from "../local-chatgpt/bridge";

function parsed<T>(schema: z.ZodType<T>, value: unknown, stored = false): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(stored ? "integration_unavailable" : "invalid_input");
  return result.data;
}
function databaseError(error: { code?: string } | null) {
  if (!error) return;
  if (["P0002", "PGRST116"].includes(error.code ?? "")) throw new ApiError("not_found");
  if (["PT409", "23505", "40001"].includes(error.code ?? "")) throw new ApiError("conflict");
  if (["22023", "22P02", "23514"].includes(error.code ?? "")) throw new ApiError("invalid_input");
  throw new ApiError("integration_unavailable");
}
async function jobRpc(auth: AuthenticatedContext, rpc: string, args: Record<string, unknown>) {
  const { data, error } = await auth.client.rpc(rpc, args);
  databaseError(error);
  const result = parsed(standaloneNamesJobResponseSchema, data, true);
  if (result.job.ownerId !== auth.userId || (args.p_job && args.p_job !== result.job.id)) throw new ApiError("not_found");
  return result;
}
const cursorSchema = z.strictObject({ before: z.iso.datetime({ offset: true }).nullable(), beforeId: z.uuid().nullable() }).refine(value => (value.before === null) === (value.beforeId === null));
export async function getStandaloneNames(auth: AuthenticatedContext, query: URLSearchParams = new URLSearchParams()): Promise<StandaloneNamesOverview> {
  if ([...query.keys()].some(key => !["before", "beforeId"].includes(key)) || [...query.keys()].some(key => query.getAll(key).length !== 1)) throw new ApiError("invalid_input");
  const cursor = parsed(cursorSchema, { before: query.get("before"), beforeId: query.get("beforeId") });
  const { data, error } = await auth.client.rpc("get_standalone_names", { p_before: cursor.before, p_before_id: cursor.beforeId });
  // This exact missing-RPC case identifies unapplied standalone setup, not an
  // empty account after an outage. Other failures preserve the client's history.
  if (error && ["42883", "PGRST202"].includes(error.code)) return {
    ownerId: auth.userId, availability: { status: "unavailable", reason: localRuntimeEnabled() ? "setup_required" : "local_runtime_required" }, jobs: [], hasMore: false,
  };
  databaseError(error);
  const result = parsed(standaloneNamesOverviewSchema, data, true);
  if (result.ownerId !== auth.userId) throw new ApiError("not_found");
  if (!localRuntimeEnabled()) result.availability = { status: "unavailable", reason: "local_runtime_required" };
  return result;
}
export function getStandaloneNameJob(auth: AuthenticatedContext, jobId: string) {
  return jobRpc(auth, "get_standalone_name_job", { p_job: parsed(z.uuid(), jobId) });
}
export async function enqueueStandaloneNames(auth: AuthenticatedContext, input: unknown) {
  if (!localRuntimeEnabled()) throw new ApiError("integration_unavailable");
  return jobRpc(auth, "enqueue_standalone_names", { p_input: parsed(enqueueStandaloneNamesSchema, input) });
}
export function cancelStandaloneNames(auth: AuthenticatedContext, jobId: string) {
  return jobRpc(auth, "cancel_standalone_names", { p_job: parsed(z.uuid(), jobId) });
}
export function retainStandaloneName(auth: AuthenticatedContext, jobId: string, input: unknown) {
  const value = parsed(standaloneNamesRetentionSchema, input);
  return jobRpc(auth, "retain_standalone_name", { p_job: parsed(z.uuid(), jobId), p_index: value.candidateIndex, p_liked: value.liked, p_saved: value.saved });
}
