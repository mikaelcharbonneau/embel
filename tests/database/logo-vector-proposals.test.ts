import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { asRole, createTestDatabase, OWNER_A, resetFixture, seedProject, type TestDatabase } from './local-supabase';
const candidate = await readFile(new URL('../../supabase/candidates/logo-vector-proposals.sql', import.meta.url), 'utf8').catch(() => '');
describe('disabled vector proposal persistence candidate', () => {
 let db: TestDatabase;
 beforeAll(async () => { db = await createTestDatabase({ additionalMigrations: [candidate] }); await resetFixture(db); }, 60_000);
 afterAll(async () => { await db?.close(); });
 it('installs an empty private immutable evidence table with FORCE RLS', async () => {
  const row = (await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("select relrowsecurity,relforcerowsecurity from pg_class where oid=to_regclass('fluid_private.logo_vector_proposals')")).rows[0];
  expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
 });
 it('does not seed policy or worker enablement for the new operation', async () => {
  expect((await db.query("select * from fluid_private.logo_runtime_policies where operation='identity.logo_vector_propose'")).rows).toEqual([]);
  const p = await seedProject(db);
  const value = await asRole(db, 'authenticated', OWNER_A, async () => (await db.query<{ v: { items: unknown[] } }>('select public.list_logo_vector_proposals($1,$2) v', [p.id, {}])).rows[0]!.v);
  expect(value.items).toEqual([]);
 });
 it('generic API claims cannot acquire even an administratively seeded proposal job', async () => {
  const p = await seedProject(db);
  // Deliberately malformed administrative fixture: exclusion must precede policy/input parsing.
  const job = (await db.query<{ id: string }>("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd) values($1,$2,'identity.logo_vector_propose',1,$3,'{}','proposal-isolation',0) returning id", [OWNER_A, p.id, 'a'.repeat(64)])).rows[0]!;
  const claimed = await asRole(db, 'service_role', null, () => db.query("select id from public.claim_job('generic',60)"));
  expect(claimed.rows).toEqual([]);
  expect((await db.query('select state from public.jobs where id=$1', [job.id])).rows[0]).toEqual({ state: 'queued' });
 });
});
