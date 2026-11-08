import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
const reference = z.string().trim().min(1).max(200);
export function normalizeDomain(input: string): string { return input.trim().toLowerCase(); }
/** Syntax only. Public suffix, registrar eligibility and IDN support require an adapter. */
export function domainSyntaxError(input: string): string | null {
  const domain = normalizeDomain(input);
  if (!domain || domain.length > 253) return "Enter a domain of at most 253 characters.";
  if (!/^[a-z0-9.-]+$/.test(domain)) return "Use an ASCII domain without a URL, path, port or email address. Internationalized names are not supported yet.";
  const labels = domain.split(".");
  if (labels.length < 2 || !/^[a-z]{2,63}$/.test(labels.at(-1)!)) return "Include a letter-based extension, such as .com.";
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return "Each label needs 1–63 letters, numbers or hyphens, with no leading or trailing hyphen.";
  if (labels.some(label => label.startsWith("xn--"))) return "Internationalized names are not supported yet.";
  return null;
}
export const domainNameSchema = z.string().transform(normalizeDomain).refine(value => domainSyntaxError(value) === null, "Invalid or unsupported domain syntax");
const canonicalDomain = domainNameSchema;
export type SearchPreparation = { domains: string[]; errors: { line: number; message: string }[] };
/** Local candidate construction never checks or reserves a name. */
export function prepareDomainSearch(input: string, extensions: string[]): SearchPreparation {
  if (input.length > 4000) return { domains: [], errors: [{ line: 0, message: "Keep search input under 4,000 characters." }] };
  const lines = input.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
  if (!lines.length || lines.length > 20) return { domains: [], errors: [{ line: 0, message: "Enter 1–20 names or domains, separated by commas or new lines." }] };
  const tlds = [...new Set(extensions.map(value => value.replace(/^\./, "").toLowerCase()))];
  if (tlds.length > 10 || tlds.some(value => !/^[a-z]{2,63}(?:\.[a-z]{2,63})?$/.test(value))) return { domains: [], errors: [{ line: 0, message: "Choose up to 10 valid extensions." }] };
  const domains = new Set<string>(), errors: SearchPreparation["errors"] = [];
  lines.forEach((line, index) => {
    const value = normalizeDomain(line);
    if (value.includes(".")) {
      const error = domainSyntaxError(value);
      if (error) errors.push({ line: index + 1, message: error }); else domains.add(value);
    } else {
      // Spaces are removed explicitly; punctuation and accents are never transliterated.
      const seed = value.replace(/\s+/g, "");
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(seed) || seed.startsWith("xn--")) errors.push({ line: index + 1, message: "Use a name with ASCII letters, numbers or interior hyphens." });
      else if (!tlds.length) errors.push({ line: index + 1, message: "Choose at least one extension for a name." });
      else tlds.forEach(tld => domains.add(`${seed}.${tld}`));
    }
  });
  // Never silently run a partial search when one input is invalid.
  return { domains: errors.length ? [] : [...domains], errors };
}

