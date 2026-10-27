import "server-only";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { z } from "zod";
import { sharedSlotLeaseSchema, type SharedSlotLease } from "../shared-pool/contracts";
import { slotSessionSchema, storageFetch, storageOrigin, storagePublicKey, storageUnavailable, type SharedStorageSession } from "./protocol";
export type SharedSlotStorageSessionInput = { targetOrigin: string; publishableKey: string; authUserId: string; email: string; password: string; slot(): SharedSlotLease | null };

/** A fixed operator-configured slot actor uses ordinary Auth. No account/admin,
 * Vault, filesystem, customer password, automatic relogin or saved token exists.
 * Refresh must retain the first session and exact slot instance/generation. */
export async function createSharedSlotStorageSession(input: SharedSlotStorageSessionInput,
  dependencies: { fetch?: typeof fetch; now?: () => number } = {}): Promise<SharedStorageSession> {
  let client: ReturnType<typeof createClient> | undefined;
  try {
    const origin = storageOrigin(input.targetOrigin), publishableKey = storagePublicKey(input.publishableKey, origin), authUserId = z.uuid().parse(input.authUserId);
    const email = z.email().max(254).parse(input.email), password = z.string().min(1).max(4096).parse(input.password);
    const first = sharedSlotLeaseSchema.parse(input.slot()), now = dependencies.now ?? Date.now, transport = dependencies.fetch ?? globalThis.fetch;
    if (first.lane !== "logo") throw storageUnavailable();
    let closed = false, fenced = false, cleanupRefresh = false, sessionId: string | undefined, closing: Promise<void> | undefined;
    function slot() {
      const current = sharedSlotLeaseSchema.parse(input.slot());
      if (closed || current.lane !== "logo" || current.slotId !== first.slotId || current.instanceId !== first.instanceId || current.generation !== first.generation
        || current.leaseToken !== first.leaseToken || current.roleName !== first.roleName || current.roleOid !== first.roleOid || Date.parse(current.expiresAt) <= now()) throw storageUnavailable();
      return current;
    }
    const allowed = new Map([[`${origin}/auth/v1/token?grant_type=password`, "POST"], [`${origin}/auth/v1/token?grant_type=refresh_token`, "POST"],
      [`${origin}/auth/v1/user`, "GET"], [`${origin}/rest/v1/rpc/shared_logo_storage_session`, "POST"], [`${origin}/auth/v1/logout?scope=local`, "POST"]]);
    client = createClient(origin, publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false },
      global: { fetch: async (raw, init) => { const url = String(raw), cleanup = cleanupRefresh && url === `${origin}/auth/v1/token?grant_type=refresh_token`;
        if (url !== `${origin}/auth/v1/logout?scope=local` && !cleanup) slot();
        if (allowed.get(url) !== (init?.method ?? "GET")) throw storageUnavailable();
        const response = await storageFetch(transport, url, init ?? {}, 16_384);
        if (cleanup && response.ok) validate(await response.clone().json(), true);
        return response;
      } } });
    function validate(raw: unknown, cleanup = false) {
      if (cleanup) { if (!sessionId) throw storageUnavailable(); } else slot();
      const session = z.object({ access_token: z.string().max(16_384), refresh_token: z.string().min(1).max(4096),
        user: z.object({ id: z.literal(authUserId), is_anonymous: z.literal(false), email_confirmed_at: z.string().min(1) }) }).parse(raw);
      const claims = decodeJwt(session.access_token);
      if (claims.sub !== authUserId || claims.role !== "authenticated" || claims.aud !== "authenticated" || claims.iss !== `${origin}/auth/v1`
        || claims.is_anonymous !== false || !z.uuid().safeParse(claims.session_id).success || sessionId !== undefined && claims.session_id !== sessionId
        || !Number.isSafeInteger(claims.exp) || claims.exp! * 1000 <= now() + (cleanup ? 0 : 120_000) || claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > now())) throw storageUnavailable();
      sessionId = claims.session_id as string;
      return { accessToken: session.access_token, refreshToken: session.refresh_token, expiresAt: claims.exp! * 1000 };
    }
    const signed = await client.auth.signInWithPassword({ email, password }); if (signed.error) throw storageUnavailable();
    let current = validate(signed.data.session);
    async function verify() {
      slot(); const verified = await client!.auth.getUser(current.accessToken);
      if (verified.error || verified.data.user?.id !== authUserId || verified.data.user.is_anonymous !== false || !verified.data.user.email_confirmed_at) throw storageUnavailable();
      const response = await storageFetch(transport, `${origin}/rest/v1/rpc/shared_logo_storage_session`, { method: "POST", headers: {
        authorization: `Bearer ${current.accessToken}`, apikey: publishableKey, "content-type": "application/json" }, body: "{}" }, 16_384);
      const actual = slotSessionSchema.parse(await response.json()), expected = { version: 1, slotId: first.slotId, instanceId: first.instanceId, generation: first.generation,
        roleName: first.roleName, roleOid: first.roleOid, authUserId, sessionId };
      if (response.status !== 200 || !isDeepStrictEqual(actual, expected)) throw storageUnavailable();
    }
    await verify();
    let refreshing: Promise<void> | undefined;
    return Object.freeze({ authUserId, sessionId: sessionId!, async tokenProvider(signal) {
      try { if (fenced) throw storageUnavailable(); slot(); signal?.throwIfAborted();
        if (now() >= current.expiresAt - 120_000) {
          refreshing ??= (async () => { const result = await client!.auth.refreshSession({ refresh_token: current.refreshToken }); if (result.error) throw storageUnavailable();
            current = validate(result.data.session); await verify(); })().finally(() => { refreshing = undefined; });
          await refreshing;
        }
        if (fenced) throw storageUnavailable(); slot(); signal?.throwIfAborted(); return current.accessToken;
      } catch { throw storageUnavailable(); }
    }, close() {
      if (closing) return closing; fenced = true;
      closing = (async () => {
        try {
          await refreshing?.catch(() => {});
          closed = true; cleanupRefresh = true;
          // The SDK may refresh an expired cached access token before logout.
          // That cleanup-only refresh must retain the original actor/session;
          // password relogin and normal work stay fenced even after takeover.
          const cached = await client!.auth.getSession(); if (cached.error) throw storageUnavailable();
          const proofToken = validate(cached.data.session, true).accessToken;
          const logout = await client!.auth.signOut({ scope: "local" }); if (logout.error) throw storageUnavailable();
          const response = await storageFetch(transport, `${origin}/rest/v1/rpc/shared_logo_storage_session_closed`, { method: "POST", headers: {
            authorization: `Bearer ${proofToken}`, apikey: publishableKey, "content-type": "application/json" }, body: "{}" }, 1024);
          if (response.status !== 200 || await response.json() !== true) throw storageUnavailable();
        } catch { throw storageUnavailable(); }
        finally { closed = true; cleanupRefresh = false; current = { accessToken: "", refreshToken: "", expiresAt: 0 }; await client!.auth.dispose().catch(() => {}); }
      })();
      return closing;
    } });
  } catch { await client?.auth.signOut({ scope: "local" }).catch(() => {}); await client?.auth.dispose().catch(() => {}); throw storageUnavailable(); }
}
