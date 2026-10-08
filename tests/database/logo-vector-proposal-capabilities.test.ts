import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createTestDatabase, type TestDatabase, OWNER_A, OWNER_B } from './local-supabase';
import { proposalAdmissionFixture, WORKER } from './logo-vector-proposal-admission-fixture';
import { logoCapabilitiesSchema } from '@/domain/logo-capabilities';
const candidates = await Promise.all(['logo-vector-proposals.sql', 'logo-vector-proposal-quotes.sql', 'logo-vector-proposal-admission.sql', 'logo-vector-proposal-observations.sql', 'logo-vector-proposal-completion.sql'].map(name => readFile(new URL('../../supabase/candidates/' + name, import.meta.url), 'utf8')));
const projection = await readFile(new URL('../../supabase/candidates/logo-vector-proposal-capabilities.sql', import.meta.url), 'utf8').catch(() => '');
let db: TestDatabase, before: unknown[], after: unknown[];
const metadata = (database: TestDatabase) => database.query('select oid,proowner,proacl::text,prosecdef,provolatile,proparallel,proconfig,procost,prorows,proargdefaults::text from pg_proc where oid=$1::regprocedure', ['public.read_logo_capabilities(uuid)']);
beforeAll(async () => { db = await createTestDatabase({ additionalMigrations: [...candidates, projection], beforeMigration: async (database, sql) => { if (sql === projection && projection) before = (await metadata(database)).rows; } }); after = (await metadata(db)).rows; }, 60_000);
afterAll(async () => { await db?.close(); });
it('projects the sixth exact operation only through current policy and qualified readiness, preserving function metadata', async () => {
 expect(projection).toContain('34b78c8dba702eb7842ce356451f6f576fa672044dc57a247b4bc6185af2cf0f'); expect(after).toEqual(before);
 const f = await proposalAdmissionFixture(db), value = logoCapabilitiesSchema.parse(await f.rpc('read_logo_capabilities', [f.workspace.projectId]));
 expect(Object.keys(value.operations)).toHaveLength(6); expect(value.operations['identity.logo_vector_propose']).toMatchObject({ status: 'available' });
 for (const [key, state] of Object.entries(value.operations)) if (key !== 'identity.logo_vector_propose') expect(state).toEqual({ status: 'unavailable' });
 const expiry = value.operations['identity.logo_vector_propose']; if (expiry?.status === 'available') expect(Date.parse(expiry.expiresAt) - Date.parse(value.observedAt)).toBeLessThanOrEqual(30_000);
 await expect(f.rpc('read_logo_capabilities', [f.workspace.projectId], OWNER_B)).rejects.toMatchObject({ code: 'P0002' });
});
it('withdraws disabled, stale-policy, expired and revoked-principal proposal hints', async () => {
 const f = await proposalAdmissionFixture(db), read = () => f.rpc('read_logo_capabilities', [f.workspace.projectId]).then(logoCapabilitiesSchema.parse);
 await db.exec('alter role ' + WORKER + ' nologin'); try { expect((await read()).operations['identity.logo_vector_propose']).toEqual({ status: 'unavailable' }); } finally { await db.exec('alter role ' + WORKER + ' login'); }
 await db.query("update fluid_private.logo_runtime_policies set enabled=false where owner_id=$1 and operation='identity.logo_vector_propose'", [OWNER_A]);
 expect((await read()).operations['identity.logo_vector_propose']).toEqual({ status: 'unavailable' });
 await db.query("update fluid_private.logo_runtime_policies set enabled=true where owner_id=$1 and operation='identity.logo_vector_propose'", [OWNER_A]);
 expect((await read()).operations['identity.logo_vector_propose']).toEqual({ status: 'unavailable' }); await f.report();
 await db.exec("update fluid_private.logo_worker_readiness set descriptor=descriptor||'{\"model\":\"changed\"}'::jsonb");
 expect((await read()).operations['identity.logo_vector_propose']).toEqual({ status: 'unavailable' }); await f.report();
 await db.exec("update fluid_private.logo_worker_readiness set ready_until=clock_timestamp()-interval '1 second'");
 expect((await read()).operations['identity.logo_vector_propose']).toEqual({ status: 'unavailable' });
});
it('refuses a mismatched predecessor transaction without changing the function or its permissions', async () => {
 const before = (await db.query("select pg_get_functiondef('public.read_logo_capabilities(uuid)'::regprocedure) definition")).rows;
 await expect(db.exec(projection)).rejects.toMatchObject({ code: '55000' }); await db.exec('rollback');
 expect((await db.query("select pg_get_functiondef('public.read_logo_capabilities(uuid)'::regprocedure) definition")).rows).toEqual(before); expect((await metadata(db)).rows).toEqual(after);
});
it('keeps historical five-operation API values readable and rejects expired, foreign or extra new-operation hints', () => {
 const ownerId = OWNER_A, projectId = 'a0000000-0000-4000-8000-000000000010', observedAt = '2026-10-08T10:00:00.000Z';
 const operations = Object.fromEntries(['identity.logo_concept', 'identity.logo_refine', 'identity.logo_vectorize', 'identity.logo_directions', 'identity.logo_export'].map(key => [key, { status: 'unavailable' }]));
 const legacy = { ownerId, projectId, observedAt, operations }; expect(logoCapabilitiesSchema.safeParse(legacy).success).toBe(true);
 expect(logoCapabilitiesSchema.safeParse({ ...legacy, operations: { ...operations, 'identity.logo_vector_propose': { status: 'available', expiresAt: '2026-10-08T10:00:30.000Z' } } }).success).toBe(true);
 for (const extra of [{ status: 'available' }, { status: 'available', expiresAt: observedAt }, { status: 'available', expiresAt: '2026-10-08T10:00:31.000Z' }, { status: 'available', expiresAt: '2026-10-08T10:00:30.000Z', policy: {} }]) expect(logoCapabilitiesSchema.safeParse({ ...legacy, operations: { ...operations, 'identity.logo_vector_propose': extra } }).success).toBe(false);
});
