import "server-only";

export type ApiErrorCode =
  | "unauthenticated" | "not_found" | "conflict" | "invalid_input"
  | "forbidden_origin" | "body_too_large" | "integration_unavailable" | "internal_error"
  | "invalid_credentials" | "signup_failed" | "auth_rate_limited" | "naming_history_capacity";

const failures = {
  unauthenticated: [401, "Sign in to continue."],
  not_found: [404, "This resource is unavailable."],
  naming_history_capacity: [409, "This project's naming history has reached the generation limit. Your saved names are preserved."],
  conflict: [409, "This request conflicts with the current state."],
  invalid_input: [422, "Check the submitted information."],
  forbidden_origin: [403, "This request origin is not allowed."],
  body_too_large: [413, "The request body is too large."],
  integration_unavailable: [503, "This integration is not configured or is unavailable."],
  internal_error: [500, "The request could not be completed."],
  invalid_credentials: [401, "The email and password could not be verified."],
  signup_failed: [422, "Account creation could not be completed with these details."],
  auth_rate_limited: [429, "Too many account attempts. Wait before trying again."],
} as const;

export class ApiError extends Error {
  readonly status: number;
  constructor(readonly code: ApiErrorCode) {
    const [status, message] = failures[code];
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function privateJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" },
  });
}

/** Never serialize provider/database errors, credentials, request bodies, or stack traces. */
export function errorResponse(error: unknown): Response {
  const safe = error instanceof ApiError ? error : new ApiError("internal_error");
  return privateJson({ error: { code: safe.code, message: safe.message } }, safe.status);
}
