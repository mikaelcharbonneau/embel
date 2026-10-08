import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
import { ApiError, errorResponse, privateJson } from "../../src/server/http/errors";
import { assertMutationOrigin, readJson } from "../../src/server/http/request";
import { getApplicationOrigin, getSupabaseConfiguration } from "../../src/server/config";

const schema = z.strictObject({ title: z.string().max(200) });
const jsonRequest = (body: string, headers: HeadersInit = {}) => new Request("https://fluid.example/api/projects", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
});

describe("server request boundaries", () => {
  it("trusts only the configured exact mutation origin, never Host or Referer", () => {
    const allowed = "https://fluid.example";
    expect(() => assertMutationOrigin(jsonRequest("{}", { origin: allowed }), allowed)).not.toThrow();
    for (const headers of ([{}, { origin: "null" }, { origin: "https://fluid.example.evil.test" }, { host: "fluid.example", referer: allowed }, { origin: allowed, "sec-fetch-site": "cross-site" }] as HeadersInit[])) {
      expect(() => assertMutationOrigin(jsonRequest("{}", headers), allowed)).toThrowError(expect.objectContaining({ code: "forbidden_origin" }));
    }
  });

  it("limits actual bytes even without Content-Length and rejects malformed or extra fields", async () => {
    await expect(readJson(jsonRequest('{"title":"ok"}'), schema, 64)).resolves.toEqual({ title: "ok" });
    await expect(readJson(jsonRequest('{"title":"' + "a".repeat(100) + '"}'), schema, 64)).rejects.toMatchObject({ code: "body_too_large" });
    await expect(readJson(jsonRequest('{"title":"' + "é".repeat(30) + '"}'), schema, 64)).rejects.toMatchObject({ code: "body_too_large" });
    await expect(readJson(jsonRequest('{"title":"x","owner_id":"forged"}'), schema)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(readJson(jsonRequest("{"), schema)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(readJson(jsonRequest("{}", { "content-type": "text/plain" }), schema)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("cancels an oversized stream and does not wait for the rest of the body", async () => {
    const cancel = vi.fn();
    const request = new Request("https://fluid.example", {
      method: "POST", headers: { "content-type": "application/json", "content-length": "1" },
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65)); }, cancel }),
      // Node requires duplex for streamed request bodies.
      duplex: "half",
    } as RequestInit);
    await expect(readJson(request, schema, 64)).rejects.toMatchObject({ code: "body_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("sanitizes unexpected errors and marks responses private/no-store", async () => {
    const response = errorResponse(new Error("secret database password provider token"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/password|token|secret/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(errorResponse(new ApiError("not_found")).status).toBe(404);
    expect(privateJson({ ok: true }).headers.get("vary")).toBe("Cookie");
  });
});

describe("configuration gating", () => {
  it("never accepts absent credentials, secret keys, or insecure production URLs", () => {
    const valid = { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_local_fixture" };
    expect(getSupabaseConfiguration(valid).url).toBe("https://project.supabase.co");
    for (const env of [{}, { ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_not_a_real_key" }, { ...valid, NEXT_PUBLIC_SUPABASE_URL: "https://name:password@project.supabase.co" }, { ...valid, NEXT_PUBLIC_SUPABASE_URL: "http://project.supabase.co" }, { ...valid, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NODE_ENV: "production" }]) {
      expect(() => getSupabaseConfiguration(env)).toThrowError(expect.objectContaining({ code: "integration_unavailable" }));
    }
    expect(getSupabaseConfiguration({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NODE_ENV: "development" }).url).toBe("http://127.0.0.1:54321");
  });

  it("requires a canonical application origin", () => {
    expect(getApplicationOrigin({ APP_ORIGIN: "https://fluid.example" })).toBe("https://fluid.example");
    for (const origin of [undefined, "", "null", "https://fluid.example/path", "https://fluid.example/?evil=1", "http://example.com"]) {
      expect(() => getApplicationOrigin({ APP_ORIGIN: origin })).toThrowError(expect.objectContaining({ code: "integration_unavailable" }));
    }
  });
});
