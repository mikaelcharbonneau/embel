import { availabilityAt, domainSyntaxError, quoteBlockReason, type DomainCheck, type DomainQuote } from "./model";

/**
 * Domain search for one name, built locally: the name's words, the chosen extensions and the chosen tweaks give a
 * list of domains. Building the list never checks or reserves anything; a domain's status and prices come only from
 * a real check the person starts.
 */

export const extensionGroups: readonly { label: string; extensions: readonly string[] }[] = [
  {
    label: "Popular",
    extensions: ["com", "net", "org", "co", "io", "ai", "app", "dev", "info", "xyz", "me", "online"],
  },
  {
    label: "Business",
    extensions: [
      "biz",
      "company",
      "co",
      "inc",
      "ltd",
      "llc",
      "business",
      "agency",
      "solutions",
      "services",
      "consulting",
      "group",
      "ventures",
      "partners",
      "enterprises",
      "holdings",
    ],
  },
  {
    label: "Technology",
    extensions: [
      "io",
      "ai",
      "app",
      "dev",
      "tech",
      "cloud",
      "software",
      "digital",
      "systems",
      "network",
      "data",
      "codes",
      "tools",
      "site",
      "website",
      "host",
    ],
  },
  {
    label: "Creative",
    extensions: [
      "studio",
      "design",
      "art",
      "media",
      "graphics",
      "photo",
      "gallery",
      "works",
      "space",
      "ink",
      "style",
      "fashion",
    ],
  },
  {
    label: "Countries",
    extensions: ["ca", "us", "uk", "fr", "de", "eu", "es", "it", "nl", "be", "ch", "au", "nz", "ie"],
  },
];
export const popularExtensions = ["com", "net", "co", "io", "ai", "app", "dev"] as const;
export const MAX_EXTENSIONS = 30;

export const prefixOptions = ["get", "try", "use", "hello", "my", "the", "go"] as const;
export const suffixOptions = ["hq", "app", "co", "labs", "studio", "ai", "io", "online"] as const;
export const tweakSwitches = [
  { id: "hyphenate", label: "Hyphenate words" },
  { id: "firstWord", label: "First word only" },
  { id: "initials", label: "Initials" },
  { id: "plural", label: "Plural and singular" },
  { id: "noVowels", label: "Drop the vowels" },
] as const;
export type TweakSwitch = (typeof tweakSwitches)[number]["id"];
export type DomainTweaks = { prefixes: string[]; suffixes: string[] } & Record<TweakSwitch, boolean>;
export const defaultTweaks: DomainTweaks = {
  prefixes: ["get"],
  suffixes: ["hq"],
  hyphenate: true,
  firstWord: false,
  initials: false,
  plural: false,
  noVowels: false,
};
export const noTweaks: DomainTweaks = {
  prefixes: [],
  suffixes: [],
  hyphenate: false,
  firstWord: false,
  initials: false,
  plural: false,
  noVowels: false,
};
export function tweakCount(tweaks: DomainTweaks): number {
  return tweaks.prefixes.length + tweaks.suffixes.length + tweakSwitches.filter(({ id }) => tweaks[id]).length;
}

/** A word added before or after a name: 1–16 ASCII letters. */
export function tweakWordError(value: string): string | null {
  return /^[a-z]{1,16}$/.test(value.trim().toLowerCase()) ? null : "Use 1–16 letters, without spaces or numbers.";
}

/** The name's ASCII words. Accents are not transliterated: a word with other letters is left out. */
export function nameWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s_.-]+/u)
    .filter((word) => /^[a-z0-9]+$/.test(word));
}
/** The search field shows the name as one label ("kestrelanalytics"); typing spaces or hyphens keeps the words. */
export function searchWords(field: string, name: string): string[] {
  const typed = nameWords(field);
  if (typed.length !== 1) return typed;
  const original = nameWords(name);
  return original.join("") === typed[0] ? original : typed;
}

export type DomainVariant = { label: string; kind: "exact" | "tweak"; tweak: string | null };

/** The labels to try before the extension, with the tweak that made each. Duplicates keep their first reason. */
export function domainVariants(words: readonly string[], tweaks: DomainTweaks): DomainVariant[] {
  const joined = words.join("");
  if (!joined) return [];
  const variants: DomainVariant[] = [{ label: joined, kind: "exact", tweak: null }];
  const add = (label: string, tweak: string) => variants.push({ label, kind: "tweak", tweak });
  const several = words.length > 1;
  if (tweaks.hyphenate && several) add(words.join("-"), "Hyphenate words");
  if (tweaks.firstWord && several) add(words[0]!, "First word only");
  if (tweaks.initials && several) add(words.map((word) => word[0]).join(""), "Initials");
  if (tweaks.plural) add(joined.endsWith("s") ? joined.slice(0, -1) : `${joined}s`, "Plural and singular");
  if (tweaks.noVowels) add(joined[0] + joined.slice(1).replace(/[aeiou]/g, ""), "Drop the vowels");
  // Words before and after join the first word of a longer name, which keeps the domain short.
  const stem = several ? words[0]! : joined;
  for (const prefix of tweaks.prefixes) add(`${prefix}${stem}`, `Word before: ${prefix}`);
  for (const suffix of tweaks.suffixes) add(`${stem}${suffix}`, `Word after: ${suffix}`);
  const seen = new Set<string>();
  return variants.filter((variant) => {
    if (seen.has(variant.label) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(variant.label)) return false;
    seen.add(variant.label);
    return true;
  });
}
/** What a tweak gives for this name, shown under its switch. */
export function tweakPreview(words: readonly string[], id: TweakSwitch): string | null {
  const only = { ...noTweaks, [id]: true };
  return domainVariants(words, only).find((variant) => variant.kind === "tweak")?.label ?? null;
}

