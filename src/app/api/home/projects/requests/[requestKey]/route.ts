import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
import { readAttachedProjectDraftRequest } from "@/server/home-attachments";
export async function GET(request: Request, context: { params: Promise<{ requestKey: string }> }) {
  try { const auth = await getAuthenticatedContext(); return privateJson(await readAttachedProjectDraftRequest(auth, (await context.params).requestKey, request.signal)); }
  catch (error) { return errorResponse(error); }
}
