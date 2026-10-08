import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: vi.fn(async () => "synthetic-fixture-token") }));
import { publishApiTextDispatch } from "../../src/server/api-text/publication";
import { getVercelOidcToken } from "@vercel/oidc";
const message = { version: 1, jobId: "10000000-0000-4000-8000-000000000001", policyIdentity: "a".repeat(64), deploymentId: "dpl_qualified", dispatchIdentity: "b".repeat(64) } as const;
function setup() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt");
  vi.stubEnv("FLUID_API_TEXT_WORKER_ORIGIN", "https://fluid-api-text-worker-qualified.vercel.app");
  const fetch = vi.fn(async () => Response.json({ state: "published", messageId: "message-confirmed" }));
  vi.stubGlobal("fetch", fetch); return fetch;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("web publication transport", () => {
  it("sends only the admitted descriptor to fixed protected worker with request-context OIDC", async () => {
    const fetch = setup();
    expect(await publishApiTextDispatch(message)).toEqual({ state: "published", messageId: "message-confirmed" });
    const [url, request] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://fluid-api-text-worker-qualified.vercel.app/api/enqueue");
    expect(JSON.parse(request.body as string)).toEqual(message);
    expect(request.redirect).toBe("error");
    expect(request.headers).toMatchObject({ authorization: "Bearer synthetic-fixture-token", "x-vercel-trusted-oidc-idp-token": "synthetic-fixture-token" });
  });
  it.each(["http://worker.vercel.app", "https://evil.example", "https://worker.vercel.app/path", "https://worker.vercel.app?token=secret", "https://user:pass@worker.vercel.app"])("fails closed for unsafe origin %s", async origin => {
    const fetch = setup(); vi.stubEnv("FLUID_API_TEXT_WORKER_ORIGIN", origin);
    expect(await publishApiTextDispatch(message)).toEqual({ state: "dispatch_pending" }); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not publish from wrong project/environment or with extra payload fields", async () => {
    const fetch = setup(); vi.stubEnv("VERCEL_ENV", "production");
    expect(await publishApiTextDispatch(message)).toEqual({ state: "dispatch_pending" });
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("VERCEL_PROJECT_ID", "wrong");
    expect(await publishApiTextDispatch(message)).toEqual({ state: "dispatch_pending" });
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt");
    expect(await publishApiTextDispatch({ ...message, prompt: "must not be transmitted" })).toEqual({ state: "dispatch_pending" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains pending on auth/network/response errors rather than losing durable admission", async () => {
    const fetch = setup(); fetch.mockRejectedValueOnce(new Error("unavailable"));
    expect(await publishApiTextDispatch(message)).toEqual({ state: "dispatch_pending" });
    fetch.mockResolvedValueOnce(new Response("login", { status: 401 }));
    expect(await publishApiTextDispatch(message)).toEqual({ state: "dispatch_pending" });
    fetch.mockResolvedValueOnce(Response.json({ state: "published" }));
    expect(await publishApiTextDispatch(message)).toEqual({ state: "dispatch_pending" });
    vi.mocked(getVercelOidcToken).mockRejectedValueOnce(new Error("missing token"));
    expect(await publishApiTextDispatch(message)).toEqual({ state: "dispatch_pending" });
  });
  it("bounds request-context token retrieval as part of the whole publication deadline", async () => {
    vi.useFakeTimers(); setup();
    vi.mocked(getVercelOidcToken).mockImplementationOnce(() => new Promise(() => {}));
    let result: unknown;
    void publishApiTextDispatch(message).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(12_001);
    expect(result).toEqual({ state: "dispatch_pending" });
    vi.useRealTimers();
  });
});
