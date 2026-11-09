import "server-only";

export type ApiErrorCode =
  | "unauthenticated" | "not_found" | "conflict" | "invalid_input"
  | "forbidden_origin" | "body_too_large" | "integration_unavailable" | "internal_error"
  | "invalid_credentials" | "signup_failed" | "auth_rate_limited" | "naming_history_capacity"
  | "naming_active" | "project_revision_changed" | "preferences_changed" | "preferences_incomplete"
  | "invalid_naming_request" | "naming_unavailable"
  | "weak_password" | "same_password" | "recovery_required";

const failures = {
  unauthenticated: [401, "Sign in to continue."],
  not_found: [404, "This resource is unavailable."],
  naming_history_capacity: [409, "This project's naming history has reached the generation limit. Your saved names are preserved."],
  naming_active: [409, "Names are already being generated for this project."],
  project_revision_changed: [409, "The project changed. Check the latest version before generating names."],
  preferences_changed: [409, "Your naming choices changed. Check them before generating names."],
  preferences_incomplete: [422, "Finish your naming choices before generating names."],
  invalid_naming_request: [422, "Check the naming request."],
  naming_unavailable: [503, "AI name generation is unavailable right now."],
  conflict: [409, "This request conflicts with the current state."],
  invalid_input: [422, "Check the submitted information."],
  forbidden_origin: [403, "This request origin is not allowed."],
  body_too_large: [413, "The request body is too large."],
  integration_unavailable: [503, "This integration is not configured or is unavailable."],
  internal_error: [500, "The request could not be completed."],
  invalid_credentials: [401, "The email and password could not be verified."],
  signup_failed: [422, "Account creation could not be completed with these details."],
  auth_rate_limited: [429, "Too many account attempts. Wait before trying again."],
  weak_password: [422, "Choose a stronger password. Avoid common passwords and ones exposed in data breaches."],
  same_password: [422, "Choose a password you haven't used for this account."],
  recovery_required: [403, "Open the newest password reset link from your email to set a new password."],
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

/** Never serialize provider/database errors, credentials, request bodies, or stack traces.
 * Unexpected errors and server-side failures (5xx) are logged without their messages. */
export function errorResponse(error: unknown): Response {
  const safe = error instanceof ApiError ? error : new ApiError("internal_error");
  if (!(error instanceof ApiError)) logServerError("api_unexpected_error", error);
  else if (error.status >= 500) logServerError("api_server_error", error);
  return privateJson({ error: { code: safe.code, message: safe.message } }, safe.status);
}

/** Short machine codes only, e.g. Postgres "23505", Node "ECONNRESET", PostgREST "PGRST116". */
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_FRAMES = 6;

/**
 * Writes one JSON line for a server failure so it appears in Vercel's runtime logs.
 * Messages, request paths, headers and bodies are never written: they can carry emails,
 * tokens, one-time codes or provider diagnostics. Only the error type, a short code and
 * the code locations ("at ..." stack frames) are kept. Logging can never throw.
 */
export function logServerError(event: string, error: unknown, details: Record<string, string | undefined> = {}): void {
  try {
    const name = error instanceof Error ? error.name : typeof error;
    const rawCode = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    const code = typeof rawCode === "string" && SAFE_CODE.test(rawCode) ? rawCode : undefined;
    const frames = error instanceof Error && typeof error.stack === "string"
      ? error.stack.split("\n").map(line => line.trim()).filter(line => line.startsWith("at ")).slice(0, MAX_FRAMES)
      : [];
    console.error(JSON.stringify({ event, name, code, ...details, frames }));
  } catch { /* A broken logger must never change the response. */ }
}
