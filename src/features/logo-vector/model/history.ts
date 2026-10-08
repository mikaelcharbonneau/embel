import { z } from "zod";
import { boundedLogoJson, logoCounterSchema, logoRasterSourceSchema, logoRevisionRefSchema, logoScopeShape, logoTimestampSchema, logoUuidSchema, uniqueLogoValues } from "../../../domain/logo-vector";

// A compact discovery projection, never geometry, approval evidence or a new
// persisted vector schema. State markers describe one authoritative workspace
// revision. A later-page cursor is invalidated when that revision changes.
export const LOGO_VECTOR_HISTORY_MAX_BYTES = 65_536;
export const logoVectorHistoryCursorSchema = z.string().min(4).max(2048).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const logoVectorHistoryQuerySchema = z.strictObject({ cursor: logoVectorHistoryCursorSchema.optional(), limit: z.number().int().min(1).max(50).default(20) });
export type LogoVectorHistoryQuery = z.input<typeof logoVectorHistoryQuerySchema>;
export const logoVectorHistoryItemSchema = z.strictObject({
  vectorRevisionId: logoUuidSchema,
  parentRevisionId: logoUuidSchema.nullable(),
  createdAt: logoTimestampSchema,
  source: logoRasterSourceSchema,
  lockCount: z.number().int().min(0).max(64),
  selection: z.enum(["current", "retained"]),
  acceptance: z.enum(["approved", "previously_accepted", "unaccepted"]),
  earlierInputs: z.boolean(),
  cancellation: z.enum(["none", "requested", "cancelled"]),
  stageRevision: logoRevisionRefSchema.refine(value => value.stage === "vector" || value.stage === "refinements", "A vector restore must name a vector-bearing stage").nullable(),
}).refine(value => value.parentRevisionId !== value.vectorRevisionId, "A vector cannot be its own parent");
export type LogoVectorHistoryItem = z.infer<typeof logoVectorHistoryItemSchema>;
export const logoVectorHistoryPageSchema = boundedLogoJson(z.strictObject({
  ...logoScopeShape,
  workspaceRevision: logoCounterSchema,
  items: z.array(logoVectorHistoryItemSchema).max(50),
  nextCursor: logoVectorHistoryCursorSchema.nullable(),
}).refine(value => uniqueLogoValues(value.items.map(item => item.vectorRevisionId))
  && value.items.filter(item => item.selection === "current").length <= 1
  && value.items.filter(item => item.acceptance === "approved").length <= 1
  && (value.nextCursor === null || value.items.length > 0), "History must contain unique immutable vectors and consistent state markers"), LOGO_VECTOR_HISTORY_MAX_BYTES);
export type LogoVectorHistoryPage = z.infer<typeof logoVectorHistoryPageSchema>;
