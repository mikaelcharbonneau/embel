import { describe, expect, it } from "vitest";
import { namingSourceSchema, nameTransformInputSchema, transformNames, type NamingSource, type NameTransformInput } from "@/domain/naming";

// Independent synthetic fixtures. These tests make no model, screening, or account calls.
const CREATED_AT = "2026-10-02T10:00:00Z";
const SOURCE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const STEP_A = "bbbbbbbb-1111-4111-8111-111111111111";
const STEP_B = "cccccccc-1111-4111-8111-111111111111";

function values(input: NameTransformInput) {
  return transformNames(input).candidates.map((candidate) => candidate.value);
}

function source(): NamingSource {
  return {
    id: SOURCE_ID, value: "LOOM", createdAt: CREATED_AT, origin: "workshop",
    history: [
      { id: STEP_A, input: { kind: "swap", seed: "room", find: "r", replacement: "l", match: "first" }, output: "loom", createdAt: CREATED_AT },
      { id: STEP_B, input: { kind: "tweaks", seed: "loom", operations: ["uppercase"] }, output: "LOOM", createdAt: CREATED_AT },
    ],
  };
}

describe("independent naming transforms", () => {
  it("treats regex syntax and replacement-template tokens as ordinary text", () => {
    const replacement = "$& $1 $$ $` $'";
    expect(values({ kind: "swap", seed: "A.*B.*C", find: ".*", replacement, match: "all" }))
      .toEqual([`A${replacement}B${replacement}C`]);
    expect(values({ kind: "swap", seed: "[x][x]", find: "[x]", replacement: "$&", match: "first" }))
      .toEqual(["$&[x]"]);
  });

  it("counts whole emoji, flags, and combining clusters when blending", () => {
    expect(values({ kind: "blend", left: "👨‍👩‍👧‍👦X", right: "🇨🇦Y", leftTake: 1, rightDrop: 1 }))
      .toEqual(["👨‍👩‍👧‍👦Y"]);
    expect(values({ kind: "blend", left: "👍🏽X", right: "e\u0301Y", leftTake: 1, rightDrop: 1 }))
      .toEqual(["👍🏽Y"]);
  });

  it("never splits an existing grapheme to satisfy a literal swap", () => {
    expect(values({ kind: "swap", seed: "👍🏽 studio", find: "👍", replacement: "New", match: "all" })).toEqual([]);
    expect(values({ kind: "swap", seed: "👨‍👩‍👧‍👦 house", find: "👩", replacement: "New", match: "all" })).toEqual([]);
    expect(values({ kind: "swap", seed: "q\u0301 studio", find: "q", replacement: "New", match: "all" })).toEqual([]);
  });

  it("rejects oversized output without cutting a name or changing the input", () => {
    const input = { kind: "swap", seed: `${"x".repeat(159)}a`, find: "a", replacement: "👨‍👩‍👧‍👦", match: "all" } as const;
    const before = structuredClone(input);
    Object.freeze(input);
    expect(values(input)).toEqual([]);
    expect(input).toEqual(before);
    expect(values({ kind: "swap", seed: `${"x".repeat(159)}a`, find: "a", replacement: "b", match: "all" }))
      .toEqual([`${"x".repeat(159)}b`]);
  });

  it("has stable repeated results and leaves mutable option arrays unchanged", () => {
    const input: NameTransformInput = { kind: "affixes", seed: "Root", prefixes: ["É", "E\u0301", "The"], suffixes: ["Lab", "Works"], separator: " " };
    const before = structuredClone(input);
    const first = transformNames(input);
    expect(transformNames(input)).toEqual(first);
    expect(input).toEqual(before);
    expect(new Set(first.candidates.map((candidate) => candidate.value)).size).toBe(first.candidates.length);
    expect(first.candidates.every((candidate) => candidate.value === candidate.value.normalize("NFC"))).toBe(true);
  });

  it("rejects hidden provider/evidence parameters instead of accepting invented checking instructions", () => {
    expect(nameTransformInputSchema.safeParse({ kind: "swap", seed: "Room", find: "R", replacement: "L", match: "all", trademarkStatus: "cleared" }).success).toBe(false);
    expect(nameTransformInputSchema.safeParse({ kind: "blend", left: "Room", right: "Loom", leftTake: 1.5, rightDrop: 1 }).success).toBe(false);
  });
});

describe("independent naming provenance validation", () => {
  it("accepts a real chain while rejecting final-value, replay, and continuity tampering", () => {
    expect(namingSourceSchema.safeParse(source()).success).toBe(true);
    const finalValue = source();
    finalValue.value = "CLEARED";
    expect(namingSourceSchema.safeParse(finalValue).success).toBe(false);

    const replay = source();
    replay.history[0]!.input = { kind: "swap", seed: "room", find: "r", replacement: "b", match: "first" };
    expect(namingSourceSchema.safeParse(replay).success).toBe(false);

    const discontinuity = source();
    discontinuity.history[1]!.input = { kind: "tweaks", seed: "LOom", operations: ["uppercase"] };
    // This step independently produces LOOM, but it did not transform the prior output.
    expect(namingSourceSchema.safeParse(discontinuity).success).toBe(false);
  });

  it("rejects duplicate step identifiers and a workshop result without history", () => {
    const duplicated = source();
    duplicated.history[1]!.id = STEP_A;
    expect(namingSourceSchema.safeParse(duplicated).success).toBe(false);
    expect(namingSourceSchema.safeParse({ ...source(), history: [] }).success).toBe(false);
  });

  it("does not relabel a transformed result as a manual capture or add invented evidence", () => {
    expect(namingSourceSchema.safeParse({ ...source(), origin: "manual" }).success).toBe(false);
    expect(namingSourceSchema.safeParse({ ...source(), evidence: [{ status: "available", provider: "local" }] }).success).toBe(false);
    expect(namingSourceSchema.safeParse({ ...source(), history: source().history.map((step) => ({ ...step, trademarkApproved: true })) }).success).toBe(false);
  });
});
