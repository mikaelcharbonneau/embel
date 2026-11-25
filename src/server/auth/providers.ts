import "server-only";
import type { Provider } from "@supabase/supabase-js";
import { authProviders, type AuthProvider } from "@/domain/auth-providers";
import { getSupabaseConfiguration } from "../config";

/**
 * Our provider ids to Supabase Auth provider identifiers. This is the only place that knows them.
 *
 * - google, apple: built-in Supabase providers with the same names.
 * - chatgpt: OpenAI's "Sign in with ChatGPT" is standard OpenID Connect (issuer https://auth.openai.com,
 *   scopes `openid profile email`; developers.openai.com/siwc/website, read November 25, 2026). Supabase
 *   has no built-in provider for it, so it is a Supabase custom OIDC provider, whose identifier must start
 *   with `custom:` (supabase.com/docs/guides/auth/custom-oauth-providers; the pinned auth-js `Provider`
 *   type accepts `custom:${string}`). The name after the prefix is ours: the provider must be created in
 *   the Supabase project with exactly this identifier. OpenAI issues client ids to selected partners only
 *   (limited trial), so until Embel has one and the provider exists and is enabled, this stays hidden.
 */
const supabaseProviderIds = {
  google: "google",
  apple: "apple",
  chatgpt: "custom:chatgpt",
} as const satisfies Record<AuthProvider, Provider>;

export function supabaseProviderId(provider: AuthProvider): Provider {
  return supabaseProviderIds[provider];
}

export function parseAuthProvider(value: unknown): AuthProvider | null {
  return authProviders.find((provider) => provider === value) ?? null;
}

/** Where a provider sign-in may land afterwards. Nothing else is ever accepted as a destination. */
export const providerDestinations = ["/brands", "/"] as const;
export type ProviderDestination = (typeof providerDestinations)[number];

export function parseProviderDestination(value: unknown): ProviderDestination | null {
  return providerDestinations.find((destination) => destination === value) ?? null;
}

/**
 * The start route remembers the destination in a short-lived HttpOnly cookie named after the PKCE flow,
 * not in the callback address: Supabase compares that address with the project's redirect allow-list,
 * query string included, and an extra parameter could stop it matching. The cookie also tells the
 * callback that this flow is a provider sign-in and not an email link.
 */
export const PROVIDER_FLOW_SECONDS = 10 * 60;
export const providerFlowId = /^[A-Za-z0-9_-]{8,64}$/;

export function providerFlowCookieName(flowId: string): string {
  return `embel-provider-flow-${flowId}`;
}

const FRESH_MS = 60_000;
const FAILED_MS = 5_000;
const TIMEOUT_MS = 2_500;
const MAX_REPLY_BYTES = 65_536;
let cached: { key: string; until: number; value: Promise<AuthProvider[]> } | null = null;

/** Tests only: forget the last answer. */
export function clearAuthProviderCache(): void {
  cached = null;
}

async function readJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    headers: { ...headers, accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const text = await response.text();
  return text.length > MAX_REPLY_BYTES ? null : (JSON.parse(text) as unknown);
}

/** Built-in providers: the public settings endpoint lists `external: { google: true, ... }`. */
async function readBuiltIn(url: string, publishableKey: string): Promise<Set<string> | null> {
  const settings = await readJson(`${url}/auth/v1/settings`, { apikey: publishableKey });
  const external = (settings as { external?: unknown } | null)?.external;
  if (typeof external !== "object" || external === null || Array.isArray(external)) return null;
  return new Set(
    Object.entries(external)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name),
  );
}

/**
 * Custom providers are not in the public settings reply (supabase/auth `internal/api/settings.go` lists
 * built-in providers only), so the only truthful source is the Auth admin API, which needs the server's
 * secret key. Without that key (previews, local development) a custom provider is reported as off.
 * The request is the one the pinned auth-js makes for `auth.admin.customProviders.getProvider(identifier)`
 * (GET /auth/v1/admin/custom-providers/custom:chatgpt, identifier unencoded); supabase/auth answers it
 * with the provider's `identifier` and `enabled`, or 404 `custom_provider_not_found`, or an error when
 * custom providers are not available to the project. Only an exact, enabled match shows the button.
 */
async function isCustomProviderEnabled(url: string, identifier: string): Promise<boolean> {
  const key = process.env.EMBEL_ENGINE_SUPABASE_SECRET_KEY;
  if (!key || !/^sb_secret_[A-Za-z0-9._-]{10,500}$/u.test(key)) return false;
  const provider = await readJson(`${url}/auth/v1/admin/custom-providers/${identifier}`, {
    apikey: key,
    authorization: `Bearer ${key}`,
  }).catch(() => null);
  const { identifier: found, enabled } = (provider ?? {}) as { identifier?: unknown; enabled?: unknown };
  return found === identifier && enabled === true;
}

async function readEnabled(url: string, publishableKey: string): Promise<AuthProvider[]> {
  const builtIn = await readBuiltIn(url, publishableKey);
  if (!builtIn) throw new Error("auth_settings_unreadable");
  const enabled = await Promise.all(
    authProviders.map((provider) => {
      const id = supabaseProviderIds[provider];
      return id.startsWith("custom:") ? isCustomProviderEnabled(url, id) : builtIn.has(id);
    }),
  );
  return authProviders.filter((_, index) => enabled[index]);
}

/**
 * Which of our sign-in providers are switched on in the Supabase project right now, in the order of
 * `authProviders`. A sign-in button is shown only for these, and the start route accepts only these.
 * Anything uncertain (Supabase not configured, network error, timeout, unexpected reply) answers [].
 * The answer is kept for a minute (five seconds after a failure) so pages are not slowed.
 */
export async function getEnabledAuthProviders(): Promise<AuthProvider[]> {
  let configuration: { url: string; publishableKey: string };
  try {
    configuration = getSupabaseConfiguration();
  } catch {
    return [];
  }
  const key = `${configuration.url}\n${configuration.publishableKey}`;
  const now = Date.now();
  if (cached && cached.key === key && cached.until > now) return [...(await cached.value)];
  const entry = {
    key,
    until: now + FRESH_MS,
    value: readEnabled(configuration.url, configuration.publishableKey).catch(() => {
      entry.until = Date.now() + FAILED_MS;
      return [] as AuthProvider[];
    }),
  };
  cached = entry;
  return [...(await entry.value)];
}
