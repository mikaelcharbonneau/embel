import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { asRole, createTestDatabase, HASH, OWNER_A, resetFixture, type TestDatabase } from "./local-supabase";
import { contextSnapshotSchema } from "../../src/domain/projects";

const candidateUrl = new URL("../../supabase/candidates/standalone_workspace_conflict_codes.sql", import.meta.url);
const signature = "public.save_standalone_workspace(text,integer,uuid,jsonb,jsonb)";
const conflicts = ["request_conflict", "revision_conflict", "source_conflict"] as const;
const requestKey = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
const domain = (input = "Local conflict fixture") => ({ version: 1, input, extensions: ["com"], candidates: [] });
const expectedDefinition = (definition: string) => conflicts.reduce((patched, conflict) =>
  patched.replace(`raise exception '${conflict}' using errcode='40001'`, `raise exception '${conflict}' using errcode='PT409'`), definition);
type FunctionSnapshot = { definition: string; metadata: Record<string, unknown> };

describe("standalone deterministic conflicts use non-retryable SQLSTATE (local PGlite)", () => {
  let db: TestDatabase;
  let candidate: string;
  let original: FunctionSnapshot;
  let patched: FunctionSnapshot;
  let reapplied: FunctionSnapshot;
  let otherFunctions: unknown[];
  const functionSnapshot = async (database: TestDatabase = db) => (await database.query<FunctionSnapshot>(
    "select pg_get_functiondef(p.oid) as definition, to_jsonb(p) - 'prosrc' as metadata from pg_proc p where p.oid=$1::regprocedure",
    [signature],
  )).rows[0]!;
  const otherFunctionSnapshot = async () => (await db.query(
    "select to_jsonb(p) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','fluid_private') and p.oid<>$1::regprocedure order by p.oid",
    [signature],
  )).rows;
  beforeAll(async () => {
    candidate = await readFile(candidateUrl, "utf8");
    let beforeMigrationSnapshot: FunctionSnapshot | undefined;
    db = await createTestDatabase({ beforeMigration: async (database, sql) => {
      if (sql === candidate) beforeMigrationSnapshot = await functionSnapshot(database);
    } });
    original = beforeMigrationSnapshot ?? await functionSnapshot();
    otherFunctions = await otherFunctionSnapshot();
    await db.exec(candidate);
    patched = await functionSnapshot();
    await db.exec(candidate);
    reapplied = await functionSnapshot();
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });
  const save = (revision: number, nonce: number, payload = domain(), imports: unknown[] = []) =>
    asRole(db, "authenticated", OWNER_A, () => db.query(
      "select public.save_standalone_workspace('domains',$1,$2,$3::jsonb,$4::jsonb) as result",
      [revision, requestKey(nonce), JSON.stringify(payload), JSON.stringify(imports)],
    ));
  const dataSnapshot = async () => ({
    heads: (await db.query("select * from public.standalone_workspaces order by id")).rows,
    history: (await db.query("select * from public.standalone_workspace_revisions order by workspace_id,revision")).rows,
    projects: (await db.query("select * from public.projects order by id")).rows,
    projectHistory: (await db.query("select * from public.project_revisions order by project_id,revision")).rows,
  });

  it("returns PT409 for a stale revision rather than retryable 40001", async () => {
    await save(0, 1);
    const before = await dataSnapshot();
    await expect(save(0, 2)).rejects.toMatchObject({ code: "PT409", message: "revision_conflict" });
    expect(await dataSnapshot()).toEqual(before);
  });

  it("returns PT409 for a reused request key with changed payload without mutating data", async () => {
    await save(0, 1);
    const before = await dataSnapshot();
    await expect(save(0, 1, domain("Changed local draft"))).rejects.toMatchObject({ code: "PT409", message: "request_conflict" });
    expect(await dataSnapshot()).toEqual(before);
  });

  it("returns PT409 for a stale fresh import without creating a workspace or revision", async () => {
    const context = contextSnapshotSchema.parse({ description: "Local source conflict fixture", selectedName: "Cedar", intake: { suppliedName: "Cedar" } });
    const project = await asRole(db, "authenticated", OWNER_A, () => db.query<{ id: string }>(
      "select * from public.create_project('naming_only','Local source fixture',$1::jsonb,$2)", [JSON.stringify(context), HASH],
    ));
    const projectId = project.rows[0]!.id;
    await asRole(db, "authenticated", OWNER_A, () => db.query(
      "select public.append_project_revision($1,1,$2::jsonb,$3)", [projectId, JSON.stringify(context), HASH],
    ));
    const before = await dataSnapshot();
    await expect(save(0, 1, domain(), [{ projectId, projectRevision: 1, selectionId: null }]))
      .rejects.toMatchObject({ code: "PT409", message: "source_conflict" });
    expect(await dataSnapshot()).toEqual(before);
    expect(before.heads).toEqual([]);
    expect(before.history).toEqual([]);
  });

  it("preserves identical replay without advancing the head or adding history", async () => {
    const saved = (await save(0, 1)).rows;
    const before = await dataSnapshot();
    expect((await save(0, 1)).rows).toEqual(saved);
    expect(await dataSnapshot()).toEqual(before);
    expect(before.heads).toHaveLength(1);
    expect(before.history).toHaveLength(1);
  });

  it("changes only the three SQLSTATE literals and preserves every other function and catalog field", async () => {
    for (const conflict of conflicts) {
      expect(original.definition.split(`raise exception '${conflict}' using errcode='40001'`)).toHaveLength(2);
    }
    expect(patched.definition).toBe(expectedDefinition(original.definition));
    expect(patched.definition).not.toContain("40001");
    // Includes OID, owner, ACL, argument names/types, result type, SECURITY DEFINER,
    // search_path, language, volatility and every other pg_proc attribute.
    expect(patched.metadata).toEqual(original.metadata);
    expect(reapplied).toEqual(patched);
    expect(await otherFunctionSnapshot()).toEqual(otherFunctions);
  });

  it("preserves nondefault owner and ACL on first application and repeated application", async () => {
    await db.exec("begin");
    try {
      await db.exec(original.definition);
      await db.exec(`
        create role fixture_standalone_patch_owner nologin;
        create role fixture_standalone_patch_grantee nologin;
        alter function ${signature} owner to fixture_standalone_patch_owner;
        grant execute on function ${signature} to fixture_standalone_patch_grantee;
      `);
      const before = await functionSnapshot();
      await db.exec(candidate);
      expect(await functionSnapshot()).toEqual({ definition: expectedDefinition(before.definition), metadata: before.metadata });
      await db.exec(candidate);
      expect(await functionSnapshot()).toEqual({ definition: expectedDefinition(before.definition), metadata: before.metadata });
    } finally { await db.exec("rollback"); }
  });

  it("can be reapplied with saved data without changing heads or immutable history", async () => {
    await save(0, 1);
    await save(1, 2, domain("Second local draft"));
    const before = await dataSnapshot();
    await db.exec(candidate);
    await db.exec(candidate);
    expect(await dataSnapshot()).toEqual(before);
    expect(await functionSnapshot()).toEqual(patched);
  });

  it.each([
    { label: "missing expected conflict branch", change: (definition: string) => definition.replace("raise exception 'request_conflict'", "raise exception 'changed_request_conflict'"), message: "Unexpected standalone workspace conflict definition: request_conflict" },
    { label: "duplicate expected conflict branch", change: (definition: string) => definition.replace("begin\n", "begin\n  if false then raise exception 'request_conflict' using errcode='40001'; end if;\n"), message: "Unexpected standalone workspace conflict definition: request_conflict" },
    { label: "unexpected retryable branch", change: (definition: string) => definition.replace("begin\n", "begin\n  if false then raise exception 'unknown_conflict' using errcode='40001'; end if;\n"), message: "Unexpected retryable SQLSTATE in standalone workspace definition" },
  ])("rejects $label without partially replacing the installed function", async ({ change, message }) => {
    await db.exec("begin");
    try {
      await db.exec(change(original.definition));
      const before = await functionSnapshot();
      await db.exec("savepoint candidate_failure");
      await expect(db.exec(candidate)).rejects.toMatchObject({ code: "P0001", message });
      await db.exec("rollback to savepoint candidate_failure");
      expect(await functionSnapshot()).toEqual(before);
      expect(await otherFunctionSnapshot()).toEqual(otherFunctions);
    } finally { await db.exec("rollback"); }
  });
});
