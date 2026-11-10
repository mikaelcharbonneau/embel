import { z } from "zod";

const knownCodes = ["weak_password", "same_password", "recovery_required", "auth_rate_limited", "integration_unavailable", "invalid_input", "forbidden_origin"] as const;
type KnownCode = (typeof knownCodes)[number];
const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });

export class PasswordResetRequestError extends Error {
  constructor(readonly status: number, readonly code: KnownCode | null = null) {
    super("The password request could not be completed.");
    this.name = "PasswordResetRequestError";
  }
}

/** Only an allowlisted error code is read from a failure; provider text never enters state. */
async function post(path: string, body: string, success: z.ZodType): Promise<void> {
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" }, body,
  });
  let value: unknown;
  try { value = await response.json(); } catch { throw new PasswordResetRequestError(response.ok ? 502 : response.status); }
  if (!response.ok) {
    const code = errorBodySchema.safeParse(value).data?.error.code;
    throw new PasswordResetRequestError(response.status, knownCodes.find(known => known === code) ?? null);
  }
  if (!success.safeParse(value).success) throw new PasswordResetRequestError(502);
}

export function requestPasswordResetEmail(email: string): Promise<void> {
  return post("/api/auth/password-reset", JSON.stringify({ email }), z.strictObject({ requested: z.literal(true) }));
}

export function saveNewPassword(password: string): Promise<void> {
  return post("/api/auth/password", JSON.stringify({ password }), z.strictObject({ updated: z.literal(true) }));
}

export function resetEmailErrorMessage(error: unknown): string {
  if (error instanceof PasswordResetRequestError) {
    if (error.status === 429) return "Too many reset requests. Wait a few minutes before asking for another link.";
    if (error.status === 503) return "Password reset is unavailable right now. Please try again shortly.";
    if (error.status === 403) return "This request couldn't be verified. Refresh the page and try again.";
    if (error.status === 413 || error.status === 422) return "Enter a valid email address.";
  }
  return "The reset link couldn't be requested. Check your connection and try again.";
}

export function newPasswordErrorMessage(error: unknown): string {
  if (error instanceof PasswordResetRequestError) {
    if (error.code === "recovery_required") return "This reset link has expired or was already used. Request a new link to continue.";
    if (error.code === "weak_password") return "Choose a stronger password. Avoid common passwords and ones exposed in data breaches.";
    if (error.code === "same_password") return "Choose a password you haven't used for this account.";
    if (error.status === 429) return "Too many attempts. Wait a few minutes before trying again.";
    if (error.status === 503) return "Password changes are unavailable right now. Please try again shortly.";
    if (error.status === 403) return "This request couldn't be verified. Refresh the page and try again.";
    if (error.status === 413 || error.status === 422) return "Use a password of at least 12 characters.";
  }
  return "Your password couldn't be saved. Check your connection and try again.";
}
