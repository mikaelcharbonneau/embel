import { describe, expect, it } from "vitest";
import { domainDraftEqual, domainDraftSchema, emptyDomainDraft, parseDomainDraft } from "../../../src/features/domain-workspace/draft";
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
});
