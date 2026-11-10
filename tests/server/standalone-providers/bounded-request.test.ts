import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
import { requestProviderJson } from "@/server/standalone-providers/bounded-request";
import {
  socialProfileObservationSchema,
  trademarkResearchSchema,
  type ProviderRequest,
} from "@/server/standalone-providers/contracts";
import { accountId, clock, domain, json, noNetwork, NOW, signal } from "./fixtures";

const input: ProviderRequest = { endpoint: "cloudflare_check", accountId, domain };
beforeEach(noNetwork);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded injected request", () => {
  it("builds_only_allowlisted_check_requests", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return json({ ok: true }, 200, { "cf-ray": "abc123-TEST", "x-request-id": "fixture-secret" });
    });
    const result = await requestProviderJson(input, { fetch, clock }, signal());
    const request = requests[0]!;
    expect(request.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/registrar/domain-check`);
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({ domains: [domain] });
    expect(request.redirect).toBe("error");
    expect(request.cache).toBe("no-store");
    expect(request.credentials).toBe("omit");
    expect(request.headers.has("authorization")).toBe(false);
    expect(result).toMatchObject({
      status: "ok",
      providerRequestId: "abc123-TEST",
      responseSha256: createHash("sha256").update('{"ok":true}').digest("hex"),
    });
    await requestProviderJson({ endpoint: "youtube_channels", handle: "test.handle_1" }, { fetch, clock }, signal());
    expect(requests[1]!.url).toBe("https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=test.handle_1");
    expect(requests[1]!.method).toBe("GET");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([262_144, 262_145])("bounds_streams_without_content_length (%i bytes)", async (size) => {
    const bytes = new TextEncoder().encode(`"${"a".repeat(size - 2)}"`);
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 10));
              controller.enqueue(bytes.slice(10));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json", "content-length": "2" } },
        ),
    );
    const result = await requestProviderJson(input, { fetch, clock }, signal());
    expect(result.status).toBe(size === 262_144 ? "ok" : "failed");
    if (size > 262_144) expect(result).toMatchObject({ code: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("settles_ignored_abort", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const pending = requestProviderJson(input, { fetch, clock: Date.now }, signal());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ status: "failed", code: "timeout" });
    expect(fetch.mock.calls).toHaveLength(1);
    resolve(json({ late: true }));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts_hanging_body_and_releases_reader", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel: cancelled,
    });
    const controller = new AbortController();
    const pending = requestProviderJson(
      input,
      { fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }), clock: Date.now },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does_not_dispatch_when_aborted_before_the_scheduled_transport", async () => {
    const controller = new AbortController(),
      fetch = vi.fn(async () => json({}));
    const pending = requestProviderJson(input, { fetch, clock }, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ code: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("times_out_body_not_only_dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const body = new ReadableStream<Uint8Array>();
    const pending = requestProviderJson(
      input,
      { fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }), clock: Date.now },
      signal(),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ code: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects_redirects_and_private_targets", async () => {
    const fetch = vi.fn(async () => json({}));
    for (const invalid of [
      { ...input, url: "https://127.0.0.1/" },
      { endpoint: "https://127.0.0.1/" },
      { ...input, accountId: "../secret" },
      { ...input, domain: "https://example.test" },
    ]) {
      await expect(requestProviderJson(invalid as ProviderRequest, { fetch, clock }, signal())).rejects.toThrow(
        "Invalid provider request",
      );
    }
    const controller = new AbortController();
    controller.abort();
    expect(await requestProviderJson(input, { fetch, clock }, controller.signal)).toMatchObject({ code: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await requestProviderJson(
        input,
        { fetch: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }), clock },
        signal(),
      ),
    ).toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [401, "not_authorized"],
    [403, "not_authorized"],
    [429, "rate_limited"],
    [500, "transport"],
    [404, "invalid_response"],
  ])("redacts_provider_errors (%i)", async (status, code) => {
    const result = await requestProviderJson(
      input,
      {
        fetch: async () =>
          json({ error: "fixture-secret" }, status as number, {
            "retry-after": "9999999",
            authorization: "fixture-secret",
          }),
        clock,
      },
      signal(),
    );
    expect(result).toMatchObject({ status: "failed", code, retryAfterSeconds: status === 429 ? 86_400 : null });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("keeps_fetch_rejected_redirects_generic_and_sanitized", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.redirect).toBe("error");
      throw new TypeError("redirect blocked fixture-secret");
    });
    const result = await requestProviderJson(input, { fetch, clock }, signal());
    expect(result).toMatchObject({ status: "failed", code: "transport" });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects_html_invalid_json_utf8_and_noninteger_retry_after", async () => {
    for (const response of [
      new Response("<h1>login</h1>", { headers: { "content-type": "text/html" } }),
      new Response("{bad", { headers: { "content-type": "application/json" } }),
      new Response(new Uint8Array([34, 255, 34]), { headers: { "content-type": "application/json" } }),
    ]) {
      expect(await requestProviderJson(input, { fetch: async () => response, clock }, signal())).toMatchObject({
        code: "invalid_response",
      });
    }
    expect(
      await requestProviderJson(
        input,
        { fetch: async () => json({}, 429, { "retry-after": "tomorrow" }), clock },
        signal(),
      ),
    ).toMatchObject({ code: "rate_limited", retryAfterSeconds: null });
    expect(
      await requestProviderJson(
        input,
        {
          fetch: async () => {
            throw new Error("fixture-secret");
          },
          clock,
        },
        signal(),
      ),
    ).toMatchObject({ code: "transport" });
  });

  it("rejects_invalid_clocks_without_a_request_or_synthetic_timestamp", async () => {
    const fetch = vi.fn(async () => json({}));
    for (const value of [NaN, Infinity, 1e20, 253_402_300_800_000])
      await expect(requestProviderJson(input, { fetch, clock: () => value }, signal())).rejects.toThrow(
        "Invalid provider clock",
      );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects_feature_claim_upgrades", () => {
    expect(
      socialProfileObservationSchema.safeParse({
        profile: "not_found",
        profileId: null,
        availability: "available",
        reservation: "unverified",
        ownership: "unverified",
      }).success,
    ).toBe(false);
    expect(trademarkResearchSchema.safeParse({ legalClearance: "clear" }).success).toBe(false);
  });
});
