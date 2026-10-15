import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
// Real route, DAL, validators and error mapper; only authenticated RPC transport
// is synthetic. PGlite covers actual SQLSTATE branches in the database companion.
import { PUT } from "../../src/app/api/workspaces/[tool]/route";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestKey = "dddddddd-dddd-4ddd-8ddd-000000000001";
const payload = { version: 1, input: "Retained local draft", extensions: ["com"], candidates: [] };

describe("standalone PT409 crosses the real HTTP and data-service boundary promptly", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("APP_ORIGIN", "http://localhost:3105");
    mocks.auth.mockResolvedValue({ userId: owner, client: { rpc: mocks.rpc } });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each(["request_conflict", "revision_conflict", "source_conflict"])("returns HTTP 409 after exactly one save attempt for %s", async message => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "get_standalone_workspace") return { data: { ownerId: owner, workspace: null }, error: null };
      if (name === "save_standalone_workspace") return { data: null, error: { code: "PT409", message }, status: 409 };
      throw new Error(`Unexpected fixture RPC: ${name}`);
    });
    const response = await PUT(new Request("http://localhost:3105/api/workspaces/domains", {
      method: "PUT",
      headers: { origin: "http://localhost:3105", "content-type": "application/json", "X-Embel-Account": owner },
      body: JSON.stringify({ requestKey, expectedRevision: 0, payload, imports: [] }),
    }), { params: Promise.resolve({ tool: "domains" }) });

    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: { code: "conflict", message: "This request conflicts with the current state." } });
    // The DAL reads once, then saves once. No retry or post-conflict fetch.
    expect(mocks.rpc.mock.calls).toEqual([
      ["get_standalone_workspace", { p_tool: "domains" }],
      ["save_standalone_workspace", { p_tool: "domains", p_expected_revision: 0, p_request_key: requestKey, p_payload: payload, p_imports: [] }],
    ]);
  }, 1_000);
});
