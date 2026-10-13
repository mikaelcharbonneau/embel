import { standaloneCapabilitiesSchema, standaloneLookupInputSchema, standaloneLookupResponseSchema } from "@/domain/standalone-live-checks";
import { getAuthenticatedContext } from "@/server/auth/context";
import { standaloneCapabilities, runStandaloneLookup } from "@/server/standalone-providers/live-runtime";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
function noQuery(request: Request) { if (new URL(request.url).search) throw new ApiError("invalid_input"); }
export async function GET(request: Request) {
  try { noQuery(request); const auth = await getAuthenticatedContext(); return privateJson(standaloneCapabilitiesSchema.parse(standaloneCapabilities(auth.userId))); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request); noQuery(request);
    const target = await readJson(request, standaloneLookupInputSchema, 8192);
    const auth = await getAuthenticatedContext();
    const result = await runStandaloneLookup(auth.userId, target, request.signal);
    return privateJson(standaloneLookupResponseSchema.parse({ ownerId: auth.userId, result }));
  } catch (error) { return errorResponse(error); }
}
