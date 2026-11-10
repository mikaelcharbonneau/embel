import "server-only";
import { z } from "zod";
import { creditSummarySchema, type GenerationRun } from "@/domain/generations";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

export const generationKindSchema = z
  .string()
  .regex(/^[a-z]+(\.[a-z_]+)+$/u)
  .max(64);
/** A journey step's kinds share its prefix, e.g. "strategy" for strategy.competitors. */
export const generationStepSchema = z.string().regex(/^[a-z]{1,32}$/u);
export const startGenerationSchema = z.strictObject({
  kind: generationKindSchema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/u),
  input: z.record(z.string(), z.unknown()).optional(),
});

const runRowSchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  project_id: z.uuid(),
  kind: generationKindSchema,
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  credits: z.number().int().nonnegative(),
  workflow_run_id: z.string().nullable(),
  error_code: z.string().nullable(),
  cancel_requested_at: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  input_revision: z.number().int().positive().nullable().default(null),
});
export type GenerationRunRow = z.infer<typeof runRowSchema>;
const outputRowSchema = z.object({
  run_id: z.uuid(),
  output_key: z.string(),
  output: z.unknown(),
  created_at: z.string(),
});

/** Function results carry the whole row; only the project revision leaves the input snapshot. */
function withInputRevision(row: unknown) {
  if (!row || typeof row !== "object") return row;
  const input = (row as { input?: unknown }).input;
  const revision = input && typeof input === "object" ? (input as { revision?: unknown }).revision : undefined;
  return { ...row, input_revision: typeof revision === "number" ? revision : null };
}

/** The browser sees status, timing and outputs; never input snapshots, workflow ids or costs. */
export function publicRun(run: GenerationRunRow, outputs: z.infer<typeof outputRowSchema>[] = []): GenerationRun {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    credits: run.credits,
    errorCode: run.error_code,
    cancelRequested: run.cancel_requested_at !== null,
    createdAt: run.created_at,
    finishedAt: run.finished_at,
    inputRevision: run.input_revision,
    // "sent.*" outputs mark a paid call as sent before it is sent; they are internal.
    outputs: outputs
      .filter((output) => output.run_id === run.id && !output.output_key.startsWith("sent."))
      .map((output) => ({ key: output.output_key, output: output.output })),
  };
}

const failures: Record<string, ApiError["code"]> = {
  unauthenticated: "unauthenticated",
  account_required: "unauthenticated",
  not_found: "not_found",
  invalid_input: "invalid_input",
  idempotency_conflict: "conflict",
  generation_active: "generation_active",
  daily_limit: "daily_limit",
  insufficient_credits: "insufficient_credits",
  generation_unavailable: "generation_unavailable",
  generation_paused: "generation_unavailable",
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
export async function admitGeneration(
  auth: AuthenticatedContext,
  project: string,
  request: z.infer<typeof startGenerationSchema>,
) {
  const { data, error } = await auth.client.rpc("start_generation", {
    p_project_id: projectId(project),
    p_kind: request.kind,
    p_idempotency_key: request.idempotencyKey,
    p_input: request.input ?? {},
  });
  databaseFailure(error);
  const run = runRowSchema.safeParse(withInputRevision(data));
  if (!run.success || run.data.owner_id !== auth.userId || run.data.project_id !== project)
    throw new ApiError("integration_unavailable");
  return run.data;
}

/** The run already admitted under this key, if any. A replay must not rebuild its input. */
export async function findGeneration(auth: AuthenticatedContext, project: string, idempotencyKey: string) {
  const { data, error } = await auth.client
    .from("generation_runs")
    .select(
      "id,owner_id,project_id,kind,status,credits,workflow_run_id,error_code,cancel_requested_at,created_at,finished_at,input_revision:input->revision",
    )
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId(project))
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  databaseFailure(error);
  return data ? runRowSchema.parse(data) : null;
}

/** The latest runs of a project: one kind, one journey step's kinds, or all. */
export async function listGenerations(
  auth: AuthenticatedContext,
  project: string,
  filter: { kind?: string; step?: string } = {},
) {
  const kind = filter.kind === undefined ? undefined : generationKindSchema.safeParse(filter.kind);
  const step = filter.step === undefined ? undefined : generationStepSchema.safeParse(filter.step);
  if (kind?.success === false || step?.success === false) throw new ApiError("invalid_input");
  let query = auth.client
    .from("generation_runs")
    .select(
      "id,owner_id,project_id,kind,status,credits,workflow_run_id,error_code,cancel_requested_at,created_at,finished_at,input_revision:input->revision",
    )
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId(project))
    .order("created_at", { ascending: false })
    .limit(64);
  if (kind) query = query.eq("kind", kind.data);
  if (step) query = query.like("kind", `${step.data}.%`);
  const { data, error } = await query;
  databaseFailure(error);
  const runs = z.array(runRowSchema).parse(data ?? []);
  if (!runs.length) return [];
  const outputs = await auth.client
    .from("generation_outputs")
    .select("run_id,output_key,output,created_at")
    .eq("owner_id", auth.userId)
    .in(
      "run_id",
      runs.map((run) => run.id),
    )
    .not("output_key", "like", "sent.%")
    .order("created_at", { ascending: true })
    .limit(400);
  databaseFailure(outputs.error);
  const rows = z.array(outputRowSchema).parse(outputs.data ?? []);
  return runs.map((run) => publicRun(run, rows));
}

export async function cancelGeneration(auth: AuthenticatedContext, project: string, runId: string) {
  if (!z.uuid().safeParse(runId).success) throw new ApiError("not_found");
  const { data, error } = await auth.client.rpc("cancel_generation", { p_run_id: runId });
  databaseFailure(error);
  const run = runRowSchema.safeParse(withInputRevision(data));
  if (!run.success || run.data.owner_id !== auth.userId || run.data.project_id !== projectId(project))
    throw new ApiError("not_found");
  return publicRun(run.data);
}

export async function getCreditSummary(auth: AuthenticatedContext) {
  const { data, error } = await auth.client.rpc("get_credit_summary");
  databaseFailure(error);
  const summary = creditSummarySchema.safeParse(data);
  if (!summary.success) throw new ApiError("integration_unavailable");
  return summary.data;
}

const catalogSchema = z.object({ kinds: z.array(z.object({ kind: generationKindSchema, enabled: z.boolean() })) });
/** Kinds the engine currently accepts. Credits and plans stay in the catalog. */
export async function enabledGenerationKinds(auth: AuthenticatedContext): Promise<ReadonlySet<string>> {
  const { data, error } = await auth.client.rpc("get_generation_catalog");
  databaseFailure(error);
  const catalog = catalogSchema.safeParse(data);
  if (!catalog.success) throw new ApiError("integration_unavailable");
  return new Set(catalog.data.kinds.filter((kind) => kind.enabled).map((kind) => kind.kind));
}
