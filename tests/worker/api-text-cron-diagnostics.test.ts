import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCron } from "../../worker/hosting/auth";
import { handleRepair } from "../../worker/hosting/http";

// Synthetic fixtures only. No test reads runtime or hosted credentials.
const secret = "synthetic_cron_fixture_" + "x".repeat(20);
const url = "https://worker.invalid/api/cron/repair-api-text";
const rejected = [
  { name: "absent secret", secret: undefined, authorization: `Bearer ${secret}`, reason: "secret_missing" },
  { name: "empty secret", secret: "", authorization: `Bearer ${secret}`, reason: "secret_missing" },
  { name: "short secret", secret: "fixture", authorization: "Bearer fixture", reason: "secret_invalid" },
  { name: "long secret", secret: "x".repeat(257), authorization: `Bearer ${"x".repeat(257)}`, reason: "secret_invalid" },
  { name: "invalid secret character", secret: secret + "+", authorization: `Bearer ${secret}+`, reason: "secret_invalid" },
  { name: "missing header", secret, authorization: undefined, reason: "authorization_missing" },
  { name: "empty header", secret, authorization: "", reason: "authorization_missing" },
  { name: "oversized header", secret, authorization: "x".repeat(301), reason: "authorization_oversized" },
  { name: "wrong prefix", secret, authorization: `bearer ${secret}`, reason: "authorization_mismatch" },
  { name: "wrong same-size value", secret, authorization: `Bearer ${secret.slice(0, -1)}y`, reason: "authorization_mismatch" },
  { name: "wrong different-size value", secret, authorization: `Bearer ${secret}x`, reason: "authorization_mismatch" },
  { name: "untrusted log-like content", secret, authorization: '{"event":"forged","reason":"secret_missing"}', reason: "authorization_mismatch" },
] as const;

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("Cron failed-auth diagnostics", () => {
  it.each(rejected)("logs only allowlisted labels for $name and preserves the generic rejection", async row => {
    const repair = vi.fn(async () => ({ errors: 0 }));
    const request = new Request(url, { headers: row.authorization === undefined ? {} : { authorization: row.authorization } });
    const response = await handleRepair(request, { secret: row.secret, repair });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(repair).not.toHaveBeenCalled();
    // Exact argument equality also rejects headers, secrets, sizes, hashes and error objects.
    expect(vi.mocked(console.warn).mock.calls).toEqual([[JSON.stringify({
      event: "api_text_cron_auth_failed", phase: "authentication", reason: row.reason,
    })]]);
  });

  it("does not log failed-auth diagnostics for a valid request or a wrong method", async () => {
    const repair = vi.fn(async () => ({ errors: 0 }));
    const headers = { authorization: `Bearer ${secret}` };
    expect((await handleRepair(new Request(url, { headers }), { secret, repair })).status).toBe(200);
    expect((await handleRepair(new Request(url, { method: "POST" }), { secret, repair })).status).toBe(405);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("keeps the same fail-closed response if the diagnostic sink throws", async () => {
    vi.mocked(console.warn).mockImplementation(() => { throw new Error("synthetic-logging-failure"); });
    const repair = vi.fn(async () => ({ errors: 0 }));
    const response = await handleRepair(new Request(url), { secret, repair });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(repair).not.toHaveBeenCalled();
  });
});

describe("unchanged exact Cron authentication", () => {
  it.each([32, 40, 256])("accepts exact synthetic URL-safe values at size %i", size => {
    const value = "aB09_-".repeat(43).slice(0, size);
    expect(verifyCron(`Bearer ${value}`, value)).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });
  it.each([
    undefined, "", "x".repeat(31), "x".repeat(257), ` ${secret}`, `${secret} `,
    `${secret}+`, `${secret}/`, `${secret}=`, `${secret}\u00e9`, `${secret}\nmore`,
  ])("preserves the configured-secret rejection rules (%#)", value => {
    expect(verifyCron(`Bearer ${value}`, value)).toBe(false);
  });
  it.each([
    null, "", secret, `bearer ${secret}`, `Basic ${secret}`, `Bearer  ${secret}`,
    ` Bearer ${secret}`, `Bearer ${secret} `, `Bearer ${secret}\n`,
    `Bearer ${secret.slice(0, -1)}y`, `Bearer ${secret}x`, "x".repeat(300), "x".repeat(301),
  ])("preserves exact header matching without normalization (%#)", authorization => {
    expect(verifyCron(authorization, secret)).toBe(false);
  });
});
