import { getAuthenticatedContext } from "@/server/auth/context";
import { getSavedLogoInputs } from "@/server/data/logo-saved-inputs";
import { errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    return privateJson(await getSavedLogoInputs(auth, (await context.params).projectId));
  } catch (error) { return errorResponse(error); }
}