export const domainCheckSchema = z.object({
  id: reference, domain: canonicalDomain, provider: reference,
  availability: z.enum(["available", "taken", "unknown"]),
  checkedAt: timestamp, validUntil: timestamp, evidenceReference: reference,
  sourceUrl: z.url().max(2048).refine(value => value.startsWith("https://")).optional(),
  detail: z.string().max(500).optional(),
}).strict().refine(value => Date.parse(value.validUntil) > Date.parse(value.checkedAt), "Check validity must follow check time");
export type DomainCheck = z.infer<typeof domainCheckSchema>;
export function availabilityAt(check: DomainCheck | null, now: number): "available" | "taken" | "unknown" {
  if (!check || !domainCheckSchema.safeParse(check).success || !Number.isFinite(now) || Date.parse(check.checkedAt) > now || Date.parse(check.validUntil) <= now) return "unknown";
  return check.availability;
}
const moneySchema = z.object({ amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export const domainQuoteSchema = z.object({
  id: reference, domain: canonicalDomain, provider: reference, checkId: reference,
  issuedAt: timestamp, expiresAt: timestamp, periodYears: z.number().int().min(1).max(10),
  total: moneySchema, renewal: moneySchema.nullable(), renewalTerms: reference,
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.issuedAt), "Quote expiry must follow issue time");
export type DomainQuote = z.infer<typeof domainQuoteSchema>;
export function quoteBlockReason(quote: DomainQuote, check: DomainCheck | null, now: number): string | null {
  if (!domainQuoteSchema.safeParse(quote).success) return "Quote evidence is invalid.";
  if (!Number.isFinite(now) || Date.parse(quote.issuedAt) > now) return "Quote time cannot be verified.";
  if (Date.parse(quote.expiresAt) <= now) return "Quote expired. Request a new quote.";
  if (!check || availabilityAt(check, now) !== "available") return "A fresh, confirmed availability check is required.";
  if (check.id !== quote.checkId || check.domain !== quote.domain || check.provider !== quote.provider || Date.parse(check.checkedAt) > Date.parse(quote.issuedAt)) return "Quote does not match the availability evidence.";
  return null;
}
export const registrationEvidenceSchema = z.object({
  orderId: reference, domain: canonicalDomain, provider: reference, registrationReference: reference,
  confirmedAt: timestamp, expiresAt: timestamp.nullable(),
}).strict().refine(value => value.expiresAt === null || Date.parse(value.expiresAt) > Date.parse(value.confirmedAt), "Registration expiry must follow confirmation");
export const domainOrderEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("payment_confirmed"), id: reference, orderId: reference, paymentReference: reference }).strict(),
  z.object({ type: z.literal("registration_confirmed"), id: reference, orderId: reference, evidence: registrationEvidenceSchema }).strict(),
  z.object({ type: z.enum(["registration_failed", "needs_reconciliation"]), id: reference, orderId: reference }).strict(),
]);
export type DomainOrderEvent = z.infer<typeof domainOrderEventSchema>;
export const domainOrderSchema = z.object({
  id: reference, domain: canonicalDomain, provider: reference, origin: z.literal("fluid"), quoteId: reference,
  payment: z.enum(["unconfirmed", "confirmed", "failed"]), paymentReference: reference.nullable(),
  registration: z.enum(["pending", "confirmed", "failed", "needs_reconciliation"]),
  confirmation: registrationEvidenceSchema.nullable(), appliedEventIds: z.array(reference).max(500),
  // Optional for legacy snapshots; an ID alone cannot prove an exact replay.
  appliedEvents: z.array(domainOrderEventSchema).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.payment === "confirmed" && !value.paymentReference) context.addIssue({ code: "custom", message: "Confirmed payment requires a payment reference" });
  if (value.registration === "confirmed" && !value.confirmation) context.addIssue({ code: "custom", message: "Registration requires registrar evidence" });
  if (value.confirmation && (value.registration !== "confirmed" || value.confirmation.orderId !== value.id || value.confirmation.domain !== value.domain || value.confirmation.provider !== value.provider)) context.addIssue({ code: "custom", message: "Registrar evidence must match this confirmed order" });
  if (new Set(value.appliedEventIds).size !== value.appliedEventIds.length) context.addIssue({ code: "custom", message: "Duplicate event identifiers" });
  const events = value.appliedEvents ?? [];
  if (new Set(events.map(event => event.id)).size !== events.length) context.addIssue({ code: "custom", message: "Duplicate event evidence" });
  for (const event of events) {
    if (!value.appliedEventIds.includes(event.id) || event.orderId !== value.id) context.addIssue({ code: "custom", message: "Applied event evidence must belong to this order and history" });
    if (event.type === "payment_confirmed" && (value.payment !== "confirmed" || event.paymentReference !== value.paymentReference)) context.addIssue({ code: "custom", message: "Applied payment evidence must match the confirmed payment" });
    if (event.type === "registration_confirmed" && (value.registration !== "confirmed" || JSON.stringify(event.evidence) !== JSON.stringify(value.confirmation))) context.addIssue({ code: "custom", message: "Applied registrar evidence must match the confirmed registration" });
  }
});
export type DomainOrder = z.infer<typeof domainOrderSchema>;
/** Only for authenticated, signature-verified server events. This is not a webhook/auth boundary. */
export function applyDomainOrderEvent(rawOrder: DomainOrder, rawEvent: DomainOrderEvent): DomainOrder {
  const order = domainOrderSchema.parse(rawOrder), event = domainOrderEventSchema.parse(rawEvent);
  if (event.orderId !== order.id) throw new Error("Event does not belong to this order");
  if (order.appliedEventIds.includes(event.id)) {
    const applied = order.appliedEvents?.find(previous => previous.id === event.id);
    if (!applied) throw new Error("Original event evidence is missing; replay requires reconciliation");
    // Parsing above canonicalizes property order and domain/reference normalization.
    if (JSON.stringify(applied) !== JSON.stringify(event)) throw new Error("Conflicting event ID reuse requires reconciliation");
    return order;
  }
  if (order.appliedEventIds.length >= 500) throw new Error("Order event history requires reconciliation");
  const next = { ...order, appliedEventIds: [...order.appliedEventIds, event.id], appliedEvents: [...(order.appliedEvents ?? []), event] };
  if (event.type === "payment_confirmed" && order.payment === "confirmed" && order.paymentReference !== event.paymentReference) throw new Error("Conflicting payment evidence requires reconciliation");
  if (event.type === "registration_confirmed" && order.confirmation && JSON.stringify(order.confirmation) !== JSON.stringify(event.evidence)) throw new Error("Conflicting registrar evidence requires reconciliation");
  if (event.type === "payment_confirmed") return domainOrderSchema.parse({ ...next, payment: "confirmed", paymentReference: event.paymentReference });
  if (event.type === "registration_confirmed") return domainOrderSchema.parse({ ...next, registration: "confirmed", confirmation: event.evidence });
  // Late failure/uncertainty cannot overwrite verified registrar confirmation.
  return domainOrderSchema.parse(order.registration === "confirmed" ? next : { ...next, registration: event.type === "registration_failed" ? "failed" : "needs_reconciliation" });
}
export function orderLabel(order: DomainOrder): string {
  if (order.registration === "confirmed") return "Registration confirmed";
  if (order.registration === "needs_reconciliation") return "Order needs reconciliation";
  if (order.registration === "failed") return "Registration failed";
  return order.payment === "confirmed" ? "Payment confirmed · registration pending" : order.payment === "failed" ? "Payment failed · registration pending" : "Registration pending";
}
export const purchasedDomainSchema = z.object({ order: domainOrderSchema, project: z.object({ id: reference, title: reference }).strict().nullable() }).strict().refine(value => value.order.registration === "confirmed" && value.order.confirmation !== null, "Library contains only registrar-confirmed Embel purchases");
export type PurchasedDomain = z.infer<typeof purchasedDomainSchema>;
export type DomainLibrary = { status: "unavailable" | "loading" | "error"; message?: string } | { status: "ready"; items: unknown[] };
export type DomainBrandSource = { type: "domain"; domain: string; check: DomainCheck | null; order: DomainOrder | null };
/** Public, locally mapped provider failures only; raw provider text is never displayed. */
export class DomainLookupError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number | null = null) { super(message); }
}
export type DomainSearchAdapter =
  | { status: "unavailable"; reason: string }
  | { status: "ready"; provider: string; description?: string;
      /** The check already returned a matching price; reading it does not make another provider request. */
      quotesWithCheck?: boolean;
      check(domain: string, signal: AbortSignal): Promise<unknown>; quote?: (domain: string, checkId: string, signal: AbortSignal) => Promise<unknown> };
