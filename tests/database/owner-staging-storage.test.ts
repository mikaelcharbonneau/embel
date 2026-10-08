import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, seedProject, HASH, type TestDatabase } from './local-supabase';
vi.mock('server-only', () => ({}));
import { vectorMemberRequestKey } from '@/features/logo-vector/server/publication';

const bucket = 'fluid-assets';
const migration = new URL('../../supabase/migrations/20261007022000_owner_staging_storage.sql', import.meta.url);
const inputRevisions = [{ stage: 'brief_references', revisionId: '41000000-0000-4000-8000-000000000001', revision: 1 }];
type ObjectRef = { id: string; path: string; owner: string; key: string; project: string };

describe('existing-owner staging Storage RLS, disposable PostgreSQL fixtures', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); await db.query("select set_config('storage.operation','',false)"); });

  async function operation<T>(name: string, owner: string | null, run: () => Promise<T>) {
    await db.query("select set_config('storage.operation',$1,false)", [name]);
    try { return await asRole(db, 'authenticated', owner, run); }
    finally { await db.query("select set_config('storage.operation','',false)"); }
  }
  const insert = (r: ObjectRef, op = 'object.upload', owner: string | null = r.owner, storedOwner: string | null = r.owner, name = r.path, bucketId = bucket) =>
    operation(op, owner, () => db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', [bucketId, name, storedOwner]));
  const read = (r: ObjectRef, op = 'object.get_authenticated', owner: string | null = r.owner) =>
    operation(op, owner, async () => (await db.query('select name from storage.objects where bucket_id=$1 and name=$2', [bucket, r.path])).rows);
  const store = (r: ObjectRef, owner: string | null = r.owner) => db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', [bucket, r.path, owner]);

  async function logo(options: { kind?: string; mimeType?: string; usage?: string; registryKind?: string; registry?: boolean; owner?: string; key?: string; source?: string; state?: string; job?: boolean; inputs?: unknown; requestChanges?: Record<string, unknown>; fileChanges?: Record<string, unknown> } = {}): Promise<ObjectRef> {
    const owner = options.owner ?? OWNER_A, project = (await seedProject(db, owner)).id;
    const key = options.key ?? randomUUID(), id = randomUUID(), asset = randomUUID(), version = randomUUID(), source = options.source ?? randomUUID();
    const usage = options.usage ?? 'logo_reference', kind = options.kind ?? 'upload';
    const mime = options.mimeType ?? (kind === 'stage' ? 'application/json' : usage === 'font' ? 'font/ttf' : 'image/png');
    const body = { requestKey: key, mimeType: mime, contentHash: HASH };
    const request = kind === 'stage' ? { kind, publication: { ...body, byteLength: 12, inputRevisions: options.inputs ?? inputRevisions, source: { kind: usage, sourceId: source } }, ...options.requestChanges }
      : { kind, intent: { ...body, usage, rightsDeclaration: 'Owned local fixture' }, byteLength: 12, ...options.requestChanges };
    let job: string | null = null;
    if (options.job) job = (await db.query<{ id: string }>("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd) values($1,$2,'strategy',1,$3,'{}',$4,0) returning id", [owner, project, HASH, randomUUID()])).rows[0]!.id;
    await db.query(`insert into public.logo_asset_publications(id,owner_id,project_id,request_key,request,asset_id,version_id,content_hash,mime_type,byte_length,purpose,source_receipt_id,source_kind,state,verification,job_id,lease_token,input_revision,input_hash)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,12,$10,$11,$12,$13,$14,$15,$16,1,$8)`,
      [id, owner, project, key, request, asset, version, HASH, mime, usage === 'logo_reference' ? 'reference_media' : 'brand_asset', source, usage, options.state ?? 'reserved', options.state && options.state !== 'reserved' ? { status: 'verified' } : null, job, job ? randomUUID() : null]);
    if (kind === 'upload' && options.registry !== false) await db.query('insert into public.logo_input_requests(owner_id,project_id,request_key,request) values($1,$2,$3,$4)',
      [owner, project, key, { kind: options.registryKind ?? (usage === 'font' ? 'font_upload' : 'reference_upload'), input: { requestKey: key }, file: { contentHash: HASH, mimeType: mime, byteLength: 12, ...options.fileChanges } }]);
    return { id, path: `${owner}/${project}/${asset}/${version}`, owner, key, project };
  }
  async function home(verified = false, linked = false, owner = OWNER_A): Promise<ObjectRef> {
    const id = randomUUID(), key = randomUUID(), version = randomUUID(), project = linked ? (await seedProject(db, owner)).id : null;
    await db.query(`insert into public.home_attachments(id,owner_id,request_key,input,blob_version_id,name,mime_type,content_hash,byte_length,verified,project_id,project_revision)
      values($1,$2,$3,'{}',$4,'fixture.txt','text/plain',$5,12,$6,$7,$8)`, [id, owner, key, version, HASH, verified, project, linked ? 1 : null]);
    return { id, key, owner, project: project ?? '', path: `${owner}/home/${id}/${version}` };
  }
  async function vectorSource(r: ObjectRef, source: string, inputs: unknown = inputRevisions, owner = r.owner, project = r.project) {
    await db.query('insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)', [source, owner, project, { id: source, ownerId: owner, projectId: project, reviewStatus: 'review_required', inputRevisions: inputs }]);
  }

  it('allows a reserved reference upload and authenticated read-back before any manifest exists', async () => {
    const r = await logo();
    expect((await db.query('select count(*)::int n from public.asset_versions')).rows).toEqual([{ n: 0 }]);
    await insert(r); expect(await read(r)).toEqual([{ name: r.path }]);
  });
  it.each([[false, false], [true, false], [true, true]])('allows Home first upload and replay with verified=%s linked=%s', async (verified, linked) => {
    const r = await home(verified, linked); await insert(r); expect(await read(r)).toEqual([{ name: r.path }]);
    await expect(insert(r)).rejects.toMatchObject({ code: '23505' });
    expect((await db.query('select count(*)::int n from public.asset_versions')).rows).toEqual([{ n: 0 }]);
  });
  it.each(['font_upload', 'font_catalog'])('permits a live matching %s registry', async registryKind => {
    const r = await logo({ usage: 'font', registryKind }); await insert(r); expect(await read(r)).toEqual([{ name: r.path }]);
  });
  it('keeps the helper private while stored policy execution works', async () => {
    const r = await logo();
    expect((await db.query("select has_schema_privilege('authenticated','fluid_private','USAGE') v")).rows).toEqual([{ v: false }]);
    await expect(asRole(db, 'authenticated', OWNER_A, () => db.query('select fluid_private.owner_staging_object_allowed($1,$2)', [bucket, r.path]))).rejects.toMatchObject({ code: '42501' });
    await insert(r); expect(await read(r)).toHaveLength(1);
    const attributes = (await db.query("select provolatile,prosecdef,proconfig from pg_proc where oid='fluid_private.owner_staging_object_allowed(text,text)'::regprocedure")).rows;
    expect(attributes).toEqual([{ provolatile: 's', prosecdef: true, proconfig: ['search_path=""'] }]);
  });
  it('accepts the provider single storage prefix for both supported operations', async () => {
    for (const r of [await logo(), await home()]) { await insert(r, 'storage.object.upload'); expect(await read(r, 'storage.object.get_authenticated')).toHaveLength(1); }
  });
  it('denies absent, empty, partial, list, signed, overwrite and unrelated operation contexts', async () => {
    const operations = ['', 'object', 'object.get', 'object.get_authenticated.extra', 'object.upload.extra', 'object.list', 'object.list_v2', 'object.sign', 'object.sign_upload',
      'object.upload_signed', 'object.copy', 'object.move', 'object.update', 'object.delete', 'object.info', 'object.get_public', 'image.render_authenticated',
      'object.transform', 's3.get_object', 's3.put_object', 'tus.upload', 'object.upload.tus', 'storage.storage.object.upload', ' storage.object.upload', 'OBJECT.UPLOAD'];
    for (const r of [await logo(), await home()]) {
      await store(r);
      for (const op of operations) {
        expect(await read(r, op), `GET ${op}`).toEqual([]);
        await expect(insert(r, op), `INSERT ${op}`).rejects.toMatchObject({ code: '42501' });
      }
      expect(await read(r, 'object.upload')).toEqual([]);
      await expect(insert(r, 'object.get_authenticated')).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('provider fixture reads the real GUC and normalizes one exact prefix only', async () => {
    for (const [current, expected, allowed] of [
      ['', '', false], ['', 'object.upload', false], ['storage.object.upload', 'object.upload', true], ['object.upload', 'storage.object.upload', true],
      ['storage.object.upload', 'storage.object.upload', true], ['storage.storage.object.upload', 'object.upload', false], ['object.upload', 'object', false],
    ] as const) {
      await db.query("select set_config('storage.operation',$1,false)", [current]);
      expect((await db.query('select storage.operation() operation, storage.allow_only_operation($1) allowed', [expected])).rows).toEqual([{ operation: current, allowed }]);
    }
    expect((await db.query('select storage.allow_only_operation(null) allowed')).rows).toEqual([{ allowed: false }]);
  });
  it('rejects foreign and null owners and wrong or missing storage owner_id', async () => {
    for (const r of [await logo(), await home()]) {
      for (const owner of [OWNER_B, null]) await expect(insert(r, 'object.upload', owner)).rejects.toMatchObject({ code: '42501' });
      for (const storedOwner of [OWNER_B, null, OWNER_A.toUpperCase()]) await expect(insert(r, 'object.upload', OWNER_A, storedOwner)).rejects.toMatchObject({ code: '42501' });
      await store(r); expect(await read(r, 'object.get_authenticated', OWNER_B)).toEqual([]); expect(await read(r, 'object.get_authenticated', null)).toEqual([]);
      await db.query('update storage.objects set owner_id=$1 where name=$2', [OWNER_B, r.path]); expect(await read(r)).toEqual([]);
      await db.query('update storage.objects set owner_id=null where name=$1', [r.path]); expect(await read(r)).toEqual([]);
    }
  });
  it('requires the exact bucket and full immutable path with no suffix, traversal or normalization', async () => {
    await db.exec("insert into storage.buckets values('other','other',false,52428800)");
    for (const r of [await logo(), await home()]) {
      for (const name of [r.path + '/extra', '/' + r.path, r.path + '/', r.path.replace('/', '//'), r.path.replace('/', '/./'), r.path.replace('/', '%2F'), r.path.toUpperCase(), r.path.replace(OWNER_A, OWNER_B), r.path.slice(0, -1), `${OWNER_A}/home/${randomUUID()}/${randomUUID()}`]) {
        await expect(insert(r, 'object.upload', OWNER_A, OWNER_A, name)).rejects.toMatchObject({ code: '42501' });
      }
      await expect(insert(r, 'object.upload', OWNER_A, OWNER_A, r.path, 'other')).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('requires the live registry, matching kind, usage and immutable file identity', async () => {
    for (const options of [{ registry: false }, { registryKind: 'font_upload' }, { usage: 'font', registryKind: 'reference_upload' },
      { fileChanges: { contentHash: 'b'.repeat(64) } }, { fileChanges: { mimeType: 'image/jpeg' } }, { fileChanges: { byteLength: 11 } },
      { fileChanges: { byteLength: '12' } }, { requestChanges: { intent: { usage: 'font' } } }]) {
      const r = await logo(options); await store(r); expect(await read(r)).toEqual([]); await expect(insert(r)).rejects.toMatchObject({ code: '42501' });
    }
  });
  it.each(['cancelled_by_user', 'inputs_changed'])('fences %s uploads on the next statement without deleting bytes', async reason => {
    const r = await logo(); await insert(r); expect(await read(r)).toHaveLength(1);
    await db.query('insert into public.logo_input_rejections(owner_id,project_id,request_key,reason) values($1,$2,$3,$4)', [r.owner, r.project, r.key, reason]);
    expect(await read(r)).toEqual([]); await expect(insert(r)).rejects.toMatchObject({ code: '42501' });
    expect((await db.query('select name from storage.objects')).rows).toEqual([{ name: r.path }]);
  });
  it('permits owned retained vector sources with frozen inputRevisions without requiring current heads', async () => {
    const source = randomUUID(), r = await logo({ kind: 'stage', usage: 'vector', source }); await vectorSource(r, source);
    expect((await db.query('select count(*)::int n from public.logo_stage_heads')).rows).toEqual([{ n: 0 }]);
    await insert(r); expect(await read(r)).toHaveLength(1);
    await db.query("update public.logo_asset_publications set state='staged',verification=$1 where id=$2", [{ status: 'verified' }, r.id]);
    expect(await read(r)).toHaveLength(1); await expect(insert(r)).rejects.toMatchObject({ code: '23505' });
  });
  it('requires the exact owned vector source and its immutable inputRevisions', async () => {
    for (const bad of ['missing', 'inputs', 'foreign', 'wrong-source', 'wrong-kind']) {
      const source = randomUUID(), r = await logo({ kind: 'stage', usage: 'vector', source });
      if (bad === 'inputs') await vectorSource(r, source, []);
      if (bad === 'foreign') await vectorSource(r, source, inputRevisions, OWNER_B, (await seedProject(db, OWNER_B)).id);
      if (bad === 'wrong-source' || bad === 'wrong-kind') {
        await vectorSource(r, source);
        await db.query(`update public.logo_asset_publications set request=jsonb_set(request,$1::text[],to_jsonb($2::text)) where id=$3`, [bad === 'wrong-source' ? ['publication', 'source', 'sourceId'] : ['publication', 'source', 'kind'], bad === 'wrong-source' ? randomUUID() : 'variant', r.id]);
      }
      await store(r); expect(await read(r), bad).toEqual([]); await expect(insert(r)).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('permits retained owned variant approvals and denies missing approvals', async () => {
    const source = randomUUID(), r = await logo({ kind: 'stage', usage: 'variant', source }), vector = randomUUID(), stage = randomUUID();
    await store(r); expect(await read(r)).toEqual([]);
    await vectorSource(r, vector);
    await db.query('insert into public.logo_approvals(id,owner_id,project_id,vector_revision_id,stage_revision_id,record) values($1,$2,$3,$4,$5,$6)', [source, r.owner, r.project, vector, stage, { id: source, ownerId: r.owner, projectId: r.project, vectorRevisionId: vector, stageRevisionId: stage }]);
    expect(await read(r)).toHaveLength(1); await expect(insert(r)).rejects.toMatchObject({ code: '23505' });
  });
  it('matches TypeScript vector member golden keys and fences both derived members, not the raw command key', async () => {
    const vectors = [
      ['00000000-0000-4000-8000-000000000001', 'document', 'ed28e767-371d-5caf-a8d4-be0a610aba7a'],
      ['00000000-0000-4000-8000-000000000001', 'svg', 'fd294cda-ce12-5824-a002-45f4cae619a2'],
      ['f1234567-89ab-4cde-8f01-234567890abc', 'document', 'bad14f9d-d3bb-5b57-a40a-b17cc8d9e6f7'],
      ['f1234567-89ab-4cde-8f01-234567890abc', 'svg', '1519b501-49ab-50e8-afd1-68d621b719ac'],
    ] as const;
    for (const [command, member, golden] of vectors) {
      const key = vectorMemberRequestKey(command, member), source = randomUUID();
      const r = await logo({ key, kind: 'stage', usage: 'vector', source, mimeType: member === 'svg' ? 'image/svg+xml' : 'application/json' }); await vectorSource(r, source); await insert(r);
      const sql = (await db.query<{ key: string }>(`with digest as (select encode(sha256(convert_to('fluid.logo-vector.publication.v1:'||$1||':'||$2,'UTF8')),'hex') h)
        select (substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid::text key from digest`, [command, member])).rows[0]!.key;
      expect(key).toBe(golden); expect(sql).toBe(golden); expect(key).not.toBe(command);
      await db.query('insert into public.logo_vector_edit_cancellations(owner_id,project_id,request_key,command) values($1,$2,$3,$4)', [r.owner, r.project, command, { method: 'saveLogoEdit', body: { requestKey: command, baseVectorRevisionId: source } }]);
      expect(await read(r), `${command} ${member}`).toEqual([]); await expect(insert(r)).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('does not mistake a publication key, another command or another project cancellation for the matching command', async () => {
    const command = randomUUID(), source = randomUUID(), r = await logo({ key: vectorMemberRequestKey(command, 'document'), kind: 'stage', usage: 'vector', source });
    await vectorSource(r, source); await insert(r);
    for (const [key, project] of [[r.key, r.project], [randomUUID(), r.project], [command, (await seedProject(db)).id]])
      await db.query('insert into public.logo_vector_edit_cancellations(owner_id,project_id,request_key,command) values($1,$2,$3,$4)', [r.owner, project, key, { method: 'saveLogoEdit', body: { requestKey: key, baseVectorRevisionId: source } }]);
    expect(await read(r)).toHaveLength(1);
  });
  it('denies worker-job reservations and every other publication source kind', async () => {
    for (const options of [{ job: true }, { kind: 'stage', usage: 'concept' }, { kind: 'stage', usage: 'direction' }, { kind: 'stage', usage: 'export' }]) {
      const r = await logo(options); await store(r); expect(await read(r)).toEqual([]); await expect(insert(r)).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('does not expose raw logo reservation/registry data or permit any metadata writes', async () => {
    const r = await logo(), h = await home();
    for (const table of ['logo_asset_publications', 'logo_input_requests', 'logo_input_rejections', 'logo_vector_edit_cancellations']) {
      if (table === 'logo_asset_publications') expect((await asRole(db, 'authenticated', OWNER_A, () => db.query(`select * from public.${table}`))).rows).toEqual([]);
      else await expect(asRole(db, 'authenticated', OWNER_A, () => db.query(`select * from public.${table}`))).rejects.toMatchObject({ code: '42501' });
      await expect(asRole(db, 'authenticated', OWNER_A, () => db.query(`delete from public.${table}`))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(asRole(db, 'authenticated', OWNER_A, () => db.query('update public.logo_asset_publications set content_hash=$1 where id=$2', [HASH, r.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(asRole(db, 'authenticated', OWNER_A, () => db.query('update public.home_attachments set verified=true where id=$1', [h.id]))).rejects.toMatchObject({ code: '42501' });
    expect((await asRole(db, 'authenticated', OWNER_B, () => db.query('select * from public.home_attachments'))).rows).toEqual([]);
  });
  it('keeps duplicate objects immutable without granting UPDATE or DELETE', async () => {
    for (const r of [await logo(), await home(true, true)]) {
      await insert(r); await expect(insert(r)).rejects.toMatchObject({ code: '23505' });
      for (const op of ['object.upload', 'object.get_authenticated', 'object.update', 'object.delete']) {
        expect((await operation(op, r.owner, () => db.query("update storage.objects set name=name||'/changed' where name=$1 returning name", [r.path]))).rows).toEqual([]);
        expect((await operation(op, r.owner, () => db.query('delete from storage.objects where name=$1 returning name', [r.path]))).rows).toEqual([]);
      }
      expect(await read(r)).toEqual([{ name: r.path }]);
    }
  });
  it('preserves both committed manifest policies and their previous operation-independent access', async () => {
    const r = await logo({ state: 'committed' }); await store(r); expect(await read(r)).toEqual([]);
    const publication = (await db.query<{ asset_id: string; version_id: string }>('select asset_id,version_id from public.logo_asset_publications where id=$1', [r.id])).rows[0]!;
    await db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'logo_reference','reference_media')", [publication.asset_id, r.owner, r.project]);
    await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,storage_path,provenance) values($1,$2,$3,$4,1,1,$5,$5,'image/png',$6,'{}')", [publication.version_id, r.owner, r.project, publication.asset_id, HASH, r.path]);
    for (const op of ['', 'object.sign', 'object.list', 'object.get_authenticated']) expect(await read(r, op)).toHaveLength(1);
    await db.query("insert into public.logo_input_rejections(owner_id,project_id,request_key,reason) values($1,$2,$3,'inputs_changed')", [r.owner, r.project, r.key]);
    expect(await read(r, 'object.sign')).toHaveLength(1); // Additive policies cannot revoke the existing committed access.
    await expect(insert(r, '')).rejects.toMatchObject({ code: '23505' });
    const source = await readFile(migration, 'utf8');
    expect(source).not.toMatch(/(?:drop|alter)\s+policy\s+fluid_asset_(?:read|insert)/i);
    expect(source).not.toMatch(/create\s+(?:or\s+replace\s+)?function\s+storage\./i);
    expect((await db.query("select policyname,cmd,roles::text from pg_policies where schemaname='storage' order by policyname")).rows).toEqual([
      { policyname: 'fluid_asset_insert', cmd: 'INSERT', roles: '{authenticated}' }, { policyname: 'fluid_asset_read', cmd: 'SELECT', roles: '{authenticated}' },
      { policyname: 'fluid_owner_staging_insert', cmd: 'INSERT', roles: '{authenticated}' }, { policyname: 'fluid_owner_staging_read', cmd: 'SELECT', roles: '{authenticated}' },
    ]);
  });

});

it('fails closed with absent operation context and scrubs only the exact helper ACL inventory', async () => {
  const db = await createTestDatabase();
  try {
    await resetFixture(db);
    expect((await db.query('select storage.operation() operation,storage.allow_only_operation(\'object.upload\') allowed')).rows).toEqual([{ operation: null, allowed: false }]);
    const id = randomUUID(), version = randomUUID(), path = `${OWNER_A}/home/${id}/${version}`;
    await db.query("insert into public.home_attachments(id,owner_id,request_key,input,blob_version_id,name,mime_type,content_hash,byte_length) values($1,$2,$3,'{}',$4,'a.txt','text/plain',$5,1)", [id, OWNER_A, randomUUID(), version, HASH]);
    await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', [bucket, path, OWNER_A]);
    expect((await asRole(db, 'authenticated', OWNER_A, () => db.query('select * from storage.objects'))).rows).toEqual([]);
    await expect(asRole(db, 'authenticated', OWNER_A, () => db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', [bucket, path, OWNER_A]))).rejects.toMatchObject({ code: '42501' });

    await db.exec(`drop policy fluid_owner_staging_read on storage.objects; drop policy fluid_owner_staging_insert on storage.objects;
      drop function fluid_private.owner_staging_object_allowed(text,text);
      create role fixture_owner_staging_hostile nologin;
      alter default privileges in schema fluid_private grant all on functions to fixture_owner_staging_hostile,anon,authenticated,service_role with grant option;
      create function fluid_private.owner_staging_object_allowed(text) returns text language sql as $$select $1$$;`);
    const policies = (await db.query("select policyname,permissive,roles::text,cmd,qual,with_check from pg_policies where schemaname='storage' order by policyname")).rows;
    const buckets = (await db.query('select * from storage.buckets order by id')).rows;
    const defaults = (await db.query('select defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows;
    const roles = (await db.query('select oid,rolname,rolcanlogin from pg_roles order by oid')).rows;
    const helpers = (await db.query("select pg_get_functiondef('storage.operation()'::regprocedure) a,pg_get_functiondef('storage.allow_only_operation(text)'::regprocedure) b")).rows;
    await db.exec(await readFile(migration, 'utf8'));
    expect((await db.query("select policyname,permissive,roles::text,cmd,qual,with_check from pg_policies where schemaname='storage' and policyname in('fluid_asset_read','fluid_asset_insert') order by policyname")).rows).toEqual(policies);
    expect((await db.query('select * from storage.buckets order by id')).rows).toEqual(buckets);
    expect((await db.query('select defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows).toEqual(defaults);
    expect((await db.query('select oid,rolname,rolcanlogin from pg_roles order by oid')).rows).toEqual(roles);
    expect((await db.query("select pg_get_functiondef('storage.operation()'::regprocedure) a,pg_get_functiondef('storage.allow_only_operation(text)'::regprocedure) b")).rows).toEqual(helpers);
    for (const role of ['fixture_owner_staging_hostile', 'anon', 'service_role']) expect((await db.query('select has_function_privilege($1,\'fluid_private.owner_staging_object_allowed(text,text)\',\'EXECUTE\') v', [role])).rows).toEqual([{ v: false }]);
    expect((await db.query("select has_function_privilege('authenticated','fluid_private.owner_staging_object_allowed(text,text)','EXECUTE') v,has_function_privilege('authenticated','fluid_private.owner_staging_object_allowed(text,text)','EXECUTE WITH GRANT OPTION') g")).rows).toEqual([{ v: true, g: false }]);
    expect((await db.query("select has_schema_privilege('authenticated','fluid_private','USAGE') v")).rows).toEqual([{ v: false }]);
    expect((await db.query("select has_function_privilege('fixture_owner_staging_hostile','fluid_private.owner_staging_object_allowed(text)','EXECUTE WITH GRANT OPTION') v")).rows).toEqual([{ v: true }]);
    expect((await db.query("select a.grantee from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid='fluid_private.owner_staging_object_allowed(text,text)'::regprocedure and a.grantee=0")).rows).toEqual([]);
    await db.query("select set_config('storage.operation','object.get_authenticated',false)");
    expect((await asRole(db, 'authenticated', OWNER_A, () => db.query('select name from storage.objects'))).rows).toEqual([{ name: path }]);
  } finally { await db.close(); }
}, 60_000);
