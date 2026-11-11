import { z } from "zod";

/** The plans on sale (owner decision, November 10, 2026). Monthly only, prices in US dollars.
 * Credits come from the database (fluid_private.plans); prices are charged by Stripe from the
 * prices that scripts/stripe/ensure-products.mjs creates with these lookup keys. A test keeps
 * the script's copy of these numbers equal to this one. */
export const PAID_PLAN_IDS = ["pro", "studio"] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];
export type PlanId = "free" | PaidPlanId;

export const PLAN_CATALOG: Record<
  PlanId,
  { name: string; monthlyPriceCents: number; lookupKey: string | null; description: string }
> = {
  free: { name: "Free", monthlyPriceCents: 0, lookupKey: null, description: "Try the full branding journey." },
  pro: {
    name: "Pro",
    monthlyPriceCents: 799,
    lookupKey: "embel_pro_monthly",
    description: "For building a brand from idea to assets.",
  },
  studio: {
    name: "Studio",
    monthlyPriceCents: 2799,
    lookupKey: "embel_studio_monthly",
    description: "For people working on several brands.",
  },
};

export const paidPlanSchema = z.enum(PAID_PLAN_IDS);

/** The plan a Stripe price lookup key sells, if it is one of ours. */
export function planForLookupKey(lookupKey: string | null | undefined): PaidPlanId | null {
  return PAID_PLAN_IDS.find((plan) => PLAN_CATALOG[plan].lookupKey === lookupKey) ?? null;
}

export function formatMonthlyPrice(cents: number) {
  return cents === 0 ? "$0" : `$${(cents / 100).toFixed(2)}`;
}

export const checkoutRequestSchema = z.strictObject({ plan: paidPlanSchema });
export const portalRequestSchema = z.strictObject({
  plan: paidPlanSchema.optional(),
  /** Opens the portal straight on cancelling the current plan (at the end of the paid period). */
  action: z.literal("cancel").optional(),
});
export const billingRedirectResponseSchema = z.strictObject({ url: z.url({ protocol: /^https$/u }) });

/** The signed-in person's plan, credits and subscription. Never a payment detail. */
export const billingSummarySchema = z.strictObject({
  planId: z.string().min(1).max(40),
  balance: z.number().int(),
  periodEnd: z.string(),
  subscription: z
    .strictObject({
      planId: z.string().min(1).max(40),
      status: z.string().min(1).max(40),
      cancelAtPeriodEnd: z.boolean(),
      currentPeriodEnd: z.string(),
    })
    .nullable(),
  plans: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(40),
        name: z.string().min(1).max(40),
        monthlyCredits: z.number().int(),
      }),
    )
    .max(10),
});
export type BillingSummary = z.infer<typeof billingSummarySchema>;
export const billingSummaryResponseSchema = z.strictObject({ billing: billingSummarySchema });
