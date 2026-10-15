import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
vi.mock("server-only", () => ({}));
import { createTestDatabase, resetFixture, asRole, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { getNamesWorkspace, saveNamesWorkspace } from "../../src/server/data/names-workspace";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { createEmptyNamesWorkspace, MAX_NAMES_BYTES, namesWorkspaceSchema, type NamesWorkspace, type NamesWorkspaceResponse } from "../../src/domain/names-workspace";
import { transformNames, type NameTransformInput } from "../../src/domain/naming";
import { namesFixtureId as id, namesWorkspaceFixture } from "../fixtures/names-workspace";

const migration = new URL("../../supabase/migrations/20261015201757_names_account_workspace.sql", import.meta.url);
describe("Names workspace database ownership and save recovery (local synthetic users)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ before: "20261015011434_terminal_research_operator_adjudication.sql" });
    await db.exec(`create role fixture_names_unrelated_worker nologin;
      alter default privileges in schema public grant all on tables to public,anon,authenticated,service_role,fixture_names_unrelated_worker;
      alter default privileges in schema fluid_private grant all on tables to public,anon,authenticated,service_role,fixture_names_unrelated_worker;
      alter default privileges in schema public grant all on functions to public,anon,authenticated,service_role,fixture_names_unrelated_worker;
      alter default privileges in schema fluid_private grant all on functions to public,anon,authenticated,service_role,fixture_names_unrelated_worker;`);
    await db.exec(await readFile(migration, "utf8"));
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });
  const run = <T>(fn: () => Promise<T>, owner = OWNER_A) => asRole(db, "authenticated", owner, fn);
  async function read(owner = OWNER_A) {
    return run(async () => (await db.query<{ result: NamesWorkspaceResponse }>("select public.get_names_workspace() as result")).rows[0]!.result, owner);
  }
  async function save(revision = 0, nonce = 1, payload: unknown = namesWorkspaceFixture(), owner = OWNER_A) {
    return run(async () => (await db.query<{ result: NamesWorkspaceResponse }>("select public.save_names_workspace($1,$2,$3::jsonb) as result", [revision, id(nonce), JSON.stringify(payload)])).rows[0]!.result, owner);
  }
  const auth = (owner = OWNER_A) => ({ userId: owner, client: { rpc: async (name: string, args: Record<string, unknown>) => {
    try {
      const data = name === "get_names_workspace" ? await read(owner) : await run(async () => (await db.query<{ result: unknown }>(
        "select public.save_names_workspace($1,$2,$3::jsonb) as result", [args.p_expected_revision, args.p_request_key, JSON.stringify(args.p_payload)],
      )).rows[0]!.result, owner);
      return { data, error: null };
    } catch (error) { return { data: null, error: { code: (error as { code: string }).code } }; }
  } } }) as unknown as AuthenticatedContext;

  it("saves and reloads full legacy workshop state through the real service, with two-owner isolation", async () => {
    expect(await getNamesWorkspace(auth())).toEqual({ ownerId: OWNER_A, workspace: null });
    const first = await saveNamesWorkspace(auth(), { expectedRevision: 0, requestKey: id(1), payload: namesWorkspaceFixture() });
    expect(first.workspace).toMatchObject({ ownerId: OWNER_A, revision: 1, payload: namesWorkspaceFixture() });
    expect(await getNamesWorkspace(auth())).toEqual(first);
    expect(await getNamesWorkspace(auth(OWNER_B))).toEqual({ ownerId: OWNER_B, workspace: null });
    expect((await run(() => db.query("select * from public.names_workspaces"), OWNER_B)).rows).toEqual([]);
    const other = await save(0, 1, createEmptyNamesWorkspace(), OWNER_B);
    expect(other.workspace?.id).not.toBe(first.workspace?.id);
  });
  it("detects stale saves atomically and retries a lost acknowledgement exactly after a later save", async () => {
    const first = await save();
    const payload = namesWorkspaceFixture(); payload.ui.query = "next edit"; payload.revision++;
    const second = await save(1, 2, payload);
    expect(await save()).toEqual(first);
    expect(await read()).toEqual(second);
    await expect(save(1, 3)).rejects.toMatchObject({ code: "PT409" });
    await expect(save(0, 1, payload)).rejects.toMatchObject({ code: "PT409" });
    await expect(save(1, 1)).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select count(*)::int total from fluid_private.names_workspace_requests")).rows).toEqual([{ total: 2 }]);
    expect(await getNamesWorkspace(auth())).toEqual(second);
    expect(await saveNamesWorkspace(auth(), { expectedRevision: 0, requestKey: id(1), payload: namesWorkspaceFixture() })).toEqual(first);
  });
  it("rolls back both head creation and advancement when recording an acknowledgement fails", async () => {
    const first = await save();
    await db.exec(`create function public.fixture_reject_names_receipt() returns trigger language plpgsql as $$ begin raise exception 'fixture failure' using errcode='23514'; end $$;
      create trigger fixture_reject_names before insert on fluid_private.names_workspace_requests for each row execute function public.fixture_reject_names_receipt();`);
    try {
      await expect(save(1, 2)).rejects.toMatchObject({ code: "23514" });
      await expect(save(0, 2, namesWorkspaceFixture(), OWNER_B)).rejects.toMatchObject({ code: "23514" });
      expect(await read()).toEqual(first); expect((await read(OWNER_B)).workspace).toBeNull();
    } finally { await db.exec("drop trigger fixture_reject_names on fluid_private.names_workspace_requests; drop function public.fixture_reject_names_receipt()"); }
  });
  it("denies raw writes, receipt/helper access and anonymous/service/worker RPCs despite hostile default grants", async () => {
    await save();
    await expect(run(() => db.query("update public.names_workspaces set revision=2"))).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("delete from public.names_workspaces"))).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("select * from fluid_private.names_workspace_requests"))).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("select fluid_private.names_workspace_payload('{}')"))).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("select fluid_private.save_names_workspace(0,$1,$2)", [id(2), JSON.stringify(namesWorkspaceFixture())]))).rejects.toMatchObject({ code: "42501" });
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(db, role, OWNER_A, () => db.query("select public.get_names_workspace()"))).rejects.toMatchObject({ code: "42501" });
      await expect(asRole(db, role, OWNER_A, () => db.query("select public.save_names_workspace(0,$1,$2)", [id(2), JSON.stringify(namesWorkspaceFixture())]))).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asRole(db, "authenticated", null, () => db.query("select public.get_names_workspace()"))).rejects.toMatchObject({ code: "42501" });
    const secure = await db.query(`select bool_and(relrowsecurity and relforcerowsecurity) secure from pg_class where oid in('public.names_workspaces'::regclass,'fluid_private.names_workspace_requests'::regclass)`);
    expect(secure.rows).toEqual([{ secure: true }]);
    for (const role of ["anon", "service_role", "fixture_names_unrelated_worker"]) {
      expect((await db.query("select has_table_privilege($1,'public.names_workspaces','SELECT,INSERT,UPDATE,DELETE') raw, has_function_privilege($1,'public.save_names_workspace(integer,uuid,jsonb)','EXECUTE') rpc, has_function_privilege($1,'fluid_private.save_names_workspace(integer,uuid,jsonb)','EXECUTE') helper", [role])).rows).toEqual([{ raw: false, rpc: false, helper: false }]);
    }
    await expect(db.query("update fluid_private.names_workspace_requests set expected_revision=1")).rejects.toMatchObject({ code: "55000" });
  });
  it.each([
    (p: NamesWorkspace) => ({ ...p, ownerId: OWNER_B }),
    (p: NamesWorkspace) => ({ ...p, version: 2 }),
    (p: NamesWorkspace) => ({ ...p, revision: -1 }),
    (p: NamesWorkspace) => ({ ...p, ui: { ...p.ui, tab: null } }),
    (p: NamesWorkspace) => ({ ...p, candidates: [...p.candidates, p.candidates[0]] }),
    (p: NamesWorkspace) => ({ ...p, ui: { ...p.ui, comparisonIds: [id(999)] } }),
    (p: NamesWorkspace) => ({ ...p, runs: [{ ...p.runs[0], parentId: id(999) }, p.runs[1]] }),
    (p: NamesWorkspace) => ({ ...p, runs: [{ ...p.runs[0], candidateIds: [] }, p.runs[1]] }),
    (p: NamesWorkspace) => ({ ...p, ui: { ...p.ui, guided: { ...p.ui.guided, savedLists: [{ words: [] }] } } }),
    (p: NamesWorkspace) => ({ ...p, ui: { ...p.ui, guided: { ...p.ui.guided, tweaks: [null] } } }),
  ])("rejects malformed graph and control claims at the direct SQL boundary", async mutate => {
    await expect(save(0, 1, mutate(namesWorkspaceFixture()))).rejects.toMatchObject({ code: "22023" });
    expect((await read()).workspace).toBeNull();
  });
  it("revalidates deterministic claims at the service read boundary without approximating Unicode in SQL", async () => {
    const payload = namesWorkspaceFixture();
    payload.candidates[1]!.explanation = "Invented explanation";
    expect(namesWorkspaceSchema.safeParse(payload).success).toBe(false);
    await save(0, 1, payload);
    await expect(getNamesWorkspace(auth())).rejects.toMatchObject({ code: "integration_unavailable" });
    await expect(saveNamesWorkspace(auth(), { expectedRevision: 1, requestKey: id(2), payload })).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("retains exact 4 MB V1 capacity rather than applying the smaller screening-workspace cap", async () => {
    const payload = createEmptyNamesWorkspace(), manual = namesWorkspaceFixture().candidates[0]!;
    payload.candidates = Array.from({ length: 400 }, (_, index) => ({ ...manual, source: { ...manual.source, id: id(1000 + index) },
      context: { ...manual.context, description: "" } }));
    let remaining = MAX_NAMES_BYTES - Buffer.byteLength(JSON.stringify(payload));
    payload.candidates.forEach(candidate => {
      const length = Math.min(12000, remaining); candidate.context.description = "x".repeat(length); remaining -= length;
    });
    expect(remaining).toBe(0);
    expect(namesWorkspaceSchema.safeParse(payload).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBe(MAX_NAMES_BYTES);
    const saved = await saveNamesWorkspace(auth(), { expectedRevision: 0, requestKey: id(1), payload });
    expect(saved.workspace?.payload).toEqual(payload);
    expect(await getNamesWorkspace(auth())).toEqual(saved);
    const tooLarge = structuredClone(payload);
    tooLarge.candidates.find(candidate => candidate.context.description.length < 12000)!.context.description += "x";
    expect(Buffer.byteLength(JSON.stringify(tooLarge))).toBe(MAX_NAMES_BYTES + 1);
    await expect(save(1, 2, tooLarge)).rejects.toMatchObject({ code: "54000" });
    expect(await read()).toEqual(saved);
  }, 30_000);
  it("preserves the existing 500-name and 100-run graph capacity", async () => {
    const payload = createEmptyNamesWorkspace(), manual = namesWorkspaceFixture().candidates[0]!;
    payload.candidates = Array.from({ length: 400 }, (_, index) => ({ ...manual, source: { ...manual.source, id: id(1000 + index) } }));
    for (let index = 0; index < 100; index++) {
      const parent = payload.candidates[0]!, runId = id(3000 + index), candidateId = id(2000 + index);
      const input: NameTransformInput = { kind: "affixes", seed: parent.source.value, prefixes: [`Variant${index}`], suffixes: [], separator: "" };
      const result = transformNames(input), output = result.candidates[0]!;
      payload.runs.push({ id: runId, input, parentId: parent.source.id, candidateIds: [candidateId], context: parent.context,
        createdAt: parent.source.createdAt, notes: result.notes, truncated: result.truncated });
      payload.candidates.push({ ...parent, source: { ...parent.source, id: candidateId, value: output.value, origin: "workshop",
        history: [{ id: runId, input, output: output.value, createdAt: parent.source.createdAt }] }, runId, explanation: output.explanation });
    }
    expect(namesWorkspaceSchema.safeParse(payload).success).toBe(true);
    const saved = await saveNamesWorkspace(auth(), { expectedRevision: 0, requestKey: id(1), payload });
    expect(await getNamesWorkspace(auth())).toEqual(saved);
    const tooMany = structuredClone(payload); tooMany.candidates.push({ ...manual, source: { ...manual.source, id: id(4000) } });
    await expect(save(1, 2, tooMany)).rejects.toMatchObject({ code: "22023" });
    expect(await read()).toEqual(saved);
  });
  it("executes the native rollback qualification packet without retaining synthetic accounts or workspaces", async () => {
    const packet = await readFile(new URL("../../supabase/tests/names_account_workspace_qualification.sql", import.meta.url), "utf8");
    await db.exec(packet);
    expect((await db.query("select count(*)::int total from public.names_workspaces")).rows).toEqual([{ total: 0 }]);
    expect((await db.query("select count(*)::int total from auth.users")).rows).toEqual([{ total: 2 }]);
    expect((await db.query("select to_regclass('pg_temp.names_qualification') is null removed")).rows).toEqual([{ removed: true }]);
  });
});
