import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
vi.mock("server-only", () => ({}));
import { createTestDatabase, resetFixture, asRole, OWNER_A, OWNER_B, HASH, type TestDatabase } from "./local-supabase";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { domainDraftSchema } from "../../src/features/domain-workspace/draft";
import { prepareDomainSearch } from "../../src/features/domain-workspace/model";
import { standalonePayloadCodec as handlesCodec } from "../../src/features/handles-workspace/account-codec";
import { createTrademarkDraft, confirmTrademarkReview } from "../../src/features/trademark-workspace/domain";
import { getStandaloneWorkspace, getStandaloneImport, saveStandaloneWorkspace } from "../../src/server/data/standalone-workspaces";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import type { StandaloneImportSource, StandaloneWorkspaceResponse } from "../../src/domain/standalone-workspaces";
const key = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
const domain = (input = "cedar") => ({ version: 1, input, extensions: ["com"], candidates: [] as string[] });
const handle = () => ({ version: 1, bundles: [{ id: "fixture", title: "Cedar", list: "User list", savedAt: "2026-10-06T00:00:00Z",
  source: { id: "manual", name: "Cedar", origin: "manual", projectId: null, projectTitle: null },
  entries: [{ platform: "instagram", handle: "cedar", favorite: true, selected: false, accountCreated: null, evidence: [] }] }] });
