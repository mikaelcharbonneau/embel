import { z } from "zod";
import { createRouteAuthClient } from "@/server/auth/client";
import { authFailure } from "@/server/auth/failure";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
const credentialsSchema = z.strictObject({
  email: z.string().trim().max(320).pipe(z.email()),
  password: z.string().min(1).max(1024),
});

/** Existing accounts only. No signup, account enumeration or credential persistence. */
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    const credentials = await readJson(request, credentialsSchema, 8192);
    const client = await createRouteAuthClient(request.signal);
    const result = await client.auth.signInWithPassword(credentials)
      .catch(() => { throw new ApiError("integration_unavailable"); });
    if (result.error) throw authFailure(result.error);
    if (!result.data.session || !result.data.user || result.data.user.is_anonymous) {
      await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      throw new ApiError("invalid_credentials");
    }
    return privateJson({ authenticated: true });
  } catch (error) { return errorResponse(error); }
}
