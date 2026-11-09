import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { namingSourceSchema } from "../../src/domain/naming";
import { accountProjectResponseSchema, accountRevisionResponseSchema } from "../../src/domain/project-api";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "../database/local-supabase";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
import { POST as create } from "../../src/app/api/projects/route";
import { PATCH } from "../../src/app/api/projects/[projectId]/route";

const initialContext = contextSnapshotSchema.parse({
  description: "Local integration fixture, not model output.",
  intake: { suppliedName: "Fixture name", namingNotes: "Keep this note", identityNotes: "Keep this preference", step: "review", example: true },
});
const request = (body: unknown, method = "POST", expectedAccount: string | null = OWNER_A) => new Request("https://fluid.example/api/projects", {
  method, headers: { origin: "https://fluid.example", "content-type": "application/json", ...(expectedAccount === null ? {} : { "X-Embel-Account": expectedAccount }) }, body: JSON.stringify(body),
});
const route = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

describe("local route-to-PostgreSQL draft integration (no live services)", () => {
  let db: TestDatabase;
  let actor: string;
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await resetFixture(db);
    actor = OWNER_A;
    vi.stubEnv("APP_ORIGIN", "https://fluid.example");
    // Only the identity/provider transport is doubled. Handlers, validation, data
    // functions, SQL migrations, RPC grants and ownership checks execute normally.
    doubles.auth.mockImplementation(async () => ({ userId: actor, client: {
      rpc(name: string, args: Record<string, unknown>) {
        return { single: async () => asRole(db, "authenticated", actor, async () => {
          try {
            let result;
            if (name === "create_project") {
              result = await db.query("select * from public.create_project($1,$2,$3::jsonb,$4)", [args.p_scope, args.p_title, args.p_context, args.p_input_hash]);
            } else if (name === "append_project_revision") {
              result = await db.query("select * from public.append_project_revision($1,$2,$3::jsonb,$4,$5)", [args.p_project_id, args.p_expected_revision, args.p_context, args.p_input_hash, args.p_title ?? null]);
            } else if (name === "expand_project_scope") {
              result = await db.query("select * from public.expand_project_scope($1,$2)", [args.p_project_id, args.p_expected_revision]);
            } else { throw new Error("Unexpected RPC in local project adapter"); }
            // PostgREST carries timestamp values as JSON strings on the wire.
            return { data: JSON.parse(JSON.stringify(result.rows[0])), error: null };
          } catch (error) { return { data: null, error }; }
        }) };
      },
    } }));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("does not persist a stale account's draft after cookies switch to another account", async () => {
    const input = { title: "Captured account A draft", scope: "complete_brand", context: initialContext };
    actor = OWNER_B;
    expect((await create(request(input))).status).toBe(401);
    expect((await create(request(input, "POST", null))).status).toBe(401);
    expect((await db.query("select * from public.projects")).rows).toEqual([]);
    expect((await db.query("select * from public.project_revisions")).rows).toEqual([]);

    const matched = await create(request({ ...input, title: "Explicit account B draft" }, "POST", OWNER_B));
    expect(matched.status).toBe(201);
    expect(accountProjectResponseSchema.parse(await matched.json()).project.owner_id).toBe(OWNER_B);
    expect((await db.query("select owner_id from public.projects")).rows).toEqual([{ owner_id: OWNER_B }]);
  });

  it("retains standalone name history in immutable account revisions and rejects fabricated transform output", async () => {
    const namingSource = namingSourceSchema.parse({
      id: "11111111-1111-4111-8111-111111111111", value: "Lumina", origin: "workshop", createdAt: "2026-10-02T20:00:00Z",
      history: [{ id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-10-02T20:00:00Z", input: { kind: "affixes", seed: "Lumi", prefixes: [], suffixes: ["na"], separator: "" }, output: "Lumina" }],
    });
    const original = contextSnapshotSchema.parse({ ...initialContext, selectedName: "Lumina", namingSource, intake: { ...initialContext.intake, suppliedName: "Lumina" } });
    const created = await create(request({ title: "Lumina", scope: "complete_brand", context: original }));
    expect(created.status).toBe(201);
    const { project } = accountProjectResponseSchema.parse(await created.json());
    expect(project.owner_id).toBe(OWNER_A);
    expect(project.context).toEqual(original);
    const changed = contextSnapshotSchema.parse({ ...original, selectedName: "Lumina Studio", intake: { ...original.intake, suppliedName: "Lumina Studio" } });
    actor = OWNER_B;
    expect((await PATCH(request({ expectedRevision: 1, title: "Forbidden change", context: changed }, "PATCH"), route(project.id))).status).toBe(404);
    actor = OWNER_A;
    const updated = await PATCH(request({ expectedRevision: 1, title: "Lumina Studio", context: changed }, "PATCH"), route(project.id));
    expect(updated.status).toBe(200);
    const { revision } = accountRevisionResponseSchema.parse(await updated.json());
    expect(revision.context.namingSource).toEqual(namingSource);
    expect(revision.context.selectedName).toBe("Lumina Studio");
    const stored = await db.query<{ revision: number; context: unknown; input_hash: string }>("select revision,context,input_hash from public.project_revisions where project_id=$1 order by revision", [project.id]);
    expect(stored.rows.map(row => row.context)).toEqual([original, changed]);
    expect(stored.rows[0]?.input_hash).not.toBe(stored.rows[1]?.input_hash);
    const fabricated = { ...original, namingSource: { ...namingSource, value: "Invented", history: [{ ...namingSource.history[0], output: "Invented" }] } };
    expect((await create(request({ title: "Invented", scope: "complete_brand", context: fabricated }))).status).toBe(422);
    expect((await db.query("select * from public.projects")).rows).toHaveLength(1);
    expect((await db.query("select * from public.jobs")).rows).toEqual([]);
  });

  it("creates and edits a brand through actual SQL with context preserved", async () => {
    const createdResponse = await create(request({ title: "Initial fixture", scope: "complete_brand", context: initialContext }));
    expect(createdResponse.status).toBe(201);
    const { project } = accountProjectResponseSchema.parse(await createdResponse.json());
    expect(project.owner_id).toBe(OWNER_A);
    const editedContext = contextSnapshotSchema.parse({
      ...initialContext, activity: "Fixture activity", offering: "Fixture offering", reformulationConfirmed: true,
      audienceSegments: [{ id: "11111111-1111-4111-8111-111111111111", label: "Selected fixture audience", needs: ["A fixture need"], reason: "User supplied", selected: true, origin: "user" }],
      intake: { ...initialContext.intake, step: "audience", audienceReviewedAt: "2026-10-02T00:00:00Z" },
    });
    const savedResponse = await PATCH(request({ expectedRevision: 1, context: editedContext, title: "Edited fixture" }, "PATCH"), route(project.id));
    expect(savedResponse.status).toBe(200);
    const { revision } = accountRevisionResponseSchema.parse(await savedResponse.json());
    expect(revision.revision).toBe(2);
    expect(revision.context).toEqual(editedContext);

    actor = OWNER_B;
    expect((await PATCH(request({ expectedRevision: 2, context: editedContext }, "PATCH"), route(project.id))).status).toBe(404);
    actor = OWNER_A;
    expect((await PATCH(request({ expectedRevision: 1, context: editedContext }, "PATCH"), route(project.id))).status).toBe(409);
    expect((await db.query("select scope,title,current_revision,deleted_at,deletion_requested_at,lifecycle_version from public.projects where id=$1", [project.id])).rows)
      .toEqual([{ scope: "complete_brand", title: "Edited fixture", current_revision: 2, deleted_at: null, deletion_requested_at: null, lifecycle_version: 0 }]);
    const stored = await db.query<{ revision: number; context: unknown; input_hash: string }>("select revision,context,input_hash from public.project_revisions where project_id=$1 order by revision", [project.id]);
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0]?.context).toEqual(initialContext);
    expect(stored.rows[1]).toEqual({ revision: 2, context: editedContext, input_hash: revision.input_hash });
    expect((await db.query("select * from public.jobs")).rows).toEqual([]);
  });
});
