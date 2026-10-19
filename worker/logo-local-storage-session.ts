import "server-only";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { z } from "zod";
import { getLogoDedicatedConfiguration, parseLogoDedicatedConfiguration, readProtectedLogoConfigurationFile, type LogoDedicatedConfiguration } from "./logo-dedicated-config";
import { qualifiedLogoGenerativeStorageCapability, type LogoStorageTokenProvider } from "./logo-generative-storage-authorization";

const ORIGIN = "https://fricsfwqibyhemknqgyf.supabase.co";
const RENEW_BEFORE_MS = 120_000;
const unavailable = () => new Error("Local logo Storage session is unavailable.");
const identitySchema = z.strictObject({ version: z.literal(1), ownerId: z.uuid(), authUserId: z.uuid(),
  email: z.email().max(254), password: z.string().min(1).max(4096) });
const scopeSchema = z.object({ version: z.literal(1), enabled: z.literal(true), binding: z.object({ ownerId: z.uuid() }),
  storage: z.object({ authUserId: z.uuid(), publishableKey: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{1,500}$/), sessionApproved: z.literal(true) }),
  // The local opt-in permits concepts and their paired preview-refinement lane. Other
  // brokers keep their separate static-session activation contracts.
  operations: z.strictObject({ concepts: z.unknown(), refinements: z.unknown().optional() }).refine(value => value.concepts !== undefined),
});
type AuthResult = { data: { session: unknown }; error: unknown };
export type LocalLogoAuthClient = {
  signInWithPassword(credentials: { email: string; password: string }): Promise<AuthResult>;
  refreshSession(session: { refresh_token: string }): Promise<AuthResult>;
  dispose(): Promise<void>;
};
export type LocalLogoStorageSessionDependencies = {
  createAuthClient(publishableKey: string): LocalLogoAuthClient; now(): number;
  verifySession(configuration: LogoDedicatedConfiguration, accessToken: string): Promise<void>;
};
const defaults: LocalLogoStorageSessionDependencies = {
  now: Date.now,
  verifySession: verifyLocalLogoStorageSession,
  createAuthClient(publishableKey) {
    const client = createClient(ORIGIN, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false },
      global: { fetch: async (input, init) => {
        const url = String(input);
        if (url !== `${ORIGIN}/auth/v1/token?grant_type=password` && url !== `${ORIGIN}/auth/v1/token?grant_type=refresh_token`
          || init?.method !== "POST") throw unavailable();
        return fetch(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(init.signal ? [init.signal] : [])]),
          redirect: "error", credentials: "omit", cache: "no-store" });
      } },
    });
    return client.auth;
  },
};
const sessionSchema = z.object({ access_token: z.string().max(16_384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  refresh_token: z.string().min(1).max(4096), user: z.object({ id: z.uuid(), is_anonymous: z.literal(false) }) });

/** Read-only startup verification: no claim, reservation, grant or image call. */
export async function verifyLocalLogoStorageSession(configuration: LogoDedicatedConfiguration, accessToken: string, transport: typeof fetch = globalThis.fetch) {
  try {
    const c = getLogoDedicatedConfiguration(configuration);
    if (!c?.storage || c.storage.accessToken !== accessToken) throw unavailable();
    const signal = AbortSignal.timeout(10_000);
    async function json(path: string, method: "GET" | "POST") {
      const url = `${ORIGIN}${path}`;
      const response = await transport(url, { method, signal, redirect: "error", credentials: "omit", cache: "no-store",
        headers: { authorization: `Bearer ${accessToken}`, apikey: c!.storage!.publishableKey, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}) });
      if (response.status !== 200 || response.redirected || response.url && response.url !== url || !response.body) throw unavailable();
      const reader = response.body.getReader(), bytes = new Uint8Array(16_384);
      let length = 0;
      try {
        while (true) {
          signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
          if (part.done) break;
          if (part.value.length > bytes.length - length) throw unavailable();
          bytes.set(part.value, length); length += part.value.length;
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    z.object({ id: z.literal(c.storage.authUserId), is_anonymous: z.literal(false) }).parse(await json("/auth/v1/user", "GET"));
    const expected = { ownerId: c.binding.ownerId, authUserId: c.storage.authUserId, sessionId: decodeJwt(accessToken).session_id,
      workerRoleName: c.binding.roleName, workerRoleOid: c.binding.roleOid, workerId: c.workerId };
    if (!isDeepStrictEqual(await json("/rest/v1/rpc/logo_storage_session", "POST"), expected)) throw unavailable();
  } catch { throw unavailable(); }
}

/** Sign in only the explicitly supplied, owner-confirmed Storage identity.
 * Supabase performs normal refresh-token rotation. Nothing is saved to disk;
 * renewals preserve the initial session and never fall back to password sign-in.
 */
export async function createLocalLogoStorageSession(identityInput: unknown, configurationInput: unknown,
  dependencies: LocalLogoStorageSessionDependencies = defaults): Promise<Readonly<{ tokenProvider: LogoStorageTokenProvider; close(): Promise<void> }>> {
  let client: LocalLogoAuthClient | undefined;
  try {
    const identity = identitySchema.parse(identityInput), scope = scopeSchema.parse(configurationInput);
    if (identity.ownerId !== scope.binding.ownerId || identity.authUserId !== scope.storage.authUserId || identity.ownerId === identity.authUserId) throw unavailable();
    const concept = qualifiedLogoGenerativeStorageCapability(scope.operations.concepts);
    const refinement = scope.operations.refinements === undefined ? null : qualifiedLogoGenerativeStorageCapability(scope.operations.refinements);
    if (!concept || concept.operation !== "identity.logo_concept" || scope.operations.refinements !== undefined &&
      (!refinement || !isDeepStrictEqual(refinement, { ...concept, operation: "identity.logo_refine" }))) throw unavailable();
    client = dependencies.createAuthClient(scope.storage.publishableKey);
    let closed = false, sessionId: string | undefined;
    function validate(result: AuthResult) {
      if (closed || result.error) throw unavailable();
      const session = sessionSchema.parse(result.data.session), claims = decodeJwt(session.access_token);
      if (session.user.id !== identity.authUserId || claims.sub !== identity.authUserId || claims.role !== "authenticated" || claims.aud !== "authenticated"
        || claims.iss !== `${ORIGIN}/auth/v1` || claims.is_anonymous !== false || !z.uuid().safeParse(claims.session_id).success
        || sessionId !== undefined && claims.session_id !== sessionId || !Number.isSafeInteger(claims.exp) || claims.exp! * 1000 <= dependencies.now() + RENEW_BEFORE_MS
        || claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > dependencies.now())) throw unavailable();
      sessionId = claims.session_id as string;
      return { accessToken: session.access_token, refreshToken: session.refresh_token, expiresAt: claims.exp! * 1000 };
    }
    let current = validate(await client.signInWithPassword({ email: identity.email, password: identity.password }));
    let renewing: Promise<void> | undefined;
    const tokenProvider: LogoStorageTokenProvider = async signal => {
      try {
        if (closed || signal?.aborted) throw unavailable();
        if (dependencies.now() >= current.expiresAt - RENEW_BEFORE_MS) {
          if (!renewing) {
            renewing = (async () => { current = validate(await client!.refreshSession({ refresh_token: current.refreshToken })); })()
              .finally(() => { renewing = undefined; });
          }
          await renewing;
        }
        if (closed || signal?.aborted || dependencies.now() >= current.expiresAt) throw unavailable();
        return current.accessToken;
      } catch { throw unavailable(); }
    };
    return Object.freeze({ tokenProvider, async close() {
      closed = true;
      current = { accessToken: "", refreshToken: "", expiresAt: 0 };
      // Dispose clears only this client's in-memory resources. Do not revoke a
      // session while a draining worker may still retain a job-bound grant.
      await client!.dispose();
    } });
  } catch {
    await client?.dispose().catch(() => {});
    throw unavailable();
  }
}

/** Explicit protected paths only; reads existing credentials without rewriting
 * either file. Startup authentication precedes parsing the expiring snapshot. */
export async function readLocalLogoStorageConfiguration(configurationPath: string, identityPath: string,
  dependencies: LocalLogoStorageSessionDependencies = defaults): Promise<Readonly<{
  configuration: LogoDedicatedConfiguration; tokenProvider: LogoStorageTokenProvider; close(): Promise<void>;
}>> {
  if (dirname(configurationPath) !== dirname(identityPath)) throw unavailable();
  const [raw, identity] = await Promise.all([readProtectedLogoConfigurationFile(configurationPath, "logo-worker.json"),
    readProtectedLogoConfigurationFile(identityPath, "logo-storage-identity.json")]);
  const session = await createLocalLogoStorageSession(identity, raw, dependencies);
  try {
    const input = raw as { storage: object };
    const configuration = parseLogoDedicatedConfiguration({ ...input, storage: { ...input.storage, accessToken: await session.tokenProvider() } });
    if (configuration.status !== "configured") throw unavailable();
    await dependencies.verifySession(configuration, await session.tokenProvider());
    return Object.freeze({ configuration, tokenProvider: session.tokenProvider, close: session.close });
  } catch { await session.close(); throw unavailable(); }
}
