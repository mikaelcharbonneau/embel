import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { guidedTurnOperation } from "@/domain/guided-interview";
import {
  STRATEGY_ASSISTANT_HISTORY_MAX_BYTES,
  STRATEGY_ASSISTANT_HISTORY_MAX_ENTRIES,
  strategyAssistantHistorySchema,
  strategyJobInputSchema,
  strategyJobResultSchema,
  strategyOperationSchema,
  type StrategyAssistantHistory,
  type StrategyOperation,
  type StrategyOverview,
} from "@/domain/strategy-jobs";
import type { AuthenticatedContext } from "../auth/context";
import { guidedStrategyPolicy, OPENAI_STRATEGY_MODEL } from "../ai/config";
import { getProject } from "../data/projects";
import { ApiError } from "../http/errors";
import { enabledGenerationKinds } from "./runs";

// Strategy on the generation engine (docs/generation-engine.md, step 2). Each Strategy
// operation is a generation kind of the same name. This module runs with the person's
// own login: it decides whether the engine path is on and freezes each run's input.

export const STRATEGY_OPERATIONS = strategyOperationSchema.options;

/** The guided policy the hosted Strategy lane uses: model, token, search and price limits. */
export function engineStrategyPolicy(operation: StrategyOperation) {
  return guidedStrategyPolicy(operation, OPENAI_STRATEGY_MODEL);
}
export function enginePolicyIdentity(operation: StrategyOperation): string {
  return createHash("sha256")
    .update(JSON.stringify(engineStrategyPolicy(operation)))
    .digest("hex");
}

/** A run's frozen input: the project revision it answers and the exact Strategy request
 * (version 3, the uncapped guided contract) that a retry or replay sends again. */
export const strategyRunInputSchema = z
  .strictObject({
    revision: z.number().int().positive(),
    request: strategyJobInputSchema,
  })
  .refine((value) => value.request.version === 3, {
    message: "Engine Strategy runs use the uncapped guided contract",
    path: ["request", "version"],
  });
export type StrategyRunInput = z.infer<typeof strategyRunInputSchema>;

/**
 * The engine path is on only when every Strategy kind is enabled, so one switch moves the
 * whole step and turning any kind off returns it to the old path. Any failure to read the
 * catalog (including a database without the engine yet) keeps the old path.
 */
export async function strategyEngineEnabled(auth: AuthenticatedContext): Promise<boolean> {
  try {
    const enabled = await enabledGenerationKinds(auth);
    return STRATEGY_OPERATIONS.every((operation) => enabled.has(operation));
  } catch {
    return false;
  }
}

/** Every operation is offered while the engine is on; credits and limits are checked at admission. */
export function engineStrategyAvailability(): StrategyOverview["availability"] {
  return {
    status: "available",
    operations: STRATEGY_OPERATIONS.map((operation) => ({
      operation,
      billingMode: "openai_api" as const,
      spendControl: "uncapped" as const,
      policyIdentity: enginePolicyIdentity(operation),
      interviewVersion: 1 as const,
    })),
  };
}

export async function assertOwnedProject(auth: AuthenticatedContext, projectId: string) {
  if (!z.uuid().safeParse(projectId).success) throw new ApiError("not_found");
  const { data, error } = await auth.client
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("owner_id", auth.userId)
    .is("deleted_at", null)
    .is("deletion_requested_at", null)
    .maybeSingle();
  if (error) throw new ApiError("integration_unavailable");
  if (!data) throw new ApiError("not_found");
}

type HistoryEntry = StrategyAssistantHistory["entries"][number];
const readFailure = (error: unknown) => {
  if (error) throw new ApiError("integration_unavailable");
};

