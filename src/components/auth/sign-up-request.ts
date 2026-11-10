import { z } from "zod";

const successSchema = z.union([
  z.strictObject({ authenticated: z.literal(true) }),
  z.strictObject({ authenticated: z.literal(false), confirmationRequired: z.literal(true) }),
]);

export class SignUpRequestError extends Error {
  constructor(readonly status: number) {
    super("The account creation request could not be completed.");
    this.name = "SignUpRequestError";
  }
}

/** No response body, credential or provider diagnostic enters application state. */
export async function requestSignUp(
  body: string,
  action: "sign-up" | "resend-confirmation" = "sign-up",
): Promise<void | "confirmation_required"> {
  const response = await fetch(`/api/auth/${action}`, {
    method: "POST",
    credentials: "same-origin",
    mode: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body,
  });
  if (!response.ok) throw new SignUpRequestError(response.status);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new SignUpRequestError(502);
  }
  const result = successSchema.safeParse(value);
  if (!result.success || (action === "resend-confirmation" && result.data.authenticated))
    throw new SignUpRequestError(502);
  if (!result.data.authenticated) return "confirmation_required";
}

export function signUpErrorMessage(error: unknown): string {
  if (error instanceof SignUpRequestError) {
    if (error.status === 400) return "The security check didn't pass. Please try again.";
    if (error.status === 429) return "Too many account attempts. Wait a little before trying again.";
    if (error.status === 503)
      return "Account creation is unavailable right now. Your work is kept. Please try again shortly.";
    if (error.status === 403) return "This account request couldn't be verified. Refresh the page and try again.";
    if (error.status === 413 || error.status === 422)
      return "Account creation couldn't be completed with those details. Check your email and use a strong password of at least 12 characters.";
    if (error.status === 502)
      return "The account response couldn't be verified. Check your email or try signing in before trying again.";
  }
  return "Account creation couldn't be confirmed. Check your connection and email before trying again.";
}
