import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { getLogoStageRevision } from "@/server/data/logo-workspace";
import { logoStageSchema } from "@/domain/logo-workspace";
import { ApiError } from "@/server/http/errors";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: {params: Promise<{projectId: string; stage: string; revisionId: string}>}) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId, stage, revisionId } = await context.params;
    const parsedStage = logoStageSchema.safeParse(stage);
    if (!parsedStage.success) throw new ApiError("invalid_input");
    return privateJson(await getLogoStageRevision(auth, projectId, parsedStage.data, revisionId));
  } catch (error) { return logoErrorResponse(error); }
}