/** Earlier Strategy replies from the old job system, for projects that started there. */
async function legacyReplies(auth: AuthenticatedContext, projectId: string, revision: number): Promise<HistoryEntry[]> {
  const jobs = await auth.client
    .from("jobs")
    .select("id,owner_id,project_id,operation,input_revision")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .eq("state", "succeeded")
    .lt("input_revision", revision)
    .in("operation", [...STRATEGY_OPERATIONS])
    .order("finished_at", { ascending: false })
    .limit(20);
  readFailure(jobs.error);
  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        owner_id: z.uuid(),
        project_id: z.uuid(),
        operation: strategyOperationSchema,
        input_revision: z.number().int().positive(),
      }),
    )
    .parse(jobs.data ?? []);
  if (!rows.length) return [];
  const steps = await auth.client
    .from("job_steps")
    .select("job_id,step_key,output,completed_at")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .eq("state", "succeeded")
    .in(
      "job_id",
      rows.map((row) => row.id),
    )
    .limit(100);
  readFailure(steps.error);
  return z
    .array(
      z.object({ job_id: z.uuid(), step_key: z.string(), output: z.unknown(), completed_at: z.string().nullable() }),
    )
    .parse(steps.data ?? [])
    .flatMap((step) => {
      const job = rows.find((row) => row.id === step.job_id);
      const output = strategyJobResultSchema.safeParse(step.output);
      if (!job || !output.success || output.data.operation !== job.operation || !step.completed_at) return [];
      return [
        {
          jobId: job.id,
          ownerId: job.owner_id,
          projectId: job.project_id,
          stepKey: step.step_key,
          inputRevision: job.input_revision,
          completedAt: step.completed_at,
          output: output.data,
        },
      ];
    });
}

/** Earlier Strategy replies from engine runs. */
async function engineReplies(auth: AuthenticatedContext, projectId: string, revision: number): Promise<HistoryEntry[]> {
  const runs = await auth.client
    .from("generation_runs")
    .select("id,owner_id,project_id,kind,input_revision:input->revision")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .eq("status", "succeeded")
    .like("kind", "strategy.%")
    .order("finished_at", { ascending: false })
    .limit(20);
  readFailure(runs.error);
  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        owner_id: z.uuid(),
        project_id: z.uuid(),
        kind: z.string(),
        input_revision: z.unknown(),
      }),
    )
    .parse(runs.data ?? [])
    .flatMap((row) =>
      typeof row.input_revision === "number" && row.input_revision < revision
        ? [{ ...row, input_revision: row.input_revision }]
        : [],
    );
  if (!rows.length) return [];
  const outputs = await auth.client
    .from("generation_outputs")
    .select("run_id,output_key,output,created_at")
    .eq("owner_id", auth.userId)
    .eq("output_key", "result")
    .in(
      "run_id",
      rows.map((row) => row.id),
    )
    .limit(20);
  readFailure(outputs.error);
  return z
    .array(z.object({ run_id: z.uuid(), output_key: z.string(), output: z.unknown(), created_at: z.string() }))
    .parse(outputs.data ?? [])
    .flatMap((item) => {
      const run = rows.find((row) => row.id === item.run_id);
      const output = strategyJobResultSchema.safeParse(item.output);
      if (!run || !output.success || output.data.operation !== run.kind) return [];
      return [
        {
          jobId: run.id,
          ownerId: run.owner_id,
          projectId: run.project_id,
          stepKey: item.output_key,
          inputRevision: run.input_revision,
          completedAt: item.created_at,
          output: output.data,
        },
      ];
    });
}

/** The results of this project's competitor research runs on the engine, so the
 * competitor-icon route can check which websites the project's research named.
 * Owner-scoped reads only; nothing is started or changed. */
