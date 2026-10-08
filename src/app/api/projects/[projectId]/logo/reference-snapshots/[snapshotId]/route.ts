import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { readLogoReferenceSnapshot } from "@/server/data/logo-workspace";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: {params: Promise<{projectId: string; snapshotId: string}>}) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId, snapshotId } = await context.params;
    return privateJson(await readLogoReferenceSnapshot(auth, projectId, snapshotId));
  } catch (error) { return logoErrorResponse(error); }
}
