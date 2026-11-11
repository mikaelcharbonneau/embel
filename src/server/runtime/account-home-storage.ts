import "server-only";
import { z } from "zod";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { LOGO_SUPABASE_ORIGIN, qualifySharedSupabaseOrigin } from "./shared-supabase-origin";
import type { SupabasePrivateAssetTransport } from "./private-asset-storage";

const unavailable = () => new ApiError("integration_unavailable");

/** Fresh verified-account token only, fixed hosted destination and home scope.
 * Never stores a token globally, refreshes, retries or borrows a worker key. */
export async function createAccountHomeStorageTransport(
  auth: AuthenticatedContext,
  dependencies: { publishableKey: string; fetch: typeof fetch; sharedSupabaseOrigin?: string },
  requestSignal?: AbortSignal,
): Promise<SupabasePrivateAssetTransport> {
  const owner = z.uuid().safeParse(auth.userId);
  if (
    !owner.success ||
    requestSignal?.aborted ||
    !/^sb_publishable_[A-Za-z0-9_-]{1,500}$/u.test(dependencies.publishableKey)
  )
    throw unavailable();
  const ownerId = owner.data.toLowerCase();
  let token: string;
  try {
    const { data, error } = await auth.client.auth.getSession();
    const session = data.session;
    if (
      error ||
      !session ||
      session.user.id.toLowerCase() !== ownerId ||
      session.user.is_anonymous ||
      !session.user.email_confirmed_at ||
      typeof session.access_token !== "string" ||
      !/^[\x21-\x7e]{1,16384}$/u.test(session.access_token)
    )
      throw unavailable();
    token = session.access_token;
    const verified = await auth.client.auth.getUser(token);
    if (
      verified.error ||
      !verified.data.user ||
      verified.data.user.is_anonymous ||
      !verified.data.user.email_confirmed_at ||
      verified.data.user.id.toLowerCase() !== ownerId ||
      requestSignal?.aborted
    )
      throw unavailable();
  } catch {
    throw unavailable();
  }
  const origin =
    dependencies.sharedSupabaseOrigin === undefined
      ? LOGO_SUPABASE_ORIGIN
      : qualifySharedSupabaseOrigin(dependencies.sharedSupabaseOrigin);
  // POST uploads to the object route; GET reads through the authenticated route.
  const uploadPrefix = `${origin}/storage/v1/object/fluid-assets/${ownerId}/home/`;
  const readPrefix = `${origin}/storage/v1/object/authenticated/fluid-assets/${ownerId}/home/`;
  return async (url, init) => {
    try {
      if (dependencies.sharedSupabaseOrigin !== undefined)
        qualifySharedSupabaseOrigin(dependencies.sharedSupabaseOrigin);
      const prefix = init.method === "GET" ? readPrefix : init.method === "POST" ? uploadPrefix : null;
      if (requestSignal?.aborted || init.signal?.aborted || !prefix || !url.startsWith(prefix)) throw unavailable();
      const parts = url.slice(prefix.length).split("/");
      if (parts.length !== 2 || parts.some((part) => !z.uuid().safeParse(part).success || part !== part.toLowerCase()))
        throw unavailable();
      const headers = new Headers(init.headers);
      if (
        headers.has("authorization") ||
        headers.has("apikey") ||
        (init.method === "POST" && headers.get("x-upsert") !== "false")
      )
        throw unavailable();
      headers.set("authorization", `Bearer ${token}`);
      headers.set("apikey", dependencies.publishableKey);
      const signal = AbortSignal.any([
        ...(requestSignal ? [requestSignal] : []),
        ...(init.signal ? [init.signal] : []),
        AbortSignal.timeout(10_000),
      ]);
      const response = await dependencies.fetch(url, {
        ...init,
        headers,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal,
      });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      return response;
    } catch {
      throw unavailable();
    }
  };
}
