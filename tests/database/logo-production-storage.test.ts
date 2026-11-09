import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { asRole, createTestDatabase, resetFixture, OWNER_A, OWNER_B, type TestDatabase } from './local-supabase';
import { installProductionStorageFixture, productionStorageFixture, vectorCapability, exportCapability, authUser, sessionId, workerRole, workerId } from './logo-production-storage-fixture';
import type { IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import { logoWorkspaceV2Schema } from '../../src/domain/logo-workspace';
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema } from '../../src/domain/logo-jobs';
import { parseClaimedJob } from '../../worker/postgres-store';

import { createLogoProductionStorageAuthorization } from '../../worker/logo-production-storage-authorization';
import { createLogoProductionAssetStore } from '../../worker/logo-production-asset-store';
import { createLogoVectorRuntimeAdapter } from '../../worker/logo-vector/runtime-adapter';
import { createLogoVectorHandler } from '../../worker/logo-vector/handler';
import { policyIdentity } from './logo-production-storage-fixture';

import { buildLogoExport } from '../../src/features/identity-deliverables/server/package';
import { publishPreparedLogoExport } from '../../src/features/identity-deliverables/server/publish';
import { createExportPublicationDependencies } from '../../src/features/identity-deliverables/server/persistence';
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";

describe('local production Storage SQL frozen-source and output-reservation authorization', () => {
  let db: TestDatabase, f: Awaited<ReturnType<typeof productionStorageFixture>>;
  beforeAll(async () => { db = await createTestDatabase(); await installProductionStorageFixture(db); }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); f = await productionStorageFixture(db); });
  it('fails closed without a separately enabled exact operation and emits no grant for readiness probes', async () => {
    const { job, original } = await f.prepareVector();
    await expect(f.authorize(job, original, 'read')).rejects.toMatchObject({ code: '42501' }); expect(await f.read(original)).toEqual([]);
    await f.enable(exportCapability); await expect(f.authorize(job, original, 'read')).rejects.toMatchObject({ code: '42501' });
    await f.enable(vectorCapability); expect(await f.authorize(job, null, 'probe')).toMatchObject({ capability: vectorCapability, reservation: null, jobInput: job.input });
    expect((await db.query('select * from fluid_private.logo_production_storage_grants')).rows).toHaveLength(0);
    const grant = await f.authorize(job, original, 'read'); expect(grant).toMatchObject({ ownerId: OWNER_A, authUserId: authUser, sessionId, jobId: job.id, leaseToken: job.leaseToken, reservation: original });
    expect(await f.authorize(job, original, 'read')).toEqual(grant); expect(await f.read(original)).toHaveLength(1); await expect(f.insert(original)).rejects.toMatchObject({ code: '42501' });
  });
  it('allows only frozen original and deterministic vector document/SVG output reservations', async () => {
    const { job, original } = await f.prepareVector(); await f.enable(vectorCapability); await f.authorize(job, original, 'read');
    for (const mime of ['application/json', 'image/svg+xml']) {
      const r = await f.reserve(job, mime); await expect(f.insert(r)).rejects.toMatchObject({ code: '42501' }); await f.authorize(job, r, 'write'); await f.insert(r); expect(await f.read(r)).toHaveLength(1);
      await expect(f.insert(r)).rejects.toMatchObject({ code: '23505' }); await expect(f.authorize(job, r, 'read')).rejects.toMatchObject({ code: '42501' });
    }
    for (const mime of ['image/png', 'application/pdf', 'application/zip', 'font/ttf', 'image/svg+xml']) { const r = await f.reserve(job, mime, undefined, randomUUID()); await expect(f.authorize(job, r, 'write')).rejects.toMatchObject({ code: '42501' }); }
    const fake = { ...original, id: randomUUID(), storagePath: original.storagePath.replace(original.reference.assetId, randomUUID()) };
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [fake.storagePath, authUser]);
    await expect(f.authorize(job, fake, 'read')).rejects.toMatchObject({ code: '42501' }); expect(await f.read(fake)).toEqual([]); await expect(f.authorize(job, original, 'write')).rejects.toMatchObject({ code: '42501' });
  });
  it('matches frozen export variant sources and exact expected filename/hash request identities', async () => {
    const { job, sources, expected } = await f.prepareExport(); await f.enable(exportCapability); expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) { await f.authorize(job, source, 'read'); expect(await f.read(source)).toHaveLength(1); await expect(f.authorize(job, source, 'write')).rejects.toMatchObject({ code: '42501' }); }
    for (const item of expected) { const r = await f.reserve(job, item.mimeType, item.name); await f.authorize(job, r, 'write'); await f.insert(r); expect(await f.read(r)).toHaveLength(1); }
    for (const item of [{ name: 'unrequested.png', mimeType: 'image/png' }, { ...expected[0]!, mimeType: 'application/zip' }, { name: 'secret.ttf', mimeType: 'font/ttf' }])
      await expect((async () => { const r = await f.reserve(job, item.mimeType, item.name); await f.authorize(job, r, 'write'); })()).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|PT409)$/) });
    const randomKey = await f.reserve(job, 'application/pdf', 'brand-guidelines.pdf', randomUUID()); await expect(f.authorize(job, randomKey, 'write')).rejects.toMatchObject({ code: '42501' });
  });
  it('denies anonymous/foreign identity, other worker, expired session and wrong lease without partial grants', async () => {
    const { job, original } = await f.prepareVector(); await f.enable(vectorCapability);
    for (const claims of [{ is_anonymous: true }, { role: 'service_role' }, { exp: 0 }, { session_id: randomUUID() }, { sub: OWNER_A }]) await expect(f.authorize(job, original, 'read', claims)).rejects.toMatchObject({ code: '42501' });
    for (const user of [OWNER_A, OWNER_B]) await expect(f.authorize(job, original, 'read', { user_metadata: { ownerId: OWNER_A } }, user)).rejects.toMatchObject({ code: '42501' });
    await expect(asRole(db, 'anon', null, () => db.query("select public.authorize_logo_production_storage($1,$2,$3,'read')", [job.id, job.leaseToken, original.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(f.authorize({ ...job, leaseToken: randomUUID() }, original, 'read')).rejects.toMatchObject({ code: '42501' });
    await db.query("update public.jobs set worker_id='other-worker' where id=$1", [job.id]); await expect(f.authorize(job, original, 'read')).rejects.toMatchObject({ code: '42501' });
    expect((await db.query('select * from fluid_private.logo_production_storage_grants')).rows).toHaveLength(0);
  });
  it.each(['lease', 'expiry', 'policy', 'capability', 'role', 'session', 'cancel'] as const)('rechecks %s during actual Storage statements after grants', async kind => {
    const { job, original } = await f.prepareVector(); await f.enable(vectorCapability); const output = await f.reserve(job, 'image/svg+xml');
    await f.authorize(job, original, 'read'); await f.authorize(job, output, 'write'); await f.insert(output);
    if (kind === 'lease') await db.query('update public.jobs set lease_token=$1 where id=$2', [randomUUID(), job.id]);
    if (kind === 'expiry') await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    if (kind === 'policy') await db.query("update fluid_private.logo_runtime_policies set policy_identity=$1 where operation='identity.logo_vectorize'", ['f'.repeat(64)]);
    if (kind === 'capability') await db.exec('update fluid_private.logo_production_storage_capabilities set enabled=false');
    if (kind === 'role') await db.exec('update fluid_private.logo_storage_principals set role_oid=0');
    if (kind === 'session') await db.exec('delete from auth.sessions');
    if (kind === 'cancel') await db.query("update public.jobs set state='cancel_requested',cancel_requested_at=clock_timestamp() where id=$1", [job.id]);
    expect(await f.read(original)).toEqual([]); expect(await f.read(output)).toEqual([]); await expect(f.insert(output)).rejects.toMatchObject({ code: '42501' });
  });
  it('denies unrelated same-owner source, foreign path and a different Auth session', async () => {
    const a = await f.prepareVector(), b = await f.prepareVector(); await f.enable(vectorCapability); await f.authorize(a.job, a.original, 'read');
    await expect(f.authorize(a.job, b.original, 'read')).rejects.toMatchObject({ code: '42501' }); expect(await f.read(b.original)).toEqual([]);
    const foreign = { ...a.original, storagePath: a.original.storagePath.replace(OWNER_A, OWNER_B) };
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [foreign.storagePath, authUser]); expect(await f.read(foreign)).toEqual([]);
    const otherSession = randomUUID(); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [otherSession, authUser]); expect(await f.read(a.original, 'object.get_authenticated', { session_id: otherSession })).toEqual([]);
  });
  it('denies list/sign/info/update/delete despite an overbroad permissive policy', async () => {
    const { job, original } = await f.prepareVector(); await f.enable(vectorCapability); await f.authorize(job, original, 'read');
    await db.exec('create policy fixture_production_overbroad on storage.objects for all to authenticated using(true) with check(true)');
    try {
      for (const operation of ['', 'object.list', 'object.list_v2', 'object.sign', 'object.get_authenticated_info', 'object.update', 'object.delete']) expect(await f.read(original, operation)).toEqual([]);
      for (const operation of ['object.upload', 'object.get_authenticated']) { expect(await f.object(operation, async () => (await db.query('update storage.objects set name=name returning name')).rows)).toEqual([]); expect(await f.object(operation, async () => (await db.query('delete from storage.objects returning name')).rows)).toEqual([]); }
      expect(await f.read(original, 'object.list', {}, OWNER_A)).toHaveLength(1);
    } finally { await db.exec('drop policy fixture_production_overbroad on storage.objects'); }
  });
  it('preserves the original live concept reservation route with no production capability enabled', async () => {
    const w = logoWorkspaceV2Schema.parse(await startLogoFixture(ownerQuery(db), { requestKey: randomUUID(), brief: { name: 'Concept compatibility', activity: 'Test', audience: 'Test', personality: 'Precise', logoTypes: ['wordmark'] } }));
    const referenceSnapshotId = (await db.query<{id:string}>('select reference_snapshot_id id from public.logo_stage_revisions where id=$1', [w.stages.brief_references!.id])).rows[0]!.id;
    const quote = logoCostQuoteSchema.parse(await f.rpc('quote_logo_operation', [w.projectId, { operation: 'concepts', expected: w.heads, briefRevisionId: w.stages.brief_references!.id, referenceSnapshotId }]));
    await f.rpc('admit_logo_operation', [w.projectId, { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: w.heads }]);
    const job = parseClaimedJob((await f.connection.query('select * from public.claim_logo_job($1,60)', [workerId])).rows[0]);
    const inputRevisions = (await f.connection.query<{value: unknown}>("select public.read_leased_logo_record($1,$2,'input_revisions',null) value", [job.id, job.leaseToken])).rows[0]!.value;
    const publication = { requestKey: randomUUID(), inputRevisions, mimeType: 'image/png', contentHash: 'd'.repeat(64), byteLength: 3, source: { kind: 'concept', sourceId: (job.input as {attemptId:string}).attemptId } };
    const r = (await f.connection.query<{value:IdentityAssetReservation}>('select fluid_private.prepare_logo_asset($1,$2,$3,$4) value', [job.projectId, JSON.stringify({kind:'stage',publication}), job.id, job.leaseToken])).rows[0]!.value;
    await f.auth(() => db.query('select public.authorize_logo_storage_reservation($1,$2,$3)', [job.id, job.leaseToken, r.id])); await f.insert(r); expect(await f.read(r)).toHaveLength(1);
    await expect(f.authorize(job, r, 'write')).rejects.toMatchObject({code:'42501'}); expect((await db.query('select * from fluid_private.logo_production_storage_grants')).rows).toEqual([]);
  });
  it.each([false, true])('uses actual authorization/broker/renderer with lost-POST-ack=%s and atomic grouped completion', async lostAck => {
    const { job, original, bytes } = await f.prepareVector(); await f.enable(vectorCapability);
    const oid = (await db.query<{oid:number}>('select oid::int oid from pg_roles where rolname=$1', [workerRole])).rows[0]!.oid;
    const claims = { sub: authUser, session_id: sessionId, role: 'authenticated', aud: 'authenticated', iss: 'https://fricsfwqibyhemknqgyf.supabase.co/auth/v1', exp: Math.floor(Date.now()/1000)+3600, is_anonymous: false };
    const token = `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic_signature`;
    let posts = 0;
    // Synthetic Auth/HTTP only. Every authorization RPC and Storage object
    // statement is actually evaluated under the restricted fixture SQL roles.
    const transport: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: authUser, is_anonymous: false });
      if (url.endsWith('/rpc/authorize_logo_production_storage')) {
        const b = JSON.parse(String(init.body));
        const value = await f.auth(async () => (await db.query<{v:unknown}>('select public.authorize_logo_production_storage($1,$2,$3,$4) v', [b.p_job,b.p_lease,b.p_reservation,b.p_mode])).rows[0]!.v);
        return Response.json(value);
      }
      const path = url.split('/storage/v1/object/fluid-assets/')[1]; if (!path) throw Error('Unexpected fixture HTTP target');
      if (init.method === 'POST') {
        posts++;
        try { await f.object('object.upload', () => db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, authUser])); }
        catch (error) { if ((error as {code?:string}).code === '23505') return Response.json({code:'ResourceAlreadyExists'}, {status:409}); throw error; }
        f.blobs.set(path, { bytes: new Uint8Array(init.body as Uint8Array), mimeType: new Headers(init.headers).get('content-type')! });
        if (lostAck) throw Error('Synthetic upload acknowledgement lost');
        return Response.json({Id:randomUUID(),Key:`fluid-assets/${path}`});
      }
      const visible = await f.object('object.get_authenticated', () => db.query('select name from storage.objects where name=$1', [path]));
      if (!visible.rows.length) return new Response(null,{status:404});
      const file = f.blobs.get(path); if (!file) return new Response(null,{status:404});
      return new Response(new Uint8Array(file.bytes), {headers:{'content-type':file.mimeType}});
    };
    const authorization = createLogoProductionStorageAuthorization({ownerId:OWNER_A,authUserId:authUser,workerRoleName:workerRole,workerRoleOid:oid,workerId,publishableKey:'sb_publishable_synthetic',accessToken:token,capability:vectorCapability},{fetch:transport})!;
    const assets = createLogoProductionAssetStore({connection:f.connection,authorization})!;
    const adapter = createLogoVectorRuntimeAdapter({ownerId:OWNER_A,policyIdentity,connection:f.connection,assets,assertAvailable:authorization.assertAvailable})!;
    await f.connection.query("select public.begin_logo_job_step($1,$2,'convert-vector',$3,0)", [job.id,job.leaseToken,`${job.id}:convert-vector`]);
    const outcome = await createLogoVectorHandler(adapter.dependencies).steps(job)[0]!.execute({job,signal:new AbortController().signal});
    expect((await db.query('select * from public.logo_vector_revisions')).rows).toHaveLength(0);
    expect(f.blobs.get(original.storagePath)!.bytes).toEqual(bytes);
    if (lostAck) {
      expect(outcome).toMatchObject({status:'needs_reconciliation',code:'logo_publication_unknown'}); expect(posts).toBe(1); expect(f.blobs.size).toBe(2);
      expect((await db.query('select * from fluid_private.logo_vector_publications')).rows).toHaveLength(0);
    } else {
      expect(outcome.status).toBe('succeeded'); if (outcome.status !== 'succeeded') throw Error('Fixture conversion failed'); expect(posts).toBe(2);
      expect((await db.query("select state from public.logo_asset_publications where job_id=$1", [job.id])).rows).toEqual([{state:'staged'},{state:'staged'}]);
      await f.connection.query("select public.complete_logo_job_step($1,$2,'convert-vector','succeeded',0,$3,null)", [job.id,job.leaseToken,outcome.result]);
      expect((await db.query('select record from public.logo_vector_revisions')).rows).toHaveLength(1);
      expect((await db.query("select state from public.logo_asset_publications where job_id=$1", [job.id])).rows).toEqual([{state:'committed'},{state:'committed'}]);
      expect(logoWorkspaceV2Schema.parse(await f.rpc('get_logo_workspace',[job.projectId])).approvedLogo).toBeNull();
    }
    authorization.close();
  }, 30_000);
  it('publishes every real SVG/PDF/PNG/ZIP through exact staged readback authority without admitting unrelated staged objects', async () => {
    const { job, snapshot, expected } = await f.prepareExport(); await f.enable(exportCapability);
    const lostAck = false;
    const oid = (await db.query<{oid:number}>('select oid::int oid from pg_roles where rolname=$1', [workerRole])).rows[0]!.oid;
    const claims = { sub: authUser, session_id: sessionId, role: 'authenticated', aud: 'authenticated', iss: 'https://fricsfwqibyhemknqgyf.supabase.co/auth/v1', exp: Math.floor(Date.now()/1000)+3600, is_anonymous: false };
    const token = `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic_signature`;
    let posts = 0;
    // Synthetic Auth/HTTP only. Every authorization RPC and Storage object
    // statement is actually evaluated under the restricted fixture SQL roles.
    const transport: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: authUser, is_anonymous: false });
      if (url.endsWith('/rpc/authorize_logo_production_storage')) {
        const b = JSON.parse(String(init.body));
        const value = await f.auth(async () => (await db.query<{v:unknown}>('select public.authorize_logo_production_storage($1,$2,$3,$4) v', [b.p_job,b.p_lease,b.p_reservation,b.p_mode])).rows[0]!.v);
        return Response.json(value);
      }
      const path = url.split('/storage/v1/object/fluid-assets/')[1]; if (!path) throw Error('Unexpected fixture HTTP target');
      if (init.method === 'POST') {
        posts++;
        try { await f.object('object.upload', () => db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, authUser])); }
        catch (error) { if ((error as {code?:string}).code === '23505') return Response.json({code:'ResourceAlreadyExists'}, {status:409}); throw error; }
        f.blobs.set(path, { bytes: new Uint8Array(init.body as Uint8Array), mimeType: new Headers(init.headers).get('content-type')! });
        if (lostAck) throw Error('Synthetic upload acknowledgement lost');
        return Response.json({Id:randomUUID(),Key:`fluid-assets/${path}`});
      }
      const visible = await f.object('object.get_authenticated', () => db.query('select name from storage.objects where name=$1', [path]));
      if (!visible.rows.length) return new Response(null,{status:404});
      const file = f.blobs.get(path); if (!file) return new Response(null,{status:404});
      return new Response(new Uint8Array(file.bytes), {headers:{'content-type':file.mimeType}});
    };
    const authorization = createLogoProductionStorageAuthorization({ownerId:OWNER_A,authUserId:authUser,workerRoleName:workerRole,workerRoleOid:oid,workerId,publishableKey:'sb_publishable_synthetic',accessToken:token,capability:exportCapability},{fetch:transport})!;
    const assets = createLogoProductionAssetStore({connection:f.connection,authorization})!;
    const signal = new AbortController().signal, prepared = await buildLogoExport(snapshot, signal);
    await f.connection.query("select public.begin_logo_job_step($1,$2,'prepare-export',$3,0)", [job.id,job.leaseToken,`${job.id}:prepare-export`]);
    const output = await publishPreparedLogoExport(job,snapshot,prepared,createExportPublicationDependencies(f.connection,assets),signal);
    expect(output.assetReceiptIds).toHaveLength(expected.length); expect(posts).toBe(expected.length);
    expect((await db.query('select * from public.logo_export_manifests')).rows).toHaveLength(0);
    expect((await db.query<{mime_type:string}>("select mime_type from public.logo_asset_publications where job_id=$1 and state='staged'",[job.id])).rows.map(r=>r.mime_type)).toEqual(expect.arrayContaining(['image/svg+xml','application/pdf','image/png','application/zip']));
    // Valid output member and observed metadata alone cannot create readback
    // permission; this exact session must already hold its write grant.
    for (const name of ['unrequested.pdf','brand-guidelines.pdf']) {
      const r = await f.reserve(job,'application/pdf',name);
      await f.connection.query('select fluid_private.observe_logo_asset($1,$2,$3,$4)',[r.id,JSON.stringify({status:'verified',checkedAt:'2026-10-08T00:00:00Z',contentHash:r.reference.contentHash,mimeType:r.mimeType,byteLength:r.byteLength}),job.id,job.leaseToken]);
      await expect(assets.readLeasedAsset(job,r.reference,signal)).rejects.toThrow();
      await expect(f.authorize(job,r,'read')).rejects.toMatchObject({code:'42501'});
    }
    await f.connection.query("select public.complete_logo_job_step($1,$2,'prepare-export','succeeded',0,$3,null)",[job.id,job.leaseToken,{version:2,kind:'logo_export',publicationId:output.id}]);
    expect((await db.query('select * from public.logo_export_manifests')).rows).toHaveLength(1);
    authorization.close();
  }, 60_000);
  it('reuses only an observed same-session write grant for readback and never upgrades source reads', async () => {
    const {job}=await f.prepareExport(); await f.enable(exportCapability); const r=await f.reserve(job,'application/pdf','brand-guidelines.pdf');
    await expect(f.authorize(job,r,'readback')).rejects.toMatchObject({code:'42501'});
    await f.authorize(job,r,'write'); await f.insert(r);
    await expect(f.authorize(job,r,'readback')).rejects.toMatchObject({code:'42501'});
    await f.connection.query('select fluid_private.observe_logo_asset($1,$2,$3,$4)',[r.id,JSON.stringify({status:'verified',checkedAt:'2026-10-08T00:00:00Z',contentHash:r.reference.contentHash,mimeType:r.mimeType,byteLength:r.byteLength}),job.id,job.leaseToken]);
    const before=(await db.query('select * from fluid_private.logo_production_storage_grants')).rows;
    expect(await f.authorize(job,r,'readback')).toMatchObject({mode:'readback',publication:{requestKey:r.requestKey,source:{kind:'export',sourceId:job.id},mimeType:'application/pdf'}});
    expect((await db.query('select * from fluid_private.logo_production_storage_grants')).rows).toEqual(before);
    await expect(f.authorize(job,r,'read')).rejects.toMatchObject({code:'42501'});
    const otherSession=randomUUID();await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[otherSession,authUser]);
    await expect(f.authorize(job,r,'readback',{session_id:otherSession})).rejects.toMatchObject({code:'42501'});
    await expect(f.authorize({...job,leaseToken:randomUUID()},r,'readback')).rejects.toMatchObject({code:'42501'});
    await db.exec('update fluid_private.logo_production_storage_capabilities set enabled=false');
    await expect(f.authorize(job,r,'readback')).rejects.toMatchObject({code:'42501'});expect(await f.read(r)).toEqual([]);
  });
  it('keeps new ACLs narrow and both DB workers unable to call the Auth RPC', async () => {
    for (const role of ['anon', 'service_role', 'fixture_production_acl_probe', workerRole, 'fixture_subscription_worker_a']) expect((await db.query<{ok:boolean}>("select has_function_privilege($1,'public.authorize_logo_production_storage(uuid,uuid,uuid,text)','execute') ok", [role])).rows[0]!.ok).toBe(false);
    for (const role of ['authenticated','anon','service_role','fixture_production_acl_probe',workerRole]) for (const table of ['logo_production_storage_grants','logo_production_storage_capabilities']) expect((await db.query<{ok:boolean}>(`select has_table_privilege($1,'fluid_private.${table}','select,insert,update,delete') ok`, [role])).rows[0]!.ok).toBe(false);
  });
});
