import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { listLogoStageHistory } from "@/server/data/logo-workspace";
import { logoStageSchema } from "@/domain/logo-workspace";
import { ApiError } from "@/server/http/errors";
import { readLogoPageQuery } from "@/server/http/logo-query";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: {params: Promise<{projectId: string; stage: string}>}) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId, stage } = await context.params;
    const parsedStage = logoStageSchema.safeParse(stage);
    if (!parsedStage.success) throw new ApiError("invalid_input");
    const query = readLogoPageQuery(request, true);
    return privateJson(await listLogoStageHistory(auth, projectId, parsedStage.data, query));
  } catch (error) { return logoErrorResponse(error); }
}
