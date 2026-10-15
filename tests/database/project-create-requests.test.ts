import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contextSnapshotSchema, type ContextSnapshot } from "../../src/domain/projects";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";

const migration = "20261015201722_project_create_requests.sql";
const context = contextSnapshotSchema.parse({ description: "Local project creation replay fixture", intake: { example: true } });
const hash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
const key = "11111111-1111-4111-8111-111111111111";
const initial = { scope: "naming_only", title: "Original project", context, hash };
type StoredProject = { id: string; owner_id: string; scope: string; title: string; current_revision: number; created_at: string; context: ContextSnapshot };
const metadataSql = "select oid,prosrc,proacl,prosecdef,proconfig,pronargs,pronargdefaults from pg_proc where oid='public.create_project(text,text,jsonb,text)'::regprocedure";

describe("project creation receipts on local PostgreSQL (not live Supabase)", () => {
  let db: TestDatabase;
  let originalFunction: unknown[];
  beforeAll(async () => {
    db = await createTestDatabase({ before: migration });
    originalFunction = (await db.query(metadataSql)).rows;
    // Simulate inherited grants to an unexpected role. The migration must strip
    // them only from its new objects, leaving unrelated defaults unchanged.
    await db.exec(`
      create role fixture_project_default_grantee nologin;
      alter default privileges grant execute on functions to fixture_project_default_grantee;
      alter default privileges grant all on tables to fixture_project_default_grantee;
    `);
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  }, 90_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });

  async function create(owner = OWNER_A, input = initial, requestKey: string | null = key) {
    return asRole(db, "authenticated", owner, async () => (await db.query<StoredProject>(
      "select * from public.create_project_with_request($1,$2,$3,$4::jsonb,$5)",
      [requestKey, input.scope, input.title, input.context, input.hash],
    )).rows[0]!);
  }
  async function receipt() {
    return (await db.query("select * from fluid_private.project_create_requests where owner_id=$1 and request_key=$2", [OWNER_A, key])).rows[0];
  }

  it("replays an exact request without another project, revision, receipt or job", async () => {
    const first = await create();
    expect(await create()).toEqual(first);
    const reordered = Object.fromEntries(Object.entries(context).reverse()) as ContextSnapshot;
    expect(await create(OWNER_A, { ...initial, context: reordered })).toEqual(first);
    expect((await db.query("select * from public.projects")).rows).toHaveLength(1);
    expect((await db.query("select * from public.project_revisions")).rows).toHaveLength(1);
    expect((await db.query("select * from fluid_private.project_create_requests")).rows).toHaveLength(1);
    expect((await db.query("select * from public.jobs")).rows).toEqual([]);
    expect(first).toMatchObject({ owner_id: OWNER_A, title: initial.title, scope: initial.scope, current_revision: 1, context });
  });

  it.each([
    { title: "Changed title" },
    { scope: "complete_brand" },
    { context: { ...context, description: "Changed context with the same caller-supplied hash" } },
    { hash: "b".repeat(64) },
  ])("rejects request key reuse with a changed payload: %j", async change => {
    const first = await create();
    const captured = await receipt();
    await expect(create(OWNER_A, { ...initial, ...change })).rejects.toMatchObject({ code: "PT409" });
    expect(await create()).toEqual(first);
    expect(await receipt()).toEqual(captured);
    expect((await db.query("select * from public.projects")).rows).toHaveLength(1);
  });

  it("binds the same request key independently to two owners", async () => {
    const a = await create();
    const b = await create(OWNER_B);
    expect(b.id).not.toBe(a.id);
    expect(b.owner_id).toBe(OWNER_B);
    expect(await create(OWNER_A)).toEqual(a);
    expect(await create(OWNER_B)).toEqual(b);
    await asRole(db, "authenticated", OWNER_B, async () => {
      expect((await db.query("select * from public.projects where id=$1", [a.id])).rows).toEqual([]);
      await expect(db.query("select * from fluid_private.project_create_requests")).rejects.toThrow(/permission denied/);
    });
    expect((await db.query("select * from fluid_private.project_create_requests")).rows).toHaveLength(2);
  });

  it("returns the current project snapshot after later edits and expansion without changing the captured digest", async () => {
    const first = await create();
    const captured = await receipt();
    const edited = { ...context, description: "Later saved account work" };
    await asRole(db, "authenticated", OWNER_A, async () => {
      await db.query("select * from public.append_project_revision($1,1,$2::jsonb,$3,'Later title')", [first.id, edited, "b".repeat(64)]);
      await db.query("select * from public.expand_project_scope($1,2)", [first.id]);
    });
    expect(await create()).toEqual({ ...first, title: "Later title", scope: "complete_brand", current_revision: 3, context: edited });
    expect(await receipt()).toEqual(captured);
    await expect(create(OWNER_A, { title: "Later title", scope: "complete_brand", context: edited, hash: "b".repeat(64) })).rejects.toMatchObject({ code: "PT409" });
    const revisions = (await db.query("select revision,context from public.project_revisions where project_id=$1 order by revision", [first.id])).rows;
    expect(revisions).toEqual([{ revision: 1, context }, { revision: 2, context: edited }, { revision: 3, context: edited }]);
  });

  it("makes receipt identity immutable and enforces the project-owner foreign key", async () => {
    await create();
    const other = await asRole(db, "authenticated", OWNER_B, async () => (await db.query<{ id: string }>(
      "select * from public.create_project($1,$2,$3::jsonb,$4)", [initial.scope, initial.title, context, hash],
    )).rows[0]!);
    await expect(db.query("update fluid_private.project_create_requests set payload_hash=$1 where owner_id=$2", ["b".repeat(64), OWNER_A])).rejects.toThrow(/immutable_history/);
    await expect(db.query("delete from fluid_private.project_create_requests where owner_id=$1", [OWNER_A])).rejects.toThrow(/immutable_history/);
    await expect(db.query("insert into fluid_private.project_create_requests(owner_id,request_key,project_id,payload_hash) values($1,$2,$3,$4)",
      [OWNER_A, randomUUID(), other.id, hash])).rejects.toMatchObject({ code: "23503" });
    expect((await db.query("select * from fluid_private.project_create_requests")).rows).toHaveLength(1);
  });

  it("rolls back failed creation without consuming the request key", async () => {
    await expect(create(OWNER_A, { ...initial, hash: "bad" })).rejects.toMatchObject({ code: "23514" });
    await expect(create(OWNER_A, initial, null)).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select * from public.projects")).rows).toEqual([]);
    expect(await receipt()).toBeUndefined();
    expect(await create()).toMatchObject({ current_revision: 1, owner_id: OWNER_A });
  });

  it("keeps the original create function definition, OID and ACL and denies unauthorized new RPC access", async () => {
    expect((await db.query(metadataSql)).rows).toEqual(originalFunction);
    for (const schema of ["public", "fluid_private"]) {
      const signature = `${schema}.create_project_with_request(uuid,text,text,jsonb,text)`;
      expect((await db.query("select prosecdef,proconfig from pg_proc where oid=$1::regprocedure", [signature])).rows)
        .toEqual([{ prosecdef: schema === "fluid_private", proconfig: ['search_path=""'] }]);
      for (const role of ["authenticated", "anon", "service_role", "fixture_subscription_worker_a", "fixture_subscription_worker_b", "fixture_project_default_grantee"]) {
        expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows)
          .toEqual([{ allowed: role === "authenticated" }]);
      }
    }
    for (const role of ["authenticated", "anon", "service_role", "fixture_subscription_worker_a", "fixture_subscription_worker_b", "fixture_project_default_grantee"]) {
      expect((await db.query("select has_table_privilege($1,'fluid_private.project_create_requests','SELECT,INSERT,UPDATE,DELETE') as allowed", [role])).rows)
        .toEqual([{ allowed: false }]);
    }
    expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='fluid_private.project_create_requests'::regclass")).rows)
      .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    for (const role of ["anon", "service_role"] as const) {
      await asRole(db, role, OWNER_A, async () => {
        await expect(db.query("select * from public.create_project_with_request($1,$2,$3,$4::jsonb,$5)", [key, initial.scope, initial.title, context, hash]))
          .rejects.toThrow(/permission denied/);
      });
    }
    await asRole(db, "authenticated", null, async () => {
      await expect(db.query("select * from public.create_project_with_request($1,$2,$3,$4::jsonb,$5)", [key, initial.scope, initial.title, context, hash]))
        .rejects.toMatchObject({ code: "P0002" });
    });
    expect((await db.query("select has_schema_privilege('authenticated','fluid_private','USAGE') as allowed")).rows).toEqual([{ allowed: false }]);
    await db.exec("set role fixture_project_default_grantee");
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_A]);
      await expect(db.query("select * from public.create_project_with_request($1,$2,$3,$4::jsonb,$5)", [key, initial.scope, initial.title, context, hash]))
        .rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub','',false)");
    }
    await db.exec("create function public.fixture_project_unrelated_grant() returns boolean language sql as $$ select true $$");
    try {
      expect((await db.query("select has_function_privilege('fixture_project_default_grantee','public.fixture_project_unrelated_grant()','EXECUTE') as allowed")).rows)
        .toEqual([{ allowed: true }]);
    } finally { await db.exec("drop function public.fixture_project_unrelated_grant()"); }
  });
});
