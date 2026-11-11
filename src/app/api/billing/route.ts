import { getAuthenticatedContext } from "@/server/auth/context";
import { getBillingSummary } from "@/server/billing/summary";
import { errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";

/** The signed-in person's plan, credits and subscription for the Plans page. */
export async function GET() {
  try {
    return privateJson({ billing: await getBillingSummary(await getAuthenticatedContext()) });
  } catch (error) {
    return errorResponse(error);
  }
}
