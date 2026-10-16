import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contextSnapshotSchema, type ContextSnapshot, type ProjectScope } from "../../src/domain/projects";
import { asRole, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";

// Synthetic fixture only: no generated strategy or external provider observations.
const context = contextSnapshotSchema.parse({
  description: "An explicitly local project draft fixture.",
  activity: "Fixture activity", offering: "Fixture offering", knownAudience: "User supplied audience", reformulationConfirmed: true,
  audienceSegments: [
    { id: "11111111-1111-4111-8111-111111111111", label: "a".repeat(180), needs: ["n".repeat(2000)], reason: "User supplied reason", selected: true, origin: "user" },
    { id: "22222222-2222-4222-8222-222222222222", label: "Unselected segment", needs: [], reason: "Keep this context too", selected: false, origin: "user" },
  ],
  competitors: [{ id: "33333333-3333-4333-8333-333333333333", name: "Local fixture competitor", relevance: "User supplied", selected: true, origin: "user" }],
  competitorReviewComplete: true,
  personality: { sincerity: 20, excitement: 30, competence: 50, sophistication: 10, ruggedness: 5 },
  positioning: "User supplied positioning", selectedName: "User supplied name", creativeLocale: "fr-CA",
  intake: { suppliedName: "Existing fixture name", namingNotes: "Preserve spelling", identityNotes: "Prefer simple shapes", step: "audience", audienceReviewedAt: "2026-10-02T00:00:00Z", example: true },
});
type StoredProject = { id: string; owner_id: string; scope: ProjectScope; title: string; current_revision: number; created_at: string };
type ExpandedProject = StoredProject & { context: ContextSnapshot };
type StoredRevision = { project_id: string; owner_id: string; revision: number; context: ContextSnapshot; input_hash: string };

describe("local PostgreSQL project drafting and expansion (not live Supabase)", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });

  async function create(scope: ProjectScope = "naming_only") {
    return asRole(db, "authenticated", OWNER_A, async () => (await db.query<StoredProject>(
      // Expansion intentionally retains its legacy seven-column RPC shape.
      "select id,owner_id,scope,title,current_revision,created_at from public.create_project($1,'Original title',$2::jsonb,$3)", [scope, context, HASH],
    )).rows[0]!);
  }
  async function expand(id: string, revision: number, owner = OWNER_A) {
    return asRole(db, "authenticated", owner, async () => (await db.query<ExpandedProject>(
      "select * from public.expand_project_scope($1,$2)", [id, revision],
    )).rows[0]!);
  }
  async function revisions(id: string) {
    return (await db.query<StoredRevision>("select * from public.project_revisions where project_id=$1 order by revision", [id])).rows;
  }

  it.each(["naming_only", "visual_identity_only"] as const)("expands %s while preserving all context, hash, title, and old revisions", async scope => {
    const project = await create(scope);
    const assetId = randomUUID(), versionId = randomUUID();
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'logo')", [assetId, OWNER_A, project.id]);
    await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance) values($1,$2,$3,$4,1,1,$5,$5,'application/json','{\"source\":\"local_fixture\"}')", [versionId, OWNER_A, project.id, assetId, HASH]);
    const versionBefore = (await db.query("select * from public.asset_versions where id=$1", [versionId])).rows;
    const before = await revisions(project.id);
    const expanded = await expand(project.id, 1);
    expect(expanded).toEqual({ ...project, scope: "complete_brand", current_revision: 2, context });
    expect((await db.query("select deleted_at,deletion_requested_at,lifecycle_version from public.projects where id=$1", [project.id])).rows)
      .toEqual([{ deleted_at: null, deletion_requested_at: null, lifecycle_version: 0 }]);
    const after = await revisions(project.id);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({ project_id: project.id, owner_id: OWNER_A, revision: 2, context, input_hash: HASH });
    await expect(db.query("update public.project_revisions set context='{}' where project_id=$1 and revision=1", [project.id])).rejects.toThrow(/immutable_history/);
    await expect(db.query("delete from public.project_revisions where project_id=$1 and revision=1", [project.id])).rejects.toThrow(/immutable_history/);
    expect((await db.query("select * from public.asset_versions where id=$1", [versionId])).rows).toEqual(versionBefore);
    expect((await db.query("select * from public.jobs")).rows).toEqual([]);
  });

  it("repeats expansion without adding a version, but rejects a stale retry", async () => {
    const project = await create();
    const expanded = await expand(project.id, 1);
    expect(await expand(project.id, 2)).toEqual(expanded);
    await expect(expand(project.id, 1)).rejects.toMatchObject({ code: "PT409" });
    expect(await revisions(project.id)).toHaveLength(2);
    const complete = await create("complete_brand");
    expect(await expand(complete.id, 1)).toEqual({ ...complete, context });
    expect(await revisions(complete.id)).toHaveLength(1);
  });

  it("hides foreign and missing projects, with no scope or context mutation", async () => {
    const project = await create();
    await expect(expand(project.id, 1, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(expand(randomUUID(), 1)).rejects.toMatchObject({ code: "P0002" });
    await asRole(db, "authenticated", OWNER_B, async () => {
      expect((await db.query("select * from public.project_revisions where project_id=$1", [project.id])).rows).toEqual([]);
      await expect(db.query("select * from public.append_project_revision($1,1,$2::jsonb,$3,'Forged title')", [project.id, context, HASH])).rejects.toMatchObject({ code: "P0002" });
    });
    expect((await db.query("select scope,title,current_revision from public.projects where id=$1", [project.id])).rows).toEqual([{ scope: "naming_only", title: "Original title", current_revision: 1 }]);
    expect(await revisions(project.id)).toHaveLength(1);
  });

  it("saves title and full context atomically, then expands the saved revision", async () => {
    const project = await create("visual_identity_only");
    const changed = { ...context, intake: { ...context.intake, namingNotes: "Changed notes" } };
    await asRole(db, "authenticated", OWNER_A, async () => {
      const result = await db.query<StoredRevision>("select * from public.append_project_revision($1,1,$2::jsonb,$3,'  Updated title  ')", [project.id, changed, "b".repeat(64)]);
      expect(result.rows[0]).toMatchObject({ revision: 2, context: changed });
      await expect(db.query("select * from public.append_project_revision($1,1,'{}',$2,'Stale title')", [project.id, HASH])).rejects.toMatchObject({ code: "PT409" });
      await expect(db.query("update public.projects set title='Bypass' where id=$1", [project.id])).rejects.toThrow(/permission denied/);
      await expect(db.query("update public.projects set scope='complete_brand' where id=$1", [project.id])).rejects.toThrow(/permission denied/);
    });
    await expect(expand(project.id, 1)).rejects.toMatchObject({ code: "PT409" });
    expect(await expand(project.id, 2)).toEqual({ ...project, title: "Updated title", scope: "complete_brand", current_revision: 3, context: changed });
    const saved = await revisions(project.id);
    expect(saved[0]?.context).toEqual(context);
    expect(saved[2]).toMatchObject({ input_hash: "b".repeat(64), context: changed });
  });

  it("rolls back the title and revision when either context persistence or title validation fails", async () => {
    const project = await create();
    await asRole(db, "authenticated", OWNER_A, async () => {
      await expect(db.query("select * from public.append_project_revision($1,1,$2::jsonb,'invalid-hash','Lost title')", [project.id, context])).rejects.toMatchObject({ code: "23514" });
      for (const title of ["  ", "x".repeat(161)]) {
        await expect(db.query("select * from public.append_project_revision($1,1,$2::jsonb,$3,$4)", [project.id, context, HASH, title])).rejects.toMatchObject({ code: "22023" });
      }
      for (const expected of [null, 0, -1]) {
        await expect(db.query("select * from public.append_project_revision($1,$2,$3::jsonb,$4,'Lost title')", [project.id, expected, context, HASH])).rejects.toMatchObject({ code: "22023" });
        await expect(db.query("select * from public.expand_project_scope($1,$2)", [project.id, expected])).rejects.toMatchObject({ code: "22023" });
      }
    });
    expect((await db.query("select title,current_revision from public.projects where id=$1", [project.id])).rows).toEqual([{ title: "Original title", current_revision: 1 }]);
    expect(await revisions(project.id)).toHaveLength(1);
  });

  it("keeps four-argument callers compatible through one defaulted RPC signature", async () => {
    const project = await create();
    await asRole(db, "authenticated", OWNER_A, async () => {
      await db.query("select * from public.append_project_revision($1,1,$2::jsonb,$3)", [project.id, context, HASH]);
      await db.query("select * from public.append_project_revision(p_project_id => $1,p_expected_revision => 2,p_context => $2::jsonb,p_input_hash => $3)", [project.id, context, HASH]);
    });
    expect((await db.query("select title,current_revision from public.projects where id=$1", [project.id])).rows).toEqual([{ title: "Original title", current_revision: 3 }]);
    expect((await db.query("select pronargs,pronargdefaults from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='append_project_revision'")).rows).toEqual([{ pronargs: 5, pronargdefaults: 1 }]);
  });

  it("denies unauthenticated and worker invocation of the user RPCs", async () => {
    const project = await create();
    for (const role of ["anon", "service_role"] as const) {
      await asRole(db, role, null, async () => {
        await expect(db.query("select * from public.expand_project_scope($1,1)", [project.id])).rejects.toThrow(/permission denied/);
        await expect(db.query("select * from public.append_project_revision($1,1,$2::jsonb,$3)", [project.id, context, HASH])).rejects.toThrow(/permission denied/);
      });
    }
    await asRole(db, "authenticated", null, async () => {
      await expect(db.query("select * from public.expand_project_scope($1,1)", [project.id])).rejects.toMatchObject({ code: "P0002" });
    });
  });

  it.each([
    "append_project_revision(uuid,integer,jsonb,text,text)",
    "expand_project_scope(uuid,integer)",
    "enqueue_strategy_job(uuid,integer,text,text,bigint)",
    "enqueue_subscription_strategy_job(uuid,integer,text,text,text)",
    "apply_strategy_job_result(uuid,uuid,integer,text)",
    "apply_strategy_job_result_v2(uuid,uuid,integer,text)",
  ])("preserves the restricted app RPC security boundary after the conflict migration: %s", async signature => {
    const name = `public.${signature}`;
    const metadata = await db.query<{ prosecdef: boolean; proconfig: string[] }>(
      "select prosecdef,proconfig from pg_proc where oid=$1::regprocedure", [name],
    );
    expect(metadata.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
    for (const role of ["authenticated", "anon", "service_role", "fixture_subscription_worker_a", "fixture_subscription_worker_b"]) {
      const privilege = await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, name]);
      expect(privilege.rows).toEqual([{ allowed: role === "authenticated" }]);
    }
  });
});
