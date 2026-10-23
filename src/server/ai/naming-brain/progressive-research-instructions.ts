import type { NamingRole } from "../../../domain/naming-brain";

const paths: Readonly<Record<string, string>> = Object.freeze({
  "www.merriam-webster.com": "/dictionary/<word>",
  "dictionary.cambridge.org": "/dictionary/<language>/<entry>",
  "en.wiktionary.org": "/wiki/<entry> (no namespace colon)",
  "en.wikipedia.org": "/wiki/<article> (no namespace colon)",
  "www.britannica.com": "/topic|science|animal|plant|place|biography|art|event|technology|sports/<entry>",
  "www.perseus.tufts.edu": "/hopper/text?doc=<document> (optional lang and highlight)",
  "logeion.uchicago.edu": "/<entry>",
  "www.cnrtl.fr": "/definition|etymologie|lexicographie/<entry>",
});

/** Selected only by an immutable future request marker; historical wire text stays exact. */
export function namingProgressiveReferenceInstructionsV2(role: Extract<NamingRole, "researcher" | "verifier">, referenceHosts: readonly string[]): string {
  const policy = referenceHosts.map(host => `- https://${host}${paths[host] ?? " (unavailable path policy)"}`).join("\n");
  const task = role === "researcher"
    ? `Research the frozen brief and every selected factual approach (classical_roots, other_languages, people_places, stories_culture when selected). Obtain useful retained excerpts for those routes, using a shared reference where it truly supports more than one route. Do not stop after one or two attempts if selected factual routes still lack evidence and the current call has time remaining. Keep the pass focused; do not browse separately for subjective creative associations. Return two to four useful territories and separate interpretations. Put factual statements in facts with the actual returned source keys. Identify each selected factual route that remains unsupported in uncertainties, with the actual retrieval limitation; an honest partial pack is valid. Never invent facts, translations, source keys or coverage.`
    : `Verify only the attached claims. Use retained excerpts and necessary real reads. Supported or corrected wording requires actual source keys and exact nonempty UTF-16 quote offsets in the retained excerpt. Missing evidence remains unresolved; never manufacture an origin, quotation, translation, route credit or clearance.`;
  return `${task}
Use web_search to find references, then read_reference to retain exact text. Only a retrieved read_reference result with an excerpt supports a fact; a search hit, plausible URL or successful tool invocation alone does not. Use only the following exact HTTPS hosts and permitted paths for read_reference:
${policy}
No credentials, alternate hosts, nonstandard ports or redirects are allowed. Except the Perseus parameters above, the only permitted query is a numeric oldid. A failed read is unavailable evidence: choose another relevant allowed reference within this same call when possible, or report the limitation. Do not request an out-of-policy host, fabricate a replacement result or describe a tool result as retrieved when it is unavailable.`;
}
