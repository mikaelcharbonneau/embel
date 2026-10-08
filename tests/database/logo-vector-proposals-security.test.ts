import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from './local-supabase';
const candidate = await readFile(new URL('../../supabase/candidates/logo-vector-proposals.sql', import.meta.url), 'utf8');
const signatures = ['fluid_private.lock_leased_job(uuid,uuid)', 'public.claim_job(text,integer)', 'public.expire_job_leases()', 'public.claim_subscription_job(text,uuid,text,integer)', 'public.subscription_worker_can_read_step(uuid,uuid)', 'fluid_private.logo_job_can_read_asset(public.jobs,jsonb)'];
const metadata = (db: TestDatabase) => db.query('select oid,proowner,proacl::text,prosecdef,provolatile,proparallel,proconfig,procost,prorows,proargdefaults::text from pg_proc where oid=any($1::regprocedure[]) order by oid', [signatures]);

/** Real disposable roles and PostgreSQL ACL checks; all content is seeded metadata. */
describe('proposal candidate exact ACL and owner isolation', () => {
 let db: TestDatabase, before: unknown[], defaults: unknown[], project: string, proposal: string;
 beforeAll(async () => {
  db = await createTestDatabase(); await resetFixture(db);
  await db.exec(`create role fixture_proposal_hostile login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   grant usage on schema public,fluid_private to fixture_proposal_hostile;
   alter default privileges in schema public,fluid_private grant all on tables to fixture_proposal_hostile with grant option;
   alter default privileges in schema public,fluid_private grant all on functions to fixture_proposal_hostile with grant option;
   create table public.unrelated_proposal_fixture(id integer);
   create function public.read_logo_vector_proposal(text) returns text language sql as $$select $1$$;`);
  before = (await metadata(db)).rows;
  defaults = (await db.query('select defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows;
  await db.exec(candidate);
  const p = await seedProject(db); project = p.id; proposal = randomUUID();
  const job = randomUUID(), quote = randomUUID(), base = randomUUID(), key = randomUUID();
  await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd) values($1,$2,$3,'identity.logo_vector_propose',1,$4,'{}',$5,0)", [job, OWNER_A, project, 'a'.repeat(64), key]);
  await db.query("insert into public.logo_cost_quotes values($1,$2,$3,'identity.logo_vector_propose','{}','[]','{}',clock_timestamp()+interval '1 minute')", [quote, OWNER_A, project]);
  await db.query('insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)', [base, OWNER_A, project, {}]);
  const record = { id: proposal, ownerId: OWNER_A, projectId: project, jobId: job, requestKey: key, quoteId: quote, baseVectorRevisionId: base, state: 'needs_reconciliation', materialization: 'unavailable', createdAt: '2026-10-08T00:00:00Z' };
  await db.query('insert into fluid_private.logo_vector_proposals(id,owner_id,project_id,job_id,request_key,quote_id,base_vector_revision_id,record) values($1,$2,$3,$4,$5,$6,$7,$8)', [proposal, OWNER_A, project, job, key, quote, base, record]);
 }, 60_000);
 afterAll(async () => { await db?.close(); });
 it('preserves every pre-existing function OID, ACL, owner and execution property', async () => {
  expect((await metadata(db)).rows).toEqual(before);
  expect((await db.query('select defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows).toEqual(defaults);
  expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_proposal_hostile','public.unrelated_proposal_fixture','TRUNCATE') v")).rows[0]!.v).toBe(true);
  expect((await db.query<{ v: boolean }>("select has_function_privilege('fixture_proposal_hostile','public.read_logo_vector_proposal(text)','EXECUTE') v")).rows[0]!.v).toBe(true);
 });
 it('scrubs hostile defaults from exact new objects, without broad grants', async () => {
  for (const role of ['anon', 'authenticated', 'service_role', 'fixture_proposal_hostile']) for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) expect((await db.query<{ v: boolean }>('select has_table_privilege($1,\'fluid_private.logo_vector_proposals\',$2) v', [role, privilege])).rows[0]!.v, `${role} ${privilege}`).toBe(false);
  for (const fn of ['public.read_logo_vector_proposal(uuid,uuid)', 'public.list_logo_vector_proposals(uuid,jsonb)']) for (const role of ['anon', 'service_role', 'fixture_proposal_hostile']) expect((await db.query<{ v: boolean }>('select has_function_privilege($1,$2,\'EXECUTE\') v', [role, fn])).rows[0]!.v, `${role} ${fn}`).toBe(false);
 });
 it('uses owner-filtered read entrypoints and rejects foreign project/proposal IDs', async () => {
  const rpc = (owner: string, id: string) => asRole(db, 'authenticated', owner, () => db.query<{ v: { id: string } }>('select public.read_logo_vector_proposal($1,$2) v', [project, id]));
  expect((await rpc(OWNER_A, proposal)).rows[0]!.v.id).toBe(proposal);
  await expect(rpc(OWNER_B, proposal)).rejects.toMatchObject({ code: 'P0002' });
  await expect(rpc(OWNER_A, randomUUID())).rejects.toMatchObject({ code: 'P0002' });
  await expect(asRole(db, 'anon', null, () => db.query('select public.read_logo_vector_proposal($1,$2)', [project, proposal]))).rejects.toMatchObject({ code: '42501' });
 });
 it('cannot change retained records even with administrative table privilege', async () => {
  await expect(db.query("update fluid_private.logo_vector_proposals set record=record||'{\"state\":\"succeeded\"}'::jsonb where id=$1", [proposal])).rejects.toMatchObject({ code: '55000' });
  await expect(db.query('delete from fluid_private.logo_vector_proposals where id=$1', [proposal])).rejects.toMatchObject({ code: '55000' });
 });
 it('FORCE RLS denies a restricted login even if a local test grants table SELECT', async () => {
  await db.exec('grant select on fluid_private.logo_vector_proposals to fixture_proposal_hostile; set session authorization fixture_proposal_hostile');
  try { expect((await db.query('select * from fluid_private.logo_vector_proposals')).rows).toEqual([]); }
  finally { await db.exec('set session authorization postgres; revoke select on fluid_private.logo_vector_proposals from fixture_proposal_hostile'); }
 });
 it('generic settlement and expiry cannot touch seeded running text proposal jobs', async () => {
  const job = (await db.query<{ id: string }>("select id from public.jobs where project_id=$1 and operation='identity.logo_vector_propose'", [project])).rows[0]!;
  const lease = randomUUID(); await db.query("update public.jobs set state='running',lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' where id=$1", [job.id, lease]);
  await expect(asRole(db, 'service_role', null, () => db.query('select public.heartbeat_job($1,$2,60)', [job.id, lease]))).rejects.toMatchObject({ code: '42501' });
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
  await asRole(db, 'service_role', null, () => db.query('select public.expire_job_leases()'));
  expect((await db.query('select state,lease_token from public.jobs where id=$1', [job.id])).rows[0]).toEqual({ state: 'running', lease_token: lease });
 });
 it('denies an otherwise-readable owned raster membership for text proposal jobs', async () => {
  const row = (await db.query<{ id: string; quote_id: string; lease_token: string }>("select j.id,p.quote_id,j.lease_token from public.jobs j join fluid_private.logo_vector_proposals p on p.job_id=j.id where j.project_id=$1", [project])).rows[0]!;
  const ref = { ownerId: OWNER_A, projectId: project, assetId: randomUUID(), versionId: randomUUID(), contentHash: 'a'.repeat(64) }, response = randomUUID();
  await db.query("update public.jobs set input=jsonb_build_object('quoteId',$2::text) where id=$1", [row.id,row.quote_id]);
  await db.query('insert into public.logo_provider_responses(id,owner_id,project_id,job_id,lease_token,observation) values($1,$2,$3,$4,$5,$6)', [response,OWNER_A,project,row.id,row.lease_token,{}]);
  await db.query('insert into public.logo_raster_results(job_id,owner_id,project_id,preview,provider_response_receipt_id) values($1,$2,$3,$4,$5)', [row.id,OWNER_A,project,{reference:ref},response]);
  const query = () => db.query<{ v: boolean }>('select fluid_private.logo_job_can_read_asset(j,$2) v from public.jobs j where j.id=$1', [row.id,ref]);
  expect((await query()).rows[0]!.v).toBe(false);
  // Mutation proof in this disposable DB: all other predecessor checks pass.
  const original = (await db.query<{ body: string; definition: string }>("select prosrc body,pg_get_functiondef(oid) definition from pg_proc where oid='fluid_private.logo_job_can_read_asset(public.jobs,jsonb)'::regprocedure")).rows[0]!;
  const guard = " if p_job.operation='identity.logo_vector_propose' then return false;end if;\n";
  expect(original.body.split(guard)).toHaveLength(2);
  try { await db.exec(original.definition.replace(original.body,original.body.replace(guard,''))); expect((await query()).rows[0]!.v).toBe(true); }
  finally { await db.exec(original.definition); }
  expect((await query()).rows[0]!.v).toBe(false);
 });
 it('rejects malformed, oversized and foreign cursors before returning summaries', async () => {
  for (const query of [{ limit: 0 }, { limit: 51 }, { limit: null }, { other: true }, { cursor: 'not-base64' }, { cursor: 'x'.repeat(5000) }, { cursor: Buffer.from(JSON.stringify({ ownerId: OWNER_B, projectId: project, id: proposal, createdAt: '2026-10-08T00:00:00Z' })).toString('base64') }]) await expect(asRole(db, 'authenticated', OWNER_A, () => db.query('select public.list_logo_vector_proposals($1,$2)', [project, query]))).rejects.toMatchObject({ code: '22023' });
 });
});

it('fails closed on a changed predecessor and rolls the candidate back', async () => {
 const db = await createTestDatabase();
 try {
  const signature = 'public.claim_job(text,integer)';
  const row = (await db.query<{ body: string; definition: string }>('select prosrc body,pg_get_functiondef(oid) definition from pg_proc where oid=$1::regprocedure', [signature])).rows[0]!;
  await db.exec(row.definition.replace(row.body, row.body + '\n-- Independent successor that requires review.\n'));
  await expect(db.exec(candidate)).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('vector_proposal_predecessor_mismatch') });
  await db.exec('rollback');
  expect((await db.query<{ v: unknown }>("select to_regclass('fluid_private.logo_vector_proposals') v")).rows[0]!.v).toBe(null);
 } finally { await db.close(); }
}, 60_000);
