import { describe, expect, it } from "vitest";
import {
  acceptedDomainCheckProvider,
  applyDomainOrderEvent,
  availabilityAt,
  REGISTRY_DOMAIN_PROVIDER,
  domainCheckSchema,
  domainNameSchema,
  domainOrderSchema,
  domainQuoteSchema,
  domainSyntaxError,
  orderLabel,
  prepareDomainSearch,
  purchasedDomainSchema,
  quoteBlockReason,
  readDomainCheck,
  readDomainQuote,
  unavailableDomainAdapter,
} from "../../../src/features/domain-workspace/model";
import { domainFixtures } from "./fixtures";
const now = Date.parse("2026-10-05T12:00:00Z");
const { check, quote, order, purchased, adapter } = domainFixtures(now);

describe("domain search preparation", () => {
  it("normalizes full domains and constructs deduplicated candidates without evidence", () => {
    expect(prepareDomainSearch("North Star, NORTHSTAR.com\nnorthstar.com", ["com", ".io", "com"])).toEqual({
      domains: ["northstar.com", "northstar.io"],
      errors: [],
    });
    expect(domainNameSchema.parse("  NorthStar.COM  ")).toBe("northstar.com");
    expect(availabilityAt(null, now)).toBe("unknown");
  });
  it.each([
    "https://name.com",
    "name.com/path",
    "a@name.com",
    "name.com:443",
    "name..com",
    "-name.com",
    "name-.com",
    "name.c",
    "name.123",
    "xn--caf-dma.com",
    "café.com",
    "a".repeat(64) + ".com",
    "name.com.",
  ])("rejects invalid or unsupported input %s", (input) => {
    expect(domainSyntaxError(input)).not.toBeNull();
    expect(prepareDomainSearch(input, ["com"]).domains).toEqual([]);
  });
  it("bounds input and never silently prepares partial requests", () => {
    expect(prepareDomainSearch("valid.com, broken..com", ["com"]).domains).toEqual([]);
    expect(prepareDomainSearch("a".repeat(4001), ["com"]).errors).not.toEqual([]);
    expect(prepareDomainSearch(Array(21).fill("name").join(","), ["com"]).errors).not.toEqual([]);
    expect(prepareDomainSearch("name", []).errors).not.toEqual([]);
    expect(prepareDomainSearch("name.com", []).domains).toEqual(["name.com"]);
    expect(prepareDomainSearch("name", ["com/path"]).errors).not.toEqual([]);
  });
});
describe("availability and quote evidence", () => {
  it("lets the authoritative registry stand in for a waiting registrar, never as available", () => {
    expect(
      acceptedDomainCheckProvider({ provider: "vercel_registrar", availability: "available" }, "vercel_registrar"),
    ).toBe(true);
    expect(
      acceptedDomainCheckProvider({ provider: REGISTRY_DOMAIN_PROVIDER, availability: "taken" }, "vercel_registrar"),
    ).toBe(true);
    expect(
      acceptedDomainCheckProvider({ provider: REGISTRY_DOMAIN_PROVIDER, availability: "unknown" }, "vercel_registrar"),
    ).toBe(true);
    expect(
      acceptedDomainCheckProvider(
        { provider: REGISTRY_DOMAIN_PROVIDER, availability: "available" },
        "vercel_registrar",
      ),
    ).toBe(false);
    expect(
      acceptedDomainCheckProvider({ provider: "cloudflare_registrar", availability: "taken" }, "vercel_registrar"),
    ).toBe(false);
  });
  it("does not treat stale, future or unknown evidence as available", () => {
    expect(availabilityAt(check, now)).toBe("available");
    expect(availabilityAt(check, Date.parse(check.validUntil))).toBe("unknown");
    expect(availabilityAt(check, now - 2000)).toBe("unknown");
    expect(availabilityAt(check, NaN)).toBe("unknown");
    expect(availabilityAt({ ...check, validUntil: "not-a-date" }, now)).toBe("unknown");
    expect(availabilityAt({ ...check, availability: "unknown" }, now)).toBe("unknown");
    expect(domainCheckSchema.safeParse({ ...check, validUntil: check.checkedAt }).success).toBe(false);
  });
  it("requires an unexpired quote bound to a fresh available check", () => {
    expect(quoteBlockReason(quote, check, now)).toBeNull();
    expect(quoteBlockReason(quote, check, Date.parse(quote.expiresAt))).toMatch(/expired/);
    expect(quoteBlockReason(quote, { ...check, id: "other" }, now)).toMatch(/match/);
    expect(quoteBlockReason(quote, { ...check, domain: "other.com" }, now)).toMatch(/match/);
    expect(quoteBlockReason(quote, { ...check, provider: "other" }, now)).toMatch(/match/);
    expect(quoteBlockReason(quote, { ...check, availability: "taken" }, now)).toMatch(/fresh/);
    expect(quoteBlockReason(quote, null, now)).toMatch(/fresh/);
    expect(quoteBlockReason(quote, check, now - 2000)).toMatch(/time/);
    expect(domainQuoteSchema.safeParse({ ...quote, total: { amountMinor: -1, currency: "USD" } }).success).toBe(false);
    expect(domainQuoteSchema.safeParse({ ...quote, total: { amountMinor: 1.2, currency: "USD" } }).success).toBe(false);
    expect(domainQuoteSchema.safeParse({ ...quote, renewalTerms: "" }).success).toBe(false);
  });
  it("validates quote time at response completion, and rejects expiry during a request", async () => {
    let current = now;
    const fresh = {
      ...adapter,
      status: "ready" as const,
      provider: check.provider,
      check: async () => check,
      quote: async () => {
        current += 10;
        return { ...quote, issuedAt: new Date(current).toISOString() };
      },
    };
    await expect(readDomainQuote(fresh, check, () => current, new AbortController().signal)).resolves.toMatchObject({
      id: quote.id,
    });
    current = now;
    const delayed = {
      ...fresh,
      quote: async () => {
        current = Date.parse(quote.expiresAt);
        return quote;
      },
    };
    await expect(readDomainQuote(delayed, check, () => current, new AbortController().signal)).rejects.toThrow(
      /expired/,
    );
  });
  it("fails closed without adapters, mismatched responses and aborts", async () => {
    const signal = new AbortController().signal;
    await expect(readDomainCheck(unavailableDomainAdapter, check.domain, signal)).rejects.toThrow(/No registrar/);
    await expect(
      readDomainCheck(
        { status: "ready", provider: check.provider, check: async () => ({ ...check, domain: "other.com" }) },
        check.domain,
        signal,
      ),
    ).rejects.toThrow(/match/);
    await expect(
      readDomainCheck({ status: "ready", provider: "other", check: async () => check }, check.domain, signal),
    ).rejects.toThrow(/match/);
    await expect(
      readDomainCheck(
        {
          status: "ready",
          provider: check.provider,
          check: async () => ({ domain: check.domain, availability: "available" }),
        },
        check.domain,
        signal,
      ),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(readDomainCheck(adapter, check.domain, controller.signal)).rejects.toThrow(/cancelled/);
    await expect(readDomainQuote(adapter, { ...check, availability: "unknown" }, () => now, signal)).rejects.toThrow(
      /fresh/,
    );
    await expect(
      readDomainQuote(
        {
          status: "ready",
          provider: check.provider,
          check: async () => check,
          quote: async () => ({ ...quote, domain: "other.com" }),
        },
        check,
        () => now,
        signal,
      ),
    ).rejects.toThrow(/match/);
  });
});
describe("Embel order and purchased library scope", () => {
  it("payment evidence leaves registration pending and stays outside purchased library", () => {
    const unpaid = { ...order, payment: "unconfirmed" as const, paymentReference: null };
    const paid = applyDomainOrderEvent(unpaid, {
      type: "payment_confirmed",
      id: "event-pay",
      orderId: order.id,
      paymentReference: "payment-ref",
    });
    expect(paid.registration).toBe("pending");
    expect(paid.confirmation).toBeNull();
    expect(orderLabel(paid)).toMatch(/registration pending/);
    expect(purchasedDomainSchema.safeParse({ order: paid, project: null }).success).toBe(false);
    expect(
      applyDomainOrderEvent(paid, {
        type: "payment_confirmed",
        id: "event-pay",
        orderId: order.id,
        paymentReference: "payment-ref",
      }),
    ).toEqual(paid);
  });
  it("rejects conflicting payment reference reuse of an already applied event ID", () => {
    const event = {
      type: "payment_confirmed" as const,
      id: "qa-payment-event",
      orderId: order.id,
      paymentReference: "qa-payment-1",
    };
    const paid = applyDomainOrderEvent({ ...order, payment: "unconfirmed", paymentReference: null }, event);
    expect(applyDomainOrderEvent(paid, event)).toEqual(paid);
    expect(() => applyDomainOrderEvent(paid, { ...event, paymentReference: "qa-payment-2" })).toThrow(
      /reconciliation/i,
    );
    expect(paid.paymentReference).toBe("qa-payment-1");
  });
  it("rejects an event ID reused for a different event type or order", () => {
    const event = {
      type: "payment_confirmed" as const,
      id: "qa-reused-event",
      orderId: order.id,
      paymentReference: order.paymentReference!,
    };
    const paid = applyDomainOrderEvent(order, event);
    expect(() =>
      applyDomainOrderEvent(paid, { type: "needs_reconciliation", id: event.id, orderId: order.id }),
    ).toThrow(/reconciliation/i);
    expect(() => applyDomainOrderEvent(paid, { ...event, orderId: "qa-other-order" })).toThrow(/belong/i);
  });
  it.each([
    ["domain", { domain: "other.com" }],
    ["provider", { provider: "Other registrar" }],
    ["order", { orderId: "qa-other-order" }],
    ["reference", { registrationReference: "qa-other-registration" }],
    ["time", { confirmedAt: new Date(now - 2000).toISOString() }],
    ["expiry", { expiresAt: null }],
  ])("rejects contradictory registration %s under the same event ID", (_name, changes) => {
    const event = {
      type: "registration_confirmed" as const,
      id: "qa-registration-event",
      orderId: order.id,
      evidence: purchased.confirmation!,
    };
    const registered = applyDomainOrderEvent(order, event);
    expect(applyDomainOrderEvent(registered, event)).toEqual(registered);
    expect(() => applyDomainOrderEvent(registered, { ...event, evidence: { ...event.evidence, ...changes } })).toThrow(
      /reconciliation/i,
    );
    expect(registered.confirmation).toEqual(event.evidence);
  });
  it("keeps exact old failure replay idempotent after later registrar success", () => {
    const failure = { type: "registration_failed" as const, id: "qa-first-failure", orderId: order.id };
    const failed = applyDomainOrderEvent(order, failure);
    const registered = applyDomainOrderEvent(failed, {
      type: "registration_confirmed",
      id: "qa-later-success",
      orderId: order.id,
      evidence: purchased.confirmation!,
    });
    expect(applyDomainOrderEvent(registered, failure)).toEqual(registered);
    expect(() => applyDomainOrderEvent(registered, { ...failure, type: "needs_reconciliation" })).toThrow(
      /reconciliation/i,
    );
  });
  it("fails closed when a legacy event ID lacks original evidence for replay comparison", () => {
    const legacy = { ...order, appliedEventIds: ["qa-legacy-id"] };
    expect(domainOrderSchema.safeParse(legacy).success).toBe(true);
    expect(() =>
      applyDomainOrderEvent(legacy, {
        type: "payment_confirmed",
        id: "qa-legacy-id",
        orderId: order.id,
        paymentReference: order.paymentReference!,
      }),
    ).toThrow(/reconciliation/i);
  });
  it("preserves exact replay through serialization, key reordering and the history bound", () => {
    const event = {
      type: "payment_confirmed" as const,
      id: "qa-serialized-event",
      orderId: order.id,
      paymentReference: order.paymentReference!,
    };
    const paid = applyDomainOrderEvent(order, event);
    const restored = domainOrderSchema.parse(JSON.parse(JSON.stringify(paid)));
    expect(
      applyDomainOrderEvent(restored, {
        paymentReference: event.paymentReference,
        orderId: event.orderId,
        id: event.id,
        type: event.type,
      }),
    ).toEqual(restored);
    const atLimit = {
      ...restored,
      appliedEventIds: [
        ...restored.appliedEventIds,
        ...Array.from({ length: 499 }, (_, index) => `qa-legacy-${index}`),
      ],
    };
    expect(applyDomainOrderEvent(atLimit, event)).toEqual(atLimit);
    expect(() => applyDomainOrderEvent(atLimit, { ...event, paymentReference: "qa-conflicting-payment" })).toThrow(
      /Conflicting event ID/,
    );
    expect(() => applyDomainOrderEvent(atLimit, { ...event, id: "qa-new-event" })).toThrow(/history/);
  });
  it("rejects duplicate, foreign, orphaned and contradictory stored event receipts", () => {
    const event = {
      type: "payment_confirmed" as const,
      id: "qa-receipt",
      orderId: order.id,
      paymentReference: order.paymentReference!,
    };
    const paid = applyDomainOrderEvent(order, event);
    expect(domainOrderSchema.safeParse({ ...paid, appliedEvents: [event, event] }).success).toBe(false);
    expect(domainOrderSchema.safeParse({ ...paid, appliedEvents: [{ ...event, orderId: "other" }] }).success).toBe(
      false,
    );
    expect(domainOrderSchema.safeParse({ ...paid, appliedEvents: [{ ...event, id: "unrecorded" }] }).success).toBe(
      false,
    );
    expect(
      domainOrderSchema.safeParse({ ...paid, appliedEvents: [{ ...event, paymentReference: "changed" }] }).success,
    ).toBe(false);
  });
  it("requires exact registrar evidence; external purchases and forged success fail", () => {
    expect(domainOrderSchema.safeParse({ ...order, registration: "confirmed" }).success).toBe(false);
    expect(domainOrderSchema.safeParse({ ...order, origin: "external" }).success).toBe(false);
    expect(domainOrderSchema.safeParse({ ...order, paymentReference: null }).success).toBe(false);
    expect(
      domainOrderSchema.safeParse({ ...purchased, confirmation: { ...purchased.confirmation, domain: "other.com" } })
        .success,
    ).toBe(false);
    expect(() =>
      applyDomainOrderEvent(order, {
        type: "registration_confirmed",
        id: "registered",
        orderId: order.id,
        evidence: { ...purchased.confirmation!, provider: "other" },
      }),
    ).toThrow();
    expect(() => applyDomainOrderEvent(order, { type: "needs_reconciliation", id: "wrong", orderId: "other" })).toThrow(
      /belong/,
    );
    expect(purchasedDomainSchema.safeParse({ order: purchased, project: null }).success).toBe(true);
  });
  it("preserves registrar success across late failure and handles reconciliation without claiming success", () => {
    const registered = applyDomainOrderEvent(order, {
      type: "registration_confirmed",
      id: "registered",
      orderId: order.id,
      evidence: purchased.confirmation!,
    });
    const late = applyDomainOrderEvent(registered, {
      type: "registration_failed",
      id: "late-failure",
      orderId: order.id,
    });
    expect(late.registration).toBe("confirmed");
    expect(late.confirmation).toEqual(purchased.confirmation);
    expect(() =>
      applyDomainOrderEvent(registered, {
        type: "registration_confirmed",
        id: "conflicting",
        orderId: order.id,
        evidence: { ...purchased.confirmation!, registrationReference: "changed" },
      }),
    ).toThrow(/Conflicting/);
    expect(() =>
      applyDomainOrderEvent(order, {
        type: "payment_confirmed",
        id: "conflicting-pay",
        orderId: order.id,
        paymentReference: "changed",
      }),
    ).toThrow(/Conflicting/);
    const uncertain = applyDomainOrderEvent(order, {
      type: "needs_reconciliation",
      id: "uncertain",
      orderId: order.id,
    });
    expect(orderLabel(uncertain)).toBe("Order needs reconciliation");
    expect(purchasedDomainSchema.safeParse({ order: uncertain, project: null }).success).toBe(false);
    expect(() =>
      applyDomainOrderEvent(
        { ...order, appliedEventIds: Array.from({ length: 500 }, (_, i) => `event-${i}`) },
        { type: "needs_reconciliation", id: "new", orderId: order.id },
      ),
    ).toThrow(/history/);
  });
});
