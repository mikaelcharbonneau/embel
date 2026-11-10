import "server-only";
import { z } from "zod";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { IDENTITY_DIRECTIONS_KIND } from "./identity-input";
import { enabledGenerationKinds, type GenerationRunRow } from "./runs";

// Creative directions on the generation engine (docs/generation-engine.md, step 5).
// The Creative direction screens keep their routes (/identity/batches); while the
// kind is enabled those routes admit, read and stop rounds through the engine's
// database functions instead of the shared worker's. This module runs with the
// person's own login.

/** The engine path is on only while the kind is enabled. Any failure to read the
 * catalog (including a database without the engine) keeps the old path. */
export async function identityEngineEnabled(auth: AuthenticatedContext): Promise<boolean> {
  try {
    return (await enabledGenerationKinds(auth)).has(IDENTITY_DIRECTIONS_KIND);
  } catch {
    return false;
  }
}

const runRowSchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  project_id: z.uuid(),
  kind: z.literal(IDENTITY_DIRECTIONS_KIND),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  workflow_run_id: z.string().nullable(),
  created_at: z.string(),
  input: z.object({ batchId: z.uuid() }).passthrough(),
});
export type IdentityDirectionsRun = Pick<GenerationRunRow, "id" | "status" | "workflow_run_id" | "created_at"> & {
  batchId: string;
};
export const parseIdentityDirectionsRun = (
  value: unknown,
  auth: AuthenticatedContext,
  projectId: string,
): IdentityDirectionsRun => {
  const run = runRowSchema.safeParse(value);
  if (!run.success || run.data.owner_id !== auth.userId || run.data.project_id !== projectId)
    throw new ApiError("integration_unavailable");
  return {
    id: run.data.id,
    status: run.data.status,
    workflow_run_id: run.data.workflow_run_id,
    created_at: run.data.created_at,
    batchId: run.data.input.batchId,
  };
};

/** The engine round that made this batch, if any (read with the person's own login). */
export async function findIdentityDirectionsRun(
  auth: AuthenticatedContext,
  projectId: string,
  select: { batchId: string } | { idempotencyKey: string },
): Promise<IdentityDirectionsRun | null> {
  let query = auth.client
    .from("generation_runs")
    .select("id,owner_id,project_id,kind,status,workflow_run_id,created_at,input")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .eq("kind", IDENTITY_DIRECTIONS_KIND);
  query =
    "batchId" in select
      ? query.eq("input->>batchId", select.batchId)
      : query.eq("idempotency_key", select.idempotencyKey);
  const { data, error } = await query.limit(2);
  if (error) {
    // A database without the engine tables has no engine rounds.
    if (error.code === "42P01" || error.code === "PGRST205") return null;
    throw new ApiError("integration_unavailable");
  }
  if (!data?.length) return null;
  if (data.length > 1) throw new ApiError("integration_unavailable");
  return parseIdentityDirectionsRun(data[0], auth, projectId);
}

/** A round admitted but whose workflow never started (a failed start, or a crash
 * between admission and start) is started again; a duplicate start loses the claim. */
const START_GRACE_MS = 15_000;
export function identityRunNeedsStart(run: IdentityDirectionsRun, now = Date.now(), graceMs = START_GRACE_MS): boolean {
  return run.status === "queued" && run.workflow_run_id === null && now - Date.parse(run.created_at) >= graceMs;
}
