import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: mock.auth }));
import { GET } from "@/app/api/projects/page/route";
import { listProjects, getProject } from "@/server/data/projects";
import { accountProjectPageSchema } from "@/domain/project-pages";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "11111111-1111-4111-8111-111111111111";
const row = { id: projectId, owner_id: owner, title: "Synthetic lifecycle fixture", scope: "complete_brand", current_revision: 3, created_at: "2026-10-15T00:00:00.123456Z", deleted_at: null as string | null, deletion_requested_at: null as string | null, deletion_state: "active", lifecycle_version: 0 };
const reply = (query = "") => GET(new Request(`https://embel.example/api/projects/page${query}`));

function client(data: unknown) {
  const query = {
    select: vi.fn(), eq: vi.fn(), is: vi.fn(), not: vi.fn(), or: vi.fn(), order: vi.fn(),
    limit: vi.fn().mockResolvedValue({ data, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
  };
  for (const name of ["select", "eq", "is", "not", "or", "order"] as const) query[name].mockReturnValue(query);
  return { from: vi.fn().mockReturnValue(query), query, rpc: vi.fn().mockResolvedValue({ data, error: null }) };
}

beforeEach(() => vi.resetAllMocks());

describe("active and deleted project listings", () => {
  it("defaults to only active rows with explicit authenticated ownership and lifecycle fields", async () => {
    const database = client([row]); mock.auth.mockResolvedValue({ userId: owner, client: database });
    const response = await reply();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ownerId: owner, items: [row], nextCursor: null });
    expect(database.query.eq).toHaveBeenCalledWith("owner_id", owner);
    expect(database.query.is).toHaveBeenCalledWith("deleted_at", null);
    expect(database.query.is).toHaveBeenCalledWith("deletion_requested_at", null);
    expect(database.rpc).not.toHaveBeenCalled();
    expect(database.query.select.mock.calls[0]?.[0]).toContain("deleted_at,lifecycle_version");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("lists owned deleted projects for recovery while retaining created-at pagination", async () => {
    const deleted = { ...row, deleted_at: "2026-10-15T01:00:00Z", deletion_state: "deleted", lifecycle_version: 1 };
    const database = client([deleted]); mock.auth.mockResolvedValue({ userId: owner, client: database });
    const response = await reply("?state=deleted&limit=20");
    expect(response.status).toBe(200);
    expect((await response.json()).items).toEqual([deleted]);
    expect(database.query.or).toHaveBeenCalledWith("deleted_at.not.is.null,deletion_requested_at.not.is.null");
    expect(database.query.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(database.query.limit).toHaveBeenCalledWith(21);
  });

  it.each(["stopping", "awaiting_resolution", "deleted"])("includes acknowledged intent with derived %s state in Deleted projects", async deletion_state => {
    const pending = { ...row, deletion_requested_at: "2026-10-15T01:00:00Z", deletion_state, lifecycle_version: 1 };
    const database = client([pending]); mock.auth.mockResolvedValue({ userId: owner, client: database });
    const response = await reply("?state=deleted");
    expect(response.status).toBe(200);
    expect((await response.json()).items).toEqual([pending]);
    expect(database.rpc).toHaveBeenCalledExactlyOnceWith("get_project_deletion_states", { p_project_ids: [projectId] });
  });

  it("rejects a concurrent lifecycle epoch rather than merging new state into stale page rows", async () => {
    const pending = { ...row, deletion_requested_at: "2026-10-15T01:00:00Z", deletion_state: "stopping", lifecycle_version: 1 };
    const database = client([pending]); mock.auth.mockResolvedValue({ userId: owner, client: database });
    database.rpc.mockResolvedValue({ data: [{ ...row, lifecycle_version: 2 }], error: null });
    expect((await reply("?state=deleted")).status).toBe(503);
  });

  it("combines deletion markers and the continuation cursor in one bounded predicate", async () => {
    const pending = { ...row, deletion_requested_at: "2026-10-15T01:00:00Z", deletion_state: "stopping", lifecycle_version: 1 };
    const database = client([pending]); mock.auth.mockResolvedValue({ userId: owner, client: database });
    const cursorCreatedAt = "2026-10-16T00:00:00Z";
    expect((await reply(`?state=deleted&cursorCreatedAt=${cursorCreatedAt}&cursorId=${projectId}`)).status).toBe(200);
    expect(database.query.or).toHaveBeenNthCalledWith(1, `and(or(deleted_at.not.is.null,deletion_requested_at.not.is.null),or(created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${projectId})))`);
  });

  it.each(["?state=all", "?state=deleted&state=active", "?state=", "?ownerId=another-account"])("rejects invalid listing options %s", async query => {
    const database = client([]); mock.auth.mockResolvedValue({ userId: owner, client: database });
    expect((await reply(query)).status).toBe(422); expect(database.from).not.toHaveBeenCalled();
  });

  it.each([
    ["", { ...row, deleted_at: "2026-10-15T01:00:00Z", lifecycle_version: 1 }],
    ["?state=deleted", row],
    ["", { ...row, owner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    ["", { ...row, lifecycle_version: undefined }],
    ["", { ...row, deletion_requested_at: undefined }],
    ["", { ...row, deletion_requested_at: "2026-10-15T01:00:00Z", deletion_state: "stopping", lifecycle_version: 1 }],
  ])("rejects inconsistent or stale database listing state", async (query, invalid) => {
    const database = client([invalid]); mock.auth.mockResolvedValue({ userId: owner, client: database });
    const response = await reply(query as string);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("Synthetic lifecycle fixture");
  });

  it("requires lifecycle fields in the browser listing response instead of assuming a current version", () => {
    expect(accountProjectPageSchema.safeParse({ ownerId: owner, items: [{ ...row, lifecycle_version: undefined }], nextCursor: null }).success).toBe(false);
    expect(accountProjectPageSchema.safeParse({ ownerId: owner, items: [{ ...row, deleted_at: undefined }], nextCursor: null }).success).toBe(false);
    expect(accountProjectPageSchema.safeParse({ ownerId: owner, items: [{ ...row, deletion_requested_at: undefined }], nextCursor: null }).success).toBe(false);
    expect(accountProjectPageSchema.safeParse({ ownerId: owner, items: [{ ...row, deletion_state: undefined }], nextCursor: null }).success).toBe(false);
  });

  it("excludes deleted projects from legacy list and detail entrypoints", async () => {
    const database = client([]);
    await listProjects({ userId: owner, client: database } as never);
    expect(database.query.is).toHaveBeenCalledWith("deleted_at", null);
    database.query.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(getProject({ userId: owner, client: database } as never, projectId)).rejects.toMatchObject({ code: "not_found" });
    expect(database.query.is).toHaveBeenCalledTimes(4);
    expect(database.query.is).toHaveBeenCalledWith("deletion_requested_at", null);
  });
});
