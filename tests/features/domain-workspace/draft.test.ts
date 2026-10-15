import { describe, expect, it } from "vitest";
import { DOMAIN_DRAFT_MAX_BYTES, DOMAIN_SHORTLIST_MAX_ITEMS, domainDraftEqual, domainDraftSchema, domainDraftShortlistedDomains, emptyDomainDraft, parseDomainDraft, toggleDomainShortlist } from "../../../src/features/domain-workspace/draft";
import { domainDraftFromSavedName, standalonePayloadCodec } from "../../../src/features/domain-workspace/account-codec";
import { domainFixtures } from "../../../src/features/domain-workspace/fixtures";
import { prepareDomainSearch } from "../../../src/features/domain-workspace/model";

const draft = { version: 1 as const, input: "North Star, northstar.com", extensions: ["com", "io"], candidates: ["northstar.com", "northstar.io"] };

describe("manual Domains account codec", () => {
  it("round trips a prepared search without adding availability evidence", () => {
    const restored = parseDomainDraft(JSON.parse(JSON.stringify(draft)));
    expect(restored).toEqual(draft);
    expect(Object.keys(restored)).toEqual(["version", "input", "extensions", "candidates"]);
    expect(standalonePayloadCodec.tool).toBe("domains");
    expect(domainDraftEqual(restored, { candidates: draft.candidates, extensions: draft.extensions, input: draft.input, version: 1 })).toBe(true);
  });
  it.each(["order", "orders", "check", "checks", "quote", "quotes", "provider", "payment", "registration", "confirmation", "appliedEventIds", "appliedEvents", "ownerId", "imports"])("rejects authority-bearing or envelope property %s", property => {
    const { purchased } = domainFixtures();
    expect(domainDraftSchema.safeParse({ ...draft, [property]: purchased }).success).toBe(false);
  });
  it.each([
    { candidates: ["northstar.io", "northstar.com"] },
    { candidates: ["northstar.com"] },
    { candidates: ["northstar.com", "other.io"] },
    { candidates: ["northstar.com", "northstar.com"] },
    { candidates: [" NorthStar.COM ", "northstar.io"] },
    { candidates: [{ domain: "northstar.com", availability: "available" }] },
    { input: "northstar, broken..com" },
    { extensions: ["com", "io", "com"] },
    { extensions: ["COM", "io"] },
    { version: 2 },
  ])("rejects mismatched or noncanonical draft %j", patch => {
    expect(domainDraftSchema.safeParse({ ...draft, ...patch }).success).toBe(false);
  });
  it("retains unfinished manual text with no candidates and does not treat it as prepared", () => {
    const value = { ...emptyDomainDraft(), input: "a draft, still typing ?" };
    expect(parseDomainDraft(value)).toEqual(value);
    expect(prepareDomainSearch(value.input, value.extensions).errors.length).toBeGreaterThan(0);
    expect(parseDomainDraft({ ...emptyDomainDraft(), input: "example.com", extensions: [], candidates: ["example.com"] }).candidates).toEqual(["example.com"]);
  });
  it("bounds lengths, extensions, candidates and total UTF-8 bytes", () => {
    expect(domainDraftSchema.safeParse({ ...emptyDomainDraft(), input: "a".repeat(4001) }).success).toBe(false);
    expect(domainDraftSchema.safeParse({ ...emptyDomainDraft(), extensions: Array(11).fill("com") }).success).toBe(false);
    expect(domainDraftSchema.safeParse({ ...draft, candidates: Array(201).fill("northstar.com") }).success).toBe(false);
    const extensions = Array.from({ length: 10 }, (_, index) => `${"a".repeat(61)}${String.fromCharCode(97 + index)}`);
    const input = Array.from({ length: 20 }, (_, index) => `${"b".repeat(61)}${String.fromCharCode(97 + index)}`).join("\n");
    const candidates = prepareDomainSearch(input, extensions).domains;
    expect(candidates).toHaveLength(200);
    expect(domainDraftSchema.safeParse({ version: 1, input, extensions, candidates }).success).toBe(false);
  });
  it("projects an explicitly imported saved name to unchecked text, preserving chosen extensions", () => {
    expect(domainDraftFromSavedName(draft, "Owned Name")).toEqual({ ...draft, input: "Owned Name", candidates: [] });
    expect(() => domainDraftFromSavedName(draft, "a".repeat(4001))).toThrow();
    expect(draft.candidates).toEqual(["northstar.com", "northstar.io"]);
  });

  it("reads legacy and explicitly empty shortlists without changing the serialized payload", () => {
    const legacy = emptyDomainDraft();
    const explicitEmpty = { ...legacy, shortlistedDomains: [] };
    expect(JSON.stringify(parseDomainDraft(legacy))).toBe(JSON.stringify(legacy));
    expect(JSON.stringify(parseDomainDraft(explicitEmpty))).toBe(JSON.stringify(explicitEmpty));
    expect(domainDraftShortlistedDomains(legacy)).toEqual([]);
    expect(domainDraftShortlistedDomains(explicitEmpty)).toEqual([]);
    expect(domainDraftEqual(legacy, explicitEmpty)).toBe(false);
    expect(Object.hasOwn(legacy, "shortlistedDomains")).toBe(false);
  });

  it("retains explicit choices across new searches and imported names independently of candidates", () => {
    const chosen = { ...draft, shortlistedDomains: ["earlier.co.uk", "northstar.io"] };
    expect(parseDomainDraft(chosen)).toEqual(chosen);
    expect(parseDomainDraft({ ...chosen, input: "still typing ?", candidates: [] }).shortlistedDomains).toEqual(chosen.shortlistedDomains);
    expect(parseDomainDraft({ ...chosen, input: "Later", candidates: ["later.com", "later.io"] }).shortlistedDomains).toEqual(chosen.shortlistedDomains);
    expect(domainDraftFromSavedName(chosen, "Owned Name")).toEqual({ ...chosen, input: "Owned Name", candidates: [] });
  });

  it("toggles only selected domains without mutating the source or adding provider evidence", () => {
    const first = toggleDomainShortlist(draft, "earlier.net");
    expect(first).toEqual({ ...draft, shortlistedDomains: ["earlier.net"] });
    const second = toggleDomainShortlist(first, "northstar.com");
    expect(second.shortlistedDomains).toEqual(["earlier.net", "northstar.com"]);
    expect(toggleDomainShortlist(second, "earlier.net").shortlistedDomains).toEqual(["northstar.com"]);
    expect(toggleDomainShortlist(first, "earlier.net")).toEqual(draft);
    expect(first.shortlistedDomains).toEqual(["earlier.net"]);
    expect(Object.hasOwn(draft, "shortlistedDomains")).toBe(false);
    const copy = domainDraftShortlistedDomains(second);
    copy.push("different.com");
    expect(second.shortlistedDomains).toEqual(["earlier.net", "northstar.com"]);
    expect(() => toggleDomainShortlist(draft, " NorthStar.COM ")).toThrow();
  });

  it.each([
    null, "northstar.com", {}, [null], [1], [true],
    ["northstar.com", "northstar.com"], ["NorthStar.com"], [" northstar.com"], ["northstar.com "],
    ["https://northstar.com"], ["northstar.com/path"], ["northstar.com:443"], ["northstar.com."],
    ["localhost"], ["broken..com"], ["-northstar.com"], ["northstar-.com"], ["northstar.c"], ["northstar.123"],
    ["xn--cedar.com"], ["sub.xn--cedar.com"], ["caf\u00e9.com"], ["\u212a.com"],
    [`${"a".repeat(64)}.com`], [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`],
    [{ domain: "northstar.com", availability: "available" }],
    [{ domain: "northstar.com", quote: { amount: 100 } }],
  ])("rejects malformed or evidence-bearing shortlist %j", shortlistedDomains => {
    expect(domainDraftSchema.safeParse({ ...draft, shortlistedDomains }).success).toBe(false);
  });

  it("accepts canonical domain boundaries and bounds the shortlist by count and complete UTF-8 bytes", () => {
    const longestDomain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(longestDomain.length).toBe(253);
    expect(parseDomainDraft({ ...draft, shortlistedDomains: ["a.co", "a-b.sub.co.uk", longestDomain] }).shortlistedDomains).toHaveLength(3);
    const maximum = { ...emptyDomainDraft(), shortlistedDomains: Array.from({ length: DOMAIN_SHORTLIST_MAX_ITEMS }, (_, n) => `choice${n}.com`) };
    expect(parseDomainDraft(maximum)).toEqual(maximum);
    expect(() => toggleDomainShortlist(maximum, "extra.com")).toThrow();
    expect(toggleDomainShortlist(maximum, "choice0.com").shortlistedDomains).toHaveLength(DOMAIN_SHORTLIST_MAX_ITEMS - 1);
    expect(domainDraftSchema.safeParse({ ...maximum, shortlistedDomains: [...maximum.shortlistedDomains, "extra.com"] }).success).toBe(false);
    const bounded = { ...emptyDomainDraft(), shortlistedDomains: Array.from({ length: 100 }, (_, n) => `d${String(n).padStart(3, "0")}.${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.com`) };
    const remaining = DOMAIN_DRAFT_MAX_BYTES - new TextEncoder().encode(JSON.stringify(bounded)).byteLength;
    expect(remaining).toBeGreaterThan(0); expect(remaining).toBeLessThanOrEqual(4000);
    const exact = { ...bounded, input: "a".repeat(remaining) };
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(DOMAIN_DRAFT_MAX_BYTES);
    expect(parseDomainDraft(exact)).toEqual(exact);
    expect(domainDraftSchema.safeParse({ ...exact, input: `${exact.input}a` }).success).toBe(false);
    expect(domainDraftSchema.safeParse({ ...exact, input: `${exact.input.slice(0, -1)}\u00e9` }).success).toBe(false);
  });
});
