import { enqueueStandaloneNamesSchema, STANDALONE_NAMES_MAX_BYTES } from "@/domain/standalone-names";
import { getAuthenticatedContext } from "@/server/auth/context";
import { enqueueStandaloneNames, getStandaloneNames } from "@/server/data/standalone-names";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return privateJson(await getStandaloneNames(await getAuthenticatedContext(), new URL(request.url).searchParams)); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    return privateJson(await enqueueStandaloneNames(auth, await readJson(request, enqueueStandaloneNamesSchema, STANDALONE_NAMES_MAX_BYTES)), 202);
  } catch (error) { return errorResponse(error); }
}
