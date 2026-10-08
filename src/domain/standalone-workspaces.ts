import { z } from "zod";

/** Shared user-draft envelope. Provider evidence is never writable through this API. */
export const STANDALONE_MUTATION_MAX_BYTES = 131_072;
export const standaloneToolSchema = z.enum(["domains", "handles", "trademarks"]);
export type StandaloneTool = z.infer<typeof standaloneToolSchema>;
const revisionSchema = z.number().int().positive().max(2_147_483_647);
const uuid = z.uuid().transform(value => value.toLowerCase());
export const standaloneImportSelectionSchema = z.strictObject({ projectId: uuid, projectRevision: revisionSchema, selectionId: uuid.nullable() });
export type StandaloneImportSelection = z.infer<typeof standaloneImportSelectionSchema>;
export const standaloneImportSourceSchema = standaloneImportSelectionSchema.extend({
  projectTitle: z.string().trim().min(1).max(160), name: z.string().trim().min(1).max(160),
  candidateId: uuid.nullable(), origin: z.enum(["project_name", "naming_selection"]),
}).superRefine((source, ctx) => {
  if ((source.origin === "naming_selection") !== (source.selectionId !== null && source.candidateId !== null) ||
      (source.origin === "project_name" && (source.selectionId !== null || source.candidateId !== null))) {
    ctx.addIssue({ code: "custom", message: "Imported provenance must bind the saved name and selection" });
  }
});
export type StandaloneImportSource = z.infer<typeof standaloneImportSourceSchema>;
export const standaloneImportResponseSchema = z.strictObject({ ownerId: uuid, source: standaloneImportSourceSchema.nullable() });
export type StandaloneImportResponse = z.infer<typeof standaloneImportResponseSchema>;
export const standaloneImportKey = (source: StandaloneImportSelection) => `${source.projectId.toLowerCase()}:${source.projectRevision}:${source.selectionId?.toLowerCase() ?? "project"}`;
const uniqueImports = <T extends StandaloneImportSelection>(imports: T[]) => new Set(imports.map(standaloneImportKey)).size === imports.length;

/** Feature-owned strict schema. Only bounded user-authored drafts belong here. */
export type StandalonePayloadCodec<T = unknown> = { tool: StandaloneTool; schema: z.ZodType<T> };
export const saveStandaloneWorkspaceInputSchema = z.strictObject({
  requestKey: uuid, expectedRevision: z.number().int().nonnegative().max(2_147_483_646), payload: z.unknown(),
  imports: z.array(standaloneImportSelectionSchema).max(30).refine(uniqueImports, "Duplicate import selection"),
});
export type SaveStandaloneWorkspaceInput = z.infer<typeof saveStandaloneWorkspaceInputSchema>;
export type StandaloneWorkspace<T = unknown> = { id: string; ownerId: string; tool: StandaloneTool; revision: number; payload: T;
  imports: StandaloneImportSource[]; createdAt: string; updatedAt: string };
export type StandaloneWorkspaceResponse<T = unknown> = { ownerId: string; workspace: StandaloneWorkspace<T> | null };
export function standaloneWorkspaceSchema<T>(codec: StandalonePayloadCodec<T>) {
  return z.strictObject({ id: uuid, ownerId: uuid, tool: z.literal(codec.tool), revision: revisionSchema, payload: codec.schema,
    imports: z.array(standaloneImportSourceSchema).max(30).refine(uniqueImports, "Duplicate import source"),
    createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
  });
}
export function standaloneWorkspaceResponseSchema<T>(codec: StandalonePayloadCodec<T>) {
  return z.strictObject({ ownerId: uuid, workspace: standaloneWorkspaceSchema(codec).nullable() }).superRefine((value, ctx) => {
    if (value.workspace && value.workspace.ownerId !== value.ownerId) ctx.addIssue({ code: "custom", message: "Workspace must belong to response owner" });
  });
}
