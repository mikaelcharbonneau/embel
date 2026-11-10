import "server-only";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  identityAvailabilitySchema,
  identityBatchRequestCloseSchema,
  identityBatchStateSchema,
  identityGenerationIntentSchema,
  type IdentityAvailability,
  type IdentityBatchRequestClose,
  type IdentityBatchState,
  type IdentityGenerationIntent,
} from "@/domain/identity-jobs";
import { IMAGE_MODEL } from "@/domain/providers";
import { brandTextReadiness } from "@/domain/brand-board-fonts";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import {
  findIdentityDirectionsRun,
  identityEngineEnabled,
  identityRunNeedsStart,
  parseIdentityDirectionsRun,
} from "../engine/identity";
import { IDENTITY_DIRECTIONS_KIND } from "../engine/identity-input";
import { startAdmittedRun } from "../engine/start";

export class IdentityAdmissionUncertainError extends ApiError {
  readonly recovery: { projectId: string; input: IdentityGenerationIntent };
  constructor(projectId: string, input: IdentityGenerationIntent) {
    super("integration_unavailable");
    this.name = "IdentityAdmissionUncertainError";
    this.recovery = { projectId, input: structuredClone(input) };
  }
}
export class IdentityIntentClosureUncertainError extends ApiError {
  readonly recovery: { projectId: string; input: IdentityGenerationIntent };
  constructor(projectId: string, input: IdentityGenerationIntent) {
    super("integration_unavailable");
    this.name = "IdentityIntentClosureUncertainError";
    this.recovery = { projectId, input: structuredClone(input) };
  }
}
const uuid = (value: string) => {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new ApiError("not_found");
  return parsed.data.toLowerCase();
};
async function ownedProject(auth: AuthenticatedContext, id: string) {
  const { data, error } = await auth.client
    .from("projects")
    .select("id,owner_id")
    .eq("id", id)
    .eq("owner_id", auth.userId)
    .maybeSingle();
  if (error) throw new ApiError("integration_unavailable");
  if (!data || data.id !== id || data.owner_id !== auth.userId) throw new ApiError("not_found");
}
function rpcFailure(error: unknown): ApiError {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === "23505" || code === "40001" || code === "PT409") return new ApiError("conflict");
  if (code === "42501" || code === "P0002" || code === "PT404") return new ApiError("not_found");
  if (code === "22023" || code === "PT422") return new ApiError("invalid_input");
  return new ApiError("integration_unavailable");
}
async function rpc(auth: AuthenticatedContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = await auth.client.rpc(name, args);
    if (error) throw rpcFailure(error);
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("integration_unavailable");
  }
}
function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  return parsed.data;
}
function scope(auth: AuthenticatedContext, projectId: string, value: { ownerId: string; projectId: string }) {
  if (value.ownerId !== auth.userId || value.projectId !== projectId) throw new ApiError("integration_unavailable");
}
/** Engine admission refusals that are final answers, not uncertain outcomes. */
const engineRefusals: Record<string, ApiError["code"]> = {
  insufficient_credits: "insufficient_credits",
  daily_limit: "daily_limit",
  generation_active: "generation_active",
  generation_unavailable: "generation_unavailable",
  generation_paused: "generation_unavailable",
  identity_generation_unavailable: "generation_unavailable",
};
async function engineRpc(auth: AuthenticatedContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: unknown };
  try {
    result = await auth.client.rpc(name, args);
  } catch {
    throw new ApiError("integration_unavailable");
  }
  if (!result.error) return result.data;
  const message =
    typeof result.error === "object" &&
    result.error !== null &&
    "message" in result.error &&
    typeof result.error.message === "string"
      ? result.error.message
      : "";
  throw Object.hasOwn(engineRefusals, message) ? new ApiError(engineRefusals[message]!) : rpcFailure(result.error);
}
/** Creative directions run on the generation engine. Turning identity.directions off is a
 * stop switch: the step shows as unavailable and nothing falls back. */
