import "server-only";
import { namingVerificationOutputSchema, namingVerificationProviderOutputSchema, type NamingEvidenceSource } from "../../../domain/naming-brain";

/** Legacy exact spans remain exact. Repair is a separate source projection,
 * never a rewrite of the retained provider item, quote, finding or source. */
export function bindNamingQuotePositions(raw: unknown, sources: readonly NamingEvidenceSource[]) {
  const input = namingVerificationProviderOutputSchema.parse(raw);
  const byKey = new Map(sources.map(source => [source.sourceKey, source]));
  if (byKey.size !== sources.length) throw new Error("quote_source_collision");
  const excerptFor = (sourceKey: string) => {
    const source = byKey.get(sourceKey);
    if (source?.evidenceStatus !== "retrieved" || source.excerpt === null) throw new Error("quote_source_missing");
    return source.excerpt;
  };
  let corrected = false;
  const output = namingVerificationOutputSchema.parse({ ...input, findings: input.findings.map(finding => ({ ...finding,
    evidence: finding.evidence.map(quote => {
      const excerpt = excerptFor(quote.sourceKey), start = excerpt.indexOf(quote.quote);
      // In Unicode mode this range matches lone surrogate code units only;
      // paired supplementary characters remain whole code points.
      if (/[\uD800-\uDFFF]/u.test(excerpt) || /[\uD800-\uDFFF]/u.test(quote.quote)) throw new Error("quote_text_invalid");
      if (quote.end - quote.start === quote.quote.length && excerpt.slice(quote.start, quote.end) === quote.quote) return { ...quote };
      // Start the second search one code unit later, so overlaps also fail.
      if (start < 0 || excerpt.indexOf(quote.quote, start + 1) !== -1) throw new Error("quote_match_not_unique");
      corrected = true;
      return { ...quote, start, end: start + quote.quote.length };
    }),
  })) });
  return { output, corrected };
}
