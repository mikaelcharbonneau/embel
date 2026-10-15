import { z } from "zod";
import { domainSyntaxError, normalizeDomain, prepareDomainSearch } from "./model";

/** Leaves room for the shared account envelope inside the 32 KiB request limit. */
export const DOMAIN_DRAFT_MAX_BYTES = 24_000;
export const DOMAIN_SHORTLIST_MAX_ITEMS = 200;
export const domainExtensionSchema = z.string().regex(/^[a-z]{2,63}(?:\.[a-z]{2,63})?$/);
const canonicalDomain = z.string().max(253).refine(value => value === normalizeDomain(value) && domainSyntaxError(value) === null, "Use a canonical domain");

/** A manual draft can never carry registrar, quote, payment or order evidence. */
export const domainDraftSchema = z.object({
  version: z.literal(1),
  input: z.string().max(4000),
  extensions: z.array(domainExtensionSchema).max(10),
  candidates: z.array(canonicalDomain).max(200),
  // Optional for exact legacy-v1 reads/replays. These are user choices, not checks.
  shortlistedDomains: z.array(canonicalDomain).max(DOMAIN_SHORTLIST_MAX_ITEMS, "Keep up to 200 domains in your shortlist").optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.extensions).size !== value.extensions.length) context.addIssue({ code: "custom", path: ["extensions"], message: "Extensions must be unique" });
  if (value.shortlistedDomains && new Set(value.shortlistedDomains).size !== value.shortlistedDomains.length) context.addIssue({ code: "custom", path: ["shortlistedDomains"], message: "Shortlisted domains must be unique" });
  if (value.candidates.length) {
    const prepared = prepareDomainSearch(value.input, value.extensions);
    if (prepared.errors.length || JSON.stringify(prepared.domains) !== JSON.stringify(value.candidates)) context.addIssue({ code: "custom", path: ["candidates"], message: "Candidates must match the complete manual search preparation" });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > DOMAIN_DRAFT_MAX_BYTES) context.addIssue({ code: "custom", message: "This domain draft is too large to save" });
});
export type DomainDraft = z.infer<typeof domainDraftSchema>;

export function emptyDomainDraft(input = ""): DomainDraft {
  return domainDraftSchema.parse({ version: 1, input, extensions: ["com", "co", "io"], candidates: [] });
}

/** Parse without projection: unexpected evidence/ownership fields are rejected. */
export function parseDomainDraft(value: unknown): DomainDraft { return domainDraftSchema.parse(value); }

export function domainDraftEqual(left: DomainDraft, right: DomainDraft): boolean {
  return JSON.stringify(domainDraftSchema.parse(left)) === JSON.stringify(domainDraftSchema.parse(right));
}

/** A copy of the saved choices; candidates and transient provider evidence are separate. */
export function domainDraftShortlistedDomains(draft: DomainDraft): string[] {
  return [...(domainDraftSchema.parse(draft).shortlistedDomains ?? [])];
}

/** Explicit selection only. Never normalize/rewrite an existing draft or its replay identity. */
export function toggleDomainShortlist(draft: DomainDraft, domain: string): DomainDraft {
  const next = domainDraftSchema.parse(draft);
  const choice = canonicalDomain.parse(domain);
  const current = next.shortlistedDomains ?? [];
  const selected = current.includes(choice) ? current.filter(value => value !== choice) : [...current, choice];
  if (selected.length) next.shortlistedDomains = selected;
  else delete next.shortlistedDomains;
  return domainDraftSchema.parse(next);
}
