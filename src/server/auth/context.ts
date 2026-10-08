import "server-only";
import { createRouteAuthClient } from "./client";
import { ApiError } from "../http/errors";

/** Route-handler context only: cookie refreshes must be written to the response. */
export async function getAuthenticatedContext() {
  const client = await createRouteAuthClient();
  // Auth server validation; never authorize from getSession() or editable user_metadata.
  const { data, error } = await client.auth.getUser().catch(() => { throw new ApiError("integration_unavailable"); });
  if (error && (error.name === "AuthRetryableFetchError" || error.status === 429 || (error.status ?? 0) >= 500)) {
    throw new ApiError("integration_unavailable");
  }
  if (error || !data.user || data.user.is_anonymous) throw new ApiError("unauthenticated");
  return { client, userId: data.user.id };
}

export type AuthenticatedContext = Awaited<ReturnType<typeof getAuthenticatedContext>>;
