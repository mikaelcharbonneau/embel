import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendEvidence,
  createEntry,
  entrySchema,
  evidenceSchema,
  handleStatus,
  lastCheckedAt,
  type HandleEvidence,
} from "@/features/handles-workspace/domain";
import { checkHandleEntry } from "@/features/handles-workspace/adapters";

const completion = "2026-10-05T12:00:00Z";
const earlier: HandleEvidence = {
  platform: "instagram",
  handle: "morrow",
  outcome: "confirmed_available",
  authority: "platform_api",
  source: "Synthetic permitted API fixture",
  sourceUrl: null,
  method: "Synthetic check",
  checkedAt: "2020-01-01T12:00:00Z",
  observedAt: "2020-01-01T12:00:01Z",
  detail: "Fixture only",
};

describe("Handle evidence chronology at a controlled completion time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(completion));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["checked in 2099", { checkedAt: "2099-01-01T00:00:00Z" }],
    [
      "checked after observation but before completion",
      { checkedAt: "2026-10-05T11:59:59Z", observedAt: "2026-10-05T11:59:58Z" },
    ],
    ["both dates in the future", { checkedAt: "2099-01-01T00:00:00Z", observedAt: "2099-01-01T00:00:01Z" }],
    ["observed after completion", { observedAt: "2026-10-05T12:00:00.001Z" }],
  ])("rejects %s without replacing valid earlier evidence", (_label, dates) => {
    const entry = appendEvidence(createEntry("instagram", "morrow"), earlier);
    const invalid = { ...earlier, ...dates };
    expect(evidenceSchema.safeParse(invalid).success).toBe(false);
    expect(() => appendEvidence(entry, invalid)).toThrow();
    expect(entry.evidence).toEqual([earlier]);
    expect(handleStatus(entry)).toBe("confirmed_available");
  });

  it("rejects a future observation even when no actual check is claimed", () => {
    expect(
      evidenceSchema.safeParse({
        ...earlier,
        outcome: "unavailable",
        authority: "none",
        checkedAt: null,
        observedAt: "2099-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("accepts equality at completion, timezone-equivalent dates and valid historical evidence", () => {
    const current = { ...earlier, checkedAt: "2026-10-05T13:00:00+01:00", observedAt: completion };
    expect(evidenceSchema.safeParse(current).success).toBe(true);
    const entry = appendEvidence(appendEvidence(createEntry("instagram", "morrow"), earlier), current);
    expect(entry.evidence).toEqual([earlier, current]);
    expect(entrySchema.safeParse(entry).success).toBe(true);
  });

  it("never displays confirmed availability from an impossible persisted date", () => {
    const entry = {
      ...createEntry("instagram", "morrow"),
      evidence: [{ ...earlier, checkedAt: "2099-01-01T00:00:00Z" }],
    };
    expect(entrySchema.safeParse(entry).success).toBe(false);
    expect(handleStatus(entry)).toBe("to_check");
  });

  it("retains the earlier valid check date instead of displaying an impossible latest date", () => {
    const entry = {
      ...createEntry("instagram", "morrow"),
      evidence: [earlier, { ...earlier, checkedAt: "2099-01-01T00:00:00Z" }],
    };
    expect(lastCheckedAt(entry)).toBe(earlier.checkedAt);
    expect(handleStatus(entry)).toBe("to_check");
  });

  it("turns an impossible adapter date into a failed unknown attempt while retaining earlier evidence", async () => {
    const entry = appendEvidence(createEntry("instagram", "morrow"), earlier);
    const next = await checkHandleEntry(entry, {
      availability: "ready",
      label: "Synthetic fixture",
      check: async () => ({ ...earlier, checkedAt: "2099-01-01T00:00:00Z" }),
    });
    expect(next.evidence).toEqual([
      earlier,
      expect.objectContaining({ outcome: "failed", checkedAt: null, observedAt: completion.replace("Z", ".000Z") }),
    ]);
    expect(handleStatus(next)).toBe("to_check");
  });
});
