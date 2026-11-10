import { createAuthTransitionClient } from "@/server/auth/client";
import { isConfirmedAuthResult } from "@/server/auth/confirmation";
import { getApplicationOrigin } from "@/server/config";
import { errorResponse } from "@/server/http/errors";

export const dynamic = "force-dynamic";

function confirmationRedirect(origin: string, status: "complete" | "failed" | "recovery") {
  // Never reflect code, provider errors, next, Host or forwarding headers.
  // An explicit empty fragment prevents browsers inheriting provider fragments.
  return new Response(null, { status: 303, headers: {
    Location: status === "recovery" ? `${origin}/reset-password#` : `${origin}/sign-in?confirmation=${status}#`,
    "Cache-Control": "private, no-store", Vary: "Cookie", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } });
}

export async function GET(request: Request) {
  let origin: string;
  try { origin = getApplicationOrigin(); } catch (error) { return errorResponse(error); }
  try {
    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    const flowId = params.get("sb_flow_id");
    if (!code || !/^[A-Za-z0-9_-]{16,1024}$/.test(code) || params.getAll("code").length !== 1 ||
        params.getAll("sb_flow_id").length > 1 || (flowId !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(flowId)) ||
        params.has("error") || params.has("error_code") || params.has("error_description")) {
      return confirmationRedirect(origin, "failed");
    }
    const { client, commitCookies } = await createAuthTransitionClient(request.signal);
    const { data, error } = await client.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
    if (error || !isConfirmedAuthResult(data)) return confirmationRedirect(origin, "failed");
    commitCookies();
    // Only a verifier this browser stored for a password reset reports "recovery". The pinned SDK returns
    // redirectType at runtime but omits it from its declared type; tests/server/auth-transition.test.ts covers it.
    const recovery = (data as { redirectType?: unknown }).redirectType === "recovery";
    return confirmationRedirect(origin, recovery ? "recovery" : "complete");
  } catch { return confirmationRedirect(origin, "failed"); }
}
