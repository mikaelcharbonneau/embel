import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
// The actual route, service, registry and feature codec run here; only auth/transport is synthetic.
import { PUT } from "../../src/app/api/workspaces/[tool]/route";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const payload = (url: string) => ({ version: 1, bundles: [{ id: "fixture", title: "Cedar", list: "Manual list", savedAt: "2026-10-06T00:00:00Z",
  source: { id: "manual", name: "Cedar", origin: "manual", projectId: null, projectTitle: null },
  entries: [{ platform: "instagram", handle: "cedar", favorite: false, selected: false, evidence: [], accountCreated: { declaredAt: "2026-10-06T00:00:00Z", url } }] }] });
describe("standalone route uses total feature validation", () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "http://localhost:3105");
    mocks.auth.mockResolvedValue({ userId: owner, client: { rpc: mocks.rpc } });
  });
  it.each(["https://www.instagram.com:99999/cedar", "https://www.instagram.com:65536/cedar", "https://www.instagram.com:-1/cedar", "https://www.instagram.com:abc/cedar", "not a URL"])("returns 422, never an internal error or database write, for %s", async url => {
    const request = new Request("http://localhost:3105/api/workspaces/handles", { method: "PUT", headers: { origin: "http://localhost:3105", "content-type": "application/json" },
      body: JSON.stringify({ requestKey: owner, expectedRevision: 0, payload: payload(url), imports: [] }) });
    const response = await PUT(request, { params: Promise.resolve({ tool: "handles" }) });
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ error: { code: "invalid_input", message: "Check the submitted information." } });
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("standalone real HTTP and DAL save outcome boundary", () => {
  const draft = { version: 1, input: "Retained stale draft", extensions: ["com"], candidates: [] };
  const input = { requestKey: owner, expectedRevision: 2, payload: draft, imports: [] };
  const saved = { ownerId: owner, workspace: { id: owner, ownerId: owner, tool: "domains", revision: 3,
    payload: { ...draft, input: "Newer saved draft" }, imports: [], createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z" } };
  const saveRequest = () => PUT(new Request("http://localhost:3105/api/workspaces/domains", { method: "PUT",
    headers: { origin: "http://localhost:3105", "content-type": "application/json" }, body: JSON.stringify(input) }), { params: Promise.resolve({ tool: "domains" }) });
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "http://localhost:3105"); vi.stubEnv("FLUID_RUNTIME", "local"); vi.stubEnv("VERCEL", "");
    mocks.auth.mockResolvedValue({ userId: owner, client: { rpc: mocks.rpc } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it.each([["40001", 500], ["40001", 503], ["PT409", 409], ["23505", 409]])("preserves known save conflict %s from upstream HTTP %i", async (code, status) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("private-logger-failure"); });
    mocks.rpc.mockResolvedValueOnce({ data: saved, error: null }).mockResolvedValueOnce({ data: null, error: { code, message: "private-database-message" }, status });
    const response = await saveRequest();
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: { code: "conflict", message: "This request conflicts with the current state." } });
    expect(warn).not.toHaveBeenCalled(); expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenLastCalledWith("save_standalone_workspace", { p_tool: "domains", p_expected_revision: 2, p_request_key: owner, p_payload: draft, p_imports: [] });
  });
  it.each([
    { stage: "pre_read", delivery: "resolved" }, { stage: "pre_read", delivery: "rejected" },
    { stage: "save_rpc", delivery: "resolved" }, { stage: "save_rpc", delivery: "rejected" },
  ])("preserves unavailable $stage/$delivery outcome when the diagnostic sink throws", async ({ stage, delivery }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("private-logger-failure"); });
    if (stage === "save_rpc") mocks.rpc.mockResolvedValueOnce({ data: saved, error: null });
    if (delivery === "resolved") mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "", message: "private-fetch-failure" }, status: 0 });
    else mocks.rpc.mockRejectedValueOnce(new TypeError("private-response-lost-after-commit"));
    const response = await saveRequest();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "integration_unavailable", message: "This integration is not configured or is unavailable." } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(stage === "pre_read" ? 1 : 2);
    if (stage === "save_rpc") expect(mocks.rpc).toHaveBeenLastCalledWith("save_standalone_workspace", {
      p_tool: "domains", p_expected_revision: 2, p_request_key: owner, p_payload: draft, p_imports: [],
    });
  });
  it.each(["pre_read", "save_rpc"])("retains unavailable semantics and identifies %s even with a newer observed head", async stage => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (stage === "save_rpc") mocks.rpc.mockResolvedValueOnce({ data: saved, error: null });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "", message: "private-fetch-failure", details: "private-details" }, status: 0 });
    const response = await saveRequest();
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: { code: "integration_unavailable", message: "This integration is not configured or is unavailable." } });
    expect(warn).toHaveBeenCalledExactlyOnceWith("[fluid:standalone]", { stage: stage === "pre_read" ? "workspace_read_rpc" : "save_rpc", codeType: "string", code: "unrecognized", status: 0 });
    expect(mocks.rpc).toHaveBeenCalledTimes(stage === "pre_read" ? 1 : 2);
  });
});
