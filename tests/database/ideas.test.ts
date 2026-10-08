import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
vi.mock("server-only", () => ({}));
import { ideaContentSchema, ideaProjectInput } from "../../src/domain/ideas";
import { asIdeaRole, createIdeasDatabase, IDEA_OWNER_A as A, IDEA_OWNER_B as B, ideaContent, ideaKey, ideaRpc, ideasFoundationAcls, readIdeasFoundationAcls } from "./ideas-database";

type Content = ReturnType<typeof ideaContent>;
type RecordRow = { id: string; ownerId: string; revision: number; content: Content; links: Link[] };
type Link = { id: string; ideaId: string; ideaRevision: number; projectId: string; requestKey: string; ownerId: string };
type Promotion = { idea: RecordRow; link: Link };
const context = (content: Content) => ideaProjectInput(ideaContentSchema.parse(content)).context;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("manual Ideas actual PostgreSQL boundary (foundation-only local fixture)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createIdeasDatabase(); }, 30000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await db.exec("truncate public.projects,public.project_revisions cascade");
    if ((await db.query<{ present: string | null }>("select to_regclass('public.ideas') as present")).rows[0]?.present) await db.exec("truncate public.ideas cascade"); });
  const create = (key = 1, content = ideaContent(), owner = A) => ideaRpc<RecordRow>(db, "create_idea", [ideaKey(key), content], owner);
  const update = (idea: RecordRow, key: number, content: Content, expected = idea.revision, owner = A) => ideaRpc<RecordRow>(db, "update_idea", [idea.id, expected, ideaKey(key), content], owner);
  const promote = (idea: RecordRow, key = 10, owner = A, custom = context(idea.content), inputHash = hash(custom)) => ideaRpc<Promotion>(db, "create_idea_brand", [idea.id, idea.revision, ideaKey(key), custom, inputHash], owner);

  it("removes hostile default grants from every new object and preserves foundation definitions/ACLs", async () => {
    expect(await readIdeasFoundationAcls(db)).toEqual(ideasFoundationAcls.get(db));
    const tables = (await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("select relname,relrowsecurity,relforcerowsecurity from pg_class where oid in ('public.ideas'::regclass,'public.idea_revisions'::regclass,'public.idea_brand_links'::regclass)")).rows;
    expect(tables).toHaveLength(3); expect(tables.every(table => table.relrowsecurity && table.relforcerowsecurity)).toBe(true);
    for (const table of tables) for (const role of ["anon", "authenticated", "service_role", "fluid_local_worker"]) for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,$2,$3) as allowed", [role, `public.${table.relname}`, privilege])).rows[0]?.allowed).toBe(role === "authenticated" && privilege === "SELECT");
    }
    const functions = (await db.query<{ signature: string; schema: string; proconfig: string[]; prosecdef: boolean }>(`select p.oid::regprocedure::text as signature,n.nspname as schema,p.proconfig,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='public' and p.proname in ('create_idea','update_idea','get_idea','list_ideas','create_idea_brand','get_project_idea_source'))
        or (n.nspname='fluid_private' and p.proname like 'idea_%')`)).rows;
    expect(functions.filter(fn => fn.schema === "public")).toHaveLength(6);
    for (const fn of functions) {
      expect(fn.proconfig).toContain('search_path=""');
      if (fn.schema === "public") expect(fn.prosecdef).toBe(true);
      for (const role of ["anon", "authenticated", "service_role", "fluid_local_worker"]) {
        expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, fn.signature])).rows[0]?.allowed).toBe(role === "authenticated" && fn.schema === "public");
      }
    }
  });

  it("rejects forged ownership and source associations at composite foreign-key boundaries", async () => {
    const first = await create(), other = await create(2, ideaContent("Foreign"), B);
    const project = await asIdeaRole(db, "authenticated", B, async () => (await db.query<{ id: string }>("select id from public.create_project('complete_brand','Local fixture','{}',$1)", ["a".repeat(64)])).rows[0]!);
    await expect(db.query("insert into public.idea_revisions(idea_id,owner_id,revision,content,operation,request_key,expected_revision) values($1,$2,2,$3,'update',$4,1)", [first.id, B, ideaContent(), ideaKey(20)])).rejects.toMatchObject({ code: "23503" });
    await expect(db.query("insert into public.idea_brand_links(owner_id,idea_id,idea_revision,project_id,request_key) values($1,$2,1,$3,$4)", [A, first.id, project.id, ideaKey(21)])).rejects.toMatchObject({ code: "23503" });
    await expect(db.query("insert into public.idea_brand_links(owner_id,idea_id,idea_revision,project_id,request_key) values($1,$2,1,$3,$4)", [A, other.id, project.id, ideaKey(22)])).rejects.toMatchObject({ code: "23503" });
  });

  it.each(["\u2000\uFEFFText 🙂\u3000", 'Quotes " and \\slashes', "Controls\n\t\b\f\r and café", "Lignes\u2028\u2029", "\u00a0\u202f\u205f\u1680"])("agrees with shared context defaults and SHA256 for Unicode/escaping %j", async text => {
    const authored = ideaContent("Source 🙂"); authored.description = text; authored.details.solution = text; authored.details.audience = text;
    const first = await create(1, authored), converted = await promote(first);
    expect((await db.query<{ context: unknown; input_hash: string }>("select context,input_hash from public.project_revisions where project_id=$1", [converted.link.projectId])).rows[0]).toEqual({ context: context(authored), input_hash: hash(context(authored)) });
  });

  it("returns no source for an owned existing project without an idea association", async () => {
    const project = await asIdeaRole(db, "authenticated", A, async () => (await db.query<{ id: string }>("select id from public.create_project('complete_brand','Local fixture','{}',$1)", ["a".repeat(64)])).rows[0]!);
    expect(await ideaRpc(db, "get_project_idea_source", [project.id])).toEqual({ ownerId: A, projectId: project.id, source: null });
  });

  it("creates an owned complete immutable initial version and replays against that version after edits", async () => {
    const first = await create();
    expect(first).toMatchObject({ ownerId: A, revision: 1, content: ideaContent(), links: [] });
    const edited = await update(first, 2, ideaContent("Edited"));
    expect(await create()).toEqual(edited);
    await expect(create(1, ideaContent("Different initial intent"))).rejects.toMatchObject({ code: "23505" });
    expect((await db.query<{ content: Content }>("select content from public.idea_revisions order by revision")).rows.map(row => row.content)).toEqual([ideaContent(), ideaContent("Edited")]);
  });
  it("uses CAS and replays one current update receipt without appending twice", async () => {
    const first = await create(), changed = ideaContent("Changed");
    const second = await update(first, 2, changed);
    expect(await update(first, 2, changed)).toEqual(second);
    await expect(update(first, 3, changed)).rejects.toMatchObject({ code: "40001" });
    await expect(update(first, 2, ideaContent("Different"))).rejects.toMatchObject({ code: "23505" });
    await expect(update(first, 2, changed, 2)).rejects.toMatchObject({ code: "23505" });
    const third = await update(second, 4, ideaContent("Third"));
    await expect(update(first, 2, changed)).rejects.toMatchObject({ code: "40001" });
    expect(third.revision).toBe(3);
    expect((await db.query<{ n: number }>("select count(*)::integer as n from public.idea_revisions")).rows[0]?.n).toBe(3);
  });
  it("rejects update-key reuse across different ideas", async () => {
    const first = await create(), other = await create(2);
    await update(first, 3, ideaContent("Changed"));
    await expect(update(other, 3, ideaContent("Changed"))).rejects.toMatchObject({ code: "23505" });
  });
  it("keeps owner rows isolated through RLS and rejects foreign mutation and conversion", async () => {
    const first = await create(), second = await create(2, ideaContent("Other owner"), B);
    await promote(first); await promote(second, 11, B);
    for (const table of ["ideas", "idea_revisions", "idea_brand_links"]) {
      await asIdeaRole(db, "authenticated", B, async () => {
        const own = (await db.query<{ owner_id: string }>(`select owner_id from public.${table}`)).rows;
        expect(own.length).toBeGreaterThan(0); expect(own.every(row => row.owner_id === B)).toBe(true);
        expect((await db.query(`select owner_id from public.${table} where owner_id=$1`, [A])).rows).toEqual([]);
      });
    }
    expect(await ideaRpc(db, "get_idea", [first.id], B)).toBeNull();
    await expect(update(first, 3, ideaContent(), 1, B)).rejects.toMatchObject({ code: "P0002" });
    await expect(promote(first, 4, B)).rejects.toMatchObject({ code: "P0002" });
    expect((await ideaRpc<RecordRow>(db, "get_idea", [second.id], B)).ownerId).toBe(B);
  });
  it.each(["anon", "service_role", "fluid_local_worker"] as const)("denies %s new table and function rights", async role => {
    for (const table of ["ideas", "idea_revisions", "idea_brand_links"]) await asIdeaRole(db, role, A, async () => {
      await expect(db.query(`select * from public.${table}`)).rejects.toMatchObject({ code: "42501" });
    });
    for (const sql of ["select public.create_idea($1,$2)", "select public.list_ideas(null,null,25,'',null)", "select public.get_idea($1)",
      "select public.update_idea($1,1,$1,$2)", "select public.create_idea_brand($1,1,$1,$2,'')", "select public.get_project_idea_source($1)"]) {
      await asIdeaRole(db, role, A, async () => { await expect(db.query(sql, sql.includes("$2") ? [ideaKey(1), ideaContent()] : sql.includes("$1") ? [ideaKey(1)] : [])).rejects.toMatchObject({ code: "42501" }); });
    }
  });
  it("rejects an authenticated session without a verified UID and direct caller writes", async () => {
    await asIdeaRole(db, "authenticated", null, async () => { await expect(db.query("select public.list_ideas(null,null,25,'',null)")).rejects.toMatchObject({ code: "42501" }); });
    const first = await create();
    for (const sql of ["update public.ideas set title='forged'", "delete from public.ideas", "insert into public.ideas(owner_id,title) values($1,'forged')",
      "update public.idea_revisions set content='{}'", "delete from public.idea_brand_links"]) {
      await asIdeaRole(db, "authenticated", A, async () => { await expect(db.query(sql, sql.includes("$1") ? [B] : [])).rejects.toMatchObject({ code: "42501" }); });
    }
    expect((await ideaRpc<RecordRow>(db, "get_idea", [first.id])).content.title).toBe("Local fixture");
  });
  it("enforces immutable revisions and source links even for privileged fixture maintenance", async () => {
    await promote(await create());
    for (const table of ["idea_revisions", "idea_brand_links"]) {
      await expect(db.query(`update public.${table} set owner_id=owner_id`)).rejects.toMatchObject({ code: "55000" });
      await expect(db.query(`delete from public.${table}`)).rejects.toMatchObject({ code: "55000" });
    }
  });
  it("atomically converts original source, leaves review flags unset, and returns an immutable association", async () => {
    const authored = ideaContent("Source title"); authored.details.solution = "  Product idea  "; authored.details.audience = "  Small teams  "; authored.details.notes = "Keep original notes";
    const first = await create(1, authored), conversion = await promote(first);
    expect(conversion.idea).toMatchObject({ revision: 2, content: { ...authored, state: "used" } });
    expect(conversion.link).toMatchObject({ ideaId: first.id, ownerId: A, ideaRevision: 1, requestKey: ideaKey(10) });
    const project = (await db.query("select p.scope,p.title,r.context from public.projects p join public.project_revisions r on r.project_id=p.id and r.revision=1")).rows[0];
    expect(project).toMatchObject({ scope: "complete_brand", title: authored.title, context: context(authored) });
    const edited = await update(conversion.idea, 11, ideaContent("Later edit"));
    expect(await ideaRpc(db, "get_project_idea_source", [conversion.link.projectId])).toMatchObject({ ownerId: A, projectId: conversion.link.projectId, source: { content: authored, link: conversion.link } });
    expect((await promote(first)).idea).toEqual(edited);
    expect((await db.query<{ n: number }>("select count(*)::integer as n from public.projects")).rows[0]?.n).toBe(1);
    await expect(promote(first, 12)).rejects.toMatchObject({ code: "40001" });
    await expect(ideaRpc(db, "get_project_idea_source", [conversion.link.projectId], B)).rejects.toMatchObject({ code: "P0002" });
  });
  it("rejects promotion key/source/context/hash mismatches and independently checks the full context mapping", async () => {
    const first = await create();
    await expect(promote(first, 10, A, { ...context(first.content), reformulationConfirmed: true })).rejects.toMatchObject({ code: "22023" });
    await expect(promote(first, 10, A, context(first.content), "invalid")).rejects.toMatchObject({ code: "22023" });
    const converted = await promote(first), other = await create(2);
    await expect(promote(other, 10)).rejects.toMatchObject({ code: "23505" });
    await expect(promote(first, 10, A, { ...context(first.content), description: "Different" })).rejects.toMatchObject({ code: "23505" });
    await expect(promote({ ...first, revision: 2 })).rejects.toMatchObject({ code: "23505" });
    // A fresh request cannot race the successful conversion of the same original revision.
    await expect(promote(first, 13)).rejects.toMatchObject({ code: "40001" });
    expect(converted.idea.revision).toBe(2);
  });
  it.each(["project", "link", "version", "head"] as const)("rolls back every write when conversion fails at %s", async stage => {
    const first = await create();
    const table = stage === "project" ? "project_revisions" : stage === "link" ? "idea_brand_links" : stage === "version" ? "idea_revisions" : "ideas";
    await db.exec(`create function public.fixture_idea_failure() returns trigger language plpgsql as $$ begin raise exception 'local_fixture_rollback'; end $$;
      create trigger fixture_idea_failure before ${stage === "head" ? "update" : "insert"} on public.${table} for each row execute function public.fixture_idea_failure();`);
    try { await expect(promote(first)).rejects.toThrow("local_fixture_rollback"); }
    finally { await db.exec(`drop trigger fixture_idea_failure on public.${table}; drop function public.fixture_idea_failure();`); }
    expect(await ideaRpc(db, "get_idea", [first.id])).toEqual(first);
    expect((await db.query<{ n: number }>("select count(*)::integer as n from public.projects")).rows[0]?.n).toBe(0);
    expect((await db.query<{ n: number }>("select count(*)::integer as n from public.idea_brand_links")).rows[0]?.n).toBe(0);
    expect((await db.query<{ n: number }>("select count(*)::integer as n from public.idea_revisions")).rows[0]?.n).toBe(1);
    expect((await promote(first)).idea.revision).toBe(2);
  });
  it.each([{}, { title: "" }, { ...ideaContent(), ownerId: B }, { ...ideaContent(), details: { notes: "", approved: true } },
    ideaContent("🙂".repeat(81)), { ...ideaContent(), description: "x".repeat(12001) }])("rejects malformed or forged content at SQL boundary", async content => {
    await expect(ideaRpc(db, "create_idea", [ideaKey(1), content])).rejects.toMatchObject({ code: "22023" });
  });
  it("fills optional fields, normalizes the title, and rejects oversized UTF-8 input", async () => {
    expect(await ideaRpc(db, "create_idea", [ideaKey(1), { title: "\t  Capture \n" }])).toMatchObject({ content: { ...ideaContent("Capture"), description: "" } });
    await expect(create(2, { ...ideaContent(), description: "🙂".repeat(6000), details: { ...ideaContent().details, notes: "🙂".repeat(1000), problem: "🙂".repeat(1000), validationSteps: "🙂".repeat(1000) } })).rejects.toMatchObject({ code: "22023" });
  });
  it("filters the full library before literal search pagination across 125 rows and exact timestamp ties", async () => {
    for (let n = 1; n <= 132; n++) {
      const content = ideaContent(n % 2 ? `Synthetic ${n}` : `Literal %_ ${n}`, n % 3 ? "to_explore" : "developing");
      const item = await create(n, content, n <= 125 ? A : B);
      await db.query("update public.ideas set created_at=$2,updated_at=$2 where id=$1", [item.id, "2026-10-05T12:00:00.000002Z"]);
    }
    const expected = (await db.query<{ id: string }>("select id from public.ideas where owner_id=$1 and state='to_explore' and strpos(title,'%_')>0 order by created_at desc,id desc", [A])).rows.map(row => row.id);
    type Cursor = { createdAt: string; id: string };
    const ids: string[] = []; let cursor: Cursor | null = null;
    do {
      const page: { ownerId: string; items: { id: string; createdAt: string }[]; nextCursor: Cursor | null } = await ideaRpc(db, "list_ideas", [cursor?.createdAt ?? null, cursor?.id ?? null, 7, "%_", "to_explore"]);
      expect(page.ownerId).toBe(A); ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor;
      if (cursor) expect(cursor.createdAt).toBe("2026-10-05T12:00:00.000002Z");
    } while (cursor);
    expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(ids.length); expect(ids.length).toBeGreaterThan(30);
    expect((await ideaRpc<{ items: unknown[] }>(db, "list_ideas", [null, null, 50, "%_", "to_explore"], B)).items).toHaveLength(2);
  }, 30000);
  it.each([[null, ideaKey(1), 25, "", null], [null, null, 51, "", null], [null, null, 25, "x".repeat(201), null], [null, null, 25, "", "invented"]].map(values => ({ values })))("bounds SQL list query inputs", async ({ values }) => {
    await expect(ideaRpc(db, "list_ideas", values)).rejects.toMatchObject({ code: "22023" });
  });
});
