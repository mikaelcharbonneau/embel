import { getAuthenticatedContext } from "@/server/auth/context";
import { getAssetLogoExport } from "@/server/data/asset-export-evidence";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ versionId: string }> }) {
  try { return privateJson(await getAssetLogoExport(await getAuthenticatedContext(), (await context.params).versionId, request.signal)); }
  catch (error) { return errorResponse(error); }
}
