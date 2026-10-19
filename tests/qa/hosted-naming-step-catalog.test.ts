import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { createTestDatabase, type TestDatabase } from "../database/local-supabase";
import { brainWorker, installBrainFixture } from "../database/naming-brain-fixture";
import { seedHostedNamingFixture } from "../database/hosted-naming-fixture";
import { saveProgressivePart } from "../database/naming-brain-progressive-fixture";

const migration = "20261019032503_hosted_naming_step_authority.sql";
const helper = "fluid_private.hosted_naming_step_authority(p_job uuid)";
const step = "public.begin_job_step(p_job_id uuid, p_lease_token uuid, p_step_key text, p_request_key text, p_max_cost_microusd bigint)";

type CatalogFunction = { signature: string; body: string; metadata: Record<string, unknown> };
async function functions(db: TestDatabase) {
  return (await db.query<CatalogFunction>(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' signature,
    p.prosrc body,to_jsonb(p)-array['oid','prosrc'] metadata
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in('public','fluid_private') order by 1`)).rows;
}

async function history(db: TestDatabase) {
  const tables = (await db.query<{ schema: string; name: string }>(`select n.nspname schema,c.relname name
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in('public','fluid_private') and c.relkind='r' order by 1,2`)).rows;
  const rows = [];
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table.schema) || !/^[a-z_]+$/.test(table.name)) throw Error("unexpected_fixture_identifier");
    const snapshot = (await db.query(`select count(*)::integer count,
      md5(coalesce(string_agg(to_jsonb(row)::text,E'\n' order by to_jsonb(row)::text),'')) digest
      from ${table.schema}.${table.name} row`)).rows;
    rows.push({ ...table, snapshot });
  }
  return rows;
}

it("changes only the shared step body, preserves its exact grants and all saved rows, and denies direct helper access", async () => {
  const db = await createTestDatabase({ before: migration });
  try {
    await installBrainFixture(db);
    const fixture = await seedHostedNamingFixture(db);
    const part = await saveProgressivePart(fixture, 0, 4);
    await brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, part.publication!, new AbortController().signal));
    // Preserve an account with insufficient historical headroom, rather than
    // testing this additive patch against a pristine accounting ledger alone.
    await db.exec("update public.usage_accounts set limit_microusd=0");
    await db.exec("create role fixture_step_hostile nologin; alter default privileges grant execute on functions to fixture_step_hostile");
    const beforeFunctions = await functions(db);
    const beforeHistory = await history(db);
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
    const afterFunctions = await functions(db);
    expect(afterFunctions.map(row => row.signature).filter(signature => !beforeFunctions.some(row => row.signature === signature))).toEqual([helper]);
    for (const previous of beforeFunctions) {
      const current = afterFunctions.find(row => row.signature === previous.signature);
      expect(current, previous.signature).toBeDefined();
      expect(current!.metadata, previous.signature).toEqual(previous.metadata);
      if (previous.signature === step) expect(current!.body).not.toBe(previous.body);
      else expect(current!.body, previous.signature).toBe(previous.body);
    }
    expect(beforeFunctions.some(row => row.signature === step)).toBe(true);
    expect(await history(db)).toEqual(beforeHistory);
    const added = afterFunctions.find(row => row.signature === helper)!;
    expect(added.metadata).toMatchObject({ prosecdef: false, provolatile: "s", proleakproof: false, proconfig: ['search_path=""'] });
    for (const role of ["anon", "authenticated", "service_role", "fixture_naming_brain_a", "fixture_naming_brain_b", "fixture_step_hostile"]) {
      const privilege = await db.query<{ allowed: boolean }>("select has_function_privilege($1,'fluid_private.hosted_naming_step_authority(uuid)','EXECUTE') allowed", [role]);
      expect(privilege.rows, role).toEqual([{ allowed: false }]);
    }
    await expect(brainWorker(db, () => db.query("select fluid_private.hosted_naming_step_authority($1)", [fixture.job.id]))).rejects.toMatchObject({ code: "42501" });
  } finally { await db.close(); }
}, 60_000);
