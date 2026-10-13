import { z } from "zod";
import { createAuthTransitionClient } from "@/server/auth/client";
import { signUpFailure } from "@/server/auth/failure";
import { getApplicationOrigin } from "@/server/config";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
const emailSchema = z.strictObject({ email: z.string().trim().max(320).pipe(z.email()) });

export async function POST(request: Request) {
  try {
    const origin = getApplicationOrigin();
    assertMutationOrigin(request, origin);
    const { email } = await readJson(request, emailSchema, 2048);
    const { client, commitCookies } = await createAuthTransitionClient(request.signal);
    const { error } = await client.auth.resend({ type: "signup", email, options: { emailRedirectTo: `${origin}/auth/callback` } })
      .catch(() => { throw new ApiError("integration_unavailable"); });
    // Existence and confirmation state are never disclosed by this endpoint.
    const hiddenAccountFailure = error && [400, 404, 422].includes(error.status ?? 0) && ["user_not_found", "email_not_confirmed", "user_already_exists", "email_exists"].includes(error.code ?? "");
    if (error && !hiddenAccountFailure) {
      throw signUpFailure(error);
    }
    if (!error) commitCookies();
    return privateJson({ authenticated: false, confirmationRequired: true });
  } catch (error) { return errorResponse(error); }
}
