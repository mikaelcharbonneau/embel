import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createRegistrarCheckContract } from "@/server/standalone-providers/registrar-check";
import { registrarReasons } from "@/server/standalone-providers/contracts";
import { evidenceFreshnessAt } from "@/domain/standalone-provider-evidence";
import { accountId, clock, domain, json, noNetwork, NOW, signal } from "./fixtures";
const eligible = { name: domain, registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57", renewal_cost: "8.57" } };
const envelope = (domains: unknown[] = [eligible]) => ({ success: true, errors: [], messages: [], result: { domains } });
const check = (body: unknown) => createRegistrarCheckContract({ accountId, clock, fetch: async () => json(body) }).check(domain, signal());
beforeEach(noNetwork); afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("registrar eligibility contract", () => {
  it("accepts_exact_eligibility", async () => {
    const adapter = createRegistrarCheckContract({ accountId, clock, fetch: async () => json(envelope()) });
    const result = await adapter.check(domain, signal());
    expect(result).toMatchObject({ status: "observed", target: { tool: "domains", domain }, value: { eligibility: "eligible", reason: "eligible" }, provenance: { providerId: "cloudflare_registrar", adapterVersion: "cloudflare-check-v1", checkedAt: new Date(NOW).toISOString(), freshUntil: new Date(NOW + 60_000).toISOString() } });
    expect(JSON.stringify(result)).not.toContain("pricing"); expect(Object.keys(adapter)).toEqual(["check"]);
  });
  it.each(registrarReasons)("does_not_call_restrictions_taken: %s", async reason => {
    const result = await check(envelope([{ name: domain, registrable: false, reason }]));
    expect(result).toMatchObject({ status: "observed", value: { eligibility: "ineligible", reason } });
    expect(JSON.stringify(result)).not.toContain("taken");
  });
  it("rejects_wrong_missing_duplicate_and_contradictory_results", async () => {
    for (const body of [envelope([{ ...eligible, name: "wrong.test" }]), envelope([{ registrable: true }]), envelope([eligible, eligible]), envelope([]), envelope([{ ...eligible, reason: "domain_premium" }]), envelope([{ name: domain, registrable: false, reason: "novel_reason" }]), envelope([{ name: domain, registrable: false }]), { result: { domains: [eligible] } }, { ...envelope(), success: false }, { ...envelope(), errors: [{ message: "fixture-secret" }] }, { ...envelope(), providerId: "forged" }]) {
      expect(await check(body)).toMatchObject({ status: "failed", code: "invalid_response" });
    }
  });
  it("bounds_freshness_and_cancelled_delivery", async () => {
    const result = await check(envelope());
    expect(result.status).toBe("observed"); if (result.status !== "observed") return;
    expect(evidenceFreshnessAt(result.provenance, NOW + 60_000)).toBe("stale");
    const controller = new AbortController();
    const adapter = createRegistrarCheckContract({ accountId, clock, fetch: async () => { controller.abort(); return json(envelope()); } });
    expect(await adapter.check(domain, controller.signal)).toMatchObject({ code: "cancelled" });
  });
  it("validates_constructor_and_domain_before_dispatch", async () => {
    const fetch = vi.fn(async () => json(envelope()));
    expect(() => createRegistrarCheckContract({ accountId: "private-host", clock, fetch })).toThrow("Invalid registrar configuration");
    expect(() => createRegistrarCheckContract({ accountId, clock: () => NaN, fetch })).toThrow("Invalid provider clock");
    const adapter = createRegistrarCheckContract({ accountId, clock, fetch });
    for (const value of ["https://a.test", "é.test", "xn--abc.test", "a.test/", "a.test:443"]) await expect(adapter.check(value, signal())).rejects.toThrow("Invalid provider target");
    expect(fetch).not.toHaveBeenCalled();
  });
});