export async function getIdentityAvailability(
  auth: AuthenticatedContext,
  projectId: string,
): Promise<IdentityAvailability> {
  projectId = uuid(projectId);
  await ownedProject(auth, projectId);
  if (!(await identityEngineEnabled(auth)))
    return identityAvailabilitySchema.parse({
      ownerId: auth.userId,
      projectId,
      status: "unavailable",
      operation: "identity.image",
      requestedModel: IMAGE_MODEL,
      reason: "runtime_unavailable",
    });
  const value = stored(
    identityAvailabilitySchema,
    await engineRpc(auth, "get_identity_directions_availability", { p_project_id: projectId }),
  );
  scope(auth, projectId, value);
  if (
    value.status === "available" &&
    value.version === 3 &&
    !brandTextReadiness(value.sourceLogo.brief.payload.name).supported
  )
    return {
      ownerId: auth.userId,
      projectId,
      status: "unavailable",
      operation: "identity.image",
      requestedModel: IMAGE_MODEL,
      reason: "unsupported_brand_text",
    };
  return value;
}
export async function enqueueIdentityBatch(
  auth: AuthenticatedContext,
  projectId: string,
  input: unknown,
): Promise<IdentityBatchState> {
  const parsed = identityGenerationIntentSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  projectId = uuid(projectId);
  await ownedProject(auth, projectId);
  // A saved request is still found through its request lookup after the kind is turned off.
  if (!(await identityEngineEnabled(auth))) throw new ApiError("generation_unavailable");
  return startEngineIdentityBatch(auth, projectId, parsed.data);
}
/**
 * Creative directions on the generation engine: one request admits (and charges) the
 * round and freezes its input in the same transaction as its batch records; then its
 * workflow starts. A replayed request key returns the same round (starting its workflow
 * if it never started) and never admits it twice. A request the database refused for
 * good (credits, today's limit, a round still running) is a final answer; any other
 * failure stays uncertain and is looked up again with the same key.
 */
async function startEngineIdentityBatch(
  auth: AuthenticatedContext,
  projectId: string,
  input: IdentityGenerationIntent,
): Promise<IdentityBatchState> {
  if (!("version" in input) || input.version !== 3) throw new ApiError("integration_unavailable");
  let value: unknown;
  try {
    value = await engineRpc(auth, "start_identity_directions", { p_project_id: projectId, p_intent: input });
  } catch (e) {
    if (e instanceof ApiError && e.code !== "integration_unavailable") throw e;
    throw new IdentityAdmissionUncertainError(projectId, input);
  }
  const result = z.object({ replayed: z.boolean(), run: z.unknown(), batch: z.unknown() }).safeParse(value);
  if (!result.success) throw new IdentityAdmissionUncertainError(projectId, input);
  const batch = stored(identityBatchStateSchema, result.data.batch);
  scope(auth, projectId, batch);
  if (!isDeepStrictEqual(batch.intent, input)) throw new IdentityAdmissionUncertainError(projectId, input);
  if (result.data.run !== null) {
    const run = parseIdentityDirectionsRun(result.data.run, auth, projectId);
    if (run.batchId !== batch.batchId) throw new IdentityAdmissionUncertainError(projectId, input);
    // A new round starts now; a replay starts only a round whose start was evidently lost,
    // so a quick retry doesn't race the first start.
    if (result.data.replayed ? identityRunNeedsStart(run) : run.status === "queued" && run.workflow_run_id === null) {
      try {
        await startAdmittedRun(IDENTITY_DIRECTIONS_KIND, run.id);
      } catch {
        throw new IdentityAdmissionUncertainError(projectId, input);
      }
    }
  }
  return batch;
}
/** A working engine round whose workflow never started is started again while the kind
 * is on (best effort; the next check tries again). */
