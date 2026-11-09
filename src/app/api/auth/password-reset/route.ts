import { z } from "zod";
import { createAuthTransitionClient } from "@/server/auth/client";
import { passwordResetFailure } from "@/server/auth/failure";
import { getApplicationOrigin } from "@/server/config";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
const emailSchema = z.strictObject({ email: z.string().trim().max(320).pipe(z.email()) });
const requested = { requested: true } as const;

/** Sends a reset link to the shared callback. Whether the address has an account is never disclosed. */
export async function POST(request: Request) {
  try {
    const origin = getApplicationOrigin();
    assertMutationOrigin(request, origin);
    const { email } = await readJson(request, emailSchema, 2048);
    const { client, commitCookies } = await createAuthTransitionClient(request.signal);
    // The SDK marks this flow's PKCE verifier as a recovery, so the callback can tell it apart.
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback` })
      .catch(() => { throw new ApiError("integration_unavailable"); });
    if (error) {
      const failure = passwordResetFailure(error);
      if (failure) throw failure;
      return privateJson(requested);
    }
    // The verifier cookie must survive until the email link is opened in this browser.
    commitCookies();
    return privateJson(requested);
  } catch (error) { return errorResponse(error); }
}
