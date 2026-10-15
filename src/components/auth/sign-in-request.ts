import { z } from "zod";

const successSchema = z.strictObject({ authenticated: z.literal(true) });

export class SignInRequestError extends Error {
  constructor(readonly status: number) {
    super("The sign-in request could not be completed.");
    this.name = "SignInRequestError";
  }
}

/** Credentials exist only in this same-origin request. Error bodies are never echoed or logged. */
export async function requestSignIn(body: string): Promise<void> {
  const response = await fetch("/api/auth/sign-in", {
    method: "POST", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" }, body,
  });
  if (!response.ok) throw new SignInRequestError(response.status);
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new SignInRequestError(502); }
  if (!successSchema.safeParse(value).success) throw new SignInRequestError(502);
}

export function signInErrorMessage(error: unknown): string {
  if (error instanceof SignInRequestError) {
    if (error.status === 401) return "We couldn't sign you in with those details. Check your email and password and try again.";
    if (error.status === 429) return "Too many sign-in attempts. Wait a little before trying again.";
    if (error.status === 503) return "Sign-in is unavailable right now. Your work is kept. Please try again shortly.";
    if (error.status === 403) return "This sign-in request couldn't be verified. Refresh the page and try again.";
    if (error.status === 413 || error.status === 422) return "Check your email and password and try again.";
    if (error.status === 502) return "The sign-in response couldn't be verified. Check your account before trying again.";
  }
  return "Sign-in couldn't be completed. Check your connection and try again.";
}
