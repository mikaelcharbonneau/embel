/** Synthetic local examples only. These records are not real availability or purchases. */
import {
  domainCheckSchema,
  domainOrderSchema,
  domainQuoteSchema,
  type DomainSearchAdapter,
} from "@/features/domain-workspace/model";
export function domainFixtures(now = Date.now()) {
  const date = (offset: number) => new Date(now + offset).toISOString();
  const check = domainCheckSchema.parse({
    id: "fixture-check",
    domain: "northstar.com",
    provider: "Synthetic fixture registrar",
    availability: "available",
    checkedAt: date(-1000),
    validUntil: date(60000),
    evidenceReference: "fixture-evidence",
  });
  const quote = domainQuoteSchema.parse({
    id: "fixture-quote",
    domain: check.domain,
    provider: check.provider,
    checkId: check.id,
    issuedAt: date(-500),
    expiresAt: date(60000),
    periodYears: 1,
    total: { amountMinor: 1200, currency: "USD" },
    renewal: null,
    renewalTerms: "Synthetic terms for interface testing only",
  });
  const order = domainOrderSchema.parse({
    id: "fixture-order",
    domain: check.domain,
    provider: check.provider,
    origin: "fluid",
    quoteId: quote.id,
    payment: "confirmed",
    paymentReference: "fixture-payment",
    registration: "pending",
    confirmation: null,
    appliedEventIds: [],
  });
  const purchased = domainOrderSchema.parse({
    ...order,
    registration: "confirmed",
    confirmation: {
      orderId: order.id,
      domain: order.domain,
      provider: order.provider,
      registrationReference: "fixture-registration",
      confirmedAt: date(-1000),
      expiresAt: date(365 * 86400000),
    },
  });
  const adapter: DomainSearchAdapter = {
    status: "ready",
    provider: check.provider,
    check: async (domain) => ({ ...check, domain }),
    quote: async (domain, checkId) => ({ ...quote, domain, checkId }),
  };
  return { check, quote, order, purchased, adapter };
}
