import { assertNotBot } from "@/server/http/bot-protection";
import { startNamingRunRequestSchema } from "@/domain/naming-generation";
import { getAuthenticatedContext } from "@/server/auth/context";
import { startNamingEngineRun } from "@/server/data/naming-engine";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
/** "More like this" names and typed guidance start a steered run. */
export async function POST(request: Request, context: RouteContext) {
  try {
    await assertNotBot();
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    const body = await readJson(request, startNamingRunRequestSchema, 16_384);
    if (body.kind !== "steer") throw new ApiError("invalid_input");
    return privateJson(await startNamingEngineRun(auth, (await context.params).projectId, body));
  } catch (error) {
    return errorResponse(error);
  }
}
