import "server-only";
import { z } from "zod";
import { logoHistoryCursorSchema, logoPageQuerySchema } from "@/domain/logo-workspace";
import { ApiError } from "./errors";

export function readLogoPageQuery(
  request: Request,
  history: true,
): { cursor?: z.infer<typeof logoHistoryCursorSchema>; limit: number };
export function readLogoPageQuery(request: Request, history?: false): z.infer<typeof logoPageQuerySchema>;
export function readLogoPageQuery(request: Request, history = false) {
  const search = new URL(request.url).search;
  if (search.length > 4096) throw new ApiError("invalid_input");
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    if (!["cursor", "limit"].includes(key) || params.getAll(key).length !== 1) throw new ApiError("invalid_input");
  }
  const cursor = params.get("cursor");
  const limit = params.get("limit");
  const input: Record<string, unknown> = {};
  if (limit !== null) {
    if (!/^[0-9]+$/.test(limit)) throw new ApiError("invalid_input");
    input.limit = Number(limit);
  }
  if (cursor !== null) {
    if (cursor.length > 2048) throw new ApiError("invalid_input");
    if (history) {
      try {
        input.cursor = JSON.parse(cursor);
      } catch {
        throw new ApiError("invalid_input");
      }
    } else input.cursor = cursor;
  }
  const schema = history
    ? z.strictObject({ cursor: logoHistoryCursorSchema.optional(), limit: z.number().int().min(1).max(50).default(20) })
    : logoPageQuerySchema;
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError("invalid_input");
  return result.data;
}
