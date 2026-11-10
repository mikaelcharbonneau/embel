import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { applicationRevision, createCoreReadinessReader } from "@/server/runtime/application-health";
import { GET } from "@/app/api/health/route";

const env = {
  NODE_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_health",
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function healthy(databaseStatus = 403) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (url.endsWith("/auth/v1/health")) return Response.json({ name: "GoTrue" });
    if (url.endsWith("/rest/v1/projects?select=id&limit=0"))
      return Response.json(databaseStatus === 200 ? [] : { code: "42501" }, { status: databaseStatus });
    if (url.endsWith("/storage/v1/status")) return new Response("OK");
    throw new Error("unexpected_health_destination");
  });
}
it("keeps liveness independent and does not reflect arbitrary revision/configuration values", async () => {
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "private-value-that-must-not-escape");
  expect(applicationRevision()).toBe("unknown");
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    service: "fluid-web",
    status: "ok",
    release: "unknown",
    readiness: "not_checked",
  });
  expect(applicationRevision({ EMBEL_SOURCE_REVISION: "a".repeat(40) })).toBe("a".repeat(40));
  expect(applicationRevision({ VERCEL_GIT_COMMIT_SHA: "", EMBEL_SOURCE_REVISION: "a".repeat(40) })).toBe(
    "a".repeat(40),
  );
  expect(applicationRevision({ VERCEL_GIT_COMMIT_SHA: "invalid", EMBEL_SOURCE_REVISION: "a".repeat(40) })).toBe(
    "a".repeat(40),
  );
  expect(applicationRevision({ VERCEL_GIT_COMMIT_SHA: "b".repeat(40), EMBEL_SOURCE_REVISION: "a".repeat(40) })).toBe(
    "b".repeat(40),
  );
});
it("fails closed without public configuration and performs no network/provider request", async () => {
  const fetcher = healthy(),
    read = createCoreReadinessReader({ env: {}, fetch: fetcher });
  const result = await read();
  expect(result.status).toBe("unavailable");
  expect(Object.values(result.checks)).toEqual(["not_configured", "not_configured", "not_configured"]);
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.provider).toBe("not_checked");
});
it.each([200, 401, 403])("qualifies only core connectivity from actual responses (database HTTP%s)", async (status) => {
  const fetcher = healthy(status),
    read = createCoreReadinessReader({ env, fetch: fetcher });
  const result = await read();
  expect(result.status).toBe("ready");
  expect(result.scope).toBe("core_connectivity");
  expect(result.checks).toEqual({ auth: "reachable", database: "reachable", storage: "reachable" });
  expect(result).toMatchObject({ workers: "not_checked", provider: "not_checked", enrollment: "not_checked" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("deduplicates simultaneous probes, expires cached observations and invalidates changed configuration", async () => {
  let now = 0;
  const configuration = { ...env },
    fetcher = healthy(),
    read = createCoreReadinessReader({ env: configuration, fetch: fetcher, now: () => now });
  const [first, second] = await Promise.all([read(), read()]);
  expect(first).toEqual(second);
  expect(fetcher).toHaveBeenCalledTimes(3);
  first.checks.auth = "unavailable";
  expect((await read()).checks.auth).toBe("reachable");
  expect(fetcher).toHaveBeenCalledTimes(3);
  now = 2001;
  await read();
  expect(fetcher).toHaveBeenCalledTimes(6);
  configuration.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_other_synthetic_health";
  await read();
  expect(fetcher).toHaveBeenCalledTimes(9);
});
it("accepts Storage's observed empty200 status response without allowing an empty Auth or database response", async () => {
  const base = healthy(),
    storageOnly = vi.fn<typeof fetch>((input, init) =>
      String(input).includes("/storage/")
        ? Promise.resolve(new Response(null, { headers: { "content-length": "0" } }))
        : base(input, init),
    );
  expect((await createCoreReadinessReader({ env, fetch: storageOnly })()).status).toBe("ready");
  const empty = vi.fn<typeof fetch>(async () => new Response(null));
  const result = await createCoreReadinessReader({ env, fetch: empty })();
  expect(result.checks).toEqual({ auth: "unavailable", database: "unavailable", storage: "reachable" });
});
it.each([
  Response.json([{ id: "private-row" }]),
  Response.json({ code: "invalid_api_key" }, { status: 401 }),
  new Response("private-upstream-error", { status: 503 }),
])("does not mistake arbitrary database responses for readiness", async (databaseResponse) => {
  const base = healthy(),
    fetcher = vi.fn<typeof fetch>((input, init) =>
      String(input).includes("/rest/") ? Promise.resolve(databaseResponse.clone()) : base(input, init),
    );
  const result = await createCoreReadinessReader({ env, fetch: fetcher })();
  expect(result.status).toBe("unavailable");
  expect(result.checks.database).toBe("unavailable");
  expect(JSON.stringify(result)).not.toMatch(/private-row|private-upstream-error|invalid_api_key/);
});
it("redacts network errors and cancels oversized upstream bodies", async () => {
  let cancelled = 0;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("/auth/")) throw new Error("secret-shaped diagnostic must never escape");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4097));
        },
        cancel() {
          cancelled++;
        },
      }),
    );
  });
  const result = await createCoreReadinessReader({ env, fetch: fetcher })();
  expect(Object.values(result.checks)).toEqual(["unavailable", "unavailable", "unavailable"]);
  expect(cancelled).toBe(2);
  expect(JSON.stringify(result)).not.toContain("secret-shaped");
});
it("does not treat a generic proxy200 JSON object as Auth service identity", async () => {
  const base = healthy(),
    fetcher = vi.fn<typeof fetch>((input, init) =>
      String(input).includes("/auth/") ? Promise.resolve(Response.json({})) : base(input, init),
    );
  const result = await createCoreReadinessReader({ env, fetch: fetcher })();
  expect(result.status).toBe("unavailable");
  expect(result.checks.auth).toBe("unavailable");
});
it("bounds the health response deadline even if the transport ignores cancellation", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const pending = createCoreReadinessReader({ env, fetch: fetcher })();
  await vi.advanceTimersByTimeAsync(2000);
  expect((await pending).status).toBe("unavailable");
  expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
});
