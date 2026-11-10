import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConfiguration } from "../config";
import { ApiError } from "../http/errors";

/**
 * The server's Supabase client for account deletion, export files and the
 * cleanup job. It uses the project's secret API key (sb_secret_…), which acts
 * as service_role: it may call the server-only account functions, the Storage
 * API for any path and the Auth admin API. It is built per request, never
 * stores a session and never reaches a browser bundle ("server-only").
 *
 * The key is the one the generation engine already uses for Storage
 * (EMBEL_ENGINE_SUPABASE_SECRET_KEY).
 */
export function accountAdminClient(env: Record<string, string | undefined> = process.env): SupabaseClient {
  const key = env.EMBEL_ENGINE_SUPABASE_SECRET_KEY;
  if (!key || !/^sb_secret_[A-Za-z0-9._-]{10,500}$/u.test(key)) throw new ApiError("integration_unavailable");
  const { url } = getSupabaseConfiguration(env);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(60_000)]),
        }),
    },
  });
}
