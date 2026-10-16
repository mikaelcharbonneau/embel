import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "../database/local-supabase";

vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mock.auth }));
import { POST } from "../../src/app/api/logo/projects/route";

const origin = "https://embel.example";
const brief = { name: "Account A synthetic brief", activity: "Local fixture", audience: "Testers", personality: "Calm", logoTypes: ["wordmark" as const] };
function request(input: unknown, expectedOwner: string | null) {
  return new Request(`${origin}/api/logo/projects`, { method: "POST", headers: {
    origin, "content-type": "application/json", ...(expectedOwner === null ? {} : { "X-Embel-Account": expectedOwner }),
  }, body: JSON.stringify(input) });
}

describe("Logo creation account fence through real local PostgreSQL (no live services)", () => {
  let db: TestDatabase, actor: string;
  beforeAll(async () => { db = await createTestDatabase(); }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await resetFixture(db);
    vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", origin); actor = OWNER_B;
    // Authentication and the PostgREST wire are synthetic. The route, client,
    // validation, data service, SQL function and RLS execute unchanged.
    mock.auth.mockImplementation(async () => ({ userId: actor, client: { rpc: mock.rpc } }));
    mock.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name !== "start_logo_project") throw new Error("Unexpected local logo fixture RPC");
      return asRole(db, "authenticated", actor, async () => {
        try {
          const result = await db.query<{ value: unknown }>("select public.start_logo_project($1::jsonb) value", [args.p_input]);
          return { data: result.rows[0]!.value, error: null };
        } catch (error) { return { data: null, error }; }
      });
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  async function expectNoPersistence() {
    for (const table of ["projects", "project_revisions", "logo_stage_revisions", "logo_workspace_requests", "jobs"]) {
      expect((await db.query(`select * from public.${table}`)).rows, table).toEqual([]);
    }
  }

  it.each([null, "", "not-an-account", OWNER_A])("rejects missing, malformed or stale account %s before reading or persisting the brief", async expectedOwner => {
    const input = request({ requestKey: randomUUID(), brief }, expectedOwner);
    const response = await POST(input);
    expect(response.status).toBe(401);
    expect(input.bodyUsed).toBe(false);
    expect(mock.rpc).not.toHaveBeenCalled();
    await expectNoPersistence();
  });

  it("derives persisted ownership from the matching authenticated account and enforces RLS", async () => {
    const input = { requestKey: randomUUID(), brief: { ...brief, name: "Explicit account B brief" } };
    const response = await POST(request(input, OWNER_B));
    expect(response.status).toBe(200);
    const workspace = logoWorkspaceV2Schema.parse(await response.json());
    expect(workspace.ownerId).toBe(OWNER_B);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("start_logo_project", { p_input: input });
    expect((await db.query("select owner_id from public.projects")).rows).toEqual([{ owner_id: OWNER_B }]);
    expect(await asRole(db, "authenticated", OWNER_A, () => db.query("select id from public.projects"))).toMatchObject({ rows: [] });
    expect(await asRole(db, "authenticated", OWNER_B, () => db.query("select id from public.projects"))).toMatchObject({ rows: [{ id: workspace.projectId }] });
  });

  it("prevents a still-visible account A client from writing its brief after cookies change to B", async () => {
    const account = { status: "ready" as const, userId: OWNER_A, generation: 1 }, expire = vi.fn();
    const client = createAccountLogoClient(account, null, () => true, expire, async (path, init) => {
      const headers = new Headers(init?.headers); headers.set("origin", origin);
      return POST(new Request(new URL(String(path), origin), { ...init, headers }));
    });
    expect(await client.startLogoProject({ requestKey: randomUUID(), brief })).toBeNull();
    expect(expire).toHaveBeenCalledExactlyOnceWith(account);
    expect(mock.rpc).not.toHaveBeenCalled();
    await expectNoPersistence();
    client.dispose();
  });
});
