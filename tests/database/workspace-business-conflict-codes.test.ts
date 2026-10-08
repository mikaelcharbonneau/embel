import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { ideaContentSchema, ideaProjectInput, type IdeaRecord } from "@/domain/ideas";
import { contextSnapshotSchema } from "@/domain/projects";

const candidateUrl = new URL("../../supabase/candidates/workspace_business_conflict_codes.sql", import.meta.url);
const targets = [
  { signature: "public.update_idea(uuid,integer,uuid,jsonb)", conflicts: { revision_conflict: 2 } },
  { signature: "public.create_idea_brand(uuid,integer,uuid,jsonb,text)", conflicts: { revision_conflict: 1, idea_link_capacity: 1 } },
  { signature: "public.attach_idea_to_project(jsonb)", conflicts: { request_conflict: 1, revision_conflict: 1 } },
  { signature: "public.promote_standalone_workspace(jsonb)", conflicts: { request_conflict: 1, revision_conflict: 1 } },
  { signature: "public.save_attached_home_project(jsonb,text)", conflicts: { home_request_conflict: 1, home_attachment_conflict: 2 } },
] as const;
const expectedDefinition = (definition: string, conflicts: Record<string, number>) => Object.keys(conflicts).reduce((sql, conflict) =>
  sql.replaceAll(`raise exception '${conflict}' using errcode='40001'`, `raise exception '${conflict}' using errcode='PT409'`), definition);
type Snapshot = { signature: string; definition: string; metadata: Record<string, unknown> };
const context = contextSnapshotSchema.parse({ description: "Explicit local conflict fixture", selectedName: "Cedar" });
const content = (title = "Frozen Idea") => ideaContentSchema.parse({ title, description: "Original local source" });
const domain = (name = "cedar") => ({ version: 1, input: name, extensions: ["com"], candidates: [`${name}.com`] });
const homeInput = (ids: string[] = []) => ({ requestKey: randomUUID(), project: { title: "Local Home brand", scope: "complete_brand", context }, attachmentIds: ids });

