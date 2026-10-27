import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), availability: vi.fn(), latest: vi.fn(), enqueue: vi.fn(), batch: vi.fn(), lookup: vi.fn(), cancel: vi.fn(), close: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("@/server/data/identity-jobs", () => ({ getIdentityAvailability: mocks.availability, getLatestIdentityBatch: mocks.latest, enqueueIdentityBatch: mocks.enqueue,
  getIdentityBatch: mocks.batch, readIdentityBatchRequest: mocks.lookup, cancelIdentityBatch: mocks.cancel, closeIdentityBatchRequest: mocks.close }));
import { GET as overview, POST } from "@/app/api/projects/[projectId]/identity/batches/route";
import { GET as read } from "@/app/api/projects/[projectId]/identity/batches/[batchId]/route";
import { GET as lookup } from "@/app/api/projects/[projectId]/identity/batches/requests/[requestKey]/route";
import { POST as stop } from "@/app/api/projects/[projectId]/identity/batches/[batchId]/cancel/route";
import { POST as close } from "@/app/api/projects/[projectId]/identity/batches/requests/[requestKey]/cancel/route";
import { ApiError } from "@/server/http/errors";
import { IMAGE_MODEL } from "@/domain/providers";
import { batchState, generationIntent, ownerId, projectId, batchId } from "../worker/identity-generation-fixture";
const context = { params: Promise.resolve({ projectId, batchId, requestKey: generationIntent.idempotencyKey }) };
function request(suffix = "", body?: unknown, query = "") { return new Request(`https://fixture.test/api/projects/${projectId}/identity/batches${suffix}${query}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "https://fixture.test", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fixture.test"); mocks.auth.mockResolvedValue({ userId: ownerId });
  mocks.availability.mockResolvedValue({ ownerId, projectId, operation: "identity.image", requestedModel: IMAGE_MODEL, status: "unavailable", reason: "runtime_unavailable" });
  mocks.latest.mockResolvedValue(batchState()); mocks.enqueue.mockResolvedValue(batchState()); mocks.batch.mockResolvedValue(batchState()); mocks.lookup.mockResolvedValue(null); mocks.cancel.mockResolvedValue({ ...batchState(), status: "cancel_requested" });
  mocks.close.mockResolvedValue({ status: "not_admitted", ownerId, projectId, intent: generationIntent });
});
afterEach(() => { vi.unstubAllEnvs(); });
describe("Identity read/admit/recovery/Stop HTTP routes", () => {
  it("returns the durable request while new generation is unavailable, without writing", async () => {
    const response = await overview(request(), context); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ latest: { batchId }, availability: { status: "unavailable" } }); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("explicitly admits the exact uncapped four-head request", async () => {
    expect((await POST(request("", generationIntent), context)).status).toBe(201);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({ userId: ownerId }, projectId, generationIntent);
  });
  it("keeps original-key lookup read-only, including honest not-found", async () => {
    expect(await (await lookup(request(), context)).json()).toEqual({ status: "not_found" });
    mocks.lookup.mockResolvedValue(batchState()); expect(await (await lookup(request(), context)).json()).toMatchObject({ status: "found", batch: { batchId } });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("reads status and returns Stop's actual pending state", async () => {
    expect((await read(request(), context)).status).toBe(200);
    expect(await (await stop(request("/cancel", {}), context)).json()).toMatchObject({ status: "cancel_requested", terminal: false });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({ userId: ownerId }, projectId, batchId);
  });
  it("returns404 for a missing owned batch without fabricating an empty result", async () => { mocks.batch.mockResolvedValue(null); expect((await read(request(), context)).status).toBe(404); });
  it("rejects additional query authority on every read and mutation", async () => {
    for (const handler of [overview, read, lookup]) expect((await handler(request("", undefined, "?owner=foreign"), context)).status).toBe(422);
    expect((await POST(request("", generationIntent, "?owner=foreign"), context)).status).toBe(422);
    expect((await stop(request("", {}, "?owner=foreign"), context)).status).toBe(422); expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("cannot smuggle owner/model/output/cost fields into uncapped admission or Stop", async () => {
    for (const extra of [{ ownerId }, { model: "fake" }, { systems: [] }, { acceptedMaxCostMicrousd: 0 }]) expect((await POST(request("", { ...generationIntent, ...extra }), context)).status).toBe(422);
    expect((await stop(request("", { ownerId }), context)).status).toBe(422); expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("requires authentication and origin, and sanitizes uncertain infrastructure errors", async () => {
    mocks.auth.mockRejectedValueOnce(new ApiError("unauthenticated")); expect((await overview(request(), context)).status).toBe(401);
    const foreign = new Request(`https://fixture.test/api/projects/${projectId}/identity/batches`, { method: "POST", headers: { origin: "https://foreign.test" }, body: "{}" });
    expect((await POST(foreign, context)).status).toBe(403);
    mocks.enqueue.mockRejectedValue(new ApiError("integration_unavailable")); const response = await POST(request("", generationIntent), context); expect(response.status).toBe(503); expect(await response.text()).not.toContain("stack");
  });
  it("closes only the exact original key and v2 intent, and returns the authoritative witness without re-admission", async () => {
    expect(await (await close(request("", generationIntent), context)).json()).toEqual({ status: "not_admitted", ownerId, projectId, intent: generationIntent });
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith({ userId: ownerId }, projectId, generationIntent); expect(mocks.enqueue).not.toHaveBeenCalled();
    expect((await close(request("", { ...generationIntent, idempotencyKey: "different-original-key" }), context)).status).toBe(422);
    expect((await close(request("", { ...generationIntent, ownerId }), context)).status).toBe(422);
    expect((await close(request("", generationIntent, "?owner=foreign"), context)).status).toBe(422); expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("never converts a lost close acknowledgment into not-admitted or stopped", async () => {
    mocks.close.mockRejectedValue(new ApiError("integration_unavailable")); const response = await close(request("", generationIntent), context);
    expect(response.status).toBe(503); expect(await response.json()).not.toHaveProperty("status", "not_admitted"); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
