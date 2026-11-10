import { startNamingRunRequestSchema } from "@/domain/naming-generation";
import { getAuthenticatedContext } from "@/server/auth/context";
import { startNamingEngineRun } from "@/server/data/naming-engine";
import { startNamingRun } from "@/server/data/naming-generation";
import { namingEngineEnabled } from "@/server/engine/naming";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
/** The first names and More names. A steered run goes through `steering`. */
export async function POST(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request); const auth = await getAuthenticatedContext(); assertExpectedAccount(request, auth.userId);
    const body = await readJson(request, startNamingRunRequestSchema, 4096);
    if (body.kind === "steer") throw new ApiError("invalid_input");
    const start = await namingEngineEnabled(auth) ? startNamingEngineRun : startNamingRun;
    return privateJson(await start(auth, (await context.params).projectId, body));
  } catch (error) { return errorResponse(error); }
}
