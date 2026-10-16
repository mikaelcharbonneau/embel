import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { contextSnapshotSchema, createProjectInputSchema } from "@/domain/projects";
import { accountProjectSchema, accountProjectSummarySchema, accountRevisionSchema, expandProjectInputSchema, updateProjectInputSchema } from "@/domain/project-api";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

const storedProjectSchema = accountProjectSummarySchema;
const storedRevisionSchema = accountRevisionSchema;
const projectColumns = "id,owner_id,scope,title,current_revision,created_at,deleted_at,lifecycle_version,deletion_requested_at";

/** Hash validated context, whose schema fixes key order and fills explicit defaults. */
function contextHash(context: z.output<typeof contextSnapshotSchema>): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

function databaseError(error: { code?: string } | null): void {
  if (!error) return;
  if (error.code === "P0002") throw new ApiError("not_found");
  if (error.code === "23505" || error.code === "40001" || error.code === "PT409") throw new ApiError("conflict");
  if (["23514", "23502", "22023"].includes(error.code ?? "")) throw new ApiError("invalid_input");
  throw new ApiError("integration_unavailable");
}

export async function listProjects(auth: AuthenticatedContext) {
  const { data, error } = await auth.client.from("projects").select(projectColumns)
    .eq("owner_id", auth.userId).is("deleted_at", null).is("deletion_requested_at", null).order("created_at", { ascending: false }).limit(100);
  databaseError(error);
  return z.array(storedProjectSchema).parse(data);
}

export async function getProject(auth: AuthenticatedContext, projectId: string) {
  if (!z.uuid().safeParse(projectId).success) throw new ApiError("not_found");
  const { data, error } = await auth.client.from("projects").select(projectColumns)
    .eq("id", projectId).eq("owner_id", auth.userId).is("deleted_at", null).is("deletion_requested_at", null).maybeSingle();
  databaseError(error);
  if (!data) throw new ApiError("not_found");
  const project = storedProjectSchema.parse(data);
  const revisionResult = await auth.client.from("project_revisions").select("project_id,owner_id,revision,context,input_hash,created_at")
    .eq("project_id", project.id).eq("owner_id", auth.userId).eq("revision", project.current_revision).maybeSingle();
  databaseError(revisionResult.error);
  if (!revisionResult.data) throw new ApiError("not_found");
  return { ...project, context: storedRevisionSchema.parse(revisionResult.data).context };
}

export async function createProject(auth: AuthenticatedContext, input: unknown) {
  const parsed = createProjectInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  const { title, scope, context, requestKey } = parsed.data;
  const { data, error } = await auth.client.rpc(requestKey ? "create_project_with_request" : "create_project", {
    p_scope: scope, p_title: title, p_context: context, p_input_hash: contextHash(context),
    ...(requestKey ? { p_request_key: requestKey } : {}),
  }).single();
  databaseError(error);
  // A replay can recover a project edited since creation. Its current context
  // and revision are read together by the RPC, never reconstructed from input.
  if (requestKey) {
    const project = accountProjectSchema.parse(data);
    if (project.owner_id !== auth.userId) throw new ApiError("not_found");
    return project;
  }
  return { ...storedProjectSchema.parse(data), context };
}

export async function appendProjectRevision(auth: AuthenticatedContext, input: unknown) {
  const parsed = updateProjectInputSchema.extend({ projectId: z.uuid() }).safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  const { projectId, expectedRevision, context, title } = parsed.data;
  const { data, error } = await auth.client.rpc("append_project_revision", {
    p_project_id: projectId, p_expected_revision: expectedRevision, p_context: context, p_input_hash: contextHash(context),
    ...(title === undefined ? {} : { p_title: title }),
  }).single();
  databaseError(error);
  return storedRevisionSchema.parse(data);
}

export async function expandProject(auth: AuthenticatedContext, projectId: string, input: unknown) {
  if (!z.uuid().safeParse(projectId).success) throw new ApiError("not_found");
  const parsed = expandProjectInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  // The RPC copies only the current persisted revision, under the project lock.
  const { data, error } = await auth.client.rpc("expand_project_scope", {
    p_project_id: projectId, p_expected_revision: parsed.data.expectedRevision,
  }).single();
  databaseError(error);
  return accountProjectSchema.parse(data);
}

