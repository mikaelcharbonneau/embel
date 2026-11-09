import { z } from "zod";
import { getVerifiedAccountContext } from "@/server/auth/context";
import { isRecentRecovery } from "@/server/auth/confirmation";
import { passwordUpdateFailure } from "@/server/auth/failure";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
const passwordSchema = z.strictObject({ password: z.string().min(12).max(1024) });
type AccountClient = Awaited<ReturnType<typeof getVerifiedAccountContext>>["client"];

/** Runs once after a new password is saved: a reset often means someone else may know the old
 * password, so every other device is signed out. A failure here never undoes the saved password. */
async function afterPasswordChanged(client: AccountClient): Promise<void> {
  await client.auth.signOut({ scope: "others" }).catch(() => undefined);
}

/** Sets a new password only for a session that began from a recent reset link. */
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    const { password } = await readJson(request, passwordSchema, 8192);
    const { client } = await getVerifiedAccountContext(request.signal).catch((error: unknown) => {
      throw error instanceof ApiError && error.code === "unauthenticated" ? new ApiError("recovery_required") : error;
    });
    // A stolen everyday session must not be enough to replace the password without the old one.
    const { data, error: claimsError } = await client.auth.getClaims()
      .catch(() => { throw new ApiError("integration_unavailable"); });
    if (claimsError && (claimsError.name === "AuthRetryableFetchError" || (claimsError.status ?? 0) >= 500)) {
      throw new ApiError("integration_unavailable");
    }
    if (claimsError || !isRecentRecovery(data?.claims)) throw new ApiError("recovery_required");
    const { error } = await client.auth.updateUser({ password })
      .catch(() => { throw new ApiError("integration_unavailable"); });
    if (error) throw passwordUpdateFailure(error);
    await afterPasswordChanged(client);
    return privateJson({ updated: true });
  } catch (error) { return errorResponse(error); }
}
