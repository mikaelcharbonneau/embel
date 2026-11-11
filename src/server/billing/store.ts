import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { PaidPlanId } from "@/domain/billing";

/** The billing records, through the server-only database functions (service_role). */
export interface BillingStore {
  ownerState(ownerId: string): Promise<BillingOwnerState>;
  linkCustomer(ownerId: string, customerId: string): Promise<string>;
  ownerForCustomer(customerId: string): Promise<string | null>;
  eventSeen(eventId: string): Promise<boolean>;
  recordEvent(eventId: string, type: string): Promise<void>;
  applySubscription(state: SubscriptionState): Promise<{ live: boolean }>;
  applyInvoice(input: {
    ownerId: string;
    invoiceId: string;
    subscriptionId: string;
    planId: PaidPlanId;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<void>;
}

export type SubscriptionState = {
  ownerId: string;
  subscriptionId: string;
  customerId: string;
  planId: PaidPlanId;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
  syncedAt: Date;
};

const ownerStateSchema = z.object({
  customerId: z.string().nullable().optional(),
  subscription: z
    .object({
      id: z.string(),
      planId: z.string(),
      status: z.string(),
      cancelAtPeriodEnd: z.boolean(),
      live: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type BillingOwnerState = {
  customerId: string | null;
  subscription: z.infer<typeof ownerStateSchema>["subscription"];
};

function failure(step: string, error: { code?: string } | null) {
  if (!error) return;
  throw Object.assign(new Error(`billing_${step}`), { code: typeof error.code === "string" ? error.code : undefined });
}

export function supabaseBillingStore(admin: SupabaseClient): BillingStore {
  return {
    async ownerState(ownerId) {
      const { data, error } = await admin.rpc("billing_owner_state", { p_owner: ownerId });
      failure("owner_state", error);
      const parsed = ownerStateSchema.parse(data ?? {});
      return { customerId: parsed.customerId ?? null, subscription: parsed.subscription ?? null };
    },
    async linkCustomer(ownerId, customerId) {
      const { data, error } = await admin.rpc("billing_link_customer", { p_owner: ownerId, p_customer: customerId });
      failure("link_customer", error);
      return z.string().parse(data);
    },
    async ownerForCustomer(customerId) {
      const { data, error } = await admin.rpc("billing_owner_for_customer", { p_customer: customerId });
      failure("owner_for_customer", error);
      return z
        .uuid()
        .nullable()
        .parse(data ?? null);
    },
    async eventSeen(eventId) {
      const { data, error } = await admin.rpc("billing_event_seen", { p_event: eventId });
      failure("event_seen", error);
      return data === true;
    },
    async recordEvent(eventId, type) {
      const { error } = await admin.rpc("billing_record_event", { p_event: eventId, p_type: type });
      failure("record_event", error);
    },
    async applySubscription(state) {
      const { data, error } = await admin.rpc("billing_apply_subscription", {
        p_owner: state.ownerId,
        p_subscription: state.subscriptionId,
        p_customer: state.customerId,
        p_plan: state.planId,
        p_status: state.status,
        p_period_start: state.periodStart.toISOString(),
        p_period_end: state.periodEnd.toISOString(),
        p_cancel_at_period_end: state.cancelAtPeriodEnd,
        p_synced_at: state.syncedAt.toISOString(),
      });
      failure("apply_subscription", error);
      return z.object({ live: z.boolean() }).parse(data);
    },
    async applyInvoice(input) {
      const { error } = await admin.rpc("billing_apply_invoice", {
        p_owner: input.ownerId,
        p_invoice: input.invoiceId,
        p_subscription: input.subscriptionId,
        p_plan: input.planId,
        p_period_start: input.periodStart.toISOString(),
        p_period_end: input.periodEnd.toISOString(),
      });
      failure("apply_invoice", error);
    },
  };
}
