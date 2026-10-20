import { domainSyntaxError, normalizeDomain } from "@/features/domain-workspace/model";

/** Reject non-ASCII before normalization, including Unicode that lowercases to ASCII. */
export function projectScreeningDomainError(input: string): string | null {
  if (!/^[A-Za-z0-9.-]*$/.test(input.trim())) return "Use an ASCII domain without a URL, path, port or email address. Internationalized names are not supported yet.";
  return domainSyntaxError(input);
}

/** Syntax-only suggestion, never availability evidence. Do not transliterate a brand. */
export function projectScreeningDomainSuggestion(name: string): string | null {
  const seed = name.trim().replace(/\s+/g, "");
  // Check before case folding: Unicode characters must not silently become ASCII.
  if (!/^[A-Za-z0-9.-]+$/.test(seed)) return null;
  const domain = normalizeDomain(seed.includes(".") ? seed : `${seed}.com`);
  return projectScreeningDomainError(domain) === null ? domain : null;
}
