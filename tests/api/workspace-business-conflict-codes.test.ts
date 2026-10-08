import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
// Real routes, DALs and HTTP mapper; only the authenticated RPC transport is fake.
// The companion PGlite suite executes every real database business-conflict branch.
import { PATCH as update } from "@/app/api/ideas/[ideaId]/route";
import { POST as brand } from "@/app/api/ideas/[ideaId]/brand/route";
import { POST as attach } from "@/app/api/ideas/[ideaId]/projects/route";
import { POST as promote } from "@/app/api/workspaces/promotions/route";
import { createPostgresHomeAttachmentBackend } from "@/server/home-attachments/postgres";
import { errorResponse } from "@/server/http/errors";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ideaContentSchema } from "@/domain/ideas";
import { contextSnapshotSchema } from "@/domain/projects";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const key = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const content = ideaContentSchema.parse({ title: "Retained local Idea" });
const context = contextSnapshotSchema.parse({ description: "Retained local Home prompt" });
const auth = { userId: owner, client: { rpc: mocks.rpc } } as unknown as AuthenticatedContext;
const params = { params: Promise.resolve({ ideaId: id }) };
const request = (body: unknown, method = "POST") => new Request("http://localhost:3105/api", {
  method, headers: { origin: "http://localhost:3105", "content-type": "application/json" }, body: JSON.stringify(body),
});
const cases = [
  { name: "update_idea", message: "revision_conflict", run: () => update(request({ requestKey: key, expectedRevision: 1, content }, "PATCH"), params) },
  ...["revision_conflict", "idea_link_capacity"].map(message => ({ name: "create_idea_brand", message, run: () => brand(request({ requestKey: key, expectedRevision: 1 }), params) })),
  ...["request_conflict", "revision_conflict"].map(message => ({ name: "attach_idea_to_project", message, run: () => attach(request({ requestKey: key, ideaId: id, expectedIdeaRevision: 1, projectId: id, expectedProjectRevision: 1 }), params) })),
  ...["request_conflict", "revision_conflict"].map(message => ({ name: "promote_standalone_workspace", message, run: () => promote(request({ requestKey: key, workspaceId: id, expectedWorkspaceRevision: 1, selection: { tool: "domains", domain: "cedar.com" }, contextSource: null, title: "Cedar" })) })),
  ...["home_request_conflict", "home_attachment_conflict"].map(message => ({ name: "save_attached_home_project", message, run: async () => {
    // The production Home service remains intentionally unconfigured. Exercise its
    // real public-RPC adapter plus the same HTTP mapper without enabling storage.
    try {
      await createPostgresHomeAttachmentBackend(null).save(auth, { requestKey: key, project: { title: "Local Home", scope: "complete_brand", context }, attachmentIds: [] });
      throw new Error("Expected a conflict");
    } catch (error) { return errorResponse(error); }
  } })),
];

describe("workspace PT409 transport reaches HTTP 409 without application retries", () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "http://localhost:3105"); mocks.auth.mockResolvedValue(auth);
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(cases)("$name / $message completes after exactly one mutation attempt", async ({ name, message, run }) => {
    mocks.rpc.mockImplementation(async (called: string) => {
      if (called === "get_idea" && name === "create_idea_brand") return { data: { id, ownerId: owner, revision: 1, content, links: [], createdAt: "2026-10-07T00:00:00.000000Z", updatedAt: "2026-10-07T00:00:00.000000Z" }, error: null };
      if (called === name) return { data: null, error: { code: "PT409", message }, status: 409 };
      throw new Error(`Unexpected fixture RPC: ${called}`);
    });
    const response = await run();
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: { code: "conflict", message: "This request conflicts with the current state." } });
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(name === "create_idea_brand" ? ["get_idea", name] : [name]);
  }, 1_000);
});
