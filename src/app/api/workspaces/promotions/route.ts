import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
import { promoteStandaloneWorkspace } from "@/server/data/home-lifecycle";
import { standalonePromotionInputSchema } from "@/domain/standalone-promotion";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const input = await readJson(request, standalonePromotionInputSchema, 32_768);
    return privateJson(await promoteStandaloneWorkspace(auth, input));
  } catch (error) { return errorResponse(error); }
}
