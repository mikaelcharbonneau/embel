import { describe, expect, it } from "vitest";
import { nameTransformInputSchema, nameValueSchema, namingSourceSchema, transformNames, type NameTransformInput, type NamingSource } from "../../src/domain/naming";

const sourceId = "10000000-0000-4000-8000-000000000001";
const stepId = "10000000-0000-4000-8000-000000000002";
const nextStepId = "10000000-0000-4000-8000-000000000003";
const at = "2026-10-02T00:00:00.000Z";
const values = (input: NameTransformInput) => transformNames(input).candidates.map(candidate => candidate.value);
const uppercase: NameTransformInput = { kind: "tweaks", seed: "Oak", operations: ["uppercase"] };
const workshop = (): NamingSource => ({ id: sourceId, value: "OAK", createdAt: at, origin: "workshop", history: [{ id: stepId, input: uppercase, output: "OAK", createdAt: at }] });

describe("bounded name values", () => {
  it("normalizes accents and outer whitespace while preserving internal spacing", () => {
    expect(nameValueSchema.parse("  Cafe\u0301  Works  ")).toBe("Café  Works");
    expect(nameValueSchema.parse("e\u0301".repeat(160))).toBe("é".repeat(160));
    expect(nameValueSchema.parse("🚀".repeat(80))).toHaveLength(160);
  });

  it.each(["", "  ", "a".repeat(161), "🚀".repeat(81), "a\nname", "a\tname", "a\u007fname", "a\u2028name", "a\u202ename", "\ud800", "\udfff", "\u200d\ufe0f"])("rejects invalid name %j", value => {
    expect(nameValueSchema.safeParse(value).success).toBe(false);
  });

  it("keeps meaningful Unicode joiners and marks", () => {
    expect(nameValueSchema.parse("👩🏽‍🚀 Žöe क्‍ष")).toBe("👩🏽‍🚀 Žöe क्‍ष");
  });
});

describe("Affixes", () => {
  it("combines prefixes and suffixes in stable prefix-major order", () => {
    const input: NameTransformInput = { kind: "affixes", seed: "Oak", prefixes: ["New", "Wild"], suffixes: ["Lab", "Works"], separator: "-" };
    const result = transformNames(input);
    expect(result.candidates.map(candidate => candidate.value)).toEqual(["New-Oak-Lab", "New-Oak-Works", "Wild-Oak-Lab", "Wild-Oak-Works"]);
    expect(result.truncated).toBe(false);
    expect(result.candidates.every(candidate => candidate.explanation.length > 0)).toBe(true);
    expect(transformNames(input)).toEqual(result);
  });

  it("treats an empty side as no affix without inserting extra separators", () => {
    expect(values({ kind: "affixes", seed: "Oak", prefixes: [], suffixes: ["Lab"], separator: " " })).toEqual(["Oak Lab"]);
    expect(values({ kind: "affixes", seed: "Oak", prefixes: ["New"], suffixes: [], separator: "" })).toEqual(["NewOak"]);
  });

  it("deduplicates after NFC normalization and omits unchanged results", () => {
    const result = transformNames({ kind: "affixes", seed: "Oak", prefixes: ["Café", "Cafe\u0301", ""], suffixes: [], separator: " " });
    expect(result.candidates.map(candidate => candidate.value)).toEqual(["Café Oak"]);
    expect(result.notes.join(" ")).toMatch(/unchanged/i);
  });

  it("returns at most 64 unique values and explicitly reports truncation", () => {
    const input: NameTransformInput = { kind: "affixes", seed: "Oak", prefixes: Array.from({ length: 12 }, (_, i) => `p${i}`), suffixes: Array.from({ length: 12 }, (_, i) => `s${i}`), separator: "-" };
    const result = transformNames(input);
    expect(result.candidates).toHaveLength(64);
    expect(result.candidates[0]?.value).toBe("p0-Oak-s0");
    expect(result.candidates[63]?.value).toBe("p5-Oak-s3");
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/64/);
    expect(transformNames({ ...input, prefixes: Array(12).fill("same"), suffixes: Array(12).fill("same") }).truncated).toBe(false);
  });

  it("omits values over 160 UTF-16 units without slicing them", () => {
    const result = transformNames({ kind: "affixes", seed: "🚀".repeat(79), prefixes: [], suffixes: ["X", "🌟"], separator: "-" });
    expect(result.candidates.map(candidate => candidate.value)).toEqual([`${"🚀".repeat(79)}-X`]);
    expect(result.notes.join(" ")).toMatch(/160/);
    expect(result.truncated).toBe(false);
  });
});

