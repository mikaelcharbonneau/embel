import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handlesDraftSchema } from "../../src/features/handles-workspace/account-codec";
import { emptyHandlesSearch } from "../../src/features/handles-workspace/domain";
import type { StandaloneWorkspaceResponse } from "../../src/domain/standalone-workspaces";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";

const migration = "20261015202644_handles_search_drafts.sql";
const target = "fluid_private.standalone_payload(text,jsonb)";
const preset = () => ({ id: randomUUID(), names: "Saved authored names", imports: ["chosen-name"], platforms: ["instagram", "youtube"], options: { prefixes: "get", suffixes: "studio", separators: ["", "_"] } });
const draft = () => ({ version: 1, bundles: [], search: { ...emptyHandlesSearch(), names: "  Cedar\nElm  ", nameDraft: " unfinished input ", title: "  Current bundle title  ", list: "  My list  ", savedSearches: [preset()] } });
const originalCheck = "if not fluid_private.standalone_keys(v,array['version','bundles']) or jsonb_typeof(v->'bundles')<>'array'";
const newCheck = "if not fluid_private.standalone_keys(v-'search',array['version','bundles']) or (v ? 'search' and not fluid_private.handles_search_payload(v->'search')) or jsonb_typeof(v->'bundles')<>'array'";
type FunctionSnapshot = { definition: string; metadata: unknown };

