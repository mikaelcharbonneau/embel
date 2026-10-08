import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";
import { CHATGPT_SCOPES, OPENAI_AUTHORIZE_URL, OPENAI_DISCOVERY_URL, OPENAI_ISSUER, OPENAI_JWKS_URL, OPENAI_RESOURCE, OPENAI_REVOCATION_URL, OPENAI_TOKEN_URL } from "../../src/server/local-chatgpt/oauth";
import { credentialRecordSchema, registrationIdFor, type ChatGPTCredentialStore, type CredentialRecord } from "../../src/server/local-chatgpt/credentials";

// Ephemeral local cryptographic fixtures. Keys are generated in memory, never saved.
export const LOCAL_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const LOCAL_OTHER_OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const LOCAL_CLIENT = "oaiapp_local_fixture";
export const LOCAL_SUBJECT = "local-fixture-subject";
export const LOCAL_HOST = "urn:uuid:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const LOCAL_BROWSER = "local_browser_fixture_01234567890123456789";
export const LOCAL_CALLBACK = "http://127.0.0.1:31415/auth/callback";
export const discoveryFixture = {
  issuer: OPENAI_ISSUER, authorization_endpoint: OPENAI_AUTHORIZE_URL, token_endpoint: OPENAI_TOKEN_URL,
  jwks_uri: OPENAI_JWKS_URL, revocation_endpoint: OPENAI_REVOCATION_URL,
  id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"],
};

export async function createOAuthFixture() {
  const pair = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(pair.publicKey), kid: "local-fixture-key", alg: "RS256", use: "sig" };
  const time = { now: Date.parse("2026-10-04T00:00:00Z") };
  let tokenHandler: (form: URLSearchParams) => Promise<Response> = async () => { throw new Error("No local token response configured"); };
  let revokeHandler: () => Promise<Response> = async () => new Response(null, { status: 200 });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === OPENAI_DISCOVERY_URL) return Response.json(discoveryFixture);
    if (String(url) === OPENAI_JWKS_URL) return Response.json({ keys: [jwk] });
    if (String(url) === OPENAI_TOKEN_URL) return tokenHandler(new URLSearchParams(String(init?.body)));
    if (String(url) === OPENAI_REVOCATION_URL) return revokeHandler();
    throw new Error("Unexpected network destination in explicit local fixture");
  });
  async function jwt(payload: Record<string, unknown>, options: { issuer?: string; audience?: string | string[]; expires?: number; issued?: number } = {}) {
    const second = Math.floor(time.now / 1000);
    return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "local-fixture-key" }).setIssuer(options.issuer ?? OPENAI_ISSUER)
      .setAudience(options.audience ?? LOCAL_CLIENT).setIssuedAt(options.issued ?? second).setExpirationTime(options.expires ?? second + 3600).sign(pair.privateKey);
  }
  async function tokens(options: { nonce?: string; clientId?: string; subject?: string; scope?: string[]; refreshToken?: string; expires?: number; issued?: number } = {}) {
    const clientId = options.clientId ?? LOCAL_CLIENT;
    const subject = options.subject ?? LOCAL_SUBJECT;
    const scopes = options.scope ?? [...CHATGPT_SCOPES];
    return {
      id_token: await jwt({ sub: subject, nonce: options.nonce ?? "fixture-nonce", email: "local-fixture@example.test" }, { audience: clientId, expires: options.expires, issued: options.issued }),
      access_token: await jwt({ sub: subject, client_id: clientId, scope: scopes.join(" ") }, { audience: OPENAI_RESOURCE, expires: options.expires, issued: options.issued }),
      refresh_token: options.refreshToken ?? "local-fixture-refresh-original", token_type: "Bearer", expires_in: 3600, scope: scopes.join(" "),
    };
  }
  return { time, fetcher, jwt, tokens, jwk, setTokenHandler: (handler: typeof tokenHandler) => { tokenHandler = handler; }, setRevokeHandler: (handler: typeof revokeHandler) => { revokeHandler = handler; } };
}

export class MemoryCredentialFixture implements ChatGPTCredentialStore {
  readonly records = new Map<string, CredentialRecord>();
  writes = 0;
  hostReads = 0;
  async getHostId() { this.hostReads++; return LOCAL_HOST; }
  async list(ownerId: string) { return structuredClone([...this.records.values()].filter(record => record.ownerId === ownerId)); }
  async read(ownerId: string, registrationId: string) {
    const record = this.records.get(registrationId);
    return record?.ownerId === ownerId ? structuredClone(record) : null;
  }
  async write(record: CredentialRecord) { this.writes++; this.records.set(record.registrationId, structuredClone(credentialRecordSchema.parse(record))); }
  async withLock<T>(_id: string, action: () => Promise<T>) { return action(); }
}

export function localRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  const identity = { ownerId: LOCAL_OWNER, issuer: OPENAI_ISSUER, clientId: LOCAL_CLIENT, subject: LOCAL_SUBJECT, ...overrides };
  return credentialRecordSchema.parse({
    version: 1, registrationId: registrationIdFor(identity), email: "local-fixture@example.test", hostId: LOCAL_HOST, updatedAt: 1791072000000,
    tokens: { accessToken: "local-fixture-access", refreshToken: "local-fixture-refresh", idToken: "local-fixture-id", scopes: [...CHATGPT_SCOPES].sort(), expiresAt: 1791075600000, earliestRefreshAt: null, receivedAt: 1791072000000 },
    ...identity,
  });
}
