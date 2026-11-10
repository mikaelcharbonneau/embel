import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ createClient: vi.fn() }));
// Keep real getAuthenticatedContext, all route validation, services and adapters.
// Only the external cookie/account client is substituted by a local port.
vi.mock("@/server/auth/client", () => ({ createRouteAuthClient: f.createClient }));
import { pathFor, type LogoHttpFixture } from "../../fixtures/logo-http-runtime";
import type { LogoRequestServiceResolver } from "@/server/runtime/logo-request-services";
const logoHttpFixture = async (...args: Parameters<typeof import("../../fixtures/logo-http-runtime")["logoHttpFixture"]>) => (await import("../../fixtures/logo-http-runtime")).logoHttpFixture(...args);
const runtime = () => import("@/server/runtime/logo-request-services");
const uploadRoute = () => import("@/app/api/projects/[projectId]/logo/references/uploads/route");
const vectorRoute = () => import("@/app/api/projects/[projectId]/logo/vector/revisions/[vectorRevisionId]/route");
const approvalRoute = () => import("@/app/api/projects/[projectId]/logo/directions/approval/route");
const context = (fixture: LogoHttpFixture) => ({ params: Promise.resolve({ projectId: fixture.projectId, vectorRevisionId: fixture.revision.id }) });
const json = (body: unknown, signal?: AbortSignal) => new Request("https://fluid.invalid/api/logo", { method: "POST", headers: { origin: "https://fluid.invalid", "content-type": "application/json" }, body: JSON.stringify(body), signal });
function upload(fixture: LogoHttpFixture) {
  const form = new FormData(); form.set("input", JSON.stringify(fixture.upload)); form.set("file", new File([Uint8Array.from(fixture.raster.bytes)], "synthetic.png", { type: "image/png" }));
  return new Request("https://fluid.invalid/api/logo", { method: "POST", headers: { origin: "https://fluid.invalid" }, body: form });
}
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
async function configure(fixture: LogoHttpFixture, custom?: LogoRequestServiceResolver) {
  f.createClient.mockResolvedValue(fixture.client);
  const resolve = vi.fn(custom ?? (async (auth, projectId) => ({ ownerId: auth.userId, projectId, dependencies: fixture.dependencies })));
  (await runtime()).configureLogoRequestServices(resolve); return resolve;
}
beforeEach(() => { Reflect.deleteProperty(globalThis, Symbol.for("fluid.logo.request-services.v1")); vi.resetModules(); vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.invalid"); });
afterEach(() => vi.unstubAllEnvs());

describe("actual HTTP logo consumers with a trusted synthetic bootstrap", () => {
  it("keeps upload and verified vector reads unavailable without installation", async () => {
    const fixture = await logoHttpFixture(); f.createClient.mockResolvedValue(fixture.client);
    for (const response of [await (await uploadRoute()).POST(upload(fixture), context(fixture)), await (await vectorRoute()).GET(new Request("https://fluid.invalid/api"), context(fixture))]) {
      expect(response.status).toBe(503); privateResponse(response);
    }
    expect(fixture.connect).not.toHaveBeenCalled(); expect(fixture.transport).not.toHaveBeenCalled();
  });
  it("uploads and verifies actual raster bytes through the real composed input/store/pool/private-storage services", async () => {
    const fixture = await logoHttpFixture(), resolve = await configure(fixture), request = upload(fixture);
    const response = await (await uploadRoute()).POST(request, context(fixture));
    expect(response.status).toBe(200); privateResponse(response);
    const result = await response.json(); expect(result).toMatchObject({ sourceKind: "upload", aspects: ["shape"], asset: { ownerId: fixture.ownerId, projectId: fixture.projectId, contentHash: fixture.raster.reference.contentHash }, workspace: { capabilities: fixture.workspace.capabilities } });
    expect(fixture.objects.get(pathFor(result.asset))?.bytes).toEqual(fixture.raster.bytes);
    expect(fixture.getUser).toHaveBeenCalledOnce(); expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ userId: fixture.ownerId }), fixture.projectId, request.signal);
    expect(fixture.rpcCalls[0]).toMatchObject({ name: "get_logo_workspace", signal: request.signal });
    expect(fixture.sqlCalls.some(call => call.sql.includes("commit_logo_input"))).toBe(true);
    expect(fixture.storageCalls.map(call => call.method)).toEqual(["POST", "GET"]);
  });
  it("reads verified owned vector geometry and exact immutable private bytes through the actual GET route", async () => {
    const fixture = await logoHttpFixture(); await configure(fixture); const request = new Request("https://fluid.invalid/api");
    const response = await (await vectorRoute()).GET(request, context(fixture)); expect(response.status).toBe(200); privateResponse(response);
    expect(await response.json()).toMatchObject({ revision: fixture.revision, document: fixture.document, sourcePreview: { reference: fixture.raster.reference } });
    expect(fixture.storageCalls.map(call => call.path)).toEqual([pathFor(fixture.revision.documentAsset), pathFor(fixture.revision.svgAsset), pathFor(fixture.raster.reference)]);
    expect(fixture.rpcCalls.every(call => call.signal === request.signal)).toBe(true); expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("retains uncertain upload request identity and recovers by exact replay without duplicated byte work", async () => {
    const fixture = await logoHttpFixture(); await configure(fixture);
    fixture.controls.loseInputCommit = true;
    const route = await uploadRoute();
    const first = await route.POST(upload(fixture), context(fixture)); expect(first.status).toBe(503); privateResponse(first);
    const before = fixture.storageCalls.length, second = await route.POST(upload(fixture), context(fixture));
    expect(second.status).toBe(200); expect(fixture.storageCalls).toHaveLength(before);
    expect(fixture.requests.get(fixture.upload.requestKey)).toMatchObject({ status: "succeeded", request: { input: fixture.upload } });
  });

  it.each(["owner", "project"] as const)("keeps concurrent %s scopes, bytes and dependencies independent", async variation => {
    const a = await logoHttpFixture(), b = await logoHttpFixture(variation === "owner" ? undefined : a.ownerId, undefined, "#123456");
    let release!: () => void; const both = new Promise<void>(resolve => { release = resolve; }); let count = 0;
    await configure(a, async (auth, projectId) => {
      const fixture = [a, b].find(item => item.ownerId === auth.userId && item.projectId === projectId)!;
      if (++count === 2) release(); await both;
      return { ownerId: fixture.ownerId, projectId, dependencies: fixture.dependencies };
    });
    f.createClient.mockResolvedValueOnce(a.client).mockResolvedValueOnce(b.client);
    const route = await uploadRoute(), responses = await Promise.all([route.POST(upload(a), context(a)), route.POST(upload(b), context(b))]);
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(200); const fixture = [a, b][index]!, other = [b, a][index]!, result = await response.json();
      expect(result.asset).toMatchObject({ ownerId: fixture.ownerId, projectId: fixture.projectId, contentHash: fixture.raster.reference.contentHash });
      expect(fixture.objects.get(pathFor(result.asset))?.bytes).toEqual(fixture.raster.bytes); expect(other.objects.has(pathFor(result.asset))).toBe(false);
    }
    expect(a.storageCalls.every(call => call.path.startsWith(`${a.ownerId}/${a.projectId}/`))).toBe(true); expect(b.storageCalls.every(call => call.path.startsWith(`${b.ownerId}/${b.projectId}/`))).toBe(true);
  });
  it("rejects foreign projects and dependency scope mismatches before private I/O", async () => {
    const fixture = await logoHttpFixture(), other = await logoHttpFixture(), resolver = await configure(fixture, async () => ({ ownerId: other.ownerId, projectId: other.projectId, dependencies: other.dependencies }));
    const route = await vectorRoute();
    expect((await route.GET(new Request("https://fluid.invalid/api"), context(other))).status).toBe(404); expect(resolver).not.toHaveBeenCalled();
    expect((await route.GET(new Request("https://fluid.invalid/api"), context(fixture))).status).toBe(404); expect(resolver).toHaveBeenCalledOnce();
    expect(fixture.transport).not.toHaveBeenCalled(); expect(other.transport).not.toHaveBeenCalled(); expect(other.connect).not.toHaveBeenCalled();
  });
  it.each(["owner", "name", "oid"] as const)("preserves the independently checked SQL principal %s fence", async mismatch => {
    const fixture = await logoHttpFixture(), other = await logoHttpFixture();
    if (mismatch === "name") fixture.controls.principal.role_name = "postgres";
    if (mismatch === "oid") fixture.controls.principal.role_oid++;
    await configure(fixture, async () => ({ ownerId: fixture.ownerId, projectId: fixture.projectId, dependencies: mismatch === "owner" ? { ...fixture.dependencies, connections: other.dependencies.connections } : fixture.dependencies }));
    expect((await (await uploadRoute()).POST(upload(fixture), context(fixture))).status).toBe(503);
    expect(fixture.sqlCalls.some(call => call.sql.includes("prepare_logo_input"))).toBe(false); expect(fixture.transport).not.toHaveBeenCalled();
  });
  it("keeps the private-storage scope fence independent of resolver labels", async () => {
    const fixture = await logoHttpFixture(), other = await logoHttpFixture(fixture.ownerId);
    await configure(fixture, async () => ({ ownerId: fixture.ownerId, projectId: fixture.projectId, dependencies: { ...fixture.dependencies, storage: other.dependencies.storage } }));
    expect((await (await vectorRoute()).GET(new Request("https://fluid.invalid/api"), context(fixture))).status).toBe(404);
    expect(other.transport).not.toHaveBeenCalled();
  });
  it("keeps auth, origin, body and public error behavior before privileged resolution", async () => {
    const fixture = await logoHttpFixture(), resolver = await configure(fixture), route = await approvalRoute();
    const body = { requestKey: crypto.randomUUID(), expected: fixture.workspace.heads, directionSelectionId: crypto.randomUUID(), consistencyHash: "a".repeat(64) };
    fixture.getUser.mockResolvedValueOnce({ data: { user: null }, error: null } as never);
    const unauthenticated = json(body); expect((await route.POST(unauthenticated, context(fixture))).status).toBe(401); expect(unauthenticated.bodyUsed).toBe(false);
    const badOrigin = json(body); badOrigin.headers.set("origin", "https://foreign.invalid"); expect((await route.POST(badOrigin, context(fixture))).status).toBe(403);
    expect((await route.POST(json({ ...body, ownerId: fixture.ownerId }), context(fixture))).status).toBe(422);
    const oversized = json(body); oversized.headers.set("content-length", "999999"); expect((await route.POST(oversized, context(fixture))).status).toBe(413);
    expect(resolver).not.toHaveBeenCalled(); expect(fixture.connect).not.toHaveBeenCalled();
  });

  it.each(["directions"] as const)("cancels a held %s account transport through the HTTP request signal", async boundary => {
    const fixture = await logoHttpFixture(), controller = new AbortController(); await configure(fixture);
    let started!: (signal?: AbortSignal) => void; const held = new Promise<AbortSignal | undefined>(resolve => { started = resolve; }); fixture.controls.heldRpc = started;
    fixture.controls.holdRpc = (name, args) => boundary === "directions" ? name === "list_logo_workspace_records" && args.p_kind === "directions_overview" : name === "read_logo_workspace_record" && args.p_kind === boundary;
    const request = json(boundary === "directions" ? { requestKey: crypto.randomUUID(), expected: fixture.workspace.heads, directionSelectionId: crypto.randomUUID(), consistencyHash: "a".repeat(64) } : boundary === "stage" ? { requestKey: crypto.randomUUID(), expected: fixture.workspace.heads, stage: "vector", revisionId: fixture.stage.id, acceptEarlierBasis: true } : fixture.edit, controller.signal);
    const route = await approvalRoute();
    const result = route.POST(request, context(fixture));
    const transportSignal = await held; controller.abort(); expect(transportSignal).toBe(request.signal); expect((await result).status).toBe(503);
    expect(fixture.storageCalls.filter(call => call.method === "POST")).toHaveLength(0); expect(fixture.sqlCalls.some(call => call.sql.includes("apply_logo_trusted_command"))).toBe(false);
  });
});
