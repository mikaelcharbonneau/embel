import "server-only";
import { z } from "zod";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

export const generationKindSchema = z.string().regex(/^[a-z]+(\.[a-z_]+)+$/u).max(64);
export const startGenerationSchema = z.strictObject({
  kind: generationKindSchema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/u),
  input: z.record(z.string(), z.unknown()).optional(),
});

const runRowSchema = z.object({
  id: z.uuid(), owner_id: z.uuid(), project_id: z.uuid(), kind: generationKindSchema,
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  credits: z.number().int().nonnegative(), workflow_run_id: z.string().nullable(), error_code: z.string().nullable(),
  cancel_requested_at: z.string().nullable(), created_at: z.string(), finished_at: z.string().nullable(),
});
export type GenerationRunRow = z.infer<typeof runRowSchema>;
const outputRowSchema = z.object({ run_id: z.uuid(), output_key: z.string(), output: z.unknown(), created_at: z.string() });

/** The browser sees status, timing and outputs; never input snapshots, workflow ids or costs. */
export function publicRun(run: GenerationRunRow, outputs: z.infer<typeof outputRowSchema>[] = []) {
  return {
    id: run.id, kind: run.kind, status: run.status, credits: run.credits, errorCode: run.error_code,
    cancelRequested: run.cancel_requested_at !== null, createdAt: run.created_at, finishedAt: run.finished_at,
    outputs: outputs.filter(output => output.run_id === run.id).map(output => ({ key: output.output_key, output: output.output })),
  };
}

const failures: Record<string, ApiError["code"]> = {
  unauthenticated: "unauthenticated", account_required: "unauthenticated", not_found: "not_found", invalid_input: "invalid_input",
  idempotency_conflict: "conflict", generation_active: "generation_active", daily_limit: "daily_limit",
  insufficient_credits: "insufficient_credits", generation_unavailable: "generation_unavailable", generation_paused: "generation_unavailable",
};

function databaseFailure(error: { message?: unknown; code?: unknown } | null): void {
  if (!error) return;
  const message = typeof error.message === "string" ? error.message : "";
  const mapped = failures[message];
  if (mapped) throw new ApiError(mapped);
  if (error.code === "P0002" || error.code === "PGRST116") throw new ApiError("not_found");
  throw new ApiError("integration_unavailable");
}

function projectId(id: string) {
  if (!z.uuid().safeParse(id).success) throw new ApiError("not_found");
  return id;
}

/** Admission runs with the person's own login, so credits and limits apply however it's called. */
export async function admitGeneration(auth: AuthenticatedContext, project: string, request: z.infer<typeof startGenerationSchema>) {
  const { data, error } = await auth.client.rpc("start_generation", {
    p_project_id: projectId(project), p_kind: request.kind, p_idempotency_key: request.idempotencyKey, p_input: request.input ?? {},
  });
  databaseFailure(error);
  const run = runRowSchema.safeParse(data);
  if (!run.success || run.data.owner_id !== auth.userId || run.data.project_id !== project) throw new ApiError("integration_unavailable");
  return run.data;
}

export async function listGenerations(auth: AuthenticatedContext, project: string, kind?: string) {
  let query = auth.client.from("generation_runs")
    .select("id,owner_id,project_id,kind,status,credits,workflow_run_id,error_code,cancel_requested_at,created_at,finished_at")
    .eq("owner_id", auth.userId).eq("project_id", projectId(project)).order("created_at", { ascending: false }).limit(20);
  if (kind) query = query.eq("kind", generationKindSchema.parse(kind));
  const { data, error } = await query;
  databaseFailure(error);
  const runs = z.array(runRowSchema).parse(data ?? []);
  if (!runs.length) return [];
  const outputs = await auth.client.from("generation_outputs").select("run_id,output_key,output,created_at")
    .eq("owner_id", auth.userId).in("run_id", runs.map(run => run.id)).order("created_at", { ascending: true }).limit(200);
  databaseFailure(outputs.error);
  const rows = z.array(outputRowSchema).parse(outputs.data ?? []);
  return runs.map(run => publicRun(run, rows));
}

export async function cancelGeneration(auth: AuthenticatedContext, project: string, runId: string) {
  if (!z.uuid().safeParse(runId).success) throw new ApiError("not_found");
  const { data, error } = await auth.client.rpc("cancel_generation", { p_run_id: runId });
  databaseFailure(error);
  const run = runRowSchema.safeParse(data);
  if (!run.success || run.data.owner_id !== auth.userId || run.data.project_id !== projectId(project)) throw new ApiError("not_found");
  return publicRun(run.data);
}

const creditSummarySchema = z.strictObject({ planId: z.string(), balance: z.number().int(), periodEnd: z.string() });
export async function getCreditSummary(auth: AuthenticatedContext) {
  const { data, error } = await auth.client.rpc("get_credit_summary");
  databaseFailure(error);
  const summary = creditSummarySchema.safeParse(data);
  if (!summary.success) throw new ApiError("integration_unavailable");
  return summary.data;
}