describe("authored Handles search drafts on local PostgreSQL", () => {
  let db: TestDatabase;
  let original: FunctionSnapshot;
  let otherFunctions: unknown[];
  let migrationSql: string;
  const functionSnapshot = async () => (await db.query<FunctionSnapshot>(
    "select pg_get_functiondef(p.oid) as definition,to_jsonb(p)-'prosrc' as metadata from pg_proc p where p.oid=$1::regprocedure", [target],
  )).rows[0]!;
  const others = async () => (await db.query(
    "select to_jsonb(p) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','fluid_private') and p.oid<>$1::regprocedure and p.proname not in('handles_search_preset','handles_search_payload') order by p.oid", [target],
  )).rows;
  beforeAll(async () => {
    db = await createTestDatabase({ before: migration });
    await db.exec(await readFile(new URL("../../supabase/candidates/standalone_workspace_conflict_codes.sql", import.meta.url), "utf8"));
    await db.exec("create role fixture_handles_default_grantee nologin; alter default privileges grant execute on functions to fixture_handles_default_grantee");
    original = await functionSnapshot();
    otherFunctions = await others();
    migrationSql = await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8");
    await db.exec(migrationSql);
  }, 90_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });
  const save = (payload: unknown, revision = 0, key = randomUUID(), owner = OWNER_A, tool = "handles") => asRole(db, "authenticated", owner, async () =>
    (await db.query<{ result: StandaloneWorkspaceResponse }>("select public.save_standalone_workspace($1,$2,$3,$4::jsonb,'[]'::jsonb) as result", [tool, revision, key, payload])).rows[0]!.result);
  const read = (owner = OWNER_A) => asRole(db, "authenticated", owner, async () =>
    (await db.query<{ result: StandaloneWorkspaceResponse }>("select public.get_standalone_workspace('handles') as result")).rows[0]!.result);
  const valid = async (payload: unknown) => (await db.query<{ valid: boolean }>("select fluid_private.standalone_payload('handles',$1::jsonb) as valid", [payload])).rows[0]!.valid;

  it("round-trips old payloads and new unfinished authored input without trimming or rewriting history", async () => {
    const old = { version: 1, bundles: [] };
    expect(handlesDraftSchema.parse(old)).toEqual(old);
    const first = await save(old);
    const payload = draft();
    payload.search.platforms = [];
    payload.search.options = { prefixes: "", suffixes: "", separators: [] };
    expect(handlesDraftSchema.parse(payload)).toEqual(payload);
    expect(await valid(payload)).toBe(true);
    const second = await save(payload, 1);
    expect(second.workspace).toMatchObject({ id: first.workspace?.id, revision: 2, payload });
    expect(await read()).toEqual(second);
    expect((await db.query("select payload from public.standalone_workspace_revisions order by revision")).rows).toEqual([{ payload: old }, { payload }]);
  });

  it("retains owner isolation, exact current replay, and stale revision rejection", async () => {
    const payload = draft(), key = randomUUID();
    const first = await save(payload, 0, key);
    expect(await save(payload, 0, key)).toEqual(first);
    expect(await read(OWNER_B)).toEqual({ ownerId: OWNER_B, workspace: null });
    const other = await save(payload, 0, key, OWNER_B);
    expect(other.workspace?.id).not.toBe(first.workspace?.id);
    await expect(save({ ...payload, search: { ...payload.search, names: "Changed input" } }, 0, key)).rejects.toMatchObject({ code: "PT409" });
    await save({ ...payload, search: { ...payload.search, names: "Later saved input" } }, 1);
    await expect(save(payload, 1)).rejects.toMatchObject({ code: "PT409" });
    expect((await read()).workspace?.revision).toBe(2);
    expect((await db.query("select * from public.jobs")).rows).toEqual([]);
  });

  it.each([
    ["null search", (): null => null],
    ["unknown key", () => ({ ...draft().search, evidence: [] })],
    ["missing required draft input", () => { const { nameDraft: _removed, ...value } = draft().search; void _removed; return value; }],
    ["oversized names", () => ({ ...draft().search, names: "x".repeat(3001) })],
    ["oversized draft input", () => ({ ...draft().search, nameDraft: "x".repeat(3001) })],
    ["oversized title", () => ({ ...draft().search, title: "x".repeat(161) })],
    ["oversized list", () => ({ ...draft().search, list: "x".repeat(161) })],
    ["duplicate imports", () => ({ ...draft().search, imports: ["same", "same"] })],
    ["oversized import list", () => ({ ...draft().search, imports: Array.from({ length: 31 }, (_, i) => String(i)) })],
    ["oversized import label", () => ({ ...draft().search, imports: ["x".repeat(161)] })],
    ["non-string import", () => ({ ...draft().search, imports: [null] })],
    ["duplicate platforms", () => ({ ...draft().search, platforms: ["x", "x"] })],
    ["unknown platform", () => ({ ...draft().search, platforms: ["other"] })],
    ["invalid options", () => ({ ...draft().search, options: null })],
    ["oversized prefix", () => ({ ...draft().search, options: { ...emptyHandlesSearch().options, prefixes: "x".repeat(201) } })],
    ["oversized suffix", () => ({ ...draft().search, options: { ...emptyHandlesSearch().options, suffixes: "x".repeat(201) } })],
    ["duplicate separators", () => ({ ...draft().search, options: { ...emptyHandlesSearch().options, separators: ["", ""] } })],
    ["unknown separator", () => ({ ...draft().search, options: { ...emptyHandlesSearch().options, separators: ["-"] } })],
    ["unknown option", () => ({ ...draft().search, options: { ...emptyHandlesSearch().options, confirmedAvailable: true } })],
    ["too many presets", () => ({ ...draft().search, savedSearches: Array.from({ length: 21 }, preset) })],
    ["invalid preset UUID", () => ({ ...draft().search, savedSearches: [{ ...preset(), id: "bad" }] })],
    ["duplicate preset UUID", () => { const item = preset(); return { ...draft().search, savedSearches: [item, item] }; }],
    ["oversized preset names", () => ({ ...draft().search, savedSearches: [{ ...preset(), names: "x".repeat(3001) }] })],
    ["unknown preset data", () => ({ ...draft().search, savedSearches: [{ ...preset(), providerResult: "available" }] })],
  ] as const)("rejects %s identically in the shared codec and SQL without inserting rows", async (_label, invalidSearch) => {
    const payload = { version: 1, bundles: [], search: invalidSearch() };
    expect(handlesDraftSchema.safeParse(payload).success).toBe(false);
    expect(await valid(payload)).toBe(false);
    await expect(save(payload)).rejects.toMatchObject({ code: "22023" });
    expect((await read()).workspace).toBeNull();
  });

  it("keeps the existing UTF-8 payload bound including the optional search state", async () => {
    const payload = draft();
    payload.search.savedSearches = Array.from({ length: 20 }, () => ({ ...preset(), names: "é".repeat(3000) }));
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeGreaterThan(120_000);
    expect(handlesDraftSchema.safeParse(payload).success).toBe(false);
    expect(await valid(payload)).toBe(false);
    await expect(save(payload)).rejects.toMatchObject({ code: "22023" });
    const bounded = draft();
    bounded.search.names = "😀".repeat(1500);
    bounded.search.nameDraft = "😀".repeat(1500);
    bounded.search.imports = ["", " ", "😀".repeat(80)];
    bounded.search.title = "😀".repeat(80);
    expect(handlesDraftSchema.safeParse(bounded).success).toBe(true);
    expect(await valid(bounded)).toBe(true);
    expect((await save(bounded)).workspace?.payload).toEqual(bounded);
  });

  it("does not admit client-written provider evidence or widen other tool payloads", async () => {
    const bundle = { id: "local-fixture", title: "Cedar", list: "User list", savedAt: "2026-10-06T00:00:00Z",
      source: { id: "manual", name: "Cedar", origin: "manual", projectId: null, projectTitle: null },
      entries: [{ platform: "instagram", handle: "cedar", favorite: true, selected: false, accountCreated: null, evidence: [{ outcome: "confirmed_available" }] }] };
    const payload = { ...draft(), bundles: [bundle] };
    expect(handlesDraftSchema.safeParse(payload).success).toBe(false);
    expect(await valid(payload)).toBe(false);
    await expect(save(payload)).rejects.toMatchObject({ code: "22023" });
    await expect(save({ version: 1, input: "", extensions: ["com"], candidates: [], search: draft().search }, 0, randomUUID(), OWNER_A, "domains"))
      .rejects.toMatchObject({ code: "22023" });
    await expect(save({ ...draft(), history: [] })).rejects.toMatchObject({ code: "22023" });
  });

  it("preserves the existing validator OID/metadata, all other functions and restricted helper grants", async () => {
    const current = await functionSnapshot();
    expect(current.metadata).toEqual(original.metadata);
    expect(current.definition).toBe(original.definition.replace(originalCheck, newCheck));
    expect(await others()).toEqual(otherFunctions);
    for (const name of ["handles_search_preset", "handles_search_payload"]) {
      const signature = `fluid_private.${name}(jsonb)`;
      expect((await db.query("select prosecdef,provolatile,proconfig from pg_proc where oid=$1::regprocedure", [signature])).rows)
        .toEqual([{ prosecdef: false, provolatile: "i", proconfig: ['search_path=""'] }]);
      for (const role of ["authenticated", "anon", "service_role", "fixture_subscription_worker_a", "fixture_subscription_worker_b", "fixture_handles_default_grantee"]) {
        expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows).toEqual([{ allowed: false }]);
      }
    }
  });

  it("patches the separately pinned hosted predecessor without losing its Domains shortlist support", async () => {
    const current = await functionSnapshot();
    // These are the complete differences in the reviewed hosted prosrc capture;
    // the exact digest below proves this fixture matches that captured version.
    const hosted = original.definition.replace(
      "    if not fluid_private.standalone_keys(v,array['version','input','extensions','candidates'])",
      "    -- The four original keys remain required; only shortlistedDomains is optional.\n    if not fluid_private.standalone_keys(v-'shortlistedDomains',array['version','input','extensions','candidates'])",
    ).replace(
      "    if (select count(*)<>count(distinct value) from jsonb_array_elements(v->'extensions')) then return false; end if;",
      `    if v ? 'shortlistedDomains' then
      if jsonb_typeof(v->'shortlistedDomains') is distinct from 'array' or jsonb_array_length(v->'shortlistedDomains')>200 then return false; end if;
      if (select count(*)<>count(distinct value) from jsonb_array_elements(v->'shortlistedDomains')) then return false; end if;
      for item in select value from jsonb_array_elements(v->'shortlistedDomains') loop
        if jsonb_typeof(item)<>'string' or not fluid_private.standalone_domain(item#>>'{}') then return false; end if;
      end loop;
    end if;
    if (select count(*)<>count(distinct value) from jsonb_array_elements(v->'extensions')) then return false; end if;`,
    );
    try {
      await db.exec(hosted);
      expect((await db.query("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') as hash from pg_proc where oid=$1::regprocedure", [target])).rows)
        .toEqual([{ hash: "cd1f2d2c36a2941265ee5e16f849a7afc48aeddd03be6af54c25210dd9f34d94" }]);
      await db.exec(migrationSql.slice(migrationSql.indexOf("-- Patch only the Handles")).replace(/\ncommit;\s*$/u, "\n"));
      const updated = await functionSnapshot();
      expect(updated.metadata).toEqual(original.metadata);
      expect(updated.definition).toBe(hosted.replace(originalCheck, newCheck));
      const domain = { version: 1, input: "", extensions: ["com"], candidates: [], shortlistedDomains: ["cedar.com"] };
      expect((await db.query("select fluid_private.standalone_payload('domains',$1::jsonb) as valid", [domain])).rows).toEqual([{ valid: true }]);
      expect((await db.query("select fluid_private.standalone_payload('domains',$1::jsonb) as valid", [{ ...domain, shortlistedDomains: ["cedar.com", "cedar.com"] }])).rows).toEqual([{ valid: false }]);
      expect(await valid(draft())).toBe(true);
    } finally { await db.exec(current.definition); }
  });
});
