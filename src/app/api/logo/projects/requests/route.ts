import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
import { listLogoProjectCreations } from "@/server/data/logo-workspace";
import { readLogoPageQuery } from "@/server/http/logo-query";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const auth = await getAuthenticatedContext();
    const query = readLogoPageQuery(request);
    return privateJson(await listLogoProjectCreations(auth, query));
  } catch (error) { return errorResponse(error); }
}
