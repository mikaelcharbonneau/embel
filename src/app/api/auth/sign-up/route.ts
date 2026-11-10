import { z } from "zod";
import { captchaOptions, captchaTokenField } from "@/server/auth/captcha";
import { createAuthTransitionClient } from "@/server/auth/client";
import { isConfirmedAuthResult } from "@/server/auth/confirmation";
import { signUpFailure } from "@/server/auth/failure";
import { getApplicationOrigin } from "@/server/config";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
const credentialsSchema = z.strictObject({
  email: z.string().trim().max(320).pipe(z.email()),
  password: z.string().min(12).max(1024),
  captchaToken: captchaTokenField,
});
const confirmation = { authenticated: false, confirmationRequired: true } as const;

export async function POST(request: Request) {
  try {
    const origin = getApplicationOrigin();
    assertMutationOrigin(request, origin);
    const { captchaToken, ...credentials } = await readJson(request, credentialsSchema, 8192);
    const { client, commitCookies } = await createAuthTransitionClient(request.signal);
    const { data, error } = await client.auth.signUp({
      ...credentials, options: { emailRedirectTo: `${origin}/auth/callback`, ...captchaOptions(captchaToken) },
    }).catch(() => { throw new ApiError("integration_unavailable"); });
    // Both provider duplicate errors and obfuscated duplicate-user successes
    // have the same public response as a new email awaiting confirmation.
    if (error) {
      if ((error.status === 400 || error.status === 422) && (error.code === "user_already_exists" || error.code === "email_exists")) return privateJson(confirmation);
      throw signUpFailure(error);
    }
    if (!data.user || data.user.is_anonymous) throw new ApiError("signup_failed");
    if (data.session) {
      if (!isConfirmedAuthResult(data)) {
        await client.auth.signOut({ scope: "local" }).catch(() => undefined);
        throw new ApiError("signup_failed");
      }
      commitCookies();
      return privateJson({ authenticated: true });
    }
    // PKCE verifier cookies must survive until the email is opened in this browser.
    commitCookies();
    return privateJson(confirmation);
  } catch (error) { return errorResponse(error); }
}
