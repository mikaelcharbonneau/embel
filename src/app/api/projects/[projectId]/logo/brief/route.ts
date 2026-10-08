import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { saveLogoBrief } from "@/server/data/logo-workspace";
import { saveLogoBriefInputSchema, LOGO_MUTATION_MAX_BYTES } from "@/domain/logo-workspace";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
export async function PUT(request: Request, context: {params: Promise<{projectId: string}>}) {
  try {
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request);
    const { projectId } = await context.params;
    const input = await readJson(request, saveLogoBriefInputSchema, LOGO_MUTATION_MAX_BYTES);
    return privateJson(await saveLogoBrief(auth, projectId, input));
  } catch (error) { return logoErrorResponse(error); }
}
