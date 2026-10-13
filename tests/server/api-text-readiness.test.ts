import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: vi.fn(async () => "synthetic-fixture-token") }));
import { getVercelOidcToken } from "@vercel/oidc";
import { getApiTextWorkerReadiness } from "../../src/server/api-text/readiness";
import { handleApiTextReadiness, readApiTextWorkerReadiness } from "../../worker/hosting/readiness";
import { strategyPolicy } from "../../src/server/ai/config";

const ready = { version: 1, deploymentId: "dpl_qualified", operations: ["strategy.reformulate"] };
function setup(environment = "production") {
  vi.stubEnv("VERCEL_ENV", environment); vi.stubEnv("VERCEL_TARGET_ENV", environment);
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt");
  vi.stubEnv("FLUID_API_TEXT_WORKER_ORIGIN", "https://fluid-api-text-worker-qualified.vercel.app");
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(ready));
  vi.stubGlobal("fetch", fetch); return fetch;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("web non-dispatch worker readiness", () => {
  it.each(["production", "preview"])("uses the existing exact %s publisher configuration and body-free protected GET", async environment => {
    const fetch = setup(environment);
    expect(await getApiTextWorkerReadiness()).toEqual(ready);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://fluid-api-text-worker-qualified.vercel.app/api/readiness");
    expect(request).toMatchObject({ method: "GET", cache: "no-store", redirect: "error",
      headers: { authorization: "Bearer synthetic-fixture-token", "x-vercel-trusted-oidc-idp-token": "synthetic-fixture-token" } });
    expect(request).not.toHaveProperty("body");
  });
  it("composes with the real worker inspection over the existing narrow database approval function", async () => {
    const fetch = setup();
    const query = vi.fn(async () => ({ rows: [{ operation: "strategy.reformulate", ready: true }] }));
    fetch.mockImplementation(async (url, request) => handleApiTextReadiness(new Request(url, request), {
      verify: async authorization => { if (authorization !== "Bearer synthetic-fixture-token") throw new Error("Unauthorized"); },
      inspect: signal => readApiTextWorkerReadiness({ deploymentId: "dpl_qualified", signal,
        configuration: { apiKey: "synthetic-never-used", policies: new Map([["strategy.reformulate", strategyPolicy("strategy.reformulate")]]) },
        database: () => ({ query }) }),
    }));
    expect(await getApiTextWorkerReadiness()).toEqual(ready);
    expect(fetch).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["FLUID_API_TEXT_WORKER_ORIGIN", undefined], ["FLUID_API_TEXT_WORKER_ORIGIN", "https://untrusted.example"],
    ["VERCEL_ENV", "development"], ["VERCEL_TARGET_ENV", "preview"], ["VERCEL_PROJECT_ID", "another-project"],
  ])("does not obtain or send a token when %s is unqualified (%#)", async (key, value) => {
    const fetch = setup(); vi.stubEnv(key!, value);
    expect(await getApiTextWorkerReadiness()).toBeNull();
    expect(getVercelOidcToken).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("distinguishes a reachable worker with no approved operations from unreachable protection", async () => {
    const fetch = setup(); fetch.mockResolvedValueOnce(Response.json({ ...ready, operations: [] }));
    expect(await getApiTextWorkerReadiness()).toEqual({ ...ready, operations: [] });
    fetch.mockResolvedValueOnce(new Response("sign-in", { status: 401 }));
    expect(await getApiTextWorkerReadiness()).toBeNull();
    fetch.mockRejectedValueOnce(new Error("redirect refused"));
    expect(await getApiTextWorkerReadiness()).toBeNull();
  });
  it.each([
    { ...ready, deploymentId: "alias" }, { ...ready, operations: ["strategy.competitors"] },
    { ...ready, operations: ["naming.generate"] }, { ...ready, operations: ["strategy.reformulate", "strategy.reformulate"] },
    { ...ready, ownerId: "unexpected-private-data" }, { ...ready, version: 2 },
  ])("rejects a malformed or expanded readiness contract (%#)", async value => {
    const fetch = setup(); fetch.mockResolvedValue(Response.json(value));
    expect(await getApiTextWorkerReadiness()).toBeNull();
  });
  it("rejects oversized and invalid UTF-8 replies", async () => {
    const fetch = setup(); fetch.mockResolvedValueOnce(new Response(" ".repeat(1_025)));
    expect(await getApiTextWorkerReadiness()).toBeNull();
    fetch.mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28])));
    expect(await getApiTextWorkerReadiness()).toBeNull();
  });
  it("bounds token retrieval and never starts a late network request", async () => {
    vi.useFakeTimers(); const fetch = setup(); let release: ((token: string) => void) | undefined;
    vi.mocked(getVercelOidcToken).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const work = getApiTextWorkerReadiness(); await vi.advanceTimersByTimeAsync(12_001);
    expect(await work).toBeNull(); release?.("synthetic-late-token");
    await vi.advanceTimersByTimeAsync(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds a stalled response stream and aborts its network request", async () => {
    vi.useFakeTimers(); const fetch = setup(); fetch.mockResolvedValue(new Response(new ReadableStream()));
    const work = getApiTextWorkerReadiness(); await vi.advanceTimersByTimeAsync(12_001);
    expect(await work).toBeNull(); expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
