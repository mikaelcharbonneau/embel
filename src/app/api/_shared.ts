import { ApiError } from "@/server/http/errors";

export function throwDatabaseError(error: { code?: string } | null): void {
  if (!error) return;
  if (error.code === "P0002" || error.code === "PGRST116") throw new ApiError("not_found");
  if (error.code === "40001" || error.code === "23505") throw new ApiError("conflict");
  if (error.code === "23514" || error.code === "22023") throw new ApiError("invalid_input");
  throw new ApiError("internal_error");
}
