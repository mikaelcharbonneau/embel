import { availabilityAt, quoteBlockReason, type DomainCheck, type DomainQuote } from "./model";

export type DomainResultEvidence = { domain: string; check: DomainCheck | null; quote: DomainQuote | null };

/** Export evidence at one instant, rather than implying unchecked/stale prices. */
export function domainResultsCsv(rows: readonly DomainResultEvidence[], now = Date.now()): string {
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [["Domain", "Availability at export", "Verified price per year"], ...rows.map(row => {
    const availability = availabilityAt(row.check, now);
    const quote = row.quote?.periodYears === 1 && !quoteBlockReason(row.quote, row.check, now) ? row.quote : null;
    let price = "";
    if (quote) {
      const formatter = new Intl.NumberFormat("en", { style: "currency", currency: quote.total.currency });
      price = formatter.format(quote.total.amountMinor / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
    }
    return [row.domain, !row.check ? "Not checked" : availability === "available" ? "Confirmed available" : availability === "taken" ? "Taken" : "Unknown", price];
  })];
  return `${lines.map(line => line.map(cell).join(",")).join("\r\n")}\r\n`;
}
