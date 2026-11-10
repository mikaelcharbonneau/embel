import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { ApiError, errorResponse, logServerError } from "../../src/server/http/errors";
import { onRequestError } from "../../src/instrumentation";

const secret = "private reset-fixture@example.invalid sb_secret_fixture token=abc123";
let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("server error logging", () => {
  it("logs an unexpected error's type, code and locations, never its message", async () => {
    const error = Object.assign(new TypeError(secret), { code: "23505" });
    const response = errorResponse(error);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("private");
    expect(lines[0]).not.toContain("example.invalid");
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ event: "api_unexpected_error", name: "TypeError", code: "23505" });
    expect(entry.frames.length).toBeGreaterThan(0);
    for (const frame of entry.frames) expect(frame.startsWith("at ")).toBe(true);
  });
  it("logs server-side API failures but not the person's own mistakes", () => {
    errorResponse(new ApiError("integration_unavailable"));
    errorResponse(new ApiError("invalid_input"));
    errorResponse(new ApiError("unauthenticated"));
    errorResponse(new ApiError("auth_rate_limited"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "api_server_error", code: "integration_unavailable" });
  });
  it("drops codes that could carry free text and survives a broken logger", () => {
    logServerError("check", Object.assign(new Error(secret), { code: "has spaces and private text" }));
    expect(JSON.parse(lines[0]!).code).toBeUndefined();
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error("logger outage");
    });
    expect(errorResponse(new Error(secret)).status).toBe(500);
  });
  it("logs a rendering error by route pattern, never the real path or headers", async () => {
    await onRequestError(
      Object.assign(new Error(secret), { digest: "123456" }),
      { path: "/auth/callback?code=private-one-time-code", method: "GET", headers: { cookie: "sb-private-cookie" } },
      {
        routerKind: "App Router",
        routePath: "/auth/callback",
        routeType: "route",
        renderSource: undefined,
        revalidateReason: undefined,
      } as never,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("private");
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "request_error",
      routePath: "/auth/callback",
      routeType: "route",
      method: "GET",
      digest: "123456",
    });
  });
});
