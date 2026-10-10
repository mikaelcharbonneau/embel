import { describe, expect, it } from "vitest";
import { domainResultsCsv } from "../../../src/features/domain-workspace/result-export";
import { domainFixtures } from "../../../src/features/domain-workspace/fixtures";
const now = Date.parse("2026-10-10T12:00:00Z");
const { check, quote } = domainFixtures(now);
describe("domain CSV evidence", () => {
  it("exports current evidence with an actual annual price", () => {
    expect(domainResultsCsv([{ domain: check.domain, check, quote }], now)).toContain('"northstar.com","Confirmed available","$12.00"\r\n');
  });
  it("keeps unchecked results explicit and omits expired prices", () => {
    expect(domainResultsCsv([{ domain: "unverified.com", check: null, quote: null }], now)).toContain('"unverified.com","Not checked",""');
    const csv = domainResultsCsv([{ domain: check.domain, check, quote }], now + 60_000);
    expect(csv).toContain('"northstar.com","Unknown",""');
    expect(csv).not.toContain("$12.00");
  });
  it("omits mismatched and multi-year prices rather than estimating", () => {
    for (const invalid of [{ ...quote, checkId: "different" }, { ...quote, periodYears: 2 }]) {
      expect(domainResultsCsv([{ domain: check.domain, check, quote: invalid }], now)).not.toContain("$12.00");
    }
  });
});
