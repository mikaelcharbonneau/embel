import "server-only";
import { z } from "zod";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { standalonePromotionSnapshotResponseSchema } from "@/features/brand-lifecycle/source-snapshot";
import { requestLookupSchema } from "@/domain/attachments";
import { attachIdeaToProjectInputSchema, ideaProjectAttachmentOutcomeSchema, ideaProjectAttachmentPageSchema } from "@/domain/idea-project-attachment";
import { standalonePromotionInputSchema, standalonePromotionReceiptSchema, standalonePromotionSourceSchema } from "@/domain/standalone-promotion";

const id = (value: string) => { const parsed = z.uuid().safeParse(value); if (!parsed.success) throw new ApiError("not_found"); return parsed.data.toLowerCase(); };
function parse<T>(schema: z.ZodType<T>, value: unknown, stored = false): T { const result = schema.safeParse(value); if (!result.success) throw new ApiError(stored ? "integration_unavailable" : "invalid_input"); return result.data; }
async function rpc(auth: AuthenticatedContext, name: string, args: Record<string, unknown>): Promise<unknown> {
 const response = await Promise.resolve(auth.client.rpc(name, args)).catch(() => { throw new ApiError("integration_unavailable"); });
 if (response.error) {
  const code = response.error.code;
  if (code === "P0002") throw new ApiError("not_found");
  if (["23505", "40001", "PT409"].includes(code)) throw new ApiError("conflict");
  if (["22023", "22P02", "23514", "23502"].includes(code)) throw new ApiError("invalid_input");
  if (code === "42501") throw new ApiError("unauthenticated");
  throw new ApiError("integration_unavailable");
 }
 return response.data;
}
function owned(auth: AuthenticatedContext, value: { ownerId: string }) { if (value.ownerId !== auth.userId.toLowerCase()) throw new ApiError("integration_unavailable"); }
function bounded<T>(schema: z.ZodType<T>, input: unknown): T {
 const result = parse(schema, input); if (Buffer.byteLength(JSON.stringify(result), "utf8") > 32_768) throw new ApiError("body_too_large"); return result;
}
export async function attachIdeaToProject(auth: AuthenticatedContext, ideaId: string, raw: unknown) {
 const input = bounded(attachIdeaToProjectInputSchema, raw);
 if (id(ideaId) !== input.ideaId) throw new ApiError("invalid_input");
 const receipt = parse(ideaProjectAttachmentOutcomeSchema, await rpc(auth, "attach_idea_to_project", { p_input: input }), true); owned(auth, receipt);
 if (receipt.requestKey !== input.requestKey || JSON.stringify(receipt.input) !== JSON.stringify(input)) throw new ApiError("integration_unavailable");
 return receipt;
}
async function readRequest<T extends { ownerId: string; requestKey: string }>(auth: AuthenticatedContext, name: string, key: string, schema: z.ZodType<T>) {
 key = id(key); const lookup = parse(requestLookupSchema(schema), await rpc(auth, name, { p_request_key: key }), true);
 if (lookup.status === "committed") { owned(auth, lookup.receipt); if (lookup.receipt.requestKey !== key) throw new ApiError("integration_unavailable"); }
 if (lookup.status === "pending" && lookup.requestKey !== key) throw new ApiError("integration_unavailable"); return lookup;
}
export const readIdeaProjectAttachmentRequest = (auth: AuthenticatedContext, requestKey: string) => readRequest(auth, "read_idea_project_attachment_request", requestKey, ideaProjectAttachmentOutcomeSchema);
export async function getProjectIdeaAttachments(auth: AuthenticatedContext, projectId: string, query: { cursor?: string; limit?: number } = {}) {
 projectId = id(projectId); const { cursor, limit } = parse(z.strictObject({ cursor: z.uuid().optional(), limit: z.number().int().min(1).max(50).default(20) }), query);
 const page = parse(ideaProjectAttachmentPageSchema, await rpc(auth, "get_project_idea_attachments", { p_project_id: projectId, p_cursor: cursor ?? null, p_limit: limit }), true); owned(auth, page);
 if (page.projectId !== projectId || page.items.length > limit || (page.nextCursor && (page.items.length !== limit || page.nextCursor === cursor || page.nextCursor !== page.items.at(-1)?.association.id))) throw new ApiError("integration_unavailable"); return page;
}
export async function promoteStandaloneWorkspace(auth: AuthenticatedContext, raw: unknown) {
 const input = bounded(standalonePromotionInputSchema, raw);
 // An account project normalizes title whitespace. Reject ambiguity before writing.
 if (input.title !== input.title.trim()) throw new ApiError("invalid_input");
 const receipt = parse(standalonePromotionReceiptSchema, await rpc(auth, "promote_standalone_workspace", { p_input: input }), true); owned(auth, receipt);
 const s = receipt.source, choice = input.contextSource;
 if (receipt.requestKey !== input.requestKey || receipt.project.current_revision !== 1 || receipt.project.title !== input.title || s.workspaceId !== input.workspaceId || s.workspaceRevision !== input.expectedWorkspaceRevision || JSON.stringify(s.selection) !== JSON.stringify(input.selection) ||
  (choice === null ? s.contextSource !== null : !s.contextSource || s.contextSource.projectId !== choice.projectId || s.contextSource.projectRevision !== choice.projectRevision || s.contextSource.selectionId !== choice.selectionId)) throw new ApiError("integration_unavailable");
 return receipt;
}
export const readStandalonePromotionRequest = (auth: AuthenticatedContext, requestKey: string) => readRequest(auth, "read_standalone_promotion_request", requestKey, standalonePromotionReceiptSchema);
export async function getStandalonePromotionSource(auth: AuthenticatedContext, projectId: string) {
 projectId = id(projectId);
 const result = parse(z.strictObject({ ownerId: z.uuid(), projectId: z.uuid(), source: standalonePromotionSourceSchema.nullable() }), await rpc(auth, "get_standalone_promotion_source", { p_project_id: projectId }), true); owned(auth, result);
 if (result.projectId !== projectId || (result.source && result.source.ownerId !== result.ownerId)) throw new ApiError("integration_unavailable"); return result;
}

/** Inspects saved manual inputs only, never current workspace edits or provider claims. */
export async function getStandalonePromotionSnapshot(auth: AuthenticatedContext, projectId: string) {
 projectId = id(projectId);
 const result = parse(standalonePromotionSnapshotResponseSchema, await rpc(auth, "get_standalone_promotion_snapshot", { p_project_id: projectId }), true); owned(auth, result);
 if (result.projectId !== projectId) throw new ApiError("integration_unavailable"); return result;
}