describe("HTTP-accessible workspace business conflicts (local PGlite, no hosted calls)", () => {
  let db: TestDatabase;
  let candidate: string;
  let originals: Snapshot[];
  let patched: Snapshot[];
  let otherFunctions: unknown[];
  let migrationOriginalOtherFunctions: unknown[];
  let migrationPatchedOtherFunctions: unknown[];
  const snapshot = async (database: TestDatabase = db) => {
    const result: Snapshot[] = [];
    for (const { signature } of targets) result.push((await database.query<Snapshot>(
      "select $1::text signature,pg_get_functiondef(p.oid) definition,to_jsonb(p)-'prosrc' metadata from pg_proc p where p.oid=$1::regprocedure", [signature],
    )).rows[0]!);
    return result;
  };
  const untouched = async (database: TestDatabase = db) => (await database.query(
    "select to_jsonb(p) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','fluid_private') and p.oid not in (select unnest($1::regprocedure[])) order by p.oid",
    [targets.map(t => t.signature)],
  )).rows;
  beforeAll(async () => {
    // Absent candidate deliberately leaves the actual baseline RPCs installed for RED.
    candidate = await readFile(candidateUrl, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    let beforeMigrationSnapshot: Snapshot[] | undefined;
    let beforeMigrationOthers: unknown[] | undefined;
    let afterMigrationSnapshot: Snapshot[] | undefined;
    let afterMigrationOthers: unknown[] | undefined;
    db = await createTestDatabase({ beforeMigration: async (database, sql) => {
      // The next before-hook runs immediately after this migration, before any
      // later migration can legitimately change an unrelated function.
      if (beforeMigrationSnapshot && !afterMigrationSnapshot) {
        afterMigrationSnapshot = await snapshot(database);
        afterMigrationOthers = await untouched(database);
      }
      if (sql === candidate) {
        beforeMigrationSnapshot = await snapshot(database);
        beforeMigrationOthers = await untouched(database);
      }
    } });
    originals = beforeMigrationSnapshot ?? await snapshot();
    migrationOriginalOtherFunctions = beforeMigrationOthers ?? await untouched();
    // If the candidate is not yet a migration, execute it against the captured
    // baseline. A final migration needs no next hook: the completed fixture is
    // still its immediate after-state. Later idempotence uses the full chain.
    if (!beforeMigrationSnapshot && candidate) await db.exec(candidate);
    patched = afterMigrationSnapshot ?? await snapshot();
    migrationPatchedOtherFunctions = afterMigrationOthers ?? await untouched();
    otherFunctions = await untouched();
  }, 30_000);
  beforeEach(async () => resetFixture(db));
  afterAll(async () => db?.close());
  async function rpc<T = unknown>(name: string, args: unknown[], owner = OWNER_A): Promise<T> {
    return asRole(db, "authenticated", owner, async () => (await db.query<{ value: T }>(
      `select public.${name}(${args.map((_, n) => `$${n + 1}`).join(",")}) value`,
      args.map(value => value !== null && typeof value === "object" ? JSON.stringify(value) : value),
    )).rows[0]!.value);
  }
  const idea = () => rpc<IdeaRecord>("create_idea", [randomUUID(), content()]);
  const update = (i: IdeaRecord, key = randomUUID(), value = content("Later Idea")) => rpc<IdeaRecord>("update_idea", [i.id, i.revision, key, value]);
  const brand = (i: IdeaRecord, key = randomUUID()) => {
    const c = ideaProjectInput(i.content).context;
    return rpc<{ idea: IdeaRecord; link: { projectId: string } }>("create_idea_brand", [i.id, i.revision, key, c, createHash("sha256").update(JSON.stringify(c)).digest("hex")]);
  };
  const project = () => asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ id: string }>(
    "select id from public.create_project('complete_brand','Local brand',$1,$2)", [JSON.stringify(context), HASH],
  )).rows[0]!);
  const workspace = () => rpc<{ workspace: { id: string } }>("save_standalone_workspace", ["domains", 0, randomUUID(), domain(), []]);
  const attachInput = (ideaId: string, projectId: string) => ({ requestKey: randomUUID(), ideaId, expectedIdeaRevision: 1, projectId, expectedProjectRevision: 1 });
  const promotionInput = (workspaceId: string) => ({ requestKey: randomUUID(), workspaceId, expectedWorkspaceRevision: 1, selection: { tool: "domains", domain: "cedar.com" }, contextSource: null, title: "Local promoted brand" });
  const saveHome = (input = homeInput()) => rpc("save_attached_home_project", [input, JSON.stringify(input.project.context)]);
  const attachment = async (verified = true) => (await db.query<{ id: string }>(
    "insert into public.home_attachments(owner_id,request_key,input,name,mime_type,content_hash,byte_length,verified) values($1,$2,'{}','fixture.txt','text/plain',$3,5,$4) returning id",
    [OWNER_A, randomUUID(), HASH, verified],
  )).rows[0]!;
  const dataSnapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ["ideas", "idea_revisions", "idea_brand_links", "projects", "project_revisions", "idea_project_attachments", "idea_project_attachment_requests", "standalone_workspaces", "standalone_workspace_revisions", "standalone_promotions", "home_attachments", "home_attachment_project_requests"]) {
      result[table] = (await db.query(`select to_jsonb(t) value from public.${table} t order by to_jsonb(t)::text`)).rows;
    }
    return result;
  };
  async function conflict(run: () => Promise<unknown>, message: string) {
    const before = await dataSnapshot();
    await expect(run()).rejects.toMatchObject({ code: "PT409", message });
    expect(await dataSnapshot()).toEqual(before);
  }

  it("rejects stale Idea CAS without appending or overwriting history", async () => {
    const i = await idea(); await update(i);
    await conflict(() => update(i), "revision_conflict");
  });
  it("rejects exact Idea-update replay after a newer revision", async () => {
    const i = await idea(), key = randomUUID(), second = await update(i, key);
    await update(second);
    await conflict(() => update(i, key), "revision_conflict");
  });
  it("rejects stale Idea-brand conversion before creating a project", async () => {
    const i = await idea(); await update(i);
    await conflict(() => brand(i), "revision_conflict");
  });
  it("rejects Idea-brand capacity without creating project 101 or another revision", async () => {
    let i = await idea();
    for (let n = 0; n < 100; n++) i = (await brand(i)).idea;
    expect(i.links).toHaveLength(100);
    await conflict(() => brand(i), "idea_link_capacity");
  });
  it("rejects changed attachment request keys while preserving the frozen receipt", async () => {
    const i = await idea(), p = await project(), input = attachInput(i.id, p.id);
    await rpc("attach_idea_to_project", [input]);
    await conflict(() => rpc("attach_idea_to_project", [{ ...input, expectedProjectRevision: 2 }]), "request_conflict");
  });
  it.each(["idea", "project"])("rejects stale attachment %s CAS", async stale => {
    const i = await idea(), p = await project(), input = attachInput(i.id, p.id);
    if (stale === "idea") await update(i);
    else await rpc("append_project_revision", [p.id, 1, context, HASH]);
    await conflict(() => rpc("attach_idea_to_project", [input]), "revision_conflict");
  });
  it("rejects changed promotion request keys without creating another brand", async () => {
    const w = await workspace(), input = promotionInput(w.workspace.id);
    await rpc("promote_standalone_workspace", [input]);
    await conflict(() => rpc("promote_standalone_workspace", [{ ...input, title: "Changed" }]), "request_conflict");
  });
  it("rejects stale promotion CAS without changing the workspace", async () => {
    const w = await workspace();
    await rpc("save_standalone_workspace", ["domains", 1, randomUUID(), domain("elm"), []]);
    await conflict(() => rpc("promote_standalone_workspace", [promotionInput(w.workspace.id)]), "revision_conflict");
  });
  it("rejects changed Home-project requests without another project or receipt", async () => {
    const input = homeInput(); await saveHome(input);
    await conflict(() => saveHome({ ...input, project: { ...input.project, title: "Changed" } }), "home_request_conflict");
  });
  it.each(["unverified", "linked"])("rejects %s Home attachments without a partial project", async state => {
    const row = await attachment(state === "linked");
    if (state === "linked") await saveHome(homeInput([row.id]));
    await conflict(() => saveHome(homeInput([row.id])), "home_attachment_conflict");
  });
  it("uses PT409 in the defensive Home update branch and rolls back its new project", async () => {
    const row = await attachment();
    // Local-only trigger forces a zero-row update after the real admission checks.
    await db.exec("create function public.fixture_skip_home_link() returns trigger language plpgsql as $$begin return null;end$$; create trigger fixture_skip_home_link before update on public.home_attachments for each row execute function public.fixture_skip_home_link()");
    try { await conflict(() => saveHome(homeInput([row.id])), "home_attachment_conflict"); }
    finally { await db.exec("drop trigger fixture_skip_home_link on public.home_attachments; drop function public.fixture_skip_home_link()"); }
  });
  it("preserves successful CAS, exact replay, immutable receipts and data through repeated application", async () => {
    const i = await idea(), key = randomUUID(), revised = await update(i, key);
    expect(revised.revision).toBe(2); expect(await update(i, key)).toEqual(revised);
    const brandKey = randomUUID(), converted = await brand(revised, brandKey);
    const p = await project(), attach = attachInput(i.id, p.id); attach.expectedIdeaRevision = converted.idea.revision;
    const attached = await rpc("attach_idea_to_project", [attach]);
    const w = await workspace(), promote = promotionInput(w.workspace.id), promoted = await rpc("promote_standalone_workspace", [promote]);
    const row = await attachment(), home = homeInput([row.id]), saved = await saveHome(home);
    const before = await dataSnapshot();
    await db.exec(candidate); await db.exec(candidate);
    expect(await brand(revised, brandKey)).toEqual(converted);
    expect(await rpc("attach_idea_to_project", [attach])).toEqual(attached);
    expect(await rpc("promote_standalone_workspace", [promote])).toEqual(promoted);
    expect(await saveHome(home)).toEqual(saved);
    expect(await dataSnapshot()).toEqual(before);
    for (const table of ["idea_revisions", "idea_project_attachment_requests", "standalone_promotions", "home_attachment_project_requests"]) {
      await expect(db.exec(`delete from public.${table}`)).rejects.toMatchObject({ code: "55000" });
    }
  });
  it("changes exactly eleven code literals with every pg_proc field and unrelated function preserved", async () => {
    expect(candidate).not.toBe("");
    let total = 0;
    for (const [index, target] of targets.entries()) {
      const original = originals[index]!;
      for (const [name, count] of Object.entries(target.conflicts)) {
        expect(original.definition.split(`raise exception '${name}' using errcode='40001'`)).toHaveLength(count + 1);
        total += count;
      }
      expect(patched[index]).toEqual({ ...original, definition: expectedDefinition(original.definition, target.conflicts) });
      expect(patched[index]!.definition).not.toContain("40001");
      for (const [role, allowed] of [["authenticated", true], ["anon", false]] as const) {
        expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, target.signature])).rows[0]!.allowed).toBe(allowed);
      }
    }
    expect(total).toBe(11);
    expect(migrationPatchedOtherFunctions).toEqual(migrationOriginalOtherFunctions);
    expect(await untouched()).toEqual(otherFunctions);
    expect(otherFunctions.some(row => JSON.stringify(row).includes("40001"))).toBe(true);
  });
  it("preserves nondefault owners and ACLs on first, mixed and repeated application", async () => {
    await db.exec("begin");
    try {
      await db.exec("create role fixture_business_patch_owner nologin; create role fixture_business_patch_grantee nologin");
      for (const [index, original] of originals.entries()) {
        // The first two-branch function is only half-patched, not merely an
        // all-old/all-new function mixture. Both supported states must converge.
        await db.exec(index === 0 ? original.definition.replace("errcode='40001'", "errcode='PT409'") : original.definition);
        await db.exec(`alter function ${original.signature} owner to fixture_business_patch_owner; grant execute on function ${original.signature} to fixture_business_patch_grantee with grant option`);
      }
      const before = await snapshot();
      await db.exec(candidate); await db.exec(candidate);
      expect(await snapshot()).toEqual(before.map((row, index) => ({ ...row, definition: expectedDefinition(row.definition, targets[index]!.conflicts) })));
    } finally { await db.exec("rollback"); }
  });
  it.each([
    { label: "missing expected branch", change: (s: string) => s.replace("raise exception 'home_request_conflict'", "raise exception 'changed_request_conflict'") },
    { label: "duplicate expected branch", change: (s: string) => s.replace("begin\n", "begin\n if false then raise exception 'home_request_conflict' using errcode='40001'; end if;\n") },
    { label: "unexpected retryable branch", change: (s: string) => s.replace("begin\n", "begin\n if false then raise exception 'unknown_conflict' using errcode='40001'; end if;\n") },
  ])("atomically rejects a last-function $label without partially patching the first four", async ({ change }) => {
    await db.exec("begin");
    try {
      for (const original of originals) await db.exec(original.definition);
      await db.exec(change(originals.at(-1)!.definition));
      const before = await snapshot(); await db.exec("savepoint candidate_failure");
      await expect(db.exec(candidate)).rejects.toMatchObject({ code: "P0001" });
      await db.exec("rollback to savepoint candidate_failure");
      expect(await snapshot()).toEqual(before); expect(await untouched()).toEqual(otherFunctions);
    } finally { await db.exec("rollback"); }
  });
  it("leaves genuine serialization failures retryable and rolls back the update", async () => {
    const i = await idea(), before = await dataSnapshot();
    await db.exec("create function public.fixture_serialization() returns trigger language plpgsql as $$begin raise exception 'serialization fixture' using errcode='40001';end$$; create trigger fixture_serialization before insert on public.idea_revisions for each row execute function public.fixture_serialization()");
    try { await expect(update(i)).rejects.toMatchObject({ code: "40001", message: "serialization fixture" }); expect(await dataSnapshot()).toEqual(before); }
    finally { await db.exec("drop trigger fixture_serialization on public.idea_revisions; drop function public.fixture_serialization()"); }
  });
  it("retains foreign-owner and anonymous denial on all five public RPCs", async () => {
    const i = await idea(), p = await project(), w = await workspace(), row = await attachment();
    const calls: [string, unknown[]][] = [
      ["update_idea", [i.id, 1, randomUUID(), content()]], ["create_idea_brand", [i.id, 1, randomUUID(), context, HASH]],
      ["attach_idea_to_project", [attachInput(i.id, p.id)]], ["promote_standalone_workspace", [promotionInput(w.workspace.id)]],
      ["save_attached_home_project", [homeInput([row.id]), JSON.stringify(context)]],
    ];
    const before = await dataSnapshot();
    for (const [name, args] of calls) {
      await expect(rpc(name, args, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
      await expect(asRole(db, "anon", null, () => db.query(`select public.${name}(${args.map((_, n) => `$${n + 1}`).join(",")})`, args.map(v => v !== null && typeof v === "object" ? JSON.stringify(v) : v))))
        .rejects.toMatchObject({ code: "42501" });
    }
    expect(await dataSnapshot()).toEqual(before);
  });
});
