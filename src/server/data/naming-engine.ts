import "server-only";
import { z } from "zod";
import {
  namingFeedCursorSchema, namingGenerationFeedSchema, namingRunSchema, startNamingRunRequestSchema,
  type NamingFeedCursor, type NamingGenerationFeed, type NamingRun, type StartNamingRunRequest,
} from "@/domain/naming-generation";
import type { AuthenticatedContext } from "../auth/context";
import { NAMING_KIND, namingEngineRequest } from "../engine/naming";
import { cancelGeneration, type GenerationRunRow } from "../engine/runs";
import { startGeneration, WorkflowStartError } from "../engine/start";
import { ApiError } from "../http/errors";
import { NAMING_FEED_PAGE_LIMIT, namingDatabaseError, projectKey, rpc, verifyFeed, type NamingStartResult } from "./naming-generation";

/**
 * The Naming screens while naming.generate is enabled (docs/generation-engine.md, step 3).
 * Same routes and shapes as the old path: the feed lists the names of old runs and engine
 * runs together, starting runs goes through start_generation (credits and limits), and Stop
 * cancels the engine run, which returns its credit.
 */
export async function getNamingEngineFeed(auth: AuthenticatedContext, projectId: string, cursor?: NamingFeedCursor, limit = NAMING_FEED_PAGE_LIMIT): Promise<NamingGenerationFeed> {
  const project = projectKey(projectId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > NAMING_FEED_PAGE_LIMIT) throw new ApiError("invalid_input");
  const after = cursor ? namingFeedCursorSchema.safeParse(cursor) : null;
  if (after && !after.success) throw new ApiError("invalid_input");
  const feed = await rpc(auth, "get_name_feed", {
    p_project: project, p_after_created_at: after?.data?.createdAt ?? null, p_after_id: after?.data?.id ?? null, p_limit: limit,
  }, namingGenerationFeedSchema);
  return { ...verifyFeed(auth, project, feed), engine: true };
}

/** An engine run in the feed's run shape. Engine runs have no separate job: jobId repeats the run id. */
function namingRun(row: GenerationRunRow, kind: NamingRun["kind"]): NamingRun {
  const active = row.status === "queued" || row.status === "running";
  const parsed = namingRunSchema.safeParse({
    runId: row.id, jobId: row.id, kind, state: active && row.cancel_requested_at ? "cancel_requested" : row.status, target: 100, savedCount: 0,
    errorCode: row.error_code, usage: null, createdAt: row.created_at, finishedAt: row.finished_at,
  });
  if (!parsed.success) throw new ApiError("integration_unavailable");
  return parsed.data;
}

/** One deliberate request starts at most one run; repeating its idempotency key returns that run. */
export async function startNamingEngineRun(auth: AuthenticatedContext, projectId: string, request: StartNamingRunRequest): Promise<NamingStartResult> {
  const project = projectKey(projectId);
  const parsed = startNamingRunRequestSchema.safeParse(request);
  if (!parsed.success) throw new ApiError("invalid_input");
  let started: Awaited<ReturnType<typeof startGeneration>>;
  try { started = await startGeneration(auth, project, { kind: NAMING_KIND, idempotencyKey: parsed.data.idempotencyKey, input: namingEngineRequest(parsed.data) }); }
  catch (error) {
    // Admitted but not started: an uncertain answer, so the screen keeps the request and
    // Try again repeats the same key, which starts it once.
    if (error instanceof WorkflowStartError) throw new ApiError("internal_error");
    throw error;
  }
  const feed = await getNamingEngineFeed(auth, project);
  const run = feed.run?.runId === started.run.id ? feed.run : namingRun(started.run, parsed.data.kind);
  if (run.kind !== parsed.data.kind) throw new ApiError("conflict");
  return { feed, run, reused: started.reused };
}

/** Stop keeps every saved name. It cancels this project's working engine run (its workflow
 * cancels the open OpenAI responses and returns the credit), or an old-path run still working. */
export async function stopNamingEngineRun(auth: AuthenticatedContext, projectId: string): Promise<{ feed: NamingGenerationFeed }> {
  const project = projectKey(projectId);
  const active = await auth.client.from("generation_runs").select("id")
    .eq("owner_id", auth.userId).eq("project_id", project).eq("kind", NAMING_KIND).in("status", ["queued", "running"])
    .order("created_at", { ascending: false }).limit(1);
  if (active.error) throw new ApiError("integration_unavailable");
  const runs = z.array(z.object({ id: z.uuid() })).parse(active.data ?? []);
  if (runs[0]) await cancelGeneration(auth, project, runs[0].id);
  else {
    const legacy = await auth.client.from("jobs").select("id")
      .eq("owner_id", auth.userId).eq("project_id", project).eq("operation", NAMING_KIND).in("state", ["queued", "running"]).limit(1);
    if (legacy.error) throw new ApiError("integration_unavailable");
    if (legacy.data?.length) {
      const { error } = await auth.client.rpc("stop_naming_run", { p_project: project });
      if (error) throw namingDatabaseError(error);
    }
  }
  return { feed: await getNamingEngineFeed(auth, project) };
}
