import { getAuthenticatedContext } from "@/server/auth/context";
import { getAccountNames, readNamingQuery } from "@/server/data/project-naming";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const auth = await getAuthenticatedContext(); return privateJson(await getAccountNames(auth, readNamingQuery(request, "library"))); }
  catch (error) { return errorResponse(error); }
}
