import { randomUUID, createHash } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { asRole, createTestDatabase, resetFixture, OWNER_A, OWNER_B, type TestDatabase } from './local-supabase';
import { contextSnapshotSchema } from '@/domain/projects';
import { attachedProjectDraftReceiptSchema, ownedAttachmentRefSchema } from '@/domain/attachments';
vi.mock('server-only', () => ({}));
import { createHomeAttachmentService } from '@/server/home-attachments';
import { createPostgresHomeAttachmentBackend } from '@/server/home-attachments/postgres';
import type { AuthenticatedContext } from '@/server/auth/context';
import type { IdentityConnectionFactory } from '@/server/data/identity-transaction';
import { PROPOSED_HOME_ATTACHMENT_POLICY } from '@/domain/attachments';
const hash = createHash('sha256').update('brief').digest('hex');
const upload = () => ({ requestKey: randomUUID(), name: 'brief.txt', mimeType: 'text/plain' as const, contentHash: hash });
const context = contextSnapshotSchema.parse({ description: 'Frozen brief', selectedName: 'Cedar', intake: { conversation: [{ id: 'first', kind: 'user_message', text: 'Exact text', createdAt: '2026-10-07T00:00:00Z' }] } });
const draft = (ids: string[]) => ({ requestKey: randomUUID(), project: { title: 'Home brand', scope: 'complete_brand' as const, context }, attachmentIds: ids });
type Reservation = { requestKey: string; verified: boolean; storagePath: string; ref: { id: string; ownerId: string; projectId: string|null; projectRevision: number|null; blobVersionId: string; sourceReceiptId: string; state: string } };
describe('Home pre-project SQL ownership, CAS and recovery (local fixtures)', () => {
 let db: TestDatabase;
 beforeAll(async () => {
  db = await createTestDatabase();
  await db.exec(`create role fixture_home_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; create role fixture_home_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   grant usage on schema public,fluid_private to fixture_home_a,fixture_home_b;
   grant execute on function fluid_private.home_attachment_owner(),fluid_private.prepare_home_attachment(jsonb,bigint),fluid_private.observe_home_attachment(uuid,jsonb),fluid_private.lookup_home_attachment(uuid),fluid_private.resolve_home_attachments(uuid[]) to fixture_home_a,fixture_home_b;`);
 }, 60_000);
 beforeEach(async () => { await resetFixture(db); await db.query("insert into fluid_private.home_attachment_principals(role_name,role_oid,owner_id) select rolname,oid,case when rolname='fixture_home_a' then $1::uuid else $2::uuid end from pg_roles where rolname in('fixture_home_a','fixture_home_b')", [OWNER_A, OWNER_B]); });
 afterAll(async () => db?.close());
 async function trusted<T>(fn: () => Promise<T>, owner = OWNER_A) { await db.exec(`set session authorization ${owner === OWNER_A ? 'fixture_home_a' : 'fixture_home_b'}`); try { return await fn(); } finally { await db.exec('set session authorization postgres'); } }
 const prepare = (input = upload(), size = 5, owner = OWNER_A) => trusted(async () => (await db.query<{ value: Reservation }>('select fluid_private.prepare_home_attachment($1,$2) value', [input, size])).rows[0]!.value, owner);
 const observe = (id: string, owner = OWNER_A, byteLength = 5) => trusted(async () => (await db.query<{ value: unknown }>('select fluid_private.observe_home_attachment($1,$2) value', [id, { contentHash: hash, mimeType: 'text/plain', byteLength }])).rows[0]!.value, owner);
 const rpc = async (name: string, args: unknown[], owner = OWNER_A) => asRole(db, 'authenticated', owner, async () => (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`, args)).rows[0]!.value);
 const save = (input: ReturnType<typeof draft>, owner = OWNER_A) => rpc('save_attached_home_project', [input, JSON.stringify(input.project.context)], owner);
 it('staging has no project, freezes immutable identity and exact-request replay', async () => {
  const input = upload(), row = await prepare(input);
  expect(row.ref).toMatchObject({ ownerId: OWNER_A, projectId: null, projectRevision: null, state: 'staged' }); expect(row.verified).toBe(false); expect(await prepare(input)).toEqual(row);
  expect((await db.query('select count(*)::int total from public.projects')).rows).toEqual([{ total: 0 }]);
  expect(await rpc('read_home_attachment_request', [input.requestKey])).toEqual({ status: 'pending', requestKey: input.requestKey });
  const receipt = ownedAttachmentRefSchema.parse(await observe(row.ref.id)); expect(receipt.projectId).toBeNull();
  expect(await rpc('read_home_attachment_request', [input.requestKey])).toEqual({ status: 'committed', receipt });
  await expect(prepare({ ...input, name: 'other.txt' })).rejects.toMatchObject({ code: '40001' });
 });
 it('owner recovery and raw reads never expose another tenant, even with same key', async () => {
  const input = upload(), row = await prepare(input); await observe(row.ref.id);
  expect(await rpc('read_home_attachment_request', [input.requestKey], OWNER_B)).toEqual({ status: 'not_found' });
  expect((await asRole(db, 'authenticated', OWNER_B, () => db.query('select * from public.home_attachments'))).rows).toEqual([]);
  await expect(observe(row.ref.id, OWNER_B)).rejects.toMatchObject({ code: 'P0002' });
  const other = await prepare(input, 5, OWNER_B); expect(other.ref.id).not.toBe(row.ref.id);
 });
 it('rejects forged byte observations, anonymous callers and direct data mutations', async () => {
  const row = await prepare();
  await expect(observe(row.ref.id, OWNER_A, 6)).rejects.toMatchObject({ code: '22023' });
  await expect(asRole(db, 'authenticated', OWNER_A, () => db.query('select fluid_private.observe_home_attachment($1,$2)', [row.ref.id, {}]))).rejects.toMatchObject({ code: '42501' });
  await expect(asRole(db, 'authenticated', OWNER_A, () => db.query('update public.home_attachments set verified=true'))).rejects.toMatchObject({ code: '42501' });
  await expect(asRole(db, 'anon', null, () => db.query('select public.read_home_attachment_request($1)', [randomUUID()]))).rejects.toMatchObject({ code: '42501' });
  await expect(db.query('select fluid_private.prepare_home_attachment($1,5)', [upload()])).rejects.toMatchObject({ code: '42501' });
 });
 it('ignores spoofed owner claims and refuses changed principal OID binding', async () => {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_B]); const row = await prepare(); expect(row.ref.ownerId).toBe(OWNER_A);
  await db.query("update fluid_private.home_attachment_principals set role_oid=1 where role_name='fixture_home_a'"); await expect(prepare()).rejects.toMatchObject({ code: '42501' });
 });
 it('creates one project with all verified attachments in original order and recovers after later edits', async () => {
  const a = await prepare(), b = await prepare(); await observe(a.ref.id); await observe(b.ref.id); const input = draft([b.ref.id, a.ref.id]);
  const receipt = attachedProjectDraftReceiptSchema.parse(await save(input)); expect(receipt.project.context).toEqual(context); expect(receipt.attachments.map(r => r.id)).toEqual(input.attachmentIds);
  expect(receipt.attachments.every(r => r.projectId === receipt.project.id && r.projectRevision === 1 && r.state === 'linked')).toBe(true);
  await rpc('append_project_revision', [receipt.project.id, 1, { ...context, description: 'Later edit' }, hash]);
  expect(await save(input)).toEqual(receipt); expect(await rpc('read_attached_home_project_request', [input.requestKey])).toEqual({ status: 'committed', receipt });
  expect(await rpc('read_attached_home_project_request', [input.requestKey], OWNER_B)).toEqual({ status: 'not_found' });
  expect((await db.query('select count(*)::int total from public.projects')).rows).toEqual([{ total: 1 }]);
  expect(await rpc('read_home_attachment_request', [a.requestKey])).toEqual({ status: 'committed', receipt: { ...receipt.attachments[1], projectId: null, projectRevision: null, state: 'staged' } });
 });
 it('changed final request conflicts while already linked files cannot attach to a second project', async () => {
  const a = await prepare(); await observe(a.ref.id); const input = draft([a.ref.id]); await save(input);
  await expect(save({ ...input, project: { ...input.project, title: 'Changed' } })).rejects.toMatchObject({ code: 'PT409' });
  await expect(save(draft([a.ref.id]))).rejects.toMatchObject({ code: 'PT409' });
  expect((await db.query('select count(*)::int total from public.projects')).rows).toEqual([{ total: 1 }]);
 });
 it('rejects missing, foreign, duplicate, unverified and excessive attachments before creating a project', async () => {
  const a = await prepare(), b = await prepare(upload(), 5, OWNER_B);
  for (const ids of [[randomUUID()], [b.ref.id]]) await expect(save(draft(ids))).rejects.toMatchObject({ code: 'P0002' });
  await expect(save(draft([a.ref.id]))).rejects.toMatchObject({ code: 'PT409' });
  await expect(save(draft([a.ref.id, a.ref.id]))).rejects.toMatchObject({ code: '22023' });
  await expect(save(draft(Array.from({ length: 6 }, () => randomUUID())))).rejects.toMatchObject({ code: '22023' });
  await expect(prepare(upload(), 10_485_761)).rejects.toMatchObject({ code: '22023' });
  expect((await db.query('select count(*)::int total from public.projects')).rows).toEqual([{ total: 0 }]);
 });
 it('enforces aggregate bytes in the database, not just the client policy', async () => {
  const rows = []; for (let i=0;i<3;i++) { const r = await prepare(upload(), 10_485_760); await observe(r.ref.id, OWNER_A, 10_485_760); rows.push(r); }
  await expect(save(draft(rows.map(r => r.ref.id)))).rejects.toMatchObject({ code: '22023' }); expect((await db.query('select count(*)::int total from public.projects')).rows).toEqual([{ total: 0 }]);
 });
 it('accepts all five verified files exactly at the total-byte ceiling', async () => {
  const rows = [];
  for (const size of [10_485_760,10_485_760,5_242_878,1,1]) { const row = await prepare(upload(), size); await observe(row.ref.id, OWNER_A, size); rows.push(row); }
  const receipt = attachedProjectDraftReceiptSchema.parse(await save(draft(rows.map(r => r.ref.id))));
  expect(receipt.attachments).toHaveLength(5); expect(receipt.attachments.reduce((n, a) => n+a.byteLength, 0)).toBe(26_214_400);
 });
 it('forbids rewriting verified metadata, linked files and immutable final receipts', async () => {
  const row = await prepare(); await observe(row.ref.id); const receipt = attachedProjectDraftReceiptSchema.parse(await save(draft([row.ref.id])));
  await expect(db.query("update public.home_attachments set name='other.txt' where id=$1", [row.ref.id])).rejects.toMatchObject({ code: '55000' });
  await expect(db.query('update public.home_attachments set verified=false where id=$1', [row.ref.id])).rejects.toMatchObject({ code: '55000' });
  await expect(db.query('update public.home_attachments set project_id=null,project_revision=null where id=$1', [row.ref.id])).rejects.toMatchObject({ code: '55000' });
  await expect(db.query('delete from public.home_attachment_project_requests where project_id=$1', [receipt.project.id])).rejects.toMatchObject({ code: '55000' });
 });
 it('rolls back project and every linkage when final receipt insertion fails', async () => {
  const row = await prepare(); await observe(row.ref.id); const input = draft([row.ref.id]);
  await db.exec("create function public.reject_home_fixture() returns trigger language plpgsql as $$begin raise exception 'fixture' using errcode='23514';end$$;create trigger reject_home_fixture before insert on public.home_attachment_project_requests for each row execute function public.reject_home_fixture()");
  try { await expect(save(input)).rejects.toMatchObject({ code: '23514' }); expect((await db.query('select count(*)::int total from public.projects')).rows).toEqual([{ total: 0 }]); expect((await db.query('select project_id from public.home_attachments')).rows).toEqual([{ project_id: null }]); }
  finally { await db.exec('drop trigger reject_home_fixture on public.home_attachment_project_requests;drop function public.reject_home_fixture()'); }
  expect(attachedProjectDraftReceiptSchema.parse(await save(input)).attachments).toHaveLength(1);
 });
 it('rejects forged context text, invalid nested context and extra metadata before creating rows', async () => {
  const input = draft([]);
  await expect(rpc('save_attached_home_project', [input, '{}'])).rejects.toMatchObject({ code: '22023' });
  await expect(save({ ...input, project: { ...input.project, context: { ...context, competitors: [{ forged: true }] as never } } })).rejects.toMatchObject({ code: '22023' });
  await expect(prepare({ ...upload(), ownerId: OWNER_B } as ReturnType<typeof upload>)).rejects.toMatchObject({ code: '22023' });
 });
 it('runs actual service, byte store and Postgres adapter end to end without a pre-existing project', async () => {
  const oid = (await db.query<{ oid: number }>("select oid::int oid from pg_roles where rolname='fixture_home_a'")).rows[0]!.oid;
  const factory: IdentityConnectionFactory = { async acquire() {
   await db.exec('set session authorization fixture_home_a');
   return { binding: { ownerId: OWNER_A, roleName: 'fixture_home_a', roleOid: oid }, connection: {
    query: (sql, parameters) => db.query(sql, parameters ? [...parameters] : []),
    release: async () => { await db.exec('set session authorization postgres'); }, discard: async () => { await db.exec('set session authorization postgres'); },
   } };
  } };
  const auth = { userId: OWNER_A, client: { async rpc(name: string, args: Record<string, unknown>) {
   try { return { data: await rpc(name, Object.values(args)), error: null }; } catch (error) { return { data: null, error }; }
  } } } as unknown as AuthenticatedContext;
  const objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const service = createHomeAttachmentService({ backend: createPostgresHomeAttachmentBackend(factory), policy: PROPOSED_HOME_ATTACHMENT_POLICY, storage: {
   async putIfAbsent(path, bytes, mimeType) { if (!objects.has(path)) objects.set(path, { bytes: bytes.slice(), mimeType }); }, async read(path) { const row = objects.get(path); return row ? { ...row, bytes: row.bytes.slice() } : null; },
  } });
  const bytes = new TextEncoder().encode('brief'), input = upload();
  const ref = await service.stageHomeAttachment(auth, input, bytes);
  expect((await db.query('select count(*)::int total from public.projects')).rows).toEqual([{ total: 0 }]);
  expect(await service.readHomeAttachmentRequest(auth, input.requestKey)).toEqual({ status: 'committed', receipt: ref });
  const request = draft([ref.id]); const receipt = await service.saveAttachedProjectDraft(auth, request);
  expect(receipt.project.context).toEqual(context); expect(await service.saveAttachedProjectDraft(auth, request)).toEqual(receipt);
  expect(await service.resolveOwnedAttachments(auth, receipt.project.id, receipt.attachments)).toEqual(receipt.attachments);
  const storedHash = (await db.query<{ input_hash: string }>('select input_hash from public.project_revisions where project_id=$1', [receipt.project.id])).rows[0]!.input_hash;
  expect(storedHash).toBe(createHash('sha256').update(JSON.stringify(context)).digest('hex'));
 });

});

it('scrubs hostile default grants from only Home tables and exact function signatures', async () => {
 const { PGlite } = await import('@electric-sql/pglite'); const { readFile, readdir } = await import('node:fs/promises'); const db = new PGlite();
 try {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create role fluid_identity_writer_definer_v1 nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role fixture_subscription_worker_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
   create schema storage;create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);
   create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text,unique(bucket_id,name));
   alter table storage.objects enable row level security;grant usage on schema storage to authenticated,service_role;grant select,insert,update,delete on storage.objects to authenticated,service_role;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url), candidate = '20261007015000_home_attachments.sql';
  for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql') && n < candidate).sort()) await db.exec(await readFile(new URL(name, directory), 'utf8'));
  await db.exec("create role fixture_home_hostile nologin;alter default privileges in schema public,fluid_private grant all on tables to fixture_home_hostile with grant option;alter default privileges in schema public,fluid_private grant all on functions to fixture_home_hostile with grant option;create table public.unrelated_home_fixture(id integer);create function public.read_home_attachment_request(text) returns text language sql as $$select $1$$;");
  const defaults = (await db.query('select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid')).rows;
  await db.exec(await readFile(new URL(candidate, directory), 'utf8'));
  for (const name of ['fluid_private.home_attachment_principals','public.home_attachments','public.home_attachment_project_requests']) {
   for (const permission of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_home_hostile',$1,$2) v", [name, permission])).rows[0]!.v, `${name} ${permission}`).toBe(false);
   expect((await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>('select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass', [name])).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  }
  for (const fn of ['fluid_private.home_attachment_owner()','fluid_private.home_attachment_ref(public.home_attachments,boolean)','fluid_private.home_attachment_reservation(public.home_attachments)','fluid_private.home_attachment_immutable()','fluid_private.prepare_home_attachment(jsonb,bigint)','fluid_private.observe_home_attachment(uuid,jsonb)','fluid_private.lookup_home_attachment(uuid)','fluid_private.resolve_home_attachments(uuid[])','public.read_home_attachment_request(uuid)','public.save_attached_home_project(jsonb,text)','public.read_attached_home_project_request(uuid)']) expect((await db.query<{ v: boolean }>("select has_function_privilege('fixture_home_hostile',$1,'EXECUTE') v", [fn])).rows[0]!.v, fn).toBe(false);
  expect((await db.query('select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid')).rows).toEqual(defaults);
  expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_home_hostile','public.unrelated_home_fixture','TRUNCATE') v")).rows[0]!.v).toBe(true);
  expect((await db.query<{ v: boolean }>("select has_function_privilege('fixture_home_hostile','public.read_home_attachment_request(text)','EXECUTE') v")).rows[0]!.v).toBe(true);
 } finally { await db.close(); }
}, 60_000);
