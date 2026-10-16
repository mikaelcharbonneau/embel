import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
import { startLogoProject } from "@/server/data/logo-workspace";
import { logoProjectCreationInputSchema, LOGO_MUTATION_MAX_BYTES } from "@/domain/logo-workspace";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { assertExpectedAccount } from "@/server/http/account-fence";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request);
    assertExpectedAccount(request, auth.userId);
    const input = await readJson(request, logoProjectCreationInputSchema, LOGO_MUTATION_MAX_BYTES);
    return privateJson(await startLogoProject(auth, input));
  } catch (error) { return errorResponse(error); }
}
