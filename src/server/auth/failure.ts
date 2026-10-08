import "server-only";
import { ApiError } from "../http/errors";

/** Provider diagnostics can contain credentials or identifiers; never return them. */
export function authFailure(error: { status?: number; name?: string }): ApiError {
  if (error.status === 429) return new ApiError("auth_rate_limited");
  if (error.name === "AuthRetryableFetchError" || (error.status ?? 0) >= 500 || error.status === 0) {
    return new ApiError("integration_unavailable");
  }
  return new ApiError("invalid_credentials");
}
