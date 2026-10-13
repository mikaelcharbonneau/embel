import "server-only";
import { ApiError } from "./http/errors";
import { getVercelPreviewOrigin, getVercelProductionOrigin } from "./preview-origin.mjs";

type Environment = Record<string, string | undefined>;

export function shouldUseSecureSessionCookies(env: Environment = process.env): boolean {
  const local = env.FLUID_RUNTIME === "local" && !env.VERCEL && env.APP_ORIGIN === "http://127.0.0.1:3106";
  return env.NODE_ENV === "production" && !local;
}

export function getSupabaseConfiguration(env: Environment = process.env) {
  const rawUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!rawUrl || !publishableKey?.startsWith("sb_publishable_")) {
    throw new ApiError("integration_unavailable");
  }
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new ApiError("integration_unavailable"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(local && url.protocol === "http:" && env.NODE_ENV !== "production"))) {
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
    const approvedLocalRuntime = env.FLUID_RUNTIME === "local" && !env.VERCEL && origin.origin === "http://127.0.0.1:3106";
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
        (origin.protocol !== "https:" && !(local && origin.protocol === "http:" && (env.NODE_ENV !== "production" || approvedLocalRuntime)))) {
      throw new Error("invalid");
    }
    return origin.origin;
  } catch { throw new ApiError("integration_unavailable"); }
}
