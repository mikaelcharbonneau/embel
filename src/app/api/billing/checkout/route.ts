import { checkoutRequestSchema } from "@/domain/billing";
import { getVerifiedAccountContext } from "@/server/auth/context";
import { billingDependencies } from "@/server/billing/dependencies";
import { startCheckout } from "@/server/billing/sessions";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { assertNotBot } from "@/server/http/bot-protection";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";

/** Starts Stripe Checkout for a paid plan. The account always comes from the verified
 * session; the body only names the plan. Answers with the Checkout page to open. */
export async function POST(request: Request) {
  try {
    await assertNotBot();
    assertMutationOrigin(request);
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const { plan } = await readJson(request, checkoutRequestSchema, 1024);
    const { user } = await getVerifiedAccountContext(request.signal);
    assertExpectedAccount(request, user.id);
    const url = await startCheckout(billingDependencies(), { id: user.id, email: user.email ?? null }, plan);
    return privateJson({ url });
  } catch (error) {
    return errorResponse(error);
  }
}
