import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), single: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
import { POST } from "../../src/app/api/projects/route";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "11111111-1111-4111-8111-111111111111";
const requestKey = "22222222-2222-4222-8222-222222222222";
const context = contextSnapshotSchema.parse({ description: "Local creation request fixture", intake: { example: true } });
const input = { title: "Fixture project", scope: "complete_brand", context, requestKey };
const hash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
const project = { id: projectId, owner_id: ownerId, current_revision: 1, scope: input.scope, title: input.title, context, created_at: "2026-10-15T00:00:00Z" };
const request = (body: unknown, expectedAccount: string | null = ownerId) => new Request("https://fluid.example/api/projects", {
  method: "POST", headers: { origin: "https://fluid.example", "content-type": "application/json", ...(expectedAccount === null ? {} : { "X-Embel-Account": expectedAccount }) }, body: JSON.stringify(body),
});

describe("replay-safe project creation HTTP contract", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("APP_ORIGIN", "https://fluid.example");
    doubles.auth.mockResolvedValue({ userId: ownerId, client: { rpc: doubles.rpc } });
    doubles.rpc.mockReturnValue({ single: doubles.single });
    doubles.single.mockResolvedValue({ data: project, error: null });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([null, "", "invalid-account", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])("rejects missing, malformed or mismatched account fence %j before either create RPC", async expectedAccount => {
    for (const body of [input, { title: input.title, scope: input.scope, context }]) {
      const response = await POST(request(body, expectedAccount));
      expect(response.status).toBe(401);
    }
    expect(doubles.rpc).not.toHaveBeenCalled();
    expect(doubles.single).not.toHaveBeenCalled();
  });

  it("rejects a captured account A request when the authenticated cookie has switched to account B", async () => {
    doubles.auth.mockResolvedValue({ userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", client: { rpc: doubles.rpc } });
    expect((await POST(request(input))).status).toBe(401);
    expect(doubles.rpc).not.toHaveBeenCalled();
    expect(doubles.single).not.toHaveBeenCalled();
  });

  it("sends a stable UUID and the normalized payload through the separate create RPC", async () => {
    const response = await POST(request({ ...input, title: "  Fixture project  " }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ project });
    expect(doubles.rpc).toHaveBeenCalledExactlyOnceWith("create_project_with_request", {
      p_request_key: requestKey, p_title: input.title, p_scope: input.scope, p_context: context, p_input_hash: hash,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("returns a recovered current context and revision without overwriting them with the captured request", async () => {
    const current = { ...project, title: "Later edit", scope: "complete_brand", current_revision: 3, context: { ...context, description: "Current saved work" } };
    doubles.single.mockResolvedValue({ data: current, error: null });
    const response = await POST(request(input));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ project: current });
    expect(doubles.rpc).toHaveBeenCalledTimes(1);
  });

  it("preserves the original RPC for clients without a request key", async () => {
    const legacy = { title: input.title, scope: input.scope, context };
    doubles.single.mockResolvedValue({ data: { ...project, context: undefined }, error: null });
    const response = await POST(request(legacy));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ project });
    expect(doubles.rpc).toHaveBeenCalledExactlyOnceWith("create_project", { p_title: input.title, p_scope: input.scope, p_context: context, p_input_hash: hash });
  });

  it.each([null, "", "bad-key", 42])("rejects malformed request key %j before making a database request", async key => {
    expect((await POST(request({ ...input, requestKey: key }))).status).toBe(422);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });

  it("conceals a response belonging to a different account", async () => {
    doubles.single.mockResolvedValue({ data: { ...project, owner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, error: null });
    expect((await POST(request(input))).status).toBe(404);
  });

  it.each([["PT409", 409], ["P0002", 404], ["23514", 422], ["42883", 503]] as const)("maps %s safely without falling back to non-idempotent creation", async (code, status) => {
    doubles.single.mockResolvedValue({ data: null, error: { code, message: "private database diagnostic" } });
    const response = await POST(request(input));
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private database diagnostic");
    expect(doubles.rpc).toHaveBeenCalledTimes(1);
    expect(doubles.rpc.mock.calls[0]?.[0]).toBe("create_project_with_request");
  });
});
