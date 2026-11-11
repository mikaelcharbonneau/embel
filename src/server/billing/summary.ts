import "server-only";
import { billingSummarySchema } from "@/domain/billing";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

/** Read with the person's own login (get_billing_summary uses auth.uid()). */
export async function getBillingSummary(auth: AuthenticatedContext) {
  const { data, error } = await auth.client.rpc("get_billing_summary");
  if (error) throw new ApiError(error.code === "42501" ? "unauthenticated" : "integration_unavailable");
  const summary = billingSummarySchema.safeParse(data);
  if (!summary.success) throw new ApiError("integration_unavailable");
  return summary.data;
}
