import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createIdeaBrandInputSchema, createIdeaInputSchema, IDEA_MUTATION_MAX_BYTES, ideaBrandResponseSchema, ideaPageSchema,
  ideaProjectInput, ideaRecordSchema, ideaSourceResponseSchema, listIdeasInputSchema, updateIdeaInputSchema } from "@/domain/ideas";
import { compareProjectCursors } from "@/domain/project-pages";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
function resourceId(id: string) {
  if (!z.uuid().safeParse(id).success) throw new ApiError("not_found");
  return id;
}
function inputValue<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  return parsed.data;
}
function mutationValue<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const value = inputValue(schema, input);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > IDEA_MUTATION_MAX_BYTES ||
      (typeof value === "object" && value !== null && "expectedRevision" in value && Number(value.expectedRevision) > 2_147_483_646)) throw new ApiError("invalid_input");
  return value;
}
function storedValue<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  return parsed.data;
}
function ownedRecord(auth: AuthenticatedContext, value: unknown, id?: string) {
  const idea = storedValue(ideaRecordSchema, value);
  if (!sameId(idea.ownerId, auth.userId) || (id && !sameId(idea.id, id))) throw new ApiError("integration_unavailable");
  return idea;
}
async function rpc(auth: AuthenticatedContext, name: string, params: Record<string, unknown>) {
  const result = await Promise.resolve(auth.client.rpc(name, params)).catch(() => { throw new ApiError("integration_unavailable"); });
  if (result.error) {
    const code = result.error.code;
    if (code === "P0002") throw new ApiError("not_found");
    if (["23505", "40001", "PT409"].includes(code)) throw new ApiError("conflict");
    if (["22023", "22003", "23514", "23502"].includes(code)) throw new ApiError("invalid_input");
    if (code === "42501") throw new ApiError("unauthenticated");
    throw new ApiError("integration_unavailable");
  }
  return result.data;
}

export async function listIdeas(auth: AuthenticatedContext, input: unknown) {
  const { cursor, limit, search, state } = inputValue(listIdeasInputSchema, input);
  const page = storedValue(ideaPageSchema, await rpc(auth, "list_ideas", { p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null, p_limit: limit, p_search: search, p_state: state ?? null }));
  if (!sameId(page.ownerId, auth.userId) || page.items.length > limit || (page.nextCursor && page.items.length !== limit) ||
      page.items.some(item => cursor && compareProjectCursors({ id: item.id, createdAt: item.createdAt }, cursor) >= 0)) throw new ApiError("integration_unavailable");
  return page;
}

export async function getIdea(auth: AuthenticatedContext, id: string) {
  resourceId(id);
  const data = await rpc(auth, "get_idea", { p_idea_id: id });
  if (data === null) throw new ApiError("not_found");
  return ownedRecord(auth, data, id);
}

export async function createIdea(auth: AuthenticatedContext, input: unknown) {
  const { requestKey, content } = mutationValue(createIdeaInputSchema, input);
  return ownedRecord(auth, await rpc(auth, "create_idea", { p_request_key: requestKey, p_content: content }));
}

export async function updateIdea(auth: AuthenticatedContext, id: string, input: unknown) {
  resourceId(id);
  const { requestKey, expectedRevision, content } = mutationValue(updateIdeaInputSchema, input);
  const idea = ownedRecord(auth, await rpc(auth, "update_idea", { p_idea_id: id, p_expected_revision: expectedRevision,
    p_request_key: requestKey, p_content: content }), id);
  if (idea.revision !== expectedRevision + 1 || JSON.stringify(idea.content) !== JSON.stringify(content)) throw new ApiError("integration_unavailable");
  return idea;
}

export async function getProjectIdeaSource(auth: AuthenticatedContext, projectId: string) {
  resourceId(projectId);
  const source = storedValue(ideaSourceResponseSchema, await rpc(auth, "get_project_idea_source", { p_project_id: projectId }));
  if (!sameId(source.ownerId, auth.userId) || !sameId(source.projectId, projectId)) throw new ApiError("integration_unavailable");
  return source;
}

export async function createIdeaBrand(auth: AuthenticatedContext, id: string, input: unknown) {
  resourceId(id);
  const { requestKey, expectedRevision } = mutationValue(createIdeaBrandInputSchema, input);
  const idea = await getIdea(auth, id);
  let content = idea.content;
  const replay = idea.links.find(link => sameId(link.requestKey, requestKey));
  if (replay) {
    if (replay.ideaRevision !== expectedRevision) throw new ApiError("conflict");
    const source = (await getProjectIdeaSource(auth, replay.projectId)).source;
    if (!source || JSON.stringify(source.link) !== JSON.stringify(replay)) throw new ApiError("integration_unavailable");
    content = source.content;
  }
  const { context } = ideaProjectInput(content);
  const result = storedValue(ideaBrandResponseSchema, await rpc(auth, "create_idea_brand", { p_idea_id: id,
    p_expected_revision: expectedRevision, p_request_key: requestKey, p_context: context,
    p_input_hash: createHash("sha256").update(JSON.stringify(context)).digest("hex") }));
  ownedRecord(auth, result.idea, id);
  if (!sameId(result.link.requestKey, requestKey) || result.link.ideaRevision !== expectedRevision || result.idea.revision <= expectedRevision ||
      !result.idea.links.some(link => JSON.stringify(link) === JSON.stringify(result.link))) throw new ApiError("integration_unavailable");
  return result;
}
