import { describe, expect, it } from "vitest";
import {
  currentQuote,
  defaultFilters,
  defaultTweaks,
  domainRows,
  domainStatus,
  domainVariants,
  filterDomainRows,
  formatUsd,
  noTweaks,
  searchWords,
  sortDomainRows,
  tweakCount,
  tweakPreview,
  tweakWordError,
  type DomainResult,
} from "../../../src/features/domain-workspace/name-search";

const now = Date.parse("2026-11-13T10:00:00Z");
const at = new Date(now).toISOString();
function result(domain: string, patch: Partial<DomainResult["check"]> = {}, cents: number | null = null): DomainResult {
  const check = {
    id: `check-${domain}`,
    domain,
    provider: "vercel_registrar",
    availability: "available" as const,
    checkedAt: at,
    validUntil: new Date(now + 60_000).toISOString(),
    evidenceReference: "fixture",
    ...patch,
  };
  return {
    check,
    quote:
      cents === null
        ? null
        : {
            id: `price-${domain}`,
            domain,
            provider: check.provider,
            checkId: check.id,
            issuedAt: at,
            expiresAt: check.validUntil,
            periodYears: 1,
            total: { amountMinor: cents, currency: "USD" },
            renewal: { amountMinor: 1698, currency: "USD" },
            renewalTerms: "Fixture terms",
          },
  };
}

describe("domain search for a name", () => {
  it("keeps the name's words from the search field and never transliterates", () => {
    expect(searchWords("kestrelanalytics", "Kestrel Analytics")).toEqual(["kestrel", "analytics"]);
    expect(searchWords("kestrel hq", "Kestrel Analytics")).toEqual(["kestrel", "hq"]);
    expect(searchWords("kestrel", "Kestrel Analytics")).toEqual(["kestrel"]);
    expect(searchWords("Café Lune", "Café Lune")).toEqual(["lune"]);
  });

  it("builds the exact name first, then the tweaks that apply, without duplicates", () => {
    const words = ["kestrel", "analytics"];
    expect(domainVariants(words, defaultTweaks).map((variant) => variant.label)).toEqual([
      "kestrelanalytics",
      "kestrel-analytics",
      "getkestrel",
      "kestrelhq",
    ]);
    expect(tweakCount(defaultTweaks)).toBe(3);
    expect(domainVariants(["kestrel"], { ...noTweaks, hyphenate: true, plural: true })).toEqual([
      { label: "kestrel", kind: "exact", tweak: null },
      { label: "kestrels", kind: "tweak", tweak: "Plural and singular" },
    ]);
    expect(tweakPreview(words, "initials")).toBe("ka");
    expect(tweakPreview(words, "noVowels")).toBe("kstrlnlytcs");
    expect(tweakPreview(["kestrel"], "firstWord")).toBeNull();
    expect(tweakWordError("labs")).toBeNull();
    expect(tweakWordError("my labs")).not.toBeNull();
  });

  it("orders domains by best match: the exact name in the first extensions comes first", () => {
    const rows = domainRows(["kestrel", "analytics"], ["com", "co", "io"], defaultTweaks);
    expect(rows.slice(0, 4).map((row) => row.domain)).toEqual([
      "kestrelanalytics.com",
      "kestrelanalytics.co",
      "kestrel-analytics.com",
      "kestrelanalytics.io",
    ]);
    expect(rows).toHaveLength(12);
  });

  it("states only what a current check says, and prices only from its matching quote", () => {
    expect(domainStatus(undefined, now)).toBe("not_checked");
    expect(domainStatus(result("a.com"), now)).toBe("available");
    expect(domainStatus(result("a.com", { availability: "taken" }), now)).toBe("taken");
    expect(domainStatus(result("a.com", { availability: "unknown" }), now)).toBe("not_confirmed");
    expect(
      domainStatus(result("a.com", { detail: "Vercel reports this domain available. Premium domain." }), now),
    ).toBe("premium");
    expect(domainStatus(result("a.com", { detail: "Premium names are popular." }), now)).toBe("available");
    expect(domainStatus(result("a.com"), now + 60_000)).toBe("expired");
    expect(currentQuote(result("a.com", {}, 1298), now)?.total.amountMinor).toBe(1298);
    expect(currentQuote(result("a.com", {}, 1298), now + 60_000)).toBeNull();
    expect(currentQuote(result("a.com", { availability: "taken" }, 1298), now)).toBeNull();
    expect(formatUsd(245000)).toBe("$2,450.00");
  });

  it("filters by status and price, keeping unpriced domains out of a price filter", () => {
    const rows = domainRows(["kestrel"], ["com", "co", "io"], noTweaks);
    const results = new Map([
      ["kestrel.com", result("kestrel.com", { availability: "taken" })],
      ["kestrel.co", result("kestrel.co", {}, 1298)],
    ]);
    const lookup = (domain: string) => results.get(domain);
    const domains = (filters: typeof defaultFilters) =>
      filterDomainRows(rows, lookup, filters, now).map((row) => row.domain);
    expect(domains(defaultFilters)).toEqual(["kestrel.com", "kestrel.co", "kestrel.io"]);
    expect(domains({ ...defaultFilters, show: { ...defaultFilters.show, taken: false } })).toEqual([
      "kestrel.co",
      "kestrel.io",
    ]);
    expect(domains({ ...defaultFilters, maxPrice: 20 })).toEqual(["kestrel.co"]);
    expect(domains({ ...defaultFilters, maxPrice: 10 })).toEqual([]);
    expect(sortDomainRows(rows, "price", lookup, now)[0]!.domain).toBe("kestrel.co");
    expect(sortDomainRows(rows, "alphabetical", lookup, now).map((row) => row.domain)).toEqual([
      "kestrel.co",
      "kestrel.com",
      "kestrel.io",
    ]);
  });
});
