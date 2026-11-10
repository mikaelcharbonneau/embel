import "server-only";
import { createRouteAuthClient } from "./client";
import { ApiError } from "../http/errors";

/** Route handlers only: normal account APIs share provider-verified confirmation
 * checks, and refreshed cookies must be written to the response. */
export async function getVerifiedAccountContext(requestSignal?: AbortSignal) {
  const client = await createRouteAuthClient(requestSignal);
  // Auth server validation; never authorize from getSession() or editable user_metadata.
  const { data, error } = await client.auth.getUser().catch(() => {
    throw new ApiError("integration_unavailable");
  });
  if (error && (error.name === "AuthRetryableFetchError" || error.status === 429 || (error.status ?? 0) >= 500)) {
    throw new ApiError("integration_unavailable");
  }
  if (error || !data.user || data.user.is_anonymous || !data.user.email_confirmed_at)
    throw new ApiError("unauthenticated");
  return { client, user: data.user };
}

export async function getAuthenticatedContext() {
  const { client, user } = await getVerifiedAccountContext();
  return { client, userId: user.id };
}

export type AuthenticatedContext = Awaited<ReturnType<typeof getAuthenticatedContext>>;
