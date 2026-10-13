import { getAuthenticatedContext } from "@/server/auth/context";
import { getProjectInspiration } from "@/server/data/inspiration";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  try { return privateJson(await getProjectInspiration(await getAuthenticatedContext(), (await context.params).projectId)); }
  catch (error) { return errorResponse(error); }
}
