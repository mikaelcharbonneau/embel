import { describe, expect, it } from "vitest";
import { appendEvidence, createEntry, type HandleMatrixRow } from "@/features/handles-workspace/domain";
import { availableEverywhere } from "@/features/handles-workspace/results";

const available = (platform: "instagram" | "x") => appendEvidence(createEntry(platform, "example"), { platform, handle: "example", outcome: "confirmed_available", authority: "authorized_service", source: "Synthetic fixture", sourceUrl: null, method: "Fixture check", checkedAt: "2026-10-01T12:00:00Z", observedAt: "2026-10-01T12:00:01Z", detail: "Synthetic evidence only" });
const row = (entries: HandleMatrixRow["entries"]): HandleMatrixRow => ({ id: "fixture", source: { id: "fixture", name: "example", origin: "manual", projectId: null, projectTitle: null }, variant: "Exact name", entries });

describe("Handles Results evidence filtering", () => {
  it("requires authoritative available evidence on every selected platform", () => {
    expect(availableEverywhere(row([available("instagram"), available("x")]), ["instagram", "x"])).toBe(true);
    expect(availableEverywhere(row([available("instagram"), createEntry("x", "example")]), ["instagram", "x"])).toBe(false);
    expect(availableEverywhere(row([available("instagram")]), ["instagram", "x"])).toBe(false);
    expect(availableEverywhere(row([available("instagram")]), [])).toBe(false);
  });
  it("does not treat missing profiles, failed checks or disconnected services as available", () => {
    for (const outcome of ["profile_missing", "failed", "unavailable", "unknown", "taken"] as const) {
      const entry = appendEvidence(available("instagram"), { platform: "instagram", handle: "example", outcome, authority: outcome === "taken" ? "authorized_service" : "public_profile", source: "Synthetic fixture", sourceUrl: null, method: "Fixture recheck", checkedAt: "2026-10-02T12:00:00Z", observedAt: "2026-10-02T12:00:01Z", detail: "Synthetic only" });
      expect(availableEverywhere(row([entry]), ["instagram"])).toBe(false);
    }
  });
});