describe("Tweaks", () => {
  it("creates separate variants rather than a sequence of changes", () => {
    expect(values({ kind: "tweaks", seed: "mIxEd  nAME", operations: ["lowercase", "uppercase", "titlecase", "remove_spaces", "hyphenate"] })).toEqual(["mixed  name", "MIXED  NAME", "Mixed  Name", "mIxEdnAME", "mIxEd-nAME"]);
  });

  it("uses locale-independent Unicode case mapping and word-based title case", () => {
    expect(values({ kind: "tweaks", seed: "ÉCOLE-ROUGE", operations: ["lowercase", "titlecase"] })).toEqual(["école-rouge", "École-Rouge"]);
    expect(values({ kind: "tweaks", seed: "straße", operations: ["uppercase"] })).toEqual(["STRASSE"]);
  });

  it("removes unchanged and duplicate variants in requested order", () => {
    const result = transformNames({ kind: "tweaks", seed: "oak", operations: ["lowercase", "uppercase", "uppercase", "remove_spaces"] });
    expect(result.candidates.map(candidate => candidate.value)).toEqual(["OAK"]);
    expect(result.notes.join(" ")).toMatch(/unchanged/i);
  });

  it("applies space operations to Unicode whitespace", () => {
    expect(values({ kind: "tweaks", seed: "Oak\u00a0\u2003Lab", operations: ["remove_spaces", "hyphenate"] })).toEqual(["OakLab", "Oak-Lab"]);
  });

  it("omits case expansions that exceed the name limit", () => {
    const result = transformNames({ kind: "tweaks", seed: "ß".repeat(81), operations: ["uppercase"] });
    expect(result.candidates).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/160/);
  });
});

describe("Blend", () => {
  it("takes complete graphemes from the left and drops complete graphemes on the right", () => {
    expect(values({ kind: "blend", left: "👨‍👩‍👧‍👦Cafe\u0301", right: "🇨🇦🌿Works", leftTake: 2, rightDrop: 1 })).toEqual(["👨‍👩‍👧‍👦C🌿Works"]);
    expect(values({ kind: "blend", left: "Cafe\u0301", right: "Works", leftTake: 4, rightDrop: 0 })).toEqual(["CaféWorks"]);
  });

  it("permits dropping all of the right and normalizes the joined result", () => {
    expect(values({ kind: "blend", left: "Oak", right: "Lab", leftTake: 1, rightDrop: 3 })).toEqual(["O"]);
    expect(values({ kind: "blend", left: "A", right: "\u030ang", leftTake: 1, rightDrop: 0 })).toEqual(["Ång"]);
  });

  it("omits a blend equal to the left name", () => {
    const result = transformNames({ kind: "blend", left: "Oak", right: "Lab", leftTake: 3, rightDrop: 3 });
    expect(result.candidates).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/unchanged/i);
  });
});

