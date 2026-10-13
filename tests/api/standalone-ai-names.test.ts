import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mock.auth }));
import { GET, POST } from "../../src/app/api/names/ai/route";
import { GET as jobGet, POST as cancel, PATCH as retain } from "../../src/app/api/names/ai/[jobId]/route";
import { ApiError } from "../../src/server/http/errors";
import { intent, jobFixture, jobId, other, owner } from "../fixtures/standalone-names";
const context = { params: Promise.resolve({ jobId }) };
function request(body?: unknown, method = "POST", origin = "http://127.0.0.1:3106") {
  return new Request("http://127.0.0.1:3106/api/names/ai", { method, headers: { origin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3106"); vi.stubEnv("FLUID_RUNTIME", "local"); vi.stubEnv("VERCEL", "");
  mock.auth.mockResolvedValue({ userId: owner, client: { rpc: mock.rpc } });
  mock.rpc.mockResolvedValue({ data: { job: jobFixture() }, error: null });
});
afterEach(() => vi.unstubAllEnvs());
describe("standalone naming authenticated APIs", () => {
  it("enqueues only a durable strict intent and never a client owner or project", async () => {
    const result = await POST(request(intent)); expect(result.status).toBe(202);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("enqueue_standalone_names", { p_input: intent });
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect((await POST(request({ ...intent, ownerId: other }))).status).toBe(422);
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });
  it("returns honest unapplied setup and distinguishes a database outage", async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    expect(await (await GET(request(undefined, "GET"))).json()).toMatchObject({ ownerId: owner, availability: { status: "unavailable", reason: "setup_required" } });
    mock.rpc.mockResolvedValue({ data: null, error: { code: "ECONNRESET" } });
    expect((await GET(request(undefined, "GET"))).status).toBe(503);
  });
  it("requires the supported local runtime for admission even with a hosted authenticated account", async () => {
    vi.stubEnv("VERCEL", "1"); expect((await POST(request(intent))).status).toBe(503); expect(mock.rpc).not.toHaveBeenCalled();
    mock.rpc.mockResolvedValue({ data: { ownerId: owner, availability: { status: "unavailable", reason: "setup_required" }, jobs: [], hasMore: false }, error: null });
    expect(await (await GET(request(undefined, "GET"))).json()).toMatchObject({ availability: { reason: "local_runtime_required" } });
  });
  it("enforces auth, origin, bytes and ownership on read and writes", async () => {
    mock.auth.mockRejectedValueOnce(new ApiError("unauthenticated")); expect((await GET(request(undefined, "GET"))).status).toBe(401);
    expect((await POST(request(intent, "POST", "https://hostile.example"))).status).toBe(403);
    expect((await POST(request({ ...intent, brief: { ...intent.brief, description: "x".repeat(25000) } }))).status).toBe(413);
    mock.rpc.mockResolvedValue({ data: { job: { ...jobFixture(), ownerId: other } }, error: null }); expect((await jobGet(request(undefined, "GET"), context)).status).toBe(404);
    expect((await retain(request({ candidateIndex: 0, liked: true, saved: false }, "PATCH"), context)).status).toBe(404);
  });
  it("cancels one owned job and uses explicit idempotent retention values", async () => {
    expect((await cancel(request({ action: "cancel" }), context)).status).toBe(200);
    expect(mock.rpc).toHaveBeenLastCalledWith("cancel_standalone_names", { p_job: jobId });
    mock.rpc.mockResolvedValue({ data: { job: { ...jobFixture("succeeded"), likedIndexes: [0] } }, error: null });
    expect((await retain(request({ candidateIndex: 0, liked: true, saved: false }, "PATCH"), context)).status).toBe(200);
    expect(mock.rpc).toHaveBeenLastCalledWith("retain_standalone_name", { p_job: jobId, p_index: 0, p_liked: true, p_saved: false });
  });
});