async function resumeEngineRound(auth: AuthenticatedContext, projectId: string, batch: IdentityBatchState) {
  if (batch.terminal || batch.status !== "running") return;
  try {
    const run = await findIdentityDirectionsRun(auth, projectId, { batchId: batch.batchId });
    if (run && identityRunNeedsStart(run) && (await identityEngineEnabled(auth)))
      await startAdmittedRun(IDENTITY_DIRECTIONS_KIND, run.id);
  } catch {
    /* The round stays visible; Stop ends it, and an unstarted round ends with a refund after 10 minutes. */
  }
}
async function read(
  auth: AuthenticatedContext,
  projectId: string,
  batchId: string | null,
  requestKey: string | null,
): Promise<IdentityBatchState | null> {
  projectId = uuid(projectId);
  if (batchId !== null) batchId = uuid(batchId);
  if (
    requestKey !== null &&
    !z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .safeParse(requestKey).success
  )
    throw new ApiError("invalid_input");
  await ownedProject(auth, projectId);
  // Reads every round's batch records, whether the old worker or the engine made them.
  const value = stored(
    identityBatchStateSchema.nullable(),
    await rpc(auth, "get_shared_identity_batch", {
      p_project_id: projectId,
      p_batch_id: batchId,
      p_request_key: requestKey,
    }),
  );
  if (value) {
    scope(auth, projectId, value);
    if ((batchId && value.batchId !== batchId) || (requestKey && value.intent.idempotencyKey !== requestKey))
      throw new ApiError("integration_unavailable");
    await resumeEngineRound(auth, projectId, value);
  }
  return value;
}
export const getIdentityBatch = (auth: AuthenticatedContext, p: string, id: string) => read(auth, p, id, null);
export const readIdentityBatchRequest = (auth: AuthenticatedContext, p: string, key: string) =>
  read(auth, p, null, key);
export const getLatestIdentityBatch = (auth: AuthenticatedContext, p: string) => read(auth, p, null, null);
export async function cancelIdentityBatch(
  auth: AuthenticatedContext,
  projectId: string,
  batchId: string,
): Promise<IdentityBatchState> {
  projectId = uuid(projectId);
  batchId = uuid(batchId);
  await ownedProject(auth, projectId);
  // An engine round is stopped through its run, whether or not the kind is still on. A round
  // the old worker made has already finished: nothing runs it any more.
  if ((await findIdentityDirectionsRun(auth, projectId, { batchId })) === null) throw new ApiError("conflict");
  const value = stored(
    identityBatchStateSchema,
    await rpc(auth, "cancel_identity_directions", { p_project_id: projectId, p_batch_id: batchId }),
  );
  scope(auth, projectId, value);
  if (value.batchId !== batchId) throw new ApiError("integration_unavailable");
  return value;
}

/** A missing lookup is not rejection evidence. Only this serialized SQL mutation
 * can close the exact original intent, or request Stop for its actual admission. */
export async function closeIdentityBatchRequest(
  auth: AuthenticatedContext,
  projectId: string,
  input: unknown,
): Promise<IdentityBatchRequestClose> {
  const parsed = identityGenerationIntentSchema.safeParse(input);
  if (!parsed.success || !("version" in parsed.data) || (parsed.data.version !== 2 && parsed.data.version !== 3))
    throw new ApiError("invalid_input");
  projectId = uuid(projectId);
  await ownedProject(auth, projectId);
  // The engine's close stops an engine round through its run, and leaves a tombstone for a
  // request never admitted.
  try {
    const result = stored(
      identityBatchRequestCloseSchema,
      await rpc(auth, "close_identity_directions_intent", { p_project_id: projectId, p_intent: parsed.data }),
    );
    if (result.status === "not_admitted") {
      scope(auth, projectId, result);
      if (!isDeepStrictEqual(result.intent, parsed.data)) throw new ApiError("integration_unavailable");
    } else {
      scope(auth, projectId, result.batch);
      if (!isDeepStrictEqual(result.batch.intent, parsed.data)) throw new ApiError("integration_unavailable");
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.code !== "integration_unavailable") throw error;
    throw new IdentityIntentClosureUncertainError(projectId, parsed.data);
  }
}