export async function engineCompetitorResults(auth: AuthenticatedContext, projectId: string): Promise<unknown[]> {
  const runs = await auth.client
    .from("generation_runs")
    .select("id")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .eq("status", "succeeded")
    .eq("kind", "strategy.competitors")
    .order("finished_at", { ascending: false })
    .limit(20);
  readFailure(runs.error);
  const ids = z
    .array(z.object({ id: z.uuid() }))
    .parse(runs.data ?? [])
    .map((run) => run.id);
  if (!ids.length) return [];
  const outputs = await auth.client
    .from("generation_outputs")
    .select("output")
    .eq("owner_id", auth.userId)
    .eq("output_key", "result")
    .in("run_id", ids)
    .limit(20);
  readFailure(outputs.error);
  return z
    .array(z.object({ output: z.unknown() }))
    .parse(outputs.data ?? [])
    .map((row) => row.output);
}

// start_generation accepts at most 64 KiB of input. Leave room for the jsonb encoding.
const INPUT_BUDGET_BYTES = 56_000;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * The newest five earlier replies, newest first, within 32 KiB and the input budget, the
 * way fluid_private.guided_api_strategy_input selects them for the old path. The model uses
 * them to read the latest message; an accepted answer may only pick options they contain.
 */
export function selectAssistantHistory(
  candidates: readonly HistoryEntry[],
  base: Record<string, unknown>,
): StrategyAssistantHistory {
  const sorted = [...candidates].sort(
    (a, b) =>
      Date.parse(b.completedAt) - Date.parse(a.completedAt) ||
      b.jobId.localeCompare(a.jobId) ||
      b.stepKey.localeCompare(a.stepKey),
  );
  let history: StrategyAssistantHistory = { entries: [], truncated: false };
  for (const entry of sorted) {
    if (history.entries.length >= STRATEGY_ASSISTANT_HISTORY_MAX_ENTRIES) {
      history = { ...history, truncated: true };
      break;
    }
    const next = { ...history, entries: [...history.entries, entry] };
    if (
      bytes(next) <= STRATEGY_ASSISTANT_HISTORY_MAX_BYTES &&
      bytes({ ...base, assistantHistory: next }) <= INPUT_BUDGET_BYTES
    )
      history = next;
    else history = { ...history, truncated: true };
  }
  return strategyAssistantHistorySchema.parse(history);
}

/**
 * Freezes what one Strategy run sends, from the person's own saved data: the context of the
 * revision whose latest guided turn asks for this operation, the hosted policy, and earlier
 * replies. The browser only names the revision. Whatever a direct API caller puts in a run's
 * input instead, the workflow re-checks the policy and the turn, and the result only reaches
 * that caller's own project, which they can already edit.
 */
export async function buildStrategyRunInput(
  auth: AuthenticatedContext,
  projectId: string,
  operation: StrategyOperation,
  raw: unknown,
): Promise<StrategyRunInput> {
  const parsed = z.strictObject({ expectedRevision: z.number().int().positive() }).safeParse(raw);
  if (!parsed.success) throw new ApiError("invalid_input");
  const revision = parsed.data.expectedRevision;
  const project = await getProject(auth, projectId);
  if (project.current_revision !== revision) throw new ApiError("conflict");
  const context = project.context;
  const state = context.intake.guidedInterview;
  const turn = state?.turns.at(-1);
  if (
    !state ||
    !turn ||
    state.stage === "complete" ||
    turn.stage !== state.stage ||
    turn.inputRevision !== revision ||
    guidedTurnOperation(turn) !== operation ||
    state.answers.some((answer) => answer.turnId === turn.id)
  )
    throw new ApiError("conflict");
  const policy = engineStrategyPolicy(operation);
  const base = {
    version: 3 as const,
    context,
    policy,
    spendControl: "uncapped" as const,
    policyIdentity: enginePolicyIdentity(operation),
  };
  const candidates = [
    ...(await legacyReplies(auth, projectId, revision)),
    ...(await engineReplies(auth, projectId, revision)),
  ];
  const input = strategyRunInputSchema.safeParse({
    revision,
    request: { ...base, assistantHistory: selectAssistantHistory(candidates, base) },
  });
  if (!input.success) throw new ApiError("invalid_input");
  return input.data;
}
