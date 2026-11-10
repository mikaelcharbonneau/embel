import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { selectLogoConceptInputSchema, LOGO_MUTATION_MAX_BYTES } from "@/domain/logo-workspace";
import { selectLogoConcept } from "@/server/data/logo-workspace";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request);
    const { projectId } = await context.params;
    const input = await readJson(request, selectLogoConceptInputSchema, LOGO_MUTATION_MAX_BYTES);
    return privateJson(await selectLogoConcept(auth, projectId, input));
  } catch (error) {
    return logoErrorResponse(error);
  }
}
