import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseConfiguration, shouldUseSecureSessionCookies } from "../config";

/** Route handlers only: a fresh client and writable cookie jar for every request. */
async function createClient(requestSignal: AbortSignal | undefined, staged: boolean) {
  const configuration = getSupabaseConfiguration();
  const cookieStore = await cookies();
  const pending = new Map<string, { name: string; value: string; options: CookieOptions }>();
  const client = createServerClient(configuration.url, configuration.publishableKey, {
    // The browser uses same-origin APIs, never a client-side Supabase session reader.
    cookieOptions: { httpOnly: true, secure: shouldUseSecureSessionCookies(), sameSite: "lax", path: "/" },
    // Pinned SDK support: each email link selects its own HttpOnly PKCE verifier.
    auth: { experimental: { appendPkceFlowIdToRedirects: true } },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            ...(requestSignal ? [requestSignal] : []),
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(10_000),
          ]),
        }),
    },
    cookies: {
      getAll: () => {
        const values = new Map(cookieStore.getAll().map((cookie) => [cookie.name, cookie]));
        for (const cookie of pending.values()) {
          if (cookie.options.maxAge === 0) values.delete(cookie.name);
          else values.set(cookie.name, { name: cookie.name, value: cookie.value });
        }
        return [...values.values()];
      },
      setAll: (values) => {
        for (const cookie of values) {
          if (staged) pending.set(cookie.name, cookie);
          else cookieStore.set(cookie.name, cookie.value, cookie.options);
        }
      },
    },
  });
  return {
    client,
    commitCookies: () => {
      for (const { name, value, options } of pending.values()) cookieStore.set(name, value, options);
      pending.clear();
    },
  };
}

export async function createRouteAuthClient(requestSignal?: AbortSignal) {
  return (await createClient(requestSignal, false)).client;
}

/** Validate new authentication results before permitting any session cookie writes. */
export async function createAuthTransitionClient(requestSignal?: AbortSignal) {
  return createClient(requestSignal, true);
}