describe("Swap", () => {
  it("replaces literal strings with literal replacement text", () => {
    expect(values({ kind: "swap", seed: "a.*a.*", find: ".*", replacement: "$&$1$$$`$'", match: "first" })).toEqual(["a$&$1$$$`$'a.*"]);
    expect(values({ kind: "swap", seed: "a.*a.*", find: ".*", replacement: "$&", match: "all" })).toEqual(["a$&a$&"]);
  });

  it("uses left-to-right nonoverlapping matches from the original name", () => {
    expect(values({ kind: "swap", seed: "aaa", find: "aa", replacement: "aaaa", match: "all" })).toEqual(["aaaaa"]);
    expect(values({ kind: "swap", seed: "Oak Oak", find: "Oak", replacement: "O", match: "first" })).toEqual(["O Oak"]);
  });

  it("preserves intentional spaces in search and replacement", () => {
    expect(values({ kind: "swap", seed: "Oak Lab", find: " ", replacement: "", match: "all" })).toEqual(["OakLab"]);
    expect(values({ kind: "swap", seed: "OakLab", find: "Lab", replacement: " Works", match: "all" })).toEqual(["Oak Works"]);
  });

  it("normalizes literal search while never matching inside a grapheme", () => {
    expect(values({ kind: "swap", seed: "Café", find: "e\u0301", replacement: "a", match: "all" })).toEqual(["Cafa"]);
    expect(values({ kind: "swap", seed: "👩🏽‍🚀 lab", find: "👩", replacement: "pilot", match: "all" })).toEqual([]);
    expect(values({ kind: "swap", seed: "a\u0323\u0301b", find: "\u0301", replacement: "", match: "all" })).toEqual([]);
  });

  it("allows deletion only when the resulting name is nonempty", () => {
    expect(values({ kind: "swap", seed: "OakLab", find: "Lab", replacement: "", match: "all" })).toEqual(["Oak"]);
    const result = transformNames({ kind: "swap", seed: "Oak", find: "Oak", replacement: "", match: "all" });
    expect(result.candidates).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/empty/i);
  });

  it("reports no match and unchanged results", () => {
    const absent = transformNames({ kind: "swap", seed: "Oak", find: "oak", replacement: "Pine", match: "all" });
    expect(absent.candidates).toEqual([]);
    expect(absent.notes.join(" ")).toMatch(/match/i);
    expect(transformNames({ kind: "swap", seed: "Oak", find: "Oak", replacement: "Oak", match: "all" }).notes.join(" ")).toMatch(/unchanged/i);
  });
});

describe("strict operation bounds", () => {
  it.each([
    { kind: "affixes", seed: "Oak", prefixes: [], suffixes: [], separator: "" },
    { kind: "affixes", seed: "Oak", prefixes: [" "], suffixes: [""], separator: "" },
    { kind: "affixes", seed: "Oak", prefixes: Array(13).fill("a"), suffixes: [], separator: "" },
    { kind: "affixes", seed: "Oak", prefixes: ["a".repeat(161)], suffixes: [], separator: "" },
    { kind: "affixes", seed: "Oak", prefixes: ["a"], suffixes: [], separator: "." },
    { kind: "tweaks", seed: "Oak", operations: [] },
    { kind: "tweaks", seed: "Oak", operations: Array(6).fill("uppercase") },
    { kind: "tweaks", seed: "Oak", operations: ["randomize"] },
    { kind: "tweaks", seed: "Oak", operations: ["uppercase"], ownerId: sourceId },
    { kind: "blend", left: "Oak", right: "Lab", leftTake: 0, rightDrop: 0 },
    { kind: "blend", left: "Oak", right: "Lab", leftTake: 4, rightDrop: 0 },
    { kind: "blend", left: "👩🏽‍🚀", right: "Lab", leftTake: 2, rightDrop: 0 },
    { kind: "blend", left: "Oak", right: "Lab", leftTake: 1.5, rightDrop: 0 },
    { kind: "blend", left: "Oak", right: "Lab", leftTake: 1, rightDrop: -1 },
    { kind: "blend", left: "Oak", right: "Lab", leftTake: 1, rightDrop: 4 },
    { kind: "swap", seed: "Oak", find: "", replacement: "Pine", match: "all" },
    { kind: "swap", seed: "Oak", find: "Oak", replacement: "a".repeat(161), match: "all" },
    { kind: "swap", seed: "Oak", find: "Oak", replacement: "Pine", match: "regex" },
  ])("rejects invalid or oversized work %#", input => {
    expect(nameTransformInputSchema.safeParse(input).success).toBe(false);
    expect(() => transformNames(input as NameTransformInput)).toThrow();
  });

  it("does not mutate caller inputs", () => {
    const input: NameTransformInput = { kind: "affixes", seed: "Cafe\u0301", prefixes: [" New "], suffixes: [], separator: " " };
    const before = structuredClone(input);
    values(input);
    expect(input).toEqual(before);
  });
});

