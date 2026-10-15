import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";

const migrationName = "20261015232500_project_soft_deletion.sql";
const signatures = [
  "fluid_private.require_active_project(uuid,uuid)",
  "fluid_private.guard_project_content_lifecycle()",
  "fluid_private.guard_project_job_admission()",
  "fluid_private.guard_project_lifecycle_change()",
  "public.set_project_deleted(uuid,integer,integer,boolean)",
];

/** Independent synthetic PostgreSQL review. No hosted database/provider access. */
describe("independent project deletion safety review", () => {
  let db: TestDatabase;
  let oldFunctionIds: number[] = [];
  beforeAll(async () => {
    db = await createTestDatabase({ before: migrationName });
    oldFunctionIds = (await db.query<{ oid: number }>("select oid::int from pg_proc")).rows.map(row => row.oid);
    // Simulate pre-existing default EXECUTE privileges on a restricted worker.
    await db.exec(`alter default privileges in schema public grant execute on functions to fixture_subscription_worker_a;
      alter default privileges in schema fluid_private grant execute on functions to fixture_subscription_worker_a;`);
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url), "utf8"));
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });
  async function transition(projectId: string, version: number, deleted: boolean, owner = OWNER_A) {
    return asRole(db, "authenticated", owner, async () => (await db.query<{ id: string; deleted_at: Date | null; lifecycle_version: number }>(
      "select * from public.set_project_deleted($1,1,$2,$3)", [projectId, version, deleted],
    )).rows[0]!);
  }

  it.each(signatures)("scrubs inherited worker EXECUTE on %s", async signature => {
    expect((await db.query<{ allowed: boolean }>("select has_function_privilege('fixture_subscription_worker_a',$1,'EXECUTE') as allowed", [signature])).rows).toEqual([{ allowed: false }]);
  });

  it("leaves no newly-created lifecycle function executable by an inherited worker", async () => {
    const leaked = await db.query<{ signature: string }>("select oid::regprocedure::text as signature from pg_proc where oid<>all($1::oid[]) and has_function_privilege('fixture_subscription_worker_a',oid,'EXECUTE')", [oldFunctionIds]);
    expect(leaked.rows).toEqual([]);
  });

  it("rejects stale delete/restore requests across repeated lifecycle cycles", async () => {
    const project = await seedProject(db);
    expect(await transition(project.id, 0, true)).toMatchObject({ lifecycle_version: 1 });
    expect(await transition(project.id, 1, false)).toMatchObject({ lifecycle_version: 2, deleted_at: null });
    await expect(transition(project.id, 0, true)).rejects.toMatchObject({ code: "PT409" });
    expect(await transition(project.id, 2, true)).toMatchObject({ lifecycle_version: 3 });
    await expect(transition(project.id, 1, false)).rejects.toMatchObject({ code: "PT409" });
    await expect(transition(project.id, 3, false, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  });

  it("preserves owned asset/history reads but fences content mutations until restoration", async () => {
    const project = await seedProject(db), assetId = randomUUID();
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'fixture')", [assetId, OWNER_A, project.id]);
    await transition(project.id, 0, true);
    await asRole(db, "authenticated", OWNER_A, async () => {
      expect((await db.query("select * from public.project_revisions where project_id=$1", [project.id])).rows).toHaveLength(1);
      expect((await db.query("select * from public.assets where id=$1", [assetId])).rows).toHaveLength(1);
      await expect(db.query("select public.set_asset_retention($1,0,false,true)", [assetId])).rejects.toMatchObject({ code: "PT409" });
      await expect(db.query("select public.append_project_revision($1,1,'{}',$2)", [project.id, HASH])).rejects.toMatchObject({ code: "PT409" });
    });
    await transition(project.id, 1, false);
    await asRole(db, "authenticated", OWNER_A, async () => {
      await db.query("select public.set_asset_retention($1,0,false,true)", [assetId]);
    });
    expect((await db.query("select saved from public.assets where id=$1", [assetId])).rows).toEqual([{ saved: true }]);
  });
  it("fences post-deletion storage INSERT against an already-created immutable manifest", async () => {
    const project = await seedProject(db), assetId = randomUUID(), versionId = randomUUID();
    const path = `${OWNER_A}/${project.id}/${assetId}/${versionId}`;
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'fixture')", [assetId, OWNER_A, project.id]);
    await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance,storage_path) values($1,$2,$3,$4,1,1,$5,$5,'image/png','{}',$6)", [versionId, OWNER_A, project.id, assetId, HASH, path]);
    await transition(project.id, 0, true);
    await expect(asRole(db, "authenticated", OWNER_A, async () => {
      await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, OWNER_A]);
    })).rejects.toThrow();
    await transition(project.id, 1, false);
    await asRole(db, "authenticated", OWNER_A, async () => {
      await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, OWNER_A]);
    });
    await transition(project.id, 2, true);
    const reads = await asRole(db, "authenticated", OWNER_A, () => db.query("select name from storage.objects where name=$1", [path]));
    expect(reads.rows).toEqual([{ name: path }]);
  });

  it("keeps unlinked Home uploads available but fences linked deleted-project uploads", async () => {
    const project = await seedProject(db);
    const unlinked = randomUUID(), linked = randomUUID(), blobA = randomUUID(), blobB = randomUUID();
    await db.query(`insert into public.home_attachments(id,owner_id,request_key,input,blob_version_id,name,mime_type,content_hash,byte_length,verified,project_id,project_revision)
      values($1,$2,gen_random_uuid(),'{}',$3,'unlinked.txt','text/plain',$4,12,false,null,null),
      ($5,$2,gen_random_uuid(),'{}',$6,'linked.txt','text/plain',$4,12,true,$7,1)`, [unlinked, OWNER_A, blobA, HASH, linked, blobB, project.id]);
    await transition(project.id, 0, true);
    await db.query("select set_config('storage.operation','object.upload',false)");
    try {
      await asRole(db, "authenticated", OWNER_A, () => db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [`${OWNER_A}/home/${unlinked}/${blobA}`, OWNER_A]));
      await expect(asRole(db, "authenticated", OWNER_A, () => db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [`${OWNER_A}/home/${linked}/${blobB}`, OWNER_A]))).rejects.toThrow();
    } finally { await db.query("select set_config('storage.operation','',false)"); }
  });
});
