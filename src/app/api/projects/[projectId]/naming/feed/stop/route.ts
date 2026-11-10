import { z } from "zod";
import { getAuthenticatedContext } from "@/server/auth/context";
import { stopNamingEngineRun } from "@/server/data/naming-engine";
import { stopNamingRun } from "@/server/data/naming-generation";
import { namingEngineEnabled } from "@/server/engine/naming";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
export async function POST(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request); const auth = await getAuthenticatedContext(); assertExpectedAccount(request, auth.userId);
    await readJson(request, z.strictObject({}), 4096);
    const stop = await namingEngineEnabled(auth) ? stopNamingEngineRun : stopNamingRun;
    return privateJson(await stop(auth, (await context.params).projectId));
  } catch (error) { return errorResponse(error); }
}