describe("immutable chosen-name provenance", () => {
  it("accepts a manual name and normalizes its value", () => {
    expect(namingSourceSchema.parse({ id: sourceId, value: " Cafe\u0301 ", createdAt: at, origin: "manual", history: [] }).value).toBe("Café");
  });

  it("replays valid chosen history and preserves each step", () => {
    const source = workshop();
    source.history.push({ id: nextStepId, input: { kind: "affixes", seed: "OAK", prefixes: [], suffixes: ["LAB"], separator: " " }, output: "OAK LAB", createdAt: at });
    source.value = "OAK LAB";
    const before = structuredClone(source);
    expect(namingSourceSchema.parse(source)).toEqual(source);
    expect(source).toEqual(before);
  });

  it("permits a Blend continuation using the preceding selected name on the left", () => {
    const source = workshop();
    source.history.push({ id: nextStepId, input: { kind: "blend", left: "OAK", right: "WORKS", leftTake: 3, rightDrop: 0 }, output: "OAKWORKS", createdAt: at });
    source.value = "OAKWORKS";
    expect(namingSourceSchema.safeParse(source).success).toBe(true);
  });

  it.each([
    (source: NamingSource) => ({ ...source, origin: "manual" }),
    (source: NamingSource) => ({ ...source, history: [] }),
    (source: NamingSource) => ({ ...source, value: "PINE" }),
    (source: NamingSource) => ({ ...source, value: "PINE", history: [{ ...source.history[0], output: "PINE" }] }),
    (source: NamingSource) => ({ ...source, value: "Oak", history: [{ ...source.history[0], input: { ...uppercase, operations: ["remove_spaces"] }, output: "Oak" }] }),
    (source: NamingSource) => ({ ...source, id: "not-a-uuid" }),
    (source: NamingSource) => ({ ...source, createdAt: "yesterday" }),
    (source: NamingSource) => ({ ...source, available: true }),
    (source: NamingSource) => ({ ...source, history: [{ ...source.history[0], verified: true }] }),
  ])("rejects contradictory or untrusted provenance %#", mutate => {
    expect(namingSourceSchema.safeParse(mutate(workshop())).success).toBe(false);
  });

  it("rejects unrelated histories, duplicate step IDs and histories over 32 steps", () => {
    const source = workshop();
    const unrelated = { id: nextStepId, input: { ...uppercase, seed: "Pine" }, output: "PINE", createdAt: at };
    expect(namingSourceSchema.safeParse({ ...source, value: "PINE", history: [...source.history, unrelated] }).success).toBe(false);
    const validNext = { ...unrelated, id: stepId, input: { kind: "tweaks", seed: "OAK", operations: ["lowercase"] }, output: "oak" };
    expect(namingSourceSchema.safeParse({ ...source, value: "oak", history: [...source.history, validNext] }).success).toBe(false);
    expect(namingSourceSchema.safeParse({ ...source, history: Array(33).fill(source.history[0]) }).success).toBe(false);
  });

  it("accepts 32 real steps and rejects an otherwise valid 33rd step", () => {
    const source = workshop();
    for (let index = 1; index < 33; index += 1) {
      if (index === 32) expect(namingSourceSchema.safeParse(source).success).toBe(true);
      const output = index % 2 ? "oak" : "OAK";
      source.history.push({
        id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        input: { kind: "tweaks", seed: source.value, operations: [index % 2 ? "lowercase" : "uppercase"] },
        output, createdAt: at,
      });
      source.value = output;
    }
    expect(source.history).toHaveLength(33);
    expect(namingSourceSchema.safeParse(source).success).toBe(false);
  });

  it("reports invalid nested work without attempting to replay its output", () => {
    const source = workshop();
    const result = namingSourceSchema.safeParse({
      ...source, value: "Unknown", history: [{ ...source.history[0], output: "Unknown", input: {
        kind: "affixes", seed: "Oak", prefixes: Array(13).fill("New"), suffixes: [], separator: " ",
      } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.path)).toContainEqual(["history", 0, "input", "prefixes"]);
      expect(result.error.issues.map(issue => issue.path)).not.toContainEqual(["history", 0, "output"]);
    }
  });
});
