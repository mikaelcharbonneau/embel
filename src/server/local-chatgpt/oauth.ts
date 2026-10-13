import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";
import { z } from "zod";

export const OPENAI_ISSUER = "https://auth.openai.com" as const;
export const OPENAI_RESOURCE = "https://api.openai.com/v1" as const;
export const OPENAI_DISCOVERY_URL = `${OPENAI_ISSUER}/.well-known/openid-configuration`;
export const OPENAI_AUTHORIZE_URL = `${OPENAI_ISSUER}/api/accounts/authorize`;
export const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/api/accounts/oauth/token`;
export const OPENAI_JWKS_URL = `${OPENAI_ISSUER}/.well-known/jwks.json`;
export const OPENAI_REVOCATION_URL = `${OPENAI_ISSUER}/api/accounts/oauth/revoke`;
export const CHATGPT_SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"] as const;
export const PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";

export type LocalChatGPTErrorCode = "invalid_configuration" | "invalid_callback" | "access_denied" | "invalid_identity" |
  "invalid_token_response" | "sign_in_required" | "plan_permission_required" | "session_unavailable" | "invalid_client" |
  "registration_not_found" | "credential_store_unavailable" | "credential_store_busy" | "authorization_pending_limit";

/** Codes are safe to expose; never include a token, OAuth body or raw exception. */
export class LocalChatGPTError extends Error {
  constructor(readonly code: LocalChatGPTErrorCode) {
    super(`ChatGPT connection: ${code}.`);
    this.name = "LocalChatGPTError";
  }
}

export const issuedClientIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._~-]+$/)
  .refine(value => value !== "dynamic_agent_client");
export const hostIdSchema = z.string().regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const tokenString = z.string().min(1).max(32_768).refine(value => !/[\s\u0000-\u001f\u007f]/u.test(value));
const scopeString = z.string().max(4096).refine(value => /^[\x21\x23-\x5B\x5D-\x7E ]*$/.test(value));
const tokenResponseSchema = z.object({
  access_token: tokenString.optional(), refresh_token: tokenString.optional(), id_token: tokenString.optional(),
  token_type: z.literal("Bearer").optional(), expires_in: z.number().int().positive().max(86_400).optional(),
  scope: scopeString, earliest_refresh_at: z.union([z.number().nonnegative().finite(), z.string().max(100)]).optional(),
});

export type OAuthTokenResponse = z.infer<typeof tokenResponseSchema>;
export type ValidatedIdentity = { issuer: typeof OPENAI_ISSUER; subject: string; clientId: string; email: string | null };
export type ValidatedTokenSet = {
  accessToken: string | null; refreshToken: string | null; idToken: string;
  scopes: string[]; expiresAt: number | null; earliestRefreshAt: number | null;
  receivedAt: number;
};
export type AuthorizationAttempt = {
  ownerId: string; browserSessionId: string; state: string; nonce: string; codeVerifier: string;
  redirectUri: string; hostId: string; clientId: string | null; subject: string | null;
  registrationId: string | null; expiresAt: number;
};

export function validateLoopbackCallback(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new LocalChatGPTError("invalid_configuration"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1 ||
      url.pathname !== "/auth/callback" || url.username || url.password || url.search || url.hash) {
    throw new LocalChatGPTError("invalid_configuration");
  }
  return url.href;
}

export function createAuthorizationAttempt(input: {
  ownerId: string; browserSessionId: string; redirectUri: string; hostId: string;
  registration?: { registrationId: string; clientId: string; subject: string };
}, now = Date.now()): AuthorizationAttempt {
  if (!z.uuid().safeParse(input.ownerId).success || !/^[A-Za-z0-9_-]{32,128}$/.test(input.browserSessionId) || !hostIdSchema.safeParse(input.hostId).success ||
    (input.registration && !issuedClientIdSchema.safeParse(input.registration.clientId).success)) throw new LocalChatGPTError("invalid_configuration");
  return {
    ownerId: input.ownerId, browserSessionId: input.browserSessionId, redirectUri: validateLoopbackCallback(input.redirectUri), hostId: input.hostId,
    registrationId: input.registration?.registrationId ?? null, clientId: input.registration?.clientId ?? null, subject: input.registration?.subject ?? null,
    state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url"), codeVerifier: randomBytes(64).toString("base64url"),
    expiresAt: now + 10 * 60_000,
  };
}

export function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readAuthorizationCallback(attempt: AuthorizationAttempt, callbackUrl: string, now = Date.now()) {
  let callback: URL;
  try { callback = new URL(callbackUrl); } catch { throw new LocalChatGPTError("invalid_callback"); }
  const expected = new URL(attempt.redirectUri);
  if (callbackUrl.length > 16_384 || callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash ||
      attempt.expiresAt <= now || !constantTimeEqual(callback.searchParams.get("state") ?? "", attempt.state)) throw new LocalChatGPTError("invalid_callback");
  for (const key of ["state", "code", "error", "client_id"]) {
    if (callback.searchParams.getAll(key).length > 1) throw new LocalChatGPTError("invalid_callback");
  }
  if (callback.searchParams.has("error")) {
    throw new LocalChatGPTError(callback.searchParams.get("error") === "access_denied" ? "access_denied" : "invalid_callback");
  }
  const code = callback.searchParams.get("code");
  if (!code || code.length > 4096 || /[\u0000-\u0020\u007f]/u.test(code)) throw new LocalChatGPTError("invalid_callback");
  const returnedClient = callback.searchParams.get("client_id");
  const clientId = returnedClient ?? attempt.clientId;
  if (!issuedClientIdSchema.safeParse(clientId).success || (attempt.clientId && returnedClient && returnedClient !== attempt.clientId)) {
    throw new LocalChatGPTError("invalid_callback");
  }
  return { code, clientId: clientId! };
}

const discoverySchema = z.object({
  issuer: z.literal(OPENAI_ISSUER), authorization_endpoint: z.literal(OPENAI_AUTHORIZE_URL),
  token_endpoint: z.literal(OPENAI_TOKEN_URL), jwks_uri: z.literal(OPENAI_JWKS_URL),
  revocation_endpoint: z.literal(OPENAI_REVOCATION_URL),
  id_token_signing_alg_values_supported: z.array(z.string()).refine(values => values.includes("RS256")),
  token_endpoint_auth_methods_supported: z.array(z.string()).refine(values => values.includes("none")),
});

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new LocalChatGPTError("session_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262_144) throw new LocalChatGPTError("session_unavailable");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new LocalChatGPTError("session_unavailable"); }
  finally { await reader.cancel().catch(() => {}); }
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(" ").filter(Boolean))].sort();
}

/** Preserve a server refresh floor when its representation is recognizable.
 * The preview reference names the field but leaves its wire type unspecified.
 * Unknown representations defer refresh until expiry rather than refreshing early. */
function refreshFloor(value: OAuthTokenResponse["earliest_refresh_at"], expiresAt: number): number | null {
  if (value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value < 100_000_000_000) return value * 1000;
  if (typeof value === "string" && z.iso.datetime({ offset: true }).safeParse(value).success) return Date.parse(value);
  return expiresAt;
}

export function createOpenAIOAuthClient(options: { fetch?: typeof fetch; now?: () => number; jwks?: JWTVerifyGetKey } = {}) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let discoveryPromise: Promise<z.infer<typeof discoverySchema>> | undefined;
  let keys: JWTVerifyGetKey | undefined = options.jwks;
  const safeFetch: typeof fetch = async (url, init) => {
    try { return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new LocalChatGPTError("session_unavailable"); }
  };
  async function discovery() {
    discoveryPromise ??= (async () => {
      const response = await safeFetch(OPENAI_DISCOVERY_URL, { headers: { accept: "application/json" } });
      if (response.status !== 200) throw new LocalChatGPTError("session_unavailable");
      const parsed = discoverySchema.safeParse(await boundedJson(response));
      if (!parsed.success) throw new LocalChatGPTError("invalid_configuration");
      return parsed.data;
    })().catch(error => { discoveryPromise = undefined; throw error; });
    return discoveryPromise;
  }
  async function verify(token: string, audience: string): Promise<JWTPayload> {
    await discovery();
    keys ??= createRemoteJWKSet(new URL(OPENAI_JWKS_URL), {
      [customFetch]: safeFetch, cacheMaxAge: 10 * 60_000, cooldownDuration: 30_000, timeoutDuration: 10_000,
    });
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"], issuer: OPENAI_ISSUER, audience,
        requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5, currentDate: new Date(now()),
      });
      if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 512 || !Number.isInteger(payload.iat) ||
          payload.iat! > Math.floor(now() / 1000) + 5 || payload.exp! <= payload.iat! ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== audience)) throw new Error("invalid");
      return payload;
    } catch { throw new LocalChatGPTError("invalid_identity"); }
  }
  async function verifyIdentity(idToken: string, clientId: string, expected: { nonce?: string; subject?: string } = {}): Promise<ValidatedIdentity> {
    const payload = await verify(idToken, clientId);
    if ((expected.nonce !== undefined && (typeof payload.nonce !== "string" || !constantTimeEqual(payload.nonce, expected.nonce))) ||
        (expected.subject !== undefined && payload.sub !== expected.subject)) throw new LocalChatGPTError("invalid_identity");
    return { issuer: OPENAI_ISSUER, clientId, subject: payload.sub!, email: typeof payload.email === "string" && payload.email.length <= 320 ? payload.email : null };
  }
  async function validateAccessToken(token: string, identity: ValidatedIdentity, scopes: readonly string[]) {
    const payload = await verify(token, OPENAI_RESOURCE);
    if (payload.sub !== identity.subject || payload.client_id !== identity.clientId || typeof payload.scope !== "string" ||
      scopes.some(scope => !parseScopes(payload.scope as string).includes(scope))) throw new LocalChatGPTError("invalid_identity");
    return payload.exp! * 1000;
  }
  async function requestTokens(form: URLSearchParams, refresh: boolean): Promise<OAuthTokenResponse> {
    await discovery();
    const response = await safeFetch(OPENAI_TOKEN_URL, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form,
    });
    const body = await boundedJson(response);
    if (response.status !== 200) {
      const error = z.object({ error: z.string() }).safeParse(body);
      if (error.success && error.data.error === "invalid_client") throw new LocalChatGPTError("invalid_client");
      const terminal = ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"];
      if (refresh && error.success && terminal.includes(error.data.error)) throw new LocalChatGPTError("sign_in_required");
      if (!refresh && error.success && error.data.error === "invalid_grant") throw new LocalChatGPTError("sign_in_required");
      throw new LocalChatGPTError("session_unavailable");
    }
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) throw new LocalChatGPTError("invalid_token_response");
    return parsed.data;
  }
  async function validatedTokens(tokens: OAuthTokenResponse, identity: ValidatedIdentity, retainedIdToken?: string): Promise<ValidatedTokenSet> {
    const scopes = parseScopes(tokens.scope);
    const idToken = tokens.id_token ?? retainedIdToken;
    if (!idToken || !scopes.includes("openid")) throw new LocalChatGPTError("invalid_token_response");
    let expiresAt: number | null = null;
    const receivedAt = now();
    if (tokens.access_token) {
      if (tokens.token_type !== "Bearer" || !tokens.expires_in) throw new LocalChatGPTError("invalid_token_response");
      expiresAt = Math.min(receivedAt + tokens.expires_in * 1000, await validateAccessToken(tokens.access_token, identity, scopes));
    }
    if (scopes.includes(PLAN_USAGE_SCOPE) && (!tokens.access_token || !scopes.includes("resource.invoke"))) throw new LocalChatGPTError("invalid_token_response");
    if (scopes.includes("offline_access") && !tokens.refresh_token) throw new LocalChatGPTError("invalid_token_response");
    return {
      accessToken: tokens.access_token ?? null, refreshToken: tokens.refresh_token ?? null, idToken,
      scopes, expiresAt, earliestRefreshAt: expiresAt === null ? null : refreshFloor(tokens.earliest_refresh_at, expiresAt), receivedAt,
    };
  }
  return {
    async authorizationUrl(attempt: AuthorizationAttempt, hints: { email?: string | null } = {}) {
      await discovery();
      const url = new URL(OPENAI_AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: attempt.clientId ?? "dynamic_agent_client", ext_agent_host_id: attempt.hostId,
        response_type: "code", redirect_uri: attempt.redirectUri, scope: CHATGPT_SCOPES.join(" "), resource: OPENAI_RESOURCE,
        state: attempt.state, nonce: attempt.nonce, code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(attempt.codeVerifier).digest("base64url"),
        ...(attempt.clientId ? {} : { agent_name_hint: "Embel" }),
        ...(attempt.clientId && hints.email ? { login_hint: hints.email } : {}),
      }).toString();
      // Browser-visible: retained access, refresh and ID tokens never belong here.
      return url.href;
    },
    async exchange(attempt: AuthorizationAttempt, callback: { code: string; clientId: string }) {
      const tokens = await requestTokens(new URLSearchParams({
        grant_type: "authorization_code", client_id: callback.clientId, code: callback.code,
        code_verifier: attempt.codeVerifier, redirect_uri: attempt.redirectUri, resource: OPENAI_RESOURCE,
      }), false);
      if (!tokens.id_token) throw new LocalChatGPTError("invalid_token_response");
      const identity = await verifyIdentity(tokens.id_token, callback.clientId, { nonce: attempt.nonce, ...(attempt.subject ? { subject: attempt.subject } : {}) });
      return { identity, tokens: await validatedTokens(tokens, identity) };
    },
    async refresh(identity: ValidatedIdentity, tokens: ValidatedTokenSet) {
      if (!tokens.refreshToken) throw new LocalChatGPTError("sign_in_required");
      const response = await requestTokens(new URLSearchParams({ grant_type: "refresh_token", client_id: identity.clientId, refresh_token: tokens.refreshToken, resource: OPENAI_RESOURCE }), true);
      if (!response.refresh_token) throw new LocalChatGPTError("invalid_token_response");
      if (response.id_token) await verifyIdentity(response.id_token, identity.clientId, { subject: identity.subject });
      return validatedTokens(response, identity, tokens.idToken);
    },
    validateAccessToken,
    async revoke(clientId: string, refreshToken: string) {
      await discovery();
      const response = await safeFetch(OPENAI_REVOCATION_URL, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: clientId }),
      });
      await response.body?.cancel().catch(() => {});
      return response.status === 200 ? "confirmed" as const : response.status >= 500 ? "retryable" as const : "unconfirmed" as const;
    },
  };
}
export type OpenAIOAuthClient = ReturnType<typeof createOpenAIOAuthClient>;
