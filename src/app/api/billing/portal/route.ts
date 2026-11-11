import { portalRequestSchema } from "@/domain/billing";
import { getVerifiedAccountContext } from "@/server/auth/context";
import { billingDependencies } from "@/server/billing/dependencies";
import { startPortal } from "@/server/billing/sessions";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";

/** Opens the Stripe customer portal for the signed-in person's own subscription: cancel,
 * switch plan, payment method and invoices. With `plan`, it opens on that plan change. */
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const { plan } = await readJson(request, portalRequestSchema, 1024);
    const { user } = await getVerifiedAccountContext(request.signal);
    assertExpectedAccount(request, user.id);
    return privateJson({ url: await startPortal(billingDependencies(), user.id, plan) });
  } catch (error) {
    return errorResponse(error);
  }
}
