import "server-only";
import type { AuthenticatedContext } from "@/server/auth/context";
import { logoId, logoOwner } from "@/server/data/logo-transaction";
import { ApiError } from "@/server/http/errors";
import { LOGO_SUPABASE_ORIGIN } from "./logo-web-configuration";
import type { SupabasePrivateAssetTransport } from "./private-asset-storage";
import { qualifySharedSupabaseOrigin } from "./shared-supabase-origin";

const unavailable = () => new ApiError("integration_unavailable");
const active = (signal?: AbortSignal) => { if (signal?.aborted) throw unavailable(); };

/** The existing request client supplies a token, never authorization claims.
 * Revalidate that exact token with Auth and keep it only in this request's
 * fixed-destination transport. No global/session store, worker or refresh path. */
export async function createLogoOwnerStorageTransport(auth: AuthenticatedContext, project: string,
  dependencies: { publishableKey: string; fetch: typeof fetch; sharedSupabaseOrigin?: string }, requestSignal?: AbortSignal): Promise<SupabasePrivateAssetTransport> {
  const owner = logoOwner(auth), projectId = logoId(project);
  if (!/^sb_publishable_[A-Za-z0-9_-]{1,500}$/.test(dependencies.publishableKey) || typeof dependencies.fetch !== "function") throw unavailable();
  active(requestSignal);
  let token: string;
  try {
    const session = await auth.client.auth.getSession(); active(requestSignal);
    if (session.error || !session.data.session) throw new ApiError("unauthenticated");
    token = session.data.session.access_token;
    if (typeof token !== "string" || token.length > 16_384 || !/^[\x21-\x7e]+$/.test(token)) throw new ApiError("unauthenticated");
    const verified = await auth.client.auth.getUser(token); active(requestSignal);
    if (verified.error || !verified.data.user || verified.data.user.is_anonymous || verified.data.user.id.toLowerCase() !== owner
      || dependencies.sharedSupabaseOrigin !== undefined && !verified.data.user.email_confirmed_at) throw new ApiError("unauthenticated");
  } catch (error) { throw error instanceof ApiError ? error : unavailable(); }
  const origin = dependencies.sharedSupabaseOrigin === undefined ? LOGO_SUPABASE_ORIGIN : qualifySharedSupabaseOrigin(dependencies.sharedSupabaseOrigin);
  const prefix = `${origin}/storage/v1/object/fluid-assets/${owner}/${projectId}/`;
  return async (url, init) => {
    active(requestSignal); active(init.signal ?? undefined);
    try {
      if (dependencies.sharedSupabaseOrigin !== undefined) qualifySharedSupabaseOrigin(dependencies.sharedSupabaseOrigin);
      if (!url.startsWith(prefix) || !["GET", "POST"].includes(init.method ?? "")) throw unavailable();
      const members = url.slice(prefix.length).split("/");
      if (members.length !== 2 || members.some(member => logoId(member) !== member)) throw unavailable();
      const headers = new Headers(init.headers);
      if (headers.has("authorization") || headers.has("apikey") || init.method === "POST" && headers.get("x-upsert") !== "false") throw unavailable();
      headers.set("apikey", dependencies.publishableKey); headers.set("authorization", `Bearer ${token}`);
      const signal = AbortSignal.any([...(requestSignal ? [requestSignal] : []), ...(init.signal ? [init.signal] : []), AbortSignal.timeout(10_000)]);
      const response = await dependencies.fetch(url, { ...init, headers, redirect: "error", cache: "no-store", credentials: "omit", signal });
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw unavailable(); }
      return response;
    } catch { throw unavailable(); }
  };
}
