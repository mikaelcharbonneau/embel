import { getAuthenticatedContext } from "@/server/auth/context";
import { getStrategyAvailability } from "@/server/data/strategy-jobs";
import { errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return privateJson({ availability: await getStrategyAvailability(await getAuthenticatedContext()) });
  } catch (error) {
    return errorResponse(error);
  }
}
