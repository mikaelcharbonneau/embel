import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
import { proxy } from "../../src/proxy";

const canonical = "https://fluid-platform-preview.vercel.app";
const deployment = "https://fluid-platform-preview-dx97q59gi-embel.vercel.app";

beforeEach(() => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VERCEL_URL", new URL(deployment).hostname);
  vi.stubEnv("APP_ORIGIN", canonical);
});
afterEach(() => vi.unstubAllEnvs());

describe("production authentication page navigation", () => {
  it.each(["/sign-in", "/sign-up"])("moves %s to the canonical site before credentials are entered", path => {
    const response = proxy(new NextRequest(`${deployment}${path}`));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${canonical}${path}#`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("preserves confirmation status without forwarding arbitrary queries or fragments", () => {
    const response = proxy(new NextRequest(`${deployment}/sign-in?confirmation=complete&next=https://other.invalid&code=do-not-forward#secret`));
    expect(response.headers.get("location")).toBe(`${canonical}/sign-in?confirmation=complete#`);
  });

  it.each(["/?confirmation=complete", "/brands", "/auth/callback?code=fixture", "/api/auth/sign-in"])("leaves existing draft pages and API/callback handling at %s intact", path => {
    expect(proxy(new NextRequest(`${deployment}${path}`)).headers.get("location")).toBeNull();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("never redirects or replays %s request bodies", method => {
    expect(proxy(new NextRequest(`${deployment}/sign-in`, { method, body: "inert fixture" })).headers.get("location")).toBeNull();
  });

  it("does not redirect the canonical site or trust forwarded hosts for its destination", () => {
    expect(proxy(new NextRequest(`${canonical}/sign-in`)).headers.get("location")).toBeNull();
    const response = proxy(new NextRequest(`${deployment}/sign-in`, { headers: { host: "other.invalid", "x-forwarded-host": "other.invalid" } }));
    expect(response.headers.get("location")).toBe(`${canonical}/sign-in#`);
  });

  it.each(["preview", "development"])("preserves %s authentication on its own origin", environment => {
    vi.stubEnv("VERCEL_ENV", environment);
    expect(proxy(new NextRequest(`${deployment}/sign-in`)).headers.get("location")).toBeNull();
  });

  it("never redirects to invalid configuration", () => {
    vi.stubEnv("APP_ORIGIN", "https://user:secret@other.invalid");
    expect(proxy(new NextRequest(`${deployment}/sign-in`)).headers.get("location")).toBeNull();
  });
});