export type DomainRow = { domain: string; variant: DomainVariant; extension: string; order: number };
/** Best match first: the exact name in the first extensions, then tweaks and later extensions in turn. */
export function domainRows(words: readonly string[], extensions: readonly string[], tweaks: DomainTweaks): DomainRow[] {
  const rows: (DomainRow & { rank: number; variantIndex: number })[] = [];
  domainVariants(words, tweaks).forEach((variant, variantIndex) =>
    extensions.forEach((extension, extensionIndex) => {
      const domain = `${variant.label}.${extension}`;
      if (domainSyntaxError(domain) === null)
        rows.push({ domain, variant, extension, order: 0, rank: variantIndex + extensionIndex, variantIndex });
    }),
  );
  rows.sort((a, b) => a.rank - b.rank || a.variantIndex - b.variantIndex);
  return rows.map(({ domain, variant, extension }, order) => ({ domain, variant, extension, order }));
}

export type DomainResult = { check: DomainCheck; quote: DomainQuote | null };
export type DomainStatus = "not_checked" | "available" | "premium" | "taken" | "not_confirmed" | "expired";
/** Premium is only what the registrar itself reports in its own words. */
export function premiumReported(check: DomainCheck): boolean {
  return /\b(?:Premium domain|Registry premium)\./u.test(check.detail ?? "");
}
export function domainStatus(result: DomainResult | undefined, now: number): DomainStatus {
  if (!result) return "not_checked";
  if (now >= Date.parse(result.check.validUntil)) return "expired";
  const availability = availabilityAt(result.check, now);
  if (availability === "taken") return "taken";
  if (availability === "available") return premiumReported(result.check) ? "premium" : "available";
  return "not_confirmed";
}
/** A price is shown only while the registrar's quote matches a current check of the same domain. */
export function currentQuote(result: DomainResult | undefined, now: number): DomainQuote | null {
  return result?.quote && quoteBlockReason(result.quote, result.check, now) === null ? result.quote : null;
}
export function formatUsd(amountMinor: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amountMinor / 100);
}

export type DomainFilters = {
  show: Record<"available" | "premium" | "taken" | "unchecked", boolean>;
  minPrice: number | null;
  maxPrice: number | null;
  maxRenewal: number | null;
  maxLength: number | null;
  exactOnly: boolean;
  noHyphens: boolean;
};
export const defaultFilters: DomainFilters = {
  show: { available: true, premium: true, taken: true, unchecked: true },
  minPrice: null,
  maxPrice: null,
  maxRenewal: null,
  maxLength: null,
  exactOnly: false,
  noHyphens: false,
};
export type DomainSort = "best" | "price" | "shortest" | "alphabetical";
export const sortLabels: Record<DomainSort, string> = {
  best: "Best match",
  price: "Lowest first-year price",
  shortest: "Shortest",
  alphabetical: "A to Z",
};
const priceFiltered = (filters: DomainFilters) =>
  filters.minPrice !== null || filters.maxPrice !== null || filters.maxRenewal !== null;

export function filterDomainRows(
  rows: readonly DomainRow[],
  results: (domain: string) => DomainResult | undefined,
  filters: DomainFilters,
  now: number,
): DomainRow[] {
  return rows.filter((row) => {
    const status = domainStatus(results(row.domain), now);
    const group =
      status === "available" || status === "premium" || status === "taken"
        ? status
        : ("unchecked" as const satisfies keyof DomainFilters["show"]);
    if (!filters.show[group]) return false;
    if (filters.exactOnly && row.variant.kind !== "exact") return false;
    if (filters.noHyphens && row.domain.includes("-")) return false;
    if (filters.maxLength !== null && row.domain.length > filters.maxLength) return false;
    if (!priceFiltered(filters)) return true;
    // A price filter keeps only domains whose registrar price is known and within it.
    const quote = currentQuote(results(row.domain), now);
    if (!quote || quote.total.currency !== "USD") return false;
    const first = quote.total.amountMinor / 100;
    if (filters.minPrice !== null && first < filters.minPrice) return false;
    if (filters.maxPrice !== null && first > filters.maxPrice) return false;
    const renewal = quote.renewal?.currency === "USD" ? quote.renewal.amountMinor / 100 : null;
    if (filters.maxRenewal !== null && (renewal === null || renewal > filters.maxRenewal)) return false;
    return true;
  });
}
export function sortDomainRows(
  rows: readonly DomainRow[],
  sort: DomainSort,
  results: (domain: string) => DomainResult | undefined,
  now: number,
): DomainRow[] {
  const sorted = [...rows];
  if (sort === "alphabetical") sorted.sort((a, b) => a.domain.localeCompare(b.domain));
  else if (sort === "shortest") sorted.sort((a, b) => a.domain.length - b.domain.length || a.order - b.order);
  else if (sort === "price") {
    const price = (row: DomainRow) => currentQuote(results(row.domain), now)?.total.amountMinor ?? Infinity;
    sorted.sort((a, b) => price(a) - price(b) || a.order - b.order);
  } else sorted.sort((a, b) => a.order - b.order);
  return sorted;
}