export const unavailableDomainAdapter: DomainSearchAdapter = { status: "unavailable", reason: "No registrar is connected. Availability checks, quotes and purchases are unavailable." };
export const REGISTRY_DOMAIN_PROVIDER = "Public registry RDAP";
/** A registry's DNS delegation, used only where the registry publishes no RDAP. */
export const DNS_DOMAIN_PROVIDER = "Public DNS";
/** A registrar's check may be corroborated by the public registry, but only to confirm
 * an existing registration. Registry checks never carry prices or claim availability. */
/** A registrar's own answer, or the authoritative registry standing in for it:
 * a confirmed registration, or no record (shown as not confirmed, never as
 * available) while the registrar asks Embel to wait. */
export function acceptedDomainCheckProvider(check: Pick<DomainCheck, "provider" | "availability">, expected: string): boolean {
  return check.provider === expected || expected !== REGISTRY_DOMAIN_PROVIDER && check.provider === REGISTRY_DOMAIN_PROVIDER && (check.availability === "taken" || check.availability === "unknown")
    // DNS can only show that a domain is registered.
    || check.provider === DNS_DOMAIN_PROVIDER && check.availability === "taken";
}
export async function readDomainCheck(adapter: DomainSearchAdapter, domain: string, signal: AbortSignal): Promise<DomainCheck> {
  const exact = domainNameSchema.parse(domain);
  if (signal.aborted) throw new Error("Check cancelled");
  if (adapter.status !== "ready") throw new Error(adapter.reason);
  const result = domainCheckSchema.parse(await adapter.check(exact, signal));
  if (signal.aborted) throw new Error("Check cancelled");
  if (result.domain !== exact || !acceptedDomainCheckProvider(result, adapter.provider)) throw new Error("Check does not match this domain and provider");
  return result;
}
export async function readDomainQuote(adapter: DomainSearchAdapter, check: DomainCheck, clock: () => number, signal: AbortSignal): Promise<DomainQuote> {
  if (signal.aborted) throw new Error("Quote cancelled");
  if (adapter.status !== "ready" || !adapter.quote) throw new Error("Quotes are unavailable.");
  if (check.provider !== adapter.provider || availabilityAt(check, clock()) !== "available") throw new Error("A fresh availability check is required.");
  const result = domainQuoteSchema.parse(await adapter.quote(check.domain, check.id, signal));
  if (signal.aborted) throw new Error("Quote cancelled");
  const error = quoteBlockReason(result, check, clock());
  if (error) throw new Error(error);
  return result;
}
