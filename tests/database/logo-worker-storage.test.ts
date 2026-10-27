import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, resetFixture, asRole, OWNER_A, OWNER_B, type TestDatabase } from './local-supabase';
import { SYNTHETIC_CONCEPT_READINESS } from './logo-readiness-fixture';
import { logoWorkspaceV2Schema } from '../../src/domain/logo-workspace';
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema } from '../../src/domain/logo-jobs';
import type { IdentityAssetReservation } from '../../src/server/data/identity-asset-store';

const candidate = new URL('../../supabase/candidates/logo_worker_storage.sql', import.meta.url);
const workerRole = 'fluid_logo_worker_storage_fixture', authUser = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const uuid = () => randomUUID();
type Lease = { id: string; lease_token: string; input: { attemptId: string }; project_id: string };
// Disposable PostgreSQL only: models verified provider claims and Storage operation
// context, not JWT signature verification or a live Auth/Storage service.
describe('dedicated worker session/reservation Storage authority', () => {
  let db: TestDatabase, defaultsBefore: unknown[], policiesBefore: unknown[];
  beforeAll(async () => {
    db = await createTestDatabase();
    await db.exec(`create role ${workerRole} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role fixture_storage_acl_probe nologin;
      alter default privileges grant all on tables to fixture_storage_acl_probe;
      alter default privileges grant all on functions to fixture_storage_acl_probe;
      alter table auth.users add column is_anonymous boolean not null default false;
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant execute on function auth.jwt() to authenticated;
      grant usage on schema public,fluid_private to ${workerRole};
      grant execute on function public.claim_logo_job(text,integer),public.begin_logo_job_step(uuid,uuid,text,text,bigint),
        fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),public.read_leased_logo_record(uuid,uuid,text,jsonb) to ${workerRole};
      create policy fixture_ordinary_read on storage.objects for select to authenticated using(owner_id=auth.uid()::text);
    `);
    defaultsBefore = (await db.query('select * from pg_default_acl order by oid')).rows;
    policiesBefore = (await db.query("select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='storage' order by policyname")).rows;
    await db.exec(await readFile(candidate, 'utf8'));
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await resetFixture(db);
    await db.query('insert into auth.users(id) values($1)', [authUser]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [sessionId, authUser]);
    await db.query(`insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2`, [OWNER_A, workerRole]);
    await db.query(`insert into fluid_private.logo_storage_principals(auth_user_id,owner_id,role_name,role_oid,worker_id,enabled)
      select $1,$2,rolname,oid,'fixture',true from pg_roles where rolname=$3`, [authUser, OWNER_A, workerRole]);
    await db.query(`insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled)
      values($1,'identity.logo_concept',$2,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',100,true)`, [OWNER_A, 'a'.repeat(64)]);
    // Reporter accepts fixture-prefixed names only; equivalent real reporter call
    // is made here using this actual restricted login, with an explicit manifest.
    await db.exec(`grant execute on function public.report_logo_worker_ready(text,jsonb,integer) to ${workerRole}`);
    await worker(() => db.query('select public.report_logo_worker_ready($1,$2,90)', ['fixture', [SYNTHETIC_CONCEPT_READINESS]]));
  });
  async function worker<T>(run: () => Promise<T>) { await db.exec(`set session authorization ${workerRole}`); try { return await run(); } finally { await db.exec('set session authorization postgres'); } }
  const rpc = (name: string, args: unknown[]) => asRole(db, 'authenticated', OWNER_A, async () => (await db.query<{ v: unknown }>(`select public.${name}(${args.map((_, i) => `$${i+1}`).join(',')}) v`, args)).rows[0]!.v);
  async function prepare(): Promise<{ job: Lease; reservation: IdentityAssetReservation }> {
    const w = logoWorkspaceV2Schema.parse(await rpc('start_logo_project', [{ requestKey: uuid(), brief: { name: 'Storage fixture', activity: 'Test', audience: 'Test', personality: 'Precise', logoTypes: ['wordmark'] } }]));
    const snap = (await db.query<{ id: string }>('select reference_snapshot_id id from public.logo_stage_revisions where id=$1', [w.stages.brief_references!.id])).rows[0]!.id;
    const quote = logoCostQuoteSchema.parse(await rpc('quote_logo_operation', [w.projectId, { operation: 'concepts', expected: w.heads, briefRevisionId: w.stages.brief_references!.id, referenceSnapshotId: snap }]));
    await rpc('admit_logo_operation', [w.projectId, { requestKey: uuid(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: w.heads }]);
    return worker(async () => {
      const job = (await db.query<Lease>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;
      const inputs = (await db.query<{ v: unknown }>("select public.read_leased_logo_record($1,$2,'input_revisions',null) v", [job.id, job.lease_token])).rows[0]!.v;
      const write = { kind: 'stage', publication: { requestKey: uuid(), inputRevisions: inputs, mimeType: 'image/png', contentHash: 'a'.repeat(64), byteLength: 3, source: { kind: 'concept', sourceId: job.input.attemptId } } };
      const reservation = (await db.query<{ v: IdentityAssetReservation }>('select fluid_private.prepare_logo_asset($1,$2,$3,$4) v', [job.project_id, write, job.id, job.lease_token])).rows[0]!.v;
      return { job, reservation };
    });
  }
  async function auth<T>(run: () => Promise<T>, claims: Record<string, unknown> = {}, user = authUser) {
    const jwt = { sub: user, session_id: sessionId, role: 'authenticated', aud: 'authenticated', iss: 'https://fricsfwqibyhemknqgyf.supabase.co/auth/v1', exp: Math.floor(Date.now()/1000)+3600, is_anonymous: false, ...claims };
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(jwt)]);
    try { return await asRole(db, 'authenticated', user, run); } finally { await db.query("select set_config('request.jwt.claims','',false)"); }
  }
  const authorize = (job: Lease, reservation: IdentityAssetReservation, claims = {}, user = authUser) => auth(async () => (await db.query<{ v: unknown }>('select public.authorize_logo_storage_reservation($1,$2,$3) v', [job.id, job.lease_token, reservation.id])).rows[0]!.v, claims, user);
  async function object<T>(operation: string, run: () => Promise<T>, claims = {}, user = authUser) { await db.query("select set_config('storage.operation',$1,false)", [operation]); return auth(run, claims, user); }
  const insert = (r: IdentityAssetReservation) => object('object.upload', () => db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [r.storagePath, authUser]));
  const read = (r: IdentityAssetReservation, operation = 'object.get_authenticated', claims = {}, user = authUser) => object(operation, async () => (await db.query('select name from storage.objects where name=$1', [r.storagePath])).rows, claims, user);

  it('grants exact current reservation only and preserves create-only uniqueness', async () => {
    const { job, reservation: r } = await prepare(); await expect(insert(r)).rejects.toMatchObject({ code: '42501' });
    const grant = await authorize(job, r); expect(grant).toMatchObject({ authUserId: authUser, ownerId: OWNER_A, sessionId, jobId: job.id, leaseToken: job.lease_token, reservation: r });
    expect(await authorize(job, r)).toEqual(grant); await insert(r); expect(await read(r)).toHaveLength(1);
    await expect(insert(r)).rejects.toMatchObject({ code: '23505' });
    expect((await db.query('select * from fluid_private.logo_storage_grants')).rows).toHaveLength(1);
  });
  it('rejects foreign identities, missing/forged/expired sessions and owner claims', async () => {
    const { job, reservation: r } = await prepare();
    for (const claims of [{ session_id: uuid() }, { session_id: 'bad' }, { session_id: null }, { exp: 0 }, { is_anonymous: true }, { role: 'service_role' }, { iss: 'other' }, { sub: OWNER_A }])
      await expect(authorize(job, r, claims)).rejects.toMatchObject({ code: '42501' });
    await expect(authorize(job, r, { user_metadata: { ownerId: OWNER_A, session_id: sessionId } }, OWNER_B)).rejects.toMatchObject({ code: '42501' });
    await expect(authorize(job, r, {}, OWNER_A)).rejects.toMatchObject({ code: '42501' });
  });
  it('rejects a wrong lease, reservation, worker ID and mismatched role OID', async () => {
    const { job, reservation: r } = await prepare();
    await expect(authorize({ ...job, lease_token: uuid() }, r)).rejects.toMatchObject({ code: '42501' });
    await expect(authorize(job, { ...r, id: uuid() })).rejects.toMatchObject({ code: '42501' });
    await db.query("update public.jobs set worker_id='other' where id=$1", [job.id]); await expect(authorize(job, r)).rejects.toMatchObject({ code: '42501' });
    await db.query("update public.jobs set worker_id='fixture' where id=$1", [job.id]); await db.exec('update fluid_private.logo_storage_principals set role_oid=0');
    await expect(authorize(job, r)).rejects.toMatchObject({ code: '42501' });
  });
  it.each(['cancel_requested', 'cancelled', 'succeeded', 'failed', 'needs_reconciliation'])('fences %s after grant at actual Storage statements', async state => {
    const { job, reservation: r } = await prepare(); await authorize(job, r); await insert(r);
    await db.query("update public.jobs set state=$1,lease_token=case when $1='cancel_requested' then lease_token else null end,lease_expires_at=case when $1='cancel_requested' then lease_expires_at else null end where id=$2", [state, job.id]);
    expect(await read(r)).toEqual([]); await expect(insert(r)).rejects.toMatchObject({ code: '42501' });
  });
  it.each(['expiry', 'lease', 'policy', 'policy-budget', 'binding', 'session', 'session-expiry', 'membership'])('fences revoked %s after grant', async kind => {
    const { job, reservation: r } = await prepare(); await authorize(job, r); await insert(r);
    if (kind === 'expiry') await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    if (kind === 'lease') await db.query('update public.jobs set lease_token=$1 where id=$2', [uuid(), job.id]);
    if (kind === 'policy') await db.exec('update fluid_private.logo_runtime_policies set enabled=false');
    if (kind === 'policy-budget') await db.exec('update fluid_private.logo_runtime_policies set max_cost_microusd=101');
    if (kind === 'binding') await db.exec('update fluid_private.logo_storage_principals set enabled=false');
    if (kind === 'session') await db.exec('delete from auth.sessions');
    if (kind === 'session-expiry') await db.exec("update auth.sessions set not_after=clock_timestamp()-interval '1 second'");
    if (kind === 'membership') await db.exec(`grant fixture_storage_acl_probe to ${workerRole}`);
    try { expect(await read(r)).toEqual([]); await expect(insert(r)).rejects.toMatchObject({ code: '42501' }); }
    finally { if (kind === 'membership') await db.exec(`revoke fixture_storage_acl_probe from ${workerRole}`); }
  });
  it('keeps session grants separate and denies owner-path, neighbor-path and foreign-object reads', async () => {
    const { job, reservation: r } = await prepare(); await authorize(job, r); await insert(r);
    const otherSession = uuid(); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [otherSession, authUser]);
    expect(await read(r, 'object.get_authenticated', { session_id: otherSession })).toEqual([]);
    const foreign = `${OWNER_B}/${job.project_id}/${uuid()}/${uuid()}`;
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [foreign, authUser]);
    expect(await read({ ...r, storagePath: foreign })).toEqual([]);
    await expect(insert({ ...r, storagePath: `${r.storagePath}/more` })).rejects.toMatchObject({ code: '42501' });
    await expect(insert({ ...r, storagePath: r.storagePath.replace(OWNER_A, authUser) })).rejects.toMatchObject({ code: '42501' });
  });
  it('denies list/sign/info/update/delete despite a competing permissive policy', async () => {
    const { job, reservation: r } = await prepare(); await authorize(job, r); await insert(r);
    await db.exec('create policy fixture_overbroad on storage.objects for all to authenticated using(true) with check(true)');
    try {
      for (const op of ['', 'object.list', 'object.list_v2', 'object.sign', 'object.get_authenticated_info', 'object.update', 'object.delete']) expect(await read(r, op), op).toEqual([]);
      // Even forged upload/download operation context cannot permit UPDATE/DELETE.
      for (const op of ['object.upload', 'object.get_authenticated']) {
        expect(await object(op, async () => (await db.query("update storage.objects set name=name||'/changed' returning name")).rows)).toEqual([]);
        expect(await object(op, async () => (await db.query('delete from storage.objects returning name')).rows)).toEqual([]);
      }
      await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets','ordinary-owner-object',$1)", [OWNER_A]);
      expect(await read({ ...r, storagePath: 'ordinary-owner-object' }, 'object.list', {}, OWNER_A)).toHaveLength(1);
    } finally { await db.exec('drop policy fixture_overbroad on storage.objects'); }
  });
  it('preserves old policy/default ACLs and scrubs new-object access including default grant holders', async () => {
    expect((await db.query('select * from pg_default_acl order by oid')).rows).toEqual(defaultsBefore);
    const after = (await db.query("select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='storage' order by policyname")).rows;
    for (const policy of policiesBefore) expect(after).toContainEqual(policy);
    for (const role of ['anon', 'service_role', 'fixture_storage_acl_probe']) {
      expect((await db.query<{ ok: boolean }>("select has_function_privilege($1,'public.authorize_logo_storage_reservation(uuid,uuid,uuid)','execute') ok", [role])).rows[0]!.ok).toBe(false);
    }
    for (const role of ['authenticated', 'anon', 'service_role', 'fixture_storage_acl_probe'])
      for (const table of ['logo_storage_principals', 'logo_storage_grants']) expect((await db.query<{ ok: boolean }>(`select has_table_privilege($1,'fluid_private.${table}','select,insert,update,delete') ok`, [role])).rows[0]!.ok).toBe(false);
  });
});
