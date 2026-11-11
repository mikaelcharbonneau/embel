import "server-only";
import { ApiError } from "./http/errors";
import { getVercelPreviewOrigin, getVercelProductionOrigin } from "./preview-origin.mjs";

type Environment = Record<string, string | undefined>;

export function shouldUseSecureSessionCookies(env: Environment = process.env): boolean {
  return env.NODE_ENV === "production";
}

export function getSupabaseConfiguration(env: Environment = process.env) {
  const rawUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!rawUrl || !publishableKey?.startsWith("sb_publishable_")) {
    throw new ApiError("integration_unavailable");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError("integration_unavailable");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:" && env.NODE_ENV !== "production"))
  ) {
    throw new ApiError("integration_unavailable");
  }
  return { url: url.origin, publishableKey };
}

export function getApplicationOrigin(env: Environment = process.env): string {
  try {
    if (env.VERCEL_ENV === "preview") return getVercelPreviewOrigin(env);
    if (env.VERCEL_ENV === "production") return getVercelProductionOrigin(env);
    const origin = new URL(env.APP_ORIGIN ?? "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      (origin.protocol !== "https:" && !(local && origin.protocol === "http:" && env.NODE_ENV !== "production"))
    ) {
      throw new Error("invalid");
    }
    return origin.origin;
  } catch {
    throw new ApiError("integration_unavailable");
  }
}

/** The Stripe secret key (server only). Test keys work everywhere; a live key is refused
 * outside Vercel production so a preview or a laptop can never charge real cards. */
export function getStripeSecretKey(env: Environment = process.env): string {
  const key = env.STRIPE_SECRET_KEY?.trim();
  const match = key ? /^(?:sk|rk)_(test|live)_[A-Za-z0-9]{10,500}$/u.exec(key) : null;
  if (!key || !match) throw new ApiError("integration_unavailable");
  if (match[1] === "live" && env.VERCEL_ENV !== "production") throw new ApiError("integration_unavailable");
  return key;
}

/** The signing secret of the Stripe webhook endpoint (server only). */
export function getStripeWebhookSecret(env: Environment = process.env): string {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret || !/^whsec_[A-Za-z0-9+/=_-]{10,500}$/u.test(secret)) throw new ApiError("integration_unavailable");
  return secret;
}
