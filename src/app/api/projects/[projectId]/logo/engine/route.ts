import { getAuthenticatedContext } from "@/server/auth/context";
import { logoEngineEnabled } from "@/server/engine/logo";
import { listGenerations } from "@/server/engine/runs";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";

export const dynamic = "force-dynamic";

/** Whether the Logo step draws on the generation engine, and its latest runs. While the
 * Logo kinds are off this reports `engine: false` and the screens use the old path. */
export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId } = await context.params;
    const engine = await logoEngineEnabled(auth);
    return privateJson({ engine, runs: engine ? await listGenerations(auth, projectId, { step: "logo" }) : [] });
  } catch (error) {
    return logoErrorResponse(error);
  }
}
