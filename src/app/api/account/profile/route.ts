import { PROFILE_MAX_BYTES, saveAccountProfileSchema } from "@/domain/account-profile";
import { getProfileContext, readAccountProfile, saveAccountProfile } from "@/server/data/account-profile";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { assertExpectedAccount } from "@/server/http/account-fence";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const auth = await getProfileContext(request.signal);
    return privateJson({ profile: await readAccountProfile(auth) });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    assertMutationOrigin(request);
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const input = await readJson(request, saveAccountProfileSchema, PROFILE_MAX_BYTES);
    const auth = await getProfileContext(request.signal);
    assertExpectedAccount(request, auth.userId);
    return privateJson({ profile: await saveAccountProfile(auth, input) });
  } catch (error) { return errorResponse(error); }
}
