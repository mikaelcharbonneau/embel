import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { DOMAIN_DRAFT_MAX_BYTES, domainDraftSchema, emptyDomainDraft, type DomainDraft } from "../../src/features/domain-workspace/draft";
import { getStandaloneWorkspace, saveStandaloneWorkspace } from "../../src/server/data/standalone-workspaces";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import type { StandaloneWorkspaceResponse } from "../../src/domain/standalone-workspaces";

const migrationName = "20261015180500_domain_shortlists.sql";
const migrationUrl = new URL(`../../supabase/migrations/${migrationName}`, import.meta.url);
const signature = "fluid_private.standalone_payload(text,jsonb)";
const requestKey = (n: number) => `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, "0")}`;
const draft = () => ({ version: 1 as const, input: "Cedar", extensions: ["com"], candidates: ["cedar.com"] });
const shortlist = () => ({ ...draft(), shortlistedDomains: ["earlier.co.uk", "cedar.com"] });
type FunctionSnapshot = { definition: string; metadata: Record<string, unknown> };

describe("Domains shortlists over real standalone SQL (synthetic local PGlite accounts)", () => {
  let db: TestDatabase;
  let migration: string;
  let original: FunctionSnapshot;
  let patched: FunctionSnapshot;
  let otherFunctions: unknown[];
  const functionSnapshot = async () => (await db.query<FunctionSnapshot>(
    "select pg_get_functiondef(p.oid) as definition,to_jsonb(p)-'prosrc' as metadata from pg_proc p where p.oid=$1::regprocedure", [signature],
  )).rows[0]!;
  const otherFunctionSnapshot = async () => (await db.query(
    "select to_jsonb(p) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','fluid_private') and p.oid<>$1::regprocedure order by p.oid", [signature],
  )).rows;
  const dataSnapshot = async () => ({
    heads: (await db.query("select * from public.standalone_workspaces order by id")).rows,
    history: (await db.query("select * from public.standalone_workspace_revisions order by workspace_id,revision")).rows,
  });
  const run = <T>(fn: () => Promise<T>, owner = OWNER_A) => asRole(db, "authenticated", owner, fn);
  async function rpc<T = StandaloneWorkspaceResponse<DomainDraft>>(name: string, args: unknown[], owner = OWNER_A): Promise<T> {
    return run(async () => (await db.query<{ result: T }>(`select public.${name}(${args.map((_, n) => `$${n + 1}`).join(",")}) as result`, args)).rows[0]!.result, owner);
  }
  const save = (revision = 0, nonce = 1, payload: unknown = shortlist(), owner = OWNER_A, tool = "domains") =>
    rpc("save_standalone_workspace", [tool, revision, requestKey(nonce), JSON.stringify(payload), "[]"], owner);
  const serviceAuth = (owner = OWNER_A) => ({ userId: owner, client: { rpc: async (name: string, args: Record<string, unknown>) => {
    const signatures: Record<string, string[]> = {
      get_standalone_workspace: ["p_tool"],
      save_standalone_workspace: ["p_tool", "p_expected_revision", "p_request_key", "p_payload", "p_imports"],
    };
    if (!signatures[name]) throw new Error("Unsupported shortlist fixture RPC");
    try { return { data: await rpc(name, signatures[name].map(key => typeof args[key] === "object" ? JSON.stringify(args[key]) : args[key]), owner), error: null }; }
    catch (error) { return { data: null, error: { code: (error as { code: string }).code } }; }
  } } }) as unknown as AuthenticatedContext;
  const valid = async (payload: unknown) => (await db.query<{ valid: boolean }>(
    "select fluid_private.standalone_payload('domains',$1::jsonb) as valid", [JSON.stringify(payload)],
  )).rows[0]!.valid;

  beforeAll(async () => {
    migration = await readFile(migrationUrl, "utf8");
    db = await createTestDatabase({ before: migrationName });
    original = await functionSnapshot();
    otherFunctions = await otherFunctionSnapshot();
    await db.exec(migration);
    patched = await functionSnapshot();
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });

  it("changes only the payload validator body, preserving all metadata, ACLs, RPCs and other tool branches", async () => {
    expect(patched.metadata).toEqual(original.metadata);
    expect(patched.definition).not.toBe(original.definition);
    expect(patched.definition.split("  elsif p_tool='handles' then")[1]).toBe(original.definition.split("  elsif p_tool='handles' then")[1]);
    expect(await otherFunctionSnapshot()).toEqual(otherFunctions);
    expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where relname in('standalone_workspaces','standalone_workspace_revisions') order by relname")).rows)
      .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }, { relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it("preserves legacy payloads and exact pending-save replay through the upgrade", async () => {
    await db.exec(original.definition);
    const legacy = draft();
    const saved = await save(0, 1, legacy);
    const before = await dataSnapshot();
    await db.exec(migration);
    expect(await dataSnapshot()).toEqual(before);
    expect(await save(0, 1, legacy)).toEqual(saved);
    expect(await getStandaloneWorkspace(serviceAuth(), "domains")).toEqual(saved);
    expect(Object.hasOwn(saved.workspace!.payload, "shortlistedDomains")).toBe(false);
    await expect(save(0, 1, { ...legacy, shortlistedDomains: [] })).rejects.toMatchObject({ code: "PT409" });
    expect(await dataSnapshot()).toEqual(before);
  });

  it("roundtrips choices separately from current candidates through the real service", async () => {
    const payload = shortlist();
    const saved = await saveStandaloneWorkspace(serviceAuth(), "domains", { requestKey: requestKey(1), expectedRevision: 0, payload, imports: [] });
    expect(saved.workspace?.payload).toEqual(payload);
    expect(await getStandaloneWorkspace(serviceAuth(), "domains")).toEqual(saved);
    const later = { ...payload, input: "Another search still typing ?", candidates: [] };
    const next = await saveStandaloneWorkspace(serviceAuth(), "domains", { requestKey: requestKey(2), expectedRevision: 1, payload: later, imports: [] });
    expect(next.workspace).toMatchObject({ revision: 2, payload: later });
    expect((await db.query("select payload from public.standalone_workspace_revisions order by revision")).rows).toEqual([{ payload }, { payload: later }]);
  });

  it("isolates saved shortlists by verified owner including same request-key use", async () => {
    const saved = await save();
    expect(await rpc("get_standalone_workspace", ["domains"], OWNER_B)).toEqual({ ownerId: OWNER_B, workspace: null });
    expect((await run(() => db.query("select * from public.standalone_workspaces"), OWNER_B)).rows).toEqual([]);
    expect((await run(() => db.query("select * from public.standalone_workspace_revisions"), OWNER_B)).rows).toEqual([]);
    const otherPayload = { ...draft(), shortlistedDomains: ["private-b.com"] };
    const other = await save(0, 1, otherPayload, OWNER_B);
    expect(other.workspace?.id).not.toBe(saved.workspace?.id);
    expect((await getStandaloneWorkspace(serviceAuth(), "domains")).workspace?.payload).toEqual(shortlist());
    expect((await getStandaloneWorkspace(serviceAuth(OWNER_B), "domains")).workspace?.payload).toEqual(otherPayload);
  });

  it("keeps CAS, immutable history and unchanged data after stale shortlist saves", async () => {
    await save();
    await save(1, 2, { ...draft(), shortlistedDomains: ["later.com"] });
    const before = await dataSnapshot();
    await expect(save(1, 3)).rejects.toMatchObject({ code: "PT409", message: "revision_conflict" });
    await expect(saveStandaloneWorkspace(serviceAuth(), "domains", { requestKey: requestKey(4), expectedRevision: 1, payload: shortlist(), imports: [] }))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
    await expect(db.query("update public.standalone_workspace_revisions set payload='{}'")).rejects.toMatchObject({ code: "55000" });
    expect(await dataSnapshot()).toEqual(before);
  });

  it("replays only the exact current shortlist, rejecting changed choices/order and old replay after later writes", async () => {
    const saved = await save();
    expect(await save()).toEqual(saved);
    const before = await dataSnapshot();
    await expect(save(0, 1, { ...shortlist(), shortlistedDomains: ["other.com"] })).rejects.toMatchObject({ code: "PT409", message: "request_conflict" });
    await expect(save(0, 1, { ...shortlist(), shortlistedDomains: [...shortlist().shortlistedDomains].reverse() })).rejects.toMatchObject({ code: "PT409" });
    await expect(save(0, 1, { version: 1, bundles: [] }, OWNER_A, "handles")).rejects.toMatchObject({ code: "PT409" });
    expect(await dataSnapshot()).toEqual(before);
    await save(1, 2);
    await expect(save()).rejects.toMatchObject({ code: "PT409" });
    expect((await dataSnapshot()).history).toHaveLength(2);
  });

  it("continues denying anonymous/service access, absent identity and direct writes", async () => {
    await save();
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(db, role, OWNER_A, () => db.query("select public.get_standalone_workspace('domains')"))).rejects.toMatchObject({ code: "42501" });
      await expect(asRole(db, role, OWNER_A, () => db.query("select public.save_standalone_workspace('domains',1,$1,$2::jsonb,'[]'::jsonb)", [requestKey(2), JSON.stringify(shortlist())])))
        .rejects.toMatchObject({ code: "42501" });
    }
    await expect(asRole(db, "authenticated", null, () => db.query("select public.get_standalone_workspace('domains')"))).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("select fluid_private.standalone_payload('domains',$1::jsonb)", [JSON.stringify(shortlist())]))).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("update public.standalone_workspaces set current_revision=2"))).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("delete from public.standalone_workspace_revisions"))).rejects.toMatchObject({ code: "42501" });
  });

  it.each([
    null, "cedar.com", {}, [null], [123], [true], ["cedar.com", "cedar.com"],
    ["Cedar.com"], [" cedar.com"], ["cedar.com "], ["cedar.com\n"], ["https://cedar.com"],
    ["cedar.com/path"], ["cedar.com:443"], ["cedar.com."], ["localhost"], ["broken..com"],
    ["-cedar.com"], ["cedar-.com"], ["cedar.c"], ["cedar.123"], ["xn--cedar.com"], ["sub.xn--cedar.com"],
    ["caf\u00e9.com"], ["\u212a.com"], [`${"a".repeat(64)}.com`],
    [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`],
    [{ domain: "cedar.com", availability: "available" }], [{ domain: "cedar.com", quote: { amount: 100 } }],
  ])("rejects malformed or evidence-bearing choices at the independent SQL boundary: %j", async shortlistedDomains => {
    const payload = { ...draft(), shortlistedDomains };
    expect(domainDraftSchema.safeParse(payload).success).toBe(false);
    expect(await valid(payload)).toBe(false);
    await expect(save(0, 1, payload)).rejects.toMatchObject({ code: "22023" });
    expect(await dataSnapshot()).toEqual({ heads: [], history: [] });
  });

  it.each(["ownerId", "availability", "checks", "quote", "order", "registration", "provider", "payment", "evidence", "imports"])("rejects injected %s beside an otherwise valid shortlist", async property => {
    const payload = { ...shortlist(), [property]: { value: "untrusted" } };
    expect(domainDraftSchema.safeParse(payload).success).toBe(false);
    expect(await valid(payload)).toBe(false);
    await expect(save(0, 1, payload)).rejects.toMatchObject({ code: "22023" });
    expect(await dataSnapshot()).toEqual({ heads: [], history: [] });
  });

  it("requires every original key and preserves candidate validation with shortlist present", async () => {
    for (const key of ["version", "input", "extensions", "candidates"] as const) {
      const value: Record<string, unknown> = shortlist(); delete value[key];
      expect(await valid(value)).toBe(false);
      expect(domainDraftSchema.safeParse(value).success).toBe(false);
    }
    for (const patch of [{ candidates: ["unprepared.com"] }, { extensions: ["com", "com"] }, { version: 2 }]) {
      const payload = { ...shortlist(), ...patch };
      expect(await valid(payload)).toBe(false);
      expect(domainDraftSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("preserves absent versus empty choices and independently enforces count, syntax and exact UTF-8 bytes", async () => {
    const longestDomain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    const maximum = { ...emptyDomainDraft(), shortlistedDomains: Array.from({ length: 200 }, (_, n) => `choice${n}.com`) };
    const bounded = { ...emptyDomainDraft(), shortlistedDomains: Array.from({ length: 100 }, (_, n) => `d${String(n).padStart(3, "0")}.${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.com`) };
    const remaining = DOMAIN_DRAFT_MAX_BYTES - Buffer.byteLength(JSON.stringify(bounded), "utf8");
    const exact = { ...bounded, input: "a".repeat(remaining) };
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(DOMAIN_DRAFT_MAX_BYTES);
    const accepted = [draft(), { ...draft(), shortlistedDomains: [] }, { ...draft(), shortlistedDomains: ["a.co", "a-b.sub.co.uk", longestDomain] }, maximum, exact];
    for (const [revision, payload] of accepted.entries()) {
      expect(domainDraftSchema.safeParse(payload).success).toBe(true); expect(await valid(payload)).toBe(true);
      expect((await save(revision, revision + 1, payload)).workspace?.payload).toEqual(payload);
    }
    const rejected = [{ ...maximum, shortlistedDomains: [...maximum.shortlistedDomains, "extra.com"] },
      { ...exact, input: `${exact.input}a` }, { ...exact, input: `${exact.input.slice(0, -1)}\u00e9` }];
    const before = await dataSnapshot();
    for (const payload of rejected) {
      expect(domainDraftSchema.safeParse(payload).success).toBe(false); expect(await valid(payload)).toBe(false);
      await expect(save(5, 6, payload)).rejects.toMatchObject({ code: "22023" });
    }
    expect(await dataSnapshot()).toEqual(before);
  });

  it("can be reapplied without changing saved data or function metadata", async () => {
    await save(); await save(1, 2, { ...shortlist(), input: "unfinished ?", candidates: [] });
    const before = await dataSnapshot();
    await db.exec(migration); await db.exec(migration);
    expect(await dataSnapshot()).toEqual(before);
    expect(await functionSnapshot()).toEqual(patched);
    expect(await otherFunctionSnapshot()).toEqual(otherFunctions);
  });

  it("preserves a nondefault function owner and ACL on first and repeated application", async () => {
    await db.exec("begin");
    try {
      await db.exec(original.definition);
      await db.exec(`create role fixture_domain_shortlist_owner nologin; create role fixture_domain_shortlist_reader nologin;
        alter function ${signature} owner to fixture_domain_shortlist_owner;
        grant execute on function ${signature} to fixture_domain_shortlist_reader`);
      const before = await functionSnapshot();
      await db.exec(migration); const after = await functionSnapshot();
      expect(after.metadata).toEqual(before.metadata); expect(after.definition).toBe(patched.definition);
      await db.exec(migration); expect(await functionSnapshot()).toEqual(after);
    } finally { await db.exec("rollback"); }
  });

  it.each([
    { label: "missing original guard", change: (definition: string) => definition.replace("octet_length(fluid_private.standalone_compact(v))>24000", "octet_length(fluid_private.standalone_compact(v))>25000") },
    { label: "duplicate original branch", change: (definition: string) => definition.replace("  elsif p_tool='handles' then", `  elsif p_tool='unexpected' then${definition.match(/\n    if not fluid_private.standalone_keys\(v,array\['version','input','extensions','candidates'\]\)[\s\S]*?>24000 then return false; end if;\n/)![0]}  elsif p_tool='handles' then`) },
  ])("refuses $label atomically instead of guessing at an installed validator", async ({ change }) => {
    await db.exec("begin");
    try {
      await db.exec(change(original.definition)); const before = await functionSnapshot();
      await db.exec("savepoint failed_shortlist_migration");
      await expect(db.exec(migration)).rejects.toMatchObject({ code: "P0001", message: "Unexpected standalone Domains validator definition" });
      await db.exec("rollback to savepoint failed_shortlist_migration");
      expect(await functionSnapshot()).toEqual(before);
      expect(await otherFunctionSnapshot()).toEqual(otherFunctions);
    } finally { await db.exec("rollback"); }
  });
});
