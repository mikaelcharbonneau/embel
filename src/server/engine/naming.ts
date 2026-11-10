import "server-only";
import { z } from "zod";
import { getNamingPreferencesReadiness, namingPreferencesV2Schema } from "@/domain/naming-brain-preferences";
import {
  namingBriefSchema,
  namingGenerationPolicySchema,
  namingRunKindSchema,
  startNamingRunRequestSchema,
  type NamingGenerationPolicy,
  type StartNamingRunRequest,
} from "@/domain/naming-generation";
import { namingStrategyBasis } from "@/domain/project-naming";
import type { AuthenticatedContext } from "../auth/context";
import { OPENAI_NAMING_MODEL } from "../ai/config";
import { getProject } from "../data/projects";
import { ApiError } from "../http/errors";
import { enabledGenerationKinds } from "./runs";

// Naming on the generation engine (docs/generation-engine.md, step 3). One kind runs every
// Naming request (first names, More names and steering). This module runs with the person's
// own login: it decides whether the engine path is on and freezes each run's input.

export const NAMING_KIND = "naming.generate";
/** The newest identities a run is told to avoid. SQL still skips every name already in the project. */
export const NAMING_FROZEN_EXCLUSIONS = 1_000;
// start_generation accepts at most 64 KiB of input. Leave room for the jsonb encoding.
const INPUT_BUDGET_BYTES = 56_000;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** The same policy as the Naming worker lane in production: gpt-6-luna with low reasoning. */
export function namingEnginePolicy(): NamingGenerationPolicy {
  return namingGenerationPolicySchema.parse({
    version: 2,
    operation: NAMING_KIND,
    model: OPENAI_NAMING_MODEL,
    reasoningEffort: "low",
  });
}

/** What the browser names: the kind of request and the saved versions it was made against. */
export const namingEngineRequestSchema = z
  .strictObject({
    kind: namingRunKindSchema,
    expectedProjectRevision: z.number().int().positive(),
    expectedPreferencesVersion: z.number().int().positive(),
    seedIds: z.array(z.uuid()).max(5),
    instruction: z.string().trim().min(1).max(2000).nullable(),
  })
  .refine(
    (value) =>
      value.kind === "steer"
        ? value.seedIds.length > 0 || value.instruction !== null
        : value.seedIds.length === 0 && value.instruction === null,
    "Only a steered run carries seed names or an instruction",
  )
  .refine((value) => new Set(value.seedIds).size === value.seedIds.length, "Seed names must be distinct");
export type NamingEngineRequest = z.infer<typeof namingEngineRequestSchema>;

/** The engine request a Naming screen request stands for; the idempotency key stays the screen's. */
export function namingEngineRequest(request: StartNamingRunRequest): NamingEngineRequest {
  const parsed = startNamingRunRequestSchema.parse(request);
  return {
    kind: parsed.kind,
    expectedProjectRevision: parsed.expectedProjectRevision,
    expectedPreferencesVersion: parsed.expectedPreferencesVersion,
    seedIds: parsed.seedIds,
    instruction: parsed.instruction,
  };
}

/** A run's frozen input. `exclusions` are the project's newest name identities, oldest first. */
export const namingRunInputSchema = z
  .strictObject({
    version: z.literal(1),
    kind: namingRunKindSchema,
    revision: z.number().int().positive(),
    policy: namingGenerationPolicySchema,
    brief: namingBriefSchema,
    exclusions: z.array(z.string().min(1).max(320)).max(NAMING_FROZEN_EXCLUSIONS),
  })
  .refine((value) => value.brief.contextRevision === value.revision, {
    message: "The brief answers the run's revision",
    path: ["brief", "contextRevision"],
  })
  .refine(
    (value) =>
      (value.kind === "steer") === (value.brief.strongSeeds.length > 0 || value.brief.steeringInstruction !== null),
    { message: "Only a steered run carries seed names or an instruction", path: ["kind"] },
  );
export type NamingRunInput = z.infer<typeof namingRunInputSchema>;

/** The engine path is on while naming.generate is enabled. Any failure to read the catalog
 * (including a database without the engine yet) keeps the old path. */
export async function namingEngineEnabled(auth: AuthenticatedContext): Promise<boolean> {
  try {
    return (await enabledGenerationKinds(auth)).has(NAMING_KIND);
  } catch {
    return false;
  }
}

const readFailure = (error: unknown) => {
  if (error) throw new ApiError("integration_unavailable");
};
const owned = (
  auth: AuthenticatedContext,
  projectId: string,
  rows: readonly { owner_id: string; project_id: string }[],
) => {
  if (rows.some((row) => row.owner_id !== auth.userId || row.project_id !== projectId)) throw new ApiError("not_found");
};

const candidateRow = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  project_id: z.uuid(),
  value: z.string(),
  identity_key: z.string(),
  rationale: z.string(),
  created_at: z.string(),
});
const CANDIDATE_COLUMNS = "id,owner_id,project_id,value,identity_key,rationale,created_at";

