import { cookies } from "next/headers";
import { createAuthTransitionClient } from "@/server/auth/client";
import { isConfirmedAuthResult } from "@/server/auth/confirmation";
import {
  parseProviderDestination,
  providerFlowCookieName,
  providerFlowId,
  type ProviderDestination,
} from "@/server/auth/providers";
import { getApplicationOrigin, shouldUseSecureSessionCookies } from "@/server/config";
import { errorResponse } from "@/server/http/errors";

export const dynamic = "force-dynamic";

/** Never reflect code, provider errors, next, Host or forwarding headers.
 * An explicit empty fragment prevents browsers inheriting provider fragments. */
function redirect(location: string) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${location}#`,
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * This route finishes two kinds of sign-in. An email link (confirmation, password reset) ends on the
 * sign-in or reset page. A provider sign-in (Google, Apple, ChatGPT) was started by
 * `POST /api/auth/oauth/[provider]`, which left this browser a cookie for the flow holding "/" or
 * "/brands"; it ends on that page, or on `/sign-in?provider=failed`. Nothing in the address chooses
 * the destination.
 */
function finish(origin: string, next: ProviderDestination | null, status: "complete" | "failed" | "recovery") {
  if (status === "recovery") return redirect(`${origin}/reset-password`);
  if (!next) return redirect(`${origin}/sign-in?confirmation=${status}`);
  return redirect(status === "complete" ? `${origin}${next}` : `${origin}/sign-in?provider=failed`);
}

/** The destination the start route stored for this flow, removed as it is read; null for an email link. */
async function takeProviderDestination(params: URLSearchParams): Promise<ProviderDestination | null> {
  const flowId = params.get("sb_flow_id");
  if (flowId === null || params.getAll("sb_flow_id").length !== 1 || !providerFlowId.test(flowId)) return null;
  try {
    const cookieStore = await cookies();
    const name = providerFlowCookieName(flowId);
    const stored = cookieStore.getAll().find((cookie) => cookie.name === name);
    if (!stored) return null;
    cookieStore.set(name, "", {
      httpOnly: true,
      secure: shouldUseSecureSessionCookies(),
      sameSite: "lax",
      path: "/auth/callback",
      maxAge: 0,
    });
    return parseProviderDestination(stored.value);
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  let origin: string;
  try {
    origin = getApplicationOrigin();
  } catch (error) {
    return errorResponse(error);
  }
  let next: ProviderDestination | null = null;
  try {
    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    const flowId = params.get("sb_flow_id");
    next = await takeProviderDestination(params);
    if (
      !code ||
      !/^[A-Za-z0-9_-]{16,1024}$/.test(code) ||
      params.getAll("code").length !== 1 ||
      params.getAll("sb_flow_id").length > 1 ||
      (flowId !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(flowId)) ||
      params.has("error") ||
      params.has("error_code") ||
      params.has("error_description")
    ) {
      return finish(origin, next, "failed");
    }
    const { client, commitCookies } = await createAuthTransitionClient(request.signal);
    const { data, error } = await client.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
    if (error || !isConfirmedAuthResult(data)) return finish(origin, next, "failed");
    commitCookies();
    // Only a verifier this browser stored for a password reset reports "recovery". The pinned SDK returns
    // redirectType at runtime but omits it from its declared type; tests/server/auth-transition.test.ts covers it.
    const recovery = (data as { redirectType?: unknown }).redirectType === "recovery";
    return finish(origin, next, recovery ? "recovery" : "complete");
  } catch {
    return finish(origin, next, "failed");
  }
}
