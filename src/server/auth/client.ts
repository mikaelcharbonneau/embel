import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseConfiguration, shouldUseSecureSessionCookies } from "../config";

/** Route handlers only: a fresh client and writable cookie jar for every request. */
export async function createRouteAuthClient(requestSignal?: AbortSignal) {
  const configuration = getSupabaseConfiguration();
  const cookieStore = await cookies();
  return createServerClient(configuration.url, configuration.publishableKey, {
    // The browser uses same-origin APIs, never a client-side Supabase session reader.
    cookieOptions: { httpOnly: true, secure: shouldUseSecureSessionCookies(), sameSite: "lax", path: "/" },
    global: {
      fetch: (input, init) => fetch(input, {
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
      getAll: () => cookieStore.getAll(),
      setAll: (values) => { for (const { name, value, options } of values) cookieStore.set(name, value, options); },
    },
  });
}
