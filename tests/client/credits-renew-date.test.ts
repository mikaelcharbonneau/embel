import { afterEach, expect, it } from "vitest";
import { nextCreditsDate } from "@/components/billing/use-billing-summary";
import { creditsMessage, creditsRenewDate } from "@/components/workspace/credits-message";
import type { BillingSummary } from "@/domain/billing";

const zone = process.env.TZ;
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

it("names the same renewal day in the account menu, Plans and the out-of-credits message, in any time zone", () => {
  // A credit period ends at midnight UTC. West of UTC that instant is still the previous evening locally, which is
  // where "December 1" in one place and "November 30" in another came from.
  process.env.TZ = "America/Los_Angeles";
  const periodEnd = "2026-12-01T00:00:00.000Z";
  expect(creditsRenewDate(periodEnd)).toBe("December 1");
  expect(nextCreditsDate({ periodEnd } as BillingSummary)).toBe("December 1");
  expect(creditsMessage(periodEnd, "Your logos are saved.")).toBe(
    "You've used this month's credits. They renew on December 1. Your logos are saved.",
  );
  expect(creditsRenewDate("not a date")).toBeNull();
  expect(creditsRenewDate(null)).toBeNull();
});