const declaredHandle = (url: string, declaredAt = "2026-10-06T00:00:00Z") => {
  const payload = handle(), bundle = payload.bundles[0]!;
  return { ...payload, bundles: [{ ...bundle, entries: [{ ...bundle.entries[0]!, accountCreated: { declaredAt, url } }] }] };
};
const selection = ({ projectId, projectRevision, selectionId }: StandaloneImportSource) => ({ projectId, projectRevision, selectionId });
const ecmaWhitespace = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
].map(code => ({ label: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`, char: String.fromCodePoint(code) }));

describe("standalone workspace SQL and real service over PGlite (synthetic local accounts)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await db.exec(await readFile(new URL("../../supabase/candidates/standalone_workspace_conflict_codes.sql", import.meta.url), "utf8"));
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });
  const run = <T>(fn: () => Promise<T>, owner = OWNER_A) => asRole(db, "authenticated", owner, fn);
  async function rpc<T = StandaloneWorkspaceResponse>(name: string, args: unknown[], owner = OWNER_A): Promise<T> {
    return run(async () => (await db.query<{ result: T }>(`select public.${name}(${args.map((_, n) => `$${n + 1}`).join(",")}) as result`, args)).rows[0]!.result, owner);
  }
  const save = (rev = 0, nonce = 1, payload: unknown = domain(), imports: unknown[] = [], owner = OWNER_A, tool = "domains") =>
    rpc("save_standalone_workspace", [tool, rev, key(nonce), JSON.stringify(payload), JSON.stringify(imports)], owner);
  async function project(name = "Cedar", owner = OWNER_A) {
    const context = contextSnapshotSchema.parse({ description: "Local standalone fixture", selectedName: name || null, intake: { suppliedName: name } });
    const row = await run(async () => (await db.query<{ id: string }>("select * from public.create_project('naming_only','Fixture project',$1::jsonb,$2)", [JSON.stringify(context), HASH])).rows[0]!, owner);
    return { id: row.id, context };
  }
  const serviceAuth = (owner = OWNER_A) => ({ userId: owner, client: { rpc: async (name: string, args: Record<string, unknown>) => {
    const signatures: Record<string, string[]> = {
      get_standalone_workspace: ["p_tool"], get_standalone_import: ["p_project_id"],
      save_standalone_workspace: ["p_tool", "p_expected_revision", "p_request_key", "p_payload", "p_imports"],
      get_project_name: ["p_project_id", "p_candidate_id"], get_name_transform: ["p_project_id", "p_transform_id"],
    };
    if (!signatures[name]) throw new Error("Unsupported fixture RPC");
    try { const data = await rpc(name, signatures[name].map(k => typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]), owner); return { data, error: null }; }
    catch (error) { return { data: null, error: { code: (error as { code: string }).code } }; }
  } } }) as unknown as AuthenticatedContext;

  it("creates one owned head, reloads durable draft and isolates another authenticated owner", async () => {
    expect(await rpc("get_standalone_workspace", ["domains"])).toEqual({ ownerId: OWNER_A, workspace: null });
    const first = await save(); expect(first.workspace).toMatchObject({ ownerId: OWNER_A, revision: 1, tool: "domains", payload: domain(), imports: [] });
    expect(await rpc("get_standalone_workspace", ["domains"])).toEqual(first);
    expect(await rpc("get_standalone_workspace", ["domains"], OWNER_B)).toEqual({ ownerId: OWNER_B, workspace: null });
    expect((await run(() => db.query("select * from public.standalone_workspaces"), OWNER_B)).rows).toEqual([]);
    expect((await run(() => db.query("select * from public.standalone_workspace_revisions"), OWNER_B)).rows).toEqual([]);
    const second = await save(0, 1, domain("elm"), [], OWNER_B); expect(second.workspace?.id).not.toBe(first.workspace?.id);
  });
  it("enforces compare-and-swap and immutable revision history", async () => {
    const first = await save(); const second = await save(1, 2, domain("elm"));
    expect(second.workspace).toMatchObject({ id: first.workspace?.id, revision: 2, payload: domain("elm") });
    await expect(save(1, 3)).rejects.toMatchObject({ code: "PT409" });
    await expect(save(0, 4)).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select revision,payload->>'input' as input from public.standalone_workspace_revisions order by revision")).rows).toEqual([{ revision: 1, input: "cedar" }, { revision: 2, input: "elm" }]);
    await expect(db.query("update public.standalone_workspace_revisions set payload='{}'")).rejects.toMatchObject({ code: "55000" });
  });
  it("returns conflict through the real service for a second-tab stale imported Domains draft without changing revision 3", async () => {
    const auth = serviceAuth(), p = await project("Saved fixture name");
    const source = (await getStandaloneImport(auth, p.id)).source!;
    await save(0, 1, domain("Manual fixture"));
    const imports = [selection(source)];
    await saveStandaloneWorkspace(auth, "domains", { requestKey: key(2), expectedRevision: 1, payload: domain(source.name), imports });
    const secondTab = (await getStandaloneWorkspace(auth, "domains")).workspace!;
    const latest = await saveStandaloneWorkspace(auth, "domains", { requestKey: key(3), expectedRevision: 2,
      payload: { ...domain(source.name), extensions: ["com", "net"] }, imports });
    const stale = { requestKey: key(4), expectedRevision: secondTab.revision, payload: domain("Retained stale fixture"), imports };
    await expect(saveStandaloneWorkspace(auth, "domains", stale)).rejects.toMatchObject({ code: "conflict", status: 409 });
    await expect(saveStandaloneWorkspace(auth, "domains", stale)).rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(await getStandaloneWorkspace(auth, "domains")).toEqual(latest);
    expect((await db.query("select revision from public.standalone_workspace_revisions order by revision")).rows).toEqual([{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
    expect((await db.query("select count(*)::int total from public.standalone_workspace_revisions where request_key=$1", [stale.requestKey])).rows).toEqual([{ total: 0 }]);
  });
  it("rolls back head creation/advancement when immutable insertion fails", async () => {
    await save();
    await db.exec(`create function public.fixture_reject_standalone_revision() returns trigger language plpgsql as $$ begin raise exception 'fixture insertion failure' using errcode='23514'; end $$;
      create trigger fixture_reject_standalone before insert on public.standalone_workspace_revisions for each row execute function public.fixture_reject_standalone_revision();`);
    try {
      await expect(save(1, 2, domain("Changed"))).rejects.toMatchObject({ code: "23514" });
      await expect(save(0, 3, { version: 1, bundles: [] }, [], OWNER_A, "handles")).rejects.toMatchObject({ code: "23514" });
      expect((await rpc("get_standalone_workspace", ["domains"])).workspace?.revision).toBe(1);
      expect((await rpc("get_standalone_workspace", ["handles"])).workspace).toBeNull();
      expect((await db.query("select count(*)::int total from public.standalone_workspace_revisions")).rows).toEqual([{ total: 1 }]);
    } finally { await db.exec("drop trigger fixture_reject_standalone on public.standalone_workspace_revisions; drop function public.fixture_reject_standalone_revision()"); }
  });
  it("allows exact current replay and refuses changed input, cross-tool and replay after later writes", async () => {
    const first = await save(); expect(await save()).toEqual(first);
    await expect(save(0, 1, domain("forged"))).rejects.toMatchObject({ code: "PT409" });
    await expect(save(0, 1, { version: 1, bundles: [] }, [], OWNER_A, "handles")).rejects.toMatchObject({ code: "PT409" });
    await save(1, 2); await expect(save()).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select count(*)::int as total from public.standalone_workspace_revisions")).rows).toEqual([{ total: 2 }]);
  });
  it("denies anonymous reads/writes, raw mutations, private helpers and service/worker defaults", async () => {
    await save();
    await expect(asRole(db, "anon", null, () => db.query("select public.get_standalone_workspace('domains')"))).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("update public.standalone_workspaces set current_revision=2"))).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("delete from public.standalone_workspace_revisions"))).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("select fluid_private.standalone_record($1,$2)", [key(1), OWNER_B]))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "service_role", OWNER_A, () => db.query("select public.get_standalone_workspace('domains')"))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "authenticated", null, () => db.query("select public.get_standalone_workspace('domains')"))).rejects.toMatchObject({ code: "42501" });
    const policies = (await db.query("select relrowsecurity,relforcerowsecurity from pg_class where relname in('standalone_workspaces','standalone_workspace_revisions')")).rows;
    expect(policies).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }, { relrowsecurity: true, relforcerowsecurity: true }]);
  });
  it.each([
    { ...domain(), ownerId: OWNER_B }, { ...domain(), checks: [{ availability: "available" }] }, { ...domain(), orders: [{ registration: "confirmed" }] },
    { ...domain(), candidates: ["other.com"] }, { ...domain(), extensions: ["com", "com"] }, { ...domain(), input: "x".repeat(4001) },
    { ...domain(), extensions: ["COM"] }, { ...domain(), input: null },
  ])("rejects malformed domain drafts or provider evidence at direct SQL boundary", async payload => {
    await expect(save(0, 1, payload)).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select * from public.standalone_workspaces")).rows).toEqual([]);
  });
  it("accepts exact prepared domain candidates and unicode unfinished drafts", async () => {
    await save(0, 1, { ...domain("Cedar, Elm"), candidates: ["cedar.com", "elm.com"] });
    await save(1, 2, domain("𐐀🙂"));
    await expect(save(2, 3, domain("🙂".repeat(2001)))).rejects.toMatchObject({ code: "22023" });
  });
  it.each([
    { label: "U+0085 is not ECMAScript whitespace", input: "Ce\u0085dar", candidates: ["cedar.com"] },
    { label: "U+0130 lowercases to two code points in JavaScript", input: "\u0130", candidates: ["i.com"] },
    { label: "U+0085 remains significant at input edges", input: "\u0085Cedar\u0085", candidates: ["cedar.com"] },
    { label: "U+0130 remains invalid in a full domain", input: "\u0130.COM", candidates: ["i.com"] },
  ])("normalization regression: refuses $label before any durable writes", async ({ input, candidates }) => {
    const payload = { ...domain(input), candidates };
    expect(domainDraftSchema.safeParse(payload).success).toBe(false);
    await expect(save(0, 1, payload)).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select id from public.standalone_workspaces")).rows).toEqual([]);
    expect((await db.query("select revision from public.standalone_workspace_revisions")).rows).toEqual([]);
    expect((await getStandaloneWorkspace(serviceAuth(), "domains")).workspace).toBeNull();
  });
  it.each(ecmaWhitespace)("roundtrips ECMAScript whitespace $label at domain edges and inside seeds", async ({ char }) => {
    expect(/^\s$/u.test(char)).toBe(true);
    const cases = [
      { input: `${char}Cedar.com${char}`, candidates: ["cedar.com"] },
      // LF splits input into separate lines before seed whitespace is removed.
      { input: `Ce${char}dar`, candidates: char === "\n" ? ["ce.com", "dar.com"] : ["cedar.com"] },
    ];
    for (const [revision, value] of cases.entries()) {
      const payload = { ...domain(value.input), candidates: value.candidates };
      expect(prepareDomainSearch(payload.input, payload.extensions)).toEqual({ domains: value.candidates, errors: [] });
      expect(domainDraftSchema.safeParse(payload).success).toBe(true);
      await save(revision, revision + 1, payload);
      expect((await getStandaloneWorkspace(serviceAuth(), "domains")).workspace).toMatchObject({ revision: revision + 1, payload });
    }
  });
  it.each([
    { input: "I", candidates: ["i.com"] },
    { input: "\u212a", candidates: ["k.com"] },
    { input: "\u212a.COM", candidates: ["k.com"] },
    { input: "Sub.\u212a.COM", candidates: ["sub.k.com"] },
    { input: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", candidates: ["abcdefghijklmnopqrstuvwxyz.com"] },
  ])("roundtrips JavaScript ASCII/Kelvin normalization of $input", async ({ input, candidates }) => {
    const payload = { ...domain(input), candidates };
    expect(prepareDomainSearch(input, payload.extensions)).toEqual({ domains: candidates, errors: [] });
    expect(domainDraftSchema.safeParse(payload).success).toBe(true);
    await save(0, 1, payload);
    expect((await getStandaloneWorkspace(serviceAuth(), "domains")).workspace?.payload).toEqual(payload);
  });
  it("retains unfinished Unicode inputs without inventing prepared candidates", async () => {
    for (const [revision, input] of ["Ce\u0085dar", "\u0130"].entries()) {
      const payload = domain(input);
      expect(domainDraftSchema.safeParse(payload).success).toBe(true);
      await save(revision, revision + 1, payload);
      expect((await getStandaloneWorkspace(serviceAuth(), "domains")).workspace?.payload).toEqual(payload);
    }
  });
  it("persists manual handle choices/declarations but forbids nested provider evidence and unknown fields", async () => {
    const payload = handle(); await save(0, 1, payload, [], OWNER_A, "handles");
    const declared = structuredClone(payload) as unknown as { bundles: { entries: { accountCreated: unknown }[] }[] };
    declared.bundles[0]!.entries[0]!.accountCreated = { declaredAt: "2026-10-06T00:00:00Z", url: "https://www.instagram.com/cedar" };
    await save(1, 2, declared, [], OWNER_A, "handles");
    const injected = structuredClone(payload) as unknown as { bundles: { entries: { evidence: unknown[] }[] }[] };
    injected.bundles[0]!.entries[0]!.evidence = [{ outcome: "confirmed_available" }];
    await expect(save(2, 3, injected, [], OWNER_A, "handles")).rejects.toMatchObject({ code: "22023" });
    await expect(save(2, 3, { ...payload, registered: true }, [], OWNER_A, "handles")).rejects.toMatchObject({ code: "22023" });
  });
  it.each([
    { label: "24:00 timestamp", payload: { ...handle(), bundles: [{ ...handle().bundles[0]!, savedAt: "2026-10-06T24:00:00Z" }] } },
    { label: "out-of-range URL port", payload: declaredHandle("https://www.instagram.com:99999/cedar") },
    { label: "Unicode host lowercased to a different WHATWG host", payload: declaredHandle("https://\u0130nstagram.com/cedar") },
  ])("reviewer regression: refuses $label before inserting a head or revision", async ({ payload }) => {
    expect(handlesCodec.schema.safeParse(payload).success).toBe(false);
    await expect(save(0, 1, payload, [], OWNER_A, "handles")).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select id from public.standalone_workspaces")).rows).toEqual([]);
    expect((await db.query("select revision from public.standalone_workspace_revisions")).rows).toEqual([]);
  });
  it.each([
    "2026-10-06T24:00:00Z", "2026-10-06T23:59:60Z", "2026-10-06T12:60:00Z", "2026-10-06T00:00:00+24:00",
    "2026-10-06T00:00:00+01:60", "2026-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2100-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z", "2026-00-01T00:00:00Z", "2026-10-00T00:00:00Z", "2026-10-06T23:59Z",
  ])("rejects noncanonical calendar/clock declarations without persisting %s", async declaredAt => {
    const payload = declaredHandle("https://www.instagram.com/cedar", declaredAt);
    expect(handlesCodec.schema.safeParse(payload).success).toBe(false);
    await expect(save(0, 1, payload, [], OWNER_A, "handles")).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select revision from public.standalone_workspace_revisions")).rows).toEqual([]);
  });
  it.each([
    "0000-02-29T00:00:00Z", "2000-02-29T23:59:59Z", "2024-02-29T00:00:00+23:59", "2026-04-30T00:00:00-23:59",
    "2026-10-06T12:34:56.123456789Z", `2026-10-06T12:34:56.${"1".repeat(70)}+05:30`,
  ])("roundtrips valid calendar/offset/precision boundary %s through the actual service", async declaredAt => {
    const payload = declaredHandle("https://www.instagram.com/cedar", declaredAt);
    payload.bundles[0]!.savedAt = declaredAt;
    expect(handlesCodec.schema.safeParse(payload).success).toBe(true);
    await save(0, 1, payload, [], OWNER_A, "handles");
    expect((await getStandaloneWorkspace(serviceAuth(), "handles")).workspace?.payload).toEqual(payload);
  });
  it.each([
    "https://www.instagram.com:99999/cedar", "https://www.instagram.com:65536/cedar", "https://www.instagram.com:-1/cedar",
    "https://www.instagram.com:abc/cedar", "https://www.instagram.com:80:90/cedar", "https://^.instagram.com/cedar",
    "https://[::1].instagram.com/cedar", "https://user:secret@www.instagram.com/cedar", "https://www.instagram.com.evil.invalid/cedar",
    "https://xn--.instagram.com/cedar", "https://www.instagram.com:00000065536/cedar",
  ])("refuses malformed/foreign URL authority without poisoning a workspace: %s", async url => {
    const payload = declaredHandle(url);
    expect(handlesCodec.schema.safeParse(payload).success).toBe(false);
    await expect(save(0, 1, payload, [], OWNER_A, "handles")).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select id from public.standalone_workspaces")).rows).toEqual([]);
    expect((await db.query("select revision from public.standalone_workspace_revisions")).rows).toEqual([]);
  });
  it.each([
    "https://www.instagram.com:0/cedar", "https://www.instagram.com:65535/cedar", "http://instagram.com:80/cedar",
    "https://www.instagram.com:443/cedar", "https://www.instagram.com:00000080/cedar", "https://www.instagram.com:/cedar",
    "https://Instagram.com/cedar",
    "HTTPS://WWW.INSTAGRAM.COM/Some%20Path?q=hello#section", "https://business.instagram.com/équipe?view=one two#résumé",
    "https://www.instagram.com/a path?profile=@cedar#bio", "https://www.instagram.com?profile=cedar", "https://www.instagram.com#bio",
  ])("roundtrips ordinary valid platform URL and permits a later edit: %s", async url => {
    const payload = declaredHandle(url);
    expect(handlesCodec.schema.safeParse(payload).success).toBe(true);
    await save(0, 1, payload, [], OWNER_A, "handles");
    expect((await getStandaloneWorkspace(serviceAuth(), "handles")).workspace?.payload).toEqual(payload);
    const result = await saveStandaloneWorkspace(serviceAuth(), "handles", { requestKey: key(2), expectedRevision: 1, payload, imports: [] });
    expect(result.workspace?.revision).toBe(2);
  });
  it("retains only exact user review of a trademark draft and rejects clearance claims", async () => {
    const payload = confirmTrademarkReview(createTrademarkDraft("Cedar"));
    await save(0, 1, payload, [], OWNER_A, "trademarks");
    await expect(save(1, 2, { ...payload, markName: "Elm" }, [], OWNER_A, "trademarks")).rejects.toMatchObject({ code: "22023" });
    await expect(save(1, 2, { ...payload, clearance: "cleared" }, [], OWNER_A, "trademarks")).rejects.toMatchObject({ code: "22023" });
    await expect(save(1, 2, { ...payload, userNotes: "hidden\u0001", reviewedContent: null }, [], OWNER_A, "trademarks")).rejects.toMatchObject({ code: "22023" });
  });
  it("resolves owned saved names, reports absent names and denies foreign/forged import selectors", async () => {
    const owned = await project(); const unnamed = await project(""); const other = await project("Secret", OWNER_B);
    const source = (await rpc<{ source: StandaloneImportSource }>("get_standalone_import", [owned.id])).source;
    expect(source).toMatchObject({ projectId: owned.id, name: "Cedar", projectRevision: 1, selectionId: null, candidateId: null, origin: "project_name" });
    expect(await rpc("get_standalone_import", [unnamed.id])).toMatchObject({ source: null });
    await expect(rpc("get_standalone_import", [other.id])).rejects.toMatchObject({ code: "P0002" });
    await expect(save(0, 1, domain(), [{ ...selection(source), name: "Forged" }])).rejects.toMatchObject({ code: "22023" });
    await expect(save(0, 1, domain(), [{ ...selection(source), projectId: other.id }])).rejects.toMatchObject({ code: "P0002" });
    const result = await save(0, 1, domain(), [selection(source)]); expect(result.workspace?.imports).toEqual([source]);
  });
  it("rejects changed fresh import heads and retains frozen imports across later project edits", async () => {
    const p = await project(); const source = (await rpc<{ source: StandaloneImportSource }>("get_standalone_import", [p.id])).source;
    const draft = await save(0, 1, domain(), [selection(source)]);
    const changed = contextSnapshotSchema.parse({ ...p.context, selectedName: "Elm", intake: { ...p.context.intake, suppliedName: "Elm" } });
    await run(() => db.query("select public.append_project_revision($1,1,$2::jsonb,$3,'New title')", [p.id, JSON.stringify(changed), HASH]));
    const kept = await save(1, 2, domain("draft changed"), [selection(source)]); expect(kept.workspace?.imports).toEqual(draft.workspace?.imports);
    await expect(save(0, 3, { version: 1, bundles: [] }, [selection(source)], OWNER_A, "handles")).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select current_revision from public.projects where id=$1", [p.id])).rows).toEqual([{ current_revision: 2 }]);
  });
  it("uses the production service to verify saved Naming candidate provenance through real SQL reads", async () => {
    const p = await project("");
    const imported = await rpc<{ entry: { candidate: { id: string } } }>("import_local_name", [p.id, 1, JSON.stringify({ id: key(10), value: "Cedar", createdAt: "2026-10-06T00:00:00Z", origin: "manual", history: [] }), JSON.stringify(p.context), "cedar", "fixture-standalone-import-001"]);
    const chosen = await rpc<{ currentSelection: { selection: { id: string } } }>("select_project_name", [p.id, imported.entry.candidate.id, 1, false]);
    const auth = serviceAuth(); const resolved = await getStandaloneImport(auth, p.id);
    expect(resolved.source).toMatchObject({ origin: "naming_selection", candidateId: imported.entry.candidate.id, selectionId: chosen.currentSelection.selection.id, projectRevision: 2, name: "Cedar" });
    const result = await saveStandaloneWorkspace(auth, "domains", { requestKey: key(5), expectedRevision: 0, payload: domain(), imports: [selection(resolved.source!)] });
    expect(result.workspace?.imports).toEqual([resolved.source]); expect(await getStandaloneWorkspace(auth, "domains")).toEqual(result);
    expect((await db.query("select * from public.jobs")).rows).toEqual([]);
  });
  it("refuses a syntactically saved but forged Naming identity at the service import boundary", async () => {
    const p = await project("");
    const imported = await rpc<{ entry: { candidate: { id: string } } }>("import_local_name", [p.id, 1,
      JSON.stringify({ id: key(10), value: "Cedar", createdAt: "2026-10-06T00:00:00Z", origin: "manual", history: [] }),
      JSON.stringify(p.context), "forgedidentity", "fixture-standalone-forged-001"]);
    await rpc("select_project_name", [p.id, imported.entry.candidate.id, 1, false]);
    await expect(getStandaloneImport(serviceAuth(), p.id)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect((await db.query("select * from public.standalone_workspaces")).rows).toEqual([]);
  });
  it("recovers a committed first create after response loss with the original key and no duplicate revision", async () => {
    const auth = serviceAuth(); const delegate = auth.client.rpc.bind(auth.client); let lost = false;
    const flaky = { ...auth, client: { rpc: async (name: string, args: Record<string, unknown>) => {
      const result = await delegate(name, args);
      if (name === "save_standalone_workspace" && !lost) { lost = true; throw new Error("fixture response lost after successful COMMIT"); }
      return result;
    } } } as unknown as AuthenticatedContext;
    const input = { requestKey: key(9), expectedRevision: 0, payload: domain(), imports: [] };
    await expect(saveStandaloneWorkspace(flaky, "domains", input)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect((await getStandaloneWorkspace(auth, "domains")).workspace?.revision).toBe(1);
    expect((await saveStandaloneWorkspace(auth, "domains", input)).workspace?.revision).toBe(1);
    expect((await db.query("select count(*)::int total from public.standalone_workspace_revisions")).rows).toEqual([{ total: 1 }]);
  });
  it("rejects null or mistyped enum and nested values through direct SQL calls", async () => {
    for (const payload of [{ ...createTrademarkDraft(), markType: null }, { ...createTrademarkDraft(), documents: { plan: null, notes: "" } }]) {
      await expect(save(0, 1, payload, [], OWNER_A, "trademarks")).rejects.toMatchObject({ code: "22023" });
    }
    const malformed = handle() as unknown as { bundles: { source: { origin: unknown }; entries: { platform: unknown }[] }[] };
    malformed.bundles[0]!.source.origin = null;
    await expect(save(0, 1, malformed, [], OWNER_A, "handles")).rejects.toMatchObject({ code: "22023" });
    malformed.bundles[0]!.source.origin = "manual"; malformed.bundles[0]!.entries[0]!.platform = null;
    await expect(save(0, 1, malformed, [], OWNER_A, "handles")).rejects.toMatchObject({ code: "22023" });
  });
  it("accepts service idempotent replay, with SQL authoritative when source changes after verification", async () => {
    const p = await project(); const auth = serviceAuth(); const source = (await getStandaloneImport(auth, p.id)).source!;
    const input = { requestKey: key(7), expectedRevision: 0, payload: domain(), imports: [selection(source)] };
    const result = await saveStandaloneWorkspace(auth, "domains", input); expect(await saveStandaloneWorkspace(auth, "domains", input)).toEqual(result);
    const lateProject = await project("Birch"); const lateSource = (await getStandaloneImport(auth, lateProject.id)).source!;
    const delegate = auth.client.rpc.bind(auth.client);
    const racing = { ...auth, client: { rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "save_standalone_workspace") await run(() => db.query("select public.append_project_revision($1,1,$2::jsonb,$3)", [lateProject.id, JSON.stringify(lateProject.context), HASH]));
      return delegate(name, args);
    } } } as unknown as AuthenticatedContext;
    await expect(saveStandaloneWorkspace(racing, "handles", { requestKey: key(8), expectedRevision: 0, payload: { version: 1, bundles: [] }, imports: [selection(lateSource)] })).rejects.toMatchObject({ code: "conflict" });
    expect((await rpc("get_standalone_workspace", ["handles"])).workspace).toBeNull();
  });
});
