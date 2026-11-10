import { describe, expect, it } from "vitest";
import {
  accountProfileValuesSchema,
  DEFAULT_PROFILE_VALUES,
  formatAccountDate,
  saveAccountProfileSchema,
} from "@/domain/account-profile";

describe("account display profile", () => {
  it("normalizes bounded display-only values and rejects identity/authorization fields", () => {
    expect(
      accountProfileValuesSchema.parse({ ...DEFAULT_PROFILE_VALUES, fullName: "  Renée Example  " }).fullName,
    ).toBe("Renée Example");
    for (const values of [
      { ...DEFAULT_PROFILE_VALUES, fullName: "x".repeat(101) },
      { ...DEFAULT_PROFILE_VALUES, fullName: "A\nB" },
      { ...DEFAULT_PROFILE_VALUES, fullName: "A\u202eB" },
      { ...DEFAULT_PROFILE_VALUES, timeZone: "invalid" },
      { ...DEFAULT_PROFILE_VALUES, role: "admin" },
    ]) {
      expect(accountProfileValuesSchema.safeParse(values).success).toBe(false);
    }
    for (const addition of [{ ownerId: "foreign" }, { email: "replacement@example.invalid" }, { revision: 99 }]) {
      expect(
        saveAccountProfileSchema.safeParse({ expectedRevision: 0, values: DEFAULT_PROFILE_VALUES, ...addition })
          .success,
      ).toBe(false);
    }
  });
  it("applies saved time zone across midnight and daylight saving and formats an unambiguous ISO date", () => {
    expect(formatAccountDate("2026-10-13T00:30:00Z", { timeZone: "America/Toronto", dateFormat: "iso" })).toBe(
      "2026-10-12",
    );
    expect(formatAccountDate("2026-10-13T00:30:00Z", { timeZone: "Asia/Tokyo", dateFormat: "iso" })).toBe("2026-10-13");
    expect(
      formatAccountDate("2026-12-01T04:30:00Z", { timeZone: "America/Toronto", dateFormat: "friendly" }, "en-US"),
    ).toBe("Nov 30, 2026");
  });
});
