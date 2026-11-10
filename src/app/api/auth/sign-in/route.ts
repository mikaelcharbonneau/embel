import { z } from "zod";
import { createAuthTransitionClient } from "@/server/auth/client";
import { isConfirmedAuthResult } from "@/server/auth/confirmation";
import { captchaOptions, captchaTokenField } from "@/server/auth/captcha";
import { authFailure } from "@/server/auth/failure";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
const credentialsSchema = z.strictObject({
  email: z.string().trim().max(320).pipe(z.email()),
  password: z.string().min(1).max(1024),
  captchaToken: captchaTokenField,
});

/** Existing accounts only. No signup, account enumeration or credential persistence. */
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    const { captchaToken, ...credentials } = await readJson(request, credentialsSchema, 8192);
    const { client, commitCookies } = await createAuthTransitionClient(request.signal);
    const result = await client.auth
      .signInWithPassword({ ...credentials, ...(captchaToken ? { options: captchaOptions(captchaToken) } : {}) })
      .catch(() => {
        throw new ApiError("integration_unavailable");
      });
    if (result.error) throw authFailure(result.error);
    if (!isConfirmedAuthResult(result.data)) {
      await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      throw new ApiError("invalid_credentials");
    }
    commitCookies();
    return privateJson({ authenticated: true });
  } catch (error) {
    return errorResponse(error);
  }
}
