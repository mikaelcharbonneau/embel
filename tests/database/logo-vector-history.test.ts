import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { logoWorkspaceV2Schema, type LogoWorkspaceV2 } from "../../src/domain/logo-workspace";
import { logoVectorHistoryPageSchema } from "../../src/features/logo-vector/model/history";
import { createVectorHttpFixture } from "../features/logo-vector/http-fixture";
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";

/** Disposable fixture records. Real publication retention is also covered in
 * logo-vector-publications.test.ts. This is not hosted concurrency evidence. */
describe("owned immutable vector discovery RPC", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => resetFixture(db));
  async function rpc(name: string, args: unknown[], owner = OWNER_A) {
    return asRole(db, "authenticated", owner, async () => (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) value`, args)).rows[0]!.value);
  }
  async function project(owner = OWNER_A) {
    return logoWorkspaceV2Schema.parse(await startLogoFixture(ownerQuery(db, owner), { requestKey: randomUUID(), brief: { name: "Synthetic history", activity: "Tests", audience: "Testers", personality: "Calm", logoTypes: ["combination"] } }));
  }
  async function vector(workspace: LogoWorkspaceV2, ordinal: number, earlierInputs = false) {
    const record = structuredClone(createVectorHttpFixture().initial.revision);
    record.id = `10000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
    record.ownerId = workspace.ownerId; record.projectId = workspace.projectId;
    for (const key of ["documentAsset", "svgAsset", "sourcePreview"] as const) { record[key].ownerId = workspace.ownerId; record[key].projectId = workspace.projectId; }
    record.inputRevisions = [{ ...workspace.stages.brief_references!, id: earlierInputs ? randomUUID() : workspace.stages.brief_references!.id }];
    record.createdAt = "2026-10-07T00:00:00.000Z";
    await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)", [record.id, workspace.ownerId, workspace.projectId, record]);
    return record;
  }
  async function history(workspace: LogoWorkspaceV2, query: unknown = {}) {
    return logoVectorHistoryPageSchema.parse(await rpc("list_logo_vector_history", [workspace.projectId, query], workspace.ownerId));
  }
  it("discovers off-head immutable IDs without a selection, approval or geometry read", async () => {
    const w = await project(), v = await vector(w, 1), before = await rpc("get_logo_workspace", [w.projectId]);
    const result = await history(w);
    expect(result.items).toEqual([{ vectorRevisionId: v.id, parentRevisionId: null, createdAt: v.createdAt, source: v.source, lockCount: 0,
      selection: "retained", acceptance: "unaccepted", earlierInputs: false, cancellation: "none", stageRevision: null }]);
    expect(result.workspaceRevision).toBe(w.heads.workspaceRevision); expect(result.nextCursor).toBeNull();
    expect(await rpc("get_logo_workspace", [w.projectId])).toEqual(before);
    expect((await db.query<{ record: unknown }>("select record from public.logo_vector_revisions where id=$1", [v.id])).rows[0]!.record).toEqual(v);
  });
  it("uses scoped exact anchors and stable tie-breaking for small immutable pages", async () => {
    const w = await project(); await vector(w, 1); await vector(w, 2); await vector(w, 3);
    const first = await history(w, { limit: 1 }), second = await history(w, { limit: 1, cursor: first.nextCursor }), third = await history(w, { limit: 1, cursor: second.nextCursor });
    expect([first, second, third].flatMap(page => page.items.map(item => item.vectorRevisionId))).toEqual([3, 2, 1].map(n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`));
    expect(third.nextCursor).toBeNull();
    const another = await project();
    await expect(history(another, { cursor: first.nextCursor })).rejects.toMatchObject({ code: "22023" });
    const forged = JSON.parse(Buffer.from(first.nextCursor!, "base64").toString("utf8")); forged.createdAt = "2026-10-07T00:00:01.000Z";
    await expect(history(w, { cursor: Buffer.from(JSON.stringify(forged)).toString("base64") })).rejects.toMatchObject({ code: "22023" });
  });
  it("fences changed-workspace pages and projects actual current, accepted and stale state", async () => {
    const w = await project(), v = await vector(w, 1), other = await vector(w, 2, true);
    const first = await history(w, { limit: 1 });
    const activation = (await db.query<{ value: { id: string; createdAt: string } }>("select fluid_private.logo_append_stage($1,$2,'vector',$3,$4) value", [w.ownerId, w.projectId, { vectorRevisionId: v.id, approvalId: null }, v.inputRevisions])).rows[0]!.value;
    await expect(history(w, { cursor: first.nextCursor })).rejects.toMatchObject({ code: "PT409" });
    const result = await history(w);
    expect(result.items.find(item => item.vectorRevisionId === v.id)).toMatchObject({ selection: "current", acceptance: "unaccepted", stageRevision: { stage: "vector", id: activation.id, revision: 1 } });
    expect(result.items.find(item => item.vectorRevisionId === other.id)).toMatchObject({ selection: "retained", earlierInputs: true, stageRevision: null });
    const approvalId = randomUUID();
    const acceptedStage = (await db.query<{ value: { id: string; createdAt: string } }>("select fluid_private.logo_append_stage($1,$2,'vector',$3,$4) value", [w.ownerId, w.projectId, { vectorRevisionId: v.id, approvalId }, v.inputRevisions])).rows[0]!.value;
    await db.query("insert into public.logo_approvals(id,owner_id,project_id,vector_revision_id,stage_revision_id,record) values($1,$2,$3,$4,$5,$6)", [approvalId, w.ownerId, w.projectId, v.id, acceptedStage.id,
      { id: approvalId, ownerId: w.ownerId, projectId: w.projectId, vectorRevisionId: v.id, stageRevisionId: acceptedStage.id, approvedAt: acceptedStage.createdAt }]);
    expect((await history(w)).items.find(item => item.vectorRevisionId === v.id)?.acceptance).toBe("approved");
    await db.query("select fluid_private.logo_append_stage($1,$2,'vector',$3,$4)", [w.ownerId, w.projectId, { vectorRevisionId: other.id, approvalId: null }, []]);
    expect((await history(w)).items.find(item => item.vectorRevisionId === v.id)?.acceptance).toBe("previously_accepted");
  });
  it("enforces owner/project isolation and strict query bounds at SQL", async () => {
    const w = await project(); await vector(w, 1);
    await expect(rpc("list_logo_vector_history", [w.projectId, {}], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(asRole(db, "anon", null, () => db.query("select public.list_logo_vector_history($1,'{}')", [w.projectId]))).rejects.toMatchObject({ code: "42501" });
    for (const query of [{ ownerId: OWNER_B }, { limit: 0 }, { limit: 51 }, { limit: "2" }, { cursor: "e30=" }, { cursor: "!!!!" }, { cursor: "A".repeat(2052) }, { cursor: null }]) {
      await expect(history(w, query)).rejects.toMatchObject({ code: "22023" });
    }
  });
  it("scrubs every inherited function grant and grants only authenticated read execution", async () => {
    const sql = await readFile(new URL("../../supabase/migrations/20261007011700_logo_vector_history.sql", import.meta.url), "utf8");
    await db.exec("create role fixture_history_hostile nologin; alter default privileges in schema public grant execute on functions to fixture_history_hostile with grant option;");
    try {
      await db.exec("drop function public.list_logo_vector_history(uuid,jsonb); drop index public.logo_vector_history_order,public.logo_vector_history_selections,fluid_private.logo_vector_history_publications;"); await db.exec(sql);
      const grants = await db.query<{ rolname: string }>("select pg_get_userbyid(a.grantee) rolname from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid='public.list_logo_vector_history(uuid,jsonb)'::regprocedure and a.grantee<>p.proowner");
      expect(grants.rows).toEqual([{ rolname: "authenticated" }]);
    } finally { await db.exec("alter default privileges in schema public revoke all on functions from fixture_history_hostile;"); }
  });
});
