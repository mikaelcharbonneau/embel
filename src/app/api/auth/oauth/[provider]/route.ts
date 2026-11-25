import { cookies } from "next/headers";
import { createAuthTransitionClient } from "@/server/auth/client";
import {
  getEnabledAuthProviders,
  parseAuthProvider,
  parseProviderDestination,
  PROVIDER_FLOW_SECONDS,
  providerFlowCookieName,
  providerFlowId,
  supabaseProviderId,
} from "@/server/auth/providers";
import { getApplicationOrigin, getSupabaseConfiguration, shouldUseSecureSessionCookies } from "@/server/config";
import { errorResponse } from "@/server/http/errors";
import { assertMutationOrigin, readBoundedBytes } from "@/server/http/request";

export const dynamic = "force-dynamic";

/** The browser arrives here by a full-page form post, so every answer is a redirect, never JSON. */
function redirect(location: string) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** The one optional form field: where to land afterwards. Anything unexpected means the default. */
async function readDestination(request: Request) {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded"
  )
    return "/brands";
  if (!request.body) return "/brands";
  const body = new TextDecoder().decode(await readBoundedBytes(request, 1024));
  const values = new URLSearchParams(body).getAll("next");
  return (values.length === 1 ? parseProviderDestination(values[0]) : null) ?? "/brands";
}

/**
 * Starts "Continue with Google / Apple / ChatGPT". Only providers that are switched on in Supabase are
 * accepted. The PKCE verifier and the destination are stored in HttpOnly cookies and the browser is sent
 * to Supabase, which sends it on to the provider; the provider's answer returns to `/auth/callback`.
 */
export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  let origin: string;
  try {
    origin = getApplicationOrigin();
  } catch (error) {
    return errorResponse(error);
  }
  try {
    assertMutationOrigin(request, origin);
    const provider = parseAuthProvider((await context.params).provider);
    if (!provider || !(await getEnabledAuthProviders()).includes(provider)) throw new Error("provider_unavailable");
    const next = await readDestination(request);
    const supabaseProvider = supabaseProviderId(provider);
    const { client, commitCookies } = await createAuthTransitionClient(request.signal);
    const { data, error } = await client.auth.signInWithOAuth({
      provider: supabaseProvider,
      options: { redirectTo: `${origin}/auth/callback`, skipBrowserRedirect: true },
    });
    if (error || !data.url) throw new Error("provider_start_failed");
    // Only ever send the browser to this project's own Supabase sign-in address, returning to our callback
    // with exactly the flow id whose PKCE verifier the SDK just stored (createClient enables
    // appendPkceFlowIdToRedirects, so the pinned auth-js appends `sb_flow_id` and reports it as data.flowId).
    const target = new URL(data.url);
    const back = new URL(target.searchParams.get("redirect_to") ?? "");
    const flowId = data.flowId ?? "";
    if (
      target.origin !== getSupabaseConfiguration().url ||
      target.pathname !== "/auth/v1/authorize" ||
      target.searchParams.get("provider") !== supabaseProvider ||
      back.href !== `${origin}/auth/callback?sb_flow_id=${flowId}` ||
      !providerFlowId.test(flowId)
    ) {
      throw new Error("provider_start_failed");
    }
    (await cookies()).set(providerFlowCookieName(flowId), next, {
      httpOnly: true,
      secure: shouldUseSecureSessionCookies(),
      sameSite: "lax",
      path: "/auth/callback",
      maxAge: PROVIDER_FLOW_SECONDS,
    });
    commitCookies();
    return redirect(target.href);
  } catch {
    return redirect(`${origin}/sign-in?provider=failed`);
  }
}
