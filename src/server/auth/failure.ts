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

/** Account-state answers stay hidden; only rate limits and outages are reported. */
export function passwordResetFailure(error: { status?: number; name?: string; code?: string }): ApiError | null {
  if (error.status === 429 || error.code === "over_email_send_rate_limit") return new ApiError("auth_rate_limited");
  if (["user_not_found", "email_not_confirmed", "user_banned"].includes(error.code ?? "")) return null;
  return new ApiError("integration_unavailable");
}

/** Password changes report only what the person can fix; provider text is never returned. */
export function passwordUpdateFailure(error: { status?: number; name?: string; code?: string }): ApiError {
  if (error.status === 429) return new ApiError("auth_rate_limited");
  if (error.code === "weak_password" || error.name === "AuthWeakPasswordError") return new ApiError("weak_password");
  if (error.code === "same_password") return new ApiError("same_password");
  if (error.code === "reauthentication_needed" || error.code === "session_not_found" || error.status === 401 || error.status === 403) {
    return new ApiError("recovery_required");
  }
  return new ApiError("integration_unavailable");
}

export function signUpFailure(error: { status?: number; name?: string; code?: string }): ApiError {
  const failure = authFailure(error);
  if (failure.code === "invalid_credentials" && ["email_address_not_authorized", "signup_disabled", "email_provider_disabled"].includes(error.code ?? "")) {
    return new ApiError("integration_unavailable");
  }
  return failure.code === "invalid_credentials" ? new ApiError("signup_failed") : failure;
}
