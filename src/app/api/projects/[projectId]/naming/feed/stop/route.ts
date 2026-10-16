import { stopNamingFeedIntentSchema } from "@/domain/naming-brain";
import { getAuthenticatedContext } from "@/server/auth/context";
import { stopNamingFeed } from "@/server/data/naming-brain";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
export async function POST(request: Request, context: RouteContext) {
 try { assertMutationOrigin(request); const auth = await getAuthenticatedContext(); assertExpectedAccount(request, auth.userId);
 const intent = await readJson(request, stopNamingFeedIntentSchema, 4096); return privateJson(await stopNamingFeed(auth, (await context.params).projectId, intent)); }
 catch (error) { return errorResponse(error); }
}
