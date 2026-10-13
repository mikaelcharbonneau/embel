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

export function signUpFailure(error: { status?: number; name?: string; code?: string }): ApiError {
  const failure = authFailure(error);
  if (failure.code === "invalid_credentials" && ["email_address_not_authorized", "signup_disabled", "email_provider_disabled"].includes(error.code ?? "")) {
    return new ApiError("integration_unavailable");
  }
  return failure.code === "invalid_credentials" ? new ApiError("signup_failed") : failure;
}
