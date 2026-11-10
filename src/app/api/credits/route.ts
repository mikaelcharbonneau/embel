import { getAuthenticatedContext } from "@/server/auth/context";
import { getCreditSummary } from "@/server/engine/runs";
import { errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";

/** Plan, remaining credits and when the monthly allowance renews. Credits, not prices. */
export async function GET() {
  try {
    return privateJson({ credits: await getCreditSummary(await getAuthenticatedContext()) });
  } catch (error) {
    return errorResponse(error);
  }
}