/**
 * Freezes what one Naming run asks, from the person's own saved data, the way
 * start_naming_run does for the old path: the saved choices of the named version, the
 * strategy basis of the named project revision, up to 20 liked names, the steering seeds and
 * instruction, the 50 newest names to avoid repeating, and the newest name identities.
 * The browser only names the kind, the versions and the seed names.
 */
export async function buildNamingRunInput(
  auth: AuthenticatedContext,
  projectId: string,
  raw: unknown,
): Promise<NamingRunInput> {
  const parsed = namingEngineRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("invalid_naming_request");
  const request = parsed.data;
  const project = await getProject(auth, projectId);
  if (project.current_revision !== request.expectedProjectRevision) throw new ApiError("project_revision_changed");

  const session = await auth.client
    .from("naming_sessions")
    .select("owner_id,project_id,preferences_version")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .maybeSingle();
  readFailure(session.error);
  if (!session.data || session.data.preferences_version !== request.expectedPreferencesVersion)
    throw new ApiError("preferences_changed");
  owned(auth, projectId, [session.data]);
  const saved = await auth.client
    .from("naming_preferences")
    .select("owner_id,project_id,version,preferences")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .eq("version", request.expectedPreferencesVersion)
    .maybeSingle();
  readFailure(saved.error);
  if (!saved.data) throw new ApiError("preferences_changed");
  owned(auth, projectId, [saved.data]);
  const preferences = namingPreferencesV2Schema.safeParse(saved.data.preferences);
  if (!preferences.success || !getNamingPreferencesReadiness(preferences.data).ready)
    throw new ApiError("preferences_incomplete");

  const liked = await auth.client
    .from("name_retention")
    .select("owner_id,project_id,candidate_id,updated_at")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .eq("liked", true)
    .order("updated_at", { ascending: false })
    .order("candidate_id")
    .limit(20);
  readFailure(liked.error);
  const likedRows = z
    .array(z.object({ owner_id: z.uuid(), project_id: z.uuid(), candidate_id: z.uuid() }))
    .parse(liked.data ?? []);
  owned(auth, projectId, likedRows);
  const wanted = [...new Set([...likedRows.map((row) => row.candidate_id), ...request.seedIds])];
  const named = wanted.length
    ? await auth.client
        .from("name_candidates")
        .select(CANDIDATE_COLUMNS)
        .eq("owner_id", auth.userId)
        .eq("project_id", projectId)
        .in("id", wanted)
        .limit(wanted.length)
    : { data: [], error: null };
  readFailure(named.error);
  const byId = new Map(
    z
      .array(candidateRow)
      .parse(named.data ?? [])
      .map((row) => [row.id, row]),
  );
  owned(auth, projectId, [...byId.values()]);
  if (request.seedIds.some((id) => !byId.has(id))) throw new ApiError("invalid_naming_request");

  const recent = await auth.client
    .from("name_candidates")
    .select(CANDIDATE_COLUMNS)
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(NAMING_FROZEN_EXCLUSIONS);
  readFailure(recent.error);
  const recentRows = z.array(candidateRow).parse(recent.data ?? []);
  owned(auth, projectId, recentRows);

  const seeds = request.seedIds
    .map((id) => byId.get(id)!)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const brief = namingBriefSchema.safeParse({
    version: 1,
    contextRevision: project.current_revision,
    preferencesVersion: request.expectedPreferencesVersion,
    preferences: preferences.data,
    strategyBasis: namingStrategyBasis(project.context),
    likedExamples: likedRows.flatMap((row) =>
      byId.has(row.candidate_id) ? [{ value: byId.get(row.candidate_id)!.value }] : [],
    ),
    strongSeeds: seeds.map((row) => ({ value: row.value, rationale: row.rationale.slice(0, 2000) })),
    recentExamples: recentRows.slice(0, 50).map((row) => ({ value: row.value })),
    steeringInstruction: request.instruction,
  });
  if (!brief.success) throw new ApiError("invalid_naming_request");
  // Oldest first, so a request's exclusion hint keeps the newest names.
  let exclusions = [...new Set(recentRows.map((row) => row.identity_key).filter((key) => key.length > 0))].reverse();
  const build = () =>
    namingRunInputSchema.safeParse({
      version: 1,
      kind: request.kind,
      revision: project.current_revision,
      policy: namingEnginePolicy(),
      brief: brief.data,
      exclusions,
    });
  let input = build();
  while (input.success && bytes(input.data) > INPUT_BUDGET_BYTES && exclusions.length) {
    exclusions = exclusions.slice(Math.ceil(exclusions.length / 4));
    input = build();
  }
  if (!input.success || bytes(input.data) > INPUT_BUDGET_BYTES) throw new ApiError("invalid_naming_request");
  return input.data;
}
