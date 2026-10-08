import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createTestDatabase, resetFixture, OWNER_A, OWNER_B, type TestDatabase } from './local-supabase';
import { installGenerativeStorageFixture, generativeStorageFixture, conceptCapability, refinementCapability, authUser, sessionId } from './logo-generative-storage-fixture';

describe('upload-only generative Storage SQL authority (synthetic local fixture)', () => {
  let db: TestDatabase, f: Awaited<ReturnType<typeof generativeStorageFixture>>, baseline: Awaited<ReturnType<typeof installGenerativeStorageFixture>>;
  beforeAll(async () => {
    db = await createTestDatabase();
    baseline = await installGenerativeStorageFixture(db, { candidate: process.env.LOGO_GENERATIVE_STORAGE_RED !== '1' });
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); f = await generativeStorageFixture(db); });
  it('exposes the new fail-closed RPC, separately from both old brokers', async () => {
    await expect(f.auth(() => db.query("select public.authorize_logo_generative_storage(null::uuid,null::uuid,null::uuid,'probe')"))).rejects.toMatchObject({ code: '42501' });
  });
  it('reads only actual committed uploaded references and preserves historical uploader ownership', async () => {
    const { job, reservations } = await f.prepareConcept(2), r = reservations[0]!;
    await expect(f.authorize(job, r, 'read')).rejects.toMatchObject({ code: '42501' });
    await f.enable();
    expect(await f.authorize(job, null, 'probe')).toMatchObject({ capability: conceptCapability, mode: 'probe', member: null, reservation: null, publication: null, jobInput: job.input });
    expect(await f.authorize(job, r, 'read')).toMatchObject({ authUserId: authUser, sessionId, jobId: job.id, member: 'reference', reservation: r, publication: null });
    expect(await f.read(r)).toHaveLength(1);
    expect(await f.read(reservations[1]!)).toEqual([]);
    await f.authorize(job, reservations[1]!, 'read'); expect(await f.read(reservations[1]!)).toHaveLength(1);
    const unrelated = await f.uploadReference(await f.workspace(job.projectId), 1);
    expect(unrelated.reservation.reference.contentHash).toBe(r.reference.contentHash);
    await expect(f.authorize(job, unrelated.reservation, 'read')).rejects.toMatchObject({ code: '42501' });
    expect(await f.read(unrelated.reservation)).toEqual([]);
  });
  it.each([false, true])('reads exact refinement base lineage and uploaded references (earlier-refinement=%s)', async priorRefinement => {
    const { job, base, reservations } = await f.prepareRefinement({ priorRefinement }); await f.enable(refinementCapability);
    expect(await f.authorize(job, base, 'read')).toMatchObject({ member: 'base', reservation: base });
    expect(await f.read(base)).toHaveLength(1);
    expect(await f.authorize(job, reservations[0]!, 'read')).toMatchObject({ member: 'reference' });
    const { reservation: output } = await f.reserve(job);
    await expect(f.authorize(job, output, 'read')).rejects.toMatchObject({ code: '42501' });
  });
  it('grants exact PNG output insertion and same-write readback without a staged-source mode', async () => {
    const { job } = await f.prepareConcept(), { reservation, publication } = await f.reserve(job); await f.enable();
    await expect(f.insert(reservation)).rejects.toMatchObject({ code: '42501' });
    expect(await f.authorize(job, reservation, 'write')).toMatchObject({ member: 'output', reservation, publication });
    await f.insert(reservation); expect(await f.read(reservation)).toHaveLength(1);
    await expect(f.insert(reservation)).rejects.toMatchObject({ code: '23505' });
    await expect(f.authorize(job, reservation, 'read')).rejects.toMatchObject({ code: '42501' });
    await expect(f.authorize(job, reservation, 'readback')).rejects.toMatchObject({ code: '42501' });
  });
  it('requires the current dedicated uploader on both insertion and write readback', async () => {
    const { job } = await f.prepareConcept(0), { reservation } = await f.reserve(job); await f.enable();
    await f.authorize(job, reservation, 'write');
    await expect(f.object('object.upload', () => db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [reservation.storagePath, OWNER_A]))).rejects.toMatchObject({ code: '42501' });
    await f.insert(reservation); expect(await f.read(reservation)).toHaveLength(1);
    await db.query('update storage.objects set owner_id=$1 where name=$2', [OWNER_A, reservation.storagePath]);
    expect(await f.read(reservation)).toEqual([]);
  });
  it('fences cancellation after an output write grant before insert and after bytes exist', async () => {
    const { job } = await f.prepareConcept(0), { reservation } = await f.reserve(job); await f.enable();
    await f.authorize(job, reservation, 'write'); await f.insert(reservation);
    await f.rpc('request_job_cancel', [job.id]);
    expect(await f.read(reservation)).toEqual([]);
    await expect(f.insert(reservation)).rejects.toMatchObject({ code: '42501' });
    await expect(f.authorize(job, reservation, 'write')).rejects.toMatchObject({ code: '42501' });
  });
  it.each(['mime', 'key', 'size'])('rejects output %s outside the exact admitted PNG contract', async changed => {
    const { job } = await f.prepareConcept(0); await f.enable();
    const { reservation } = await f.reserve(job, changed === 'mime' ? { mimeType: 'image/jpeg' } : changed === 'key' ? { requestKey: randomUUID() } : { byteLength: 8_388_609 });
    await expect(f.authorize(job, reservation, 'write')).rejects.toMatchObject({ code: '42501' });
  });
  it.each(['rights', 'request', 'receipt', 'provenance', 'path', 'mime', 'purpose', 'verification'])('rejects matching source IDs with absent or mismatched %s evidence', async kind => {
    const { job, reservations } = await f.prepareConcept(), r = reservations[0]!; await f.enable();
    await f.authorize(job, r, 'read');
    // Fixture superuser corruption tests the authorization boundary without
    // weakening any production immutability trigger or granting that privilege.
    await db.exec('set session_replication_role=replica');
    try {
      if (kind === 'rights') await db.query("update public.logo_input_rights set rights_declaration='Unrelated declaration' where publication_id=$1", [r.id]);
      if (kind === 'request') await db.query("update public.logo_input_requests set request=jsonb_set(request,'{file,contentHash}',to_jsonb(repeat('f',64))) where request_key=$1", [r.requestKey]);
      if (kind === 'receipt') await db.query('delete from public.logo_input_receipts where request_key=$1', [r.requestKey]);
      if (kind === 'path') await db.query("update public.asset_versions set storage_path=null where id=$1", [r.reference.versionId]);
      if (kind === 'mime') await db.query("update public.asset_versions set mime_type='image/jpeg' where id=$1", [r.reference.versionId]);
      if (kind === 'purpose') await db.query("update public.assets set purpose='brand_asset' where id=$1", [r.reference.assetId]);
      if (kind === 'verification') await db.query("update public.logo_asset_publications set verification=jsonb_set(verification,'{contentHash}',to_jsonb(repeat('f',64))) where id=$1", [r.id]);
      if (kind === 'provenance') await db.query("update public.asset_versions set provenance=jsonb_set(provenance,'{publicationId}',to_jsonb($1::text)) where id=$2", [randomUUID(), r.reference.versionId]);
    } finally { await db.exec('set session_replication_role=origin'); }
    await expect(f.authorize(job, r, 'read')).rejects.toMatchObject({ code: '42501' }); expect(await f.read(r)).toEqual([]);
  });
  it.each(['capability', 'policy', 'budget', 'binding', 'session', 'session-expiry', 'lease', 'expiry', 'worker', 'role-oid', 'cancel'])('rechecks %s after grant on each actual source read', async kind => {
    const { job, reservations } = await f.prepareConcept(), r = reservations[0]!; await f.enable(); await f.authorize(job, r, 'read');
    if (kind === 'capability') await db.exec('update fluid_private.logo_generative_storage_capabilities set enabled=false');
    if (kind === 'policy') await db.exec('update fluid_private.logo_runtime_policies set enabled=false');
    if (kind === 'budget') await db.exec('update fluid_private.logo_runtime_policies set max_cost_microusd=101 where operation=\'identity.logo_concept\'');
    if (kind === 'binding') await db.exec('update fluid_private.logo_storage_principals set enabled=false');
    if (kind === 'session') await db.exec('delete from auth.sessions');
    if (kind === 'session-expiry') await db.exec("update auth.sessions set not_after=clock_timestamp()-interval '1 second'");
    if (kind === 'lease') await db.query('update public.jobs set lease_token=$1 where id=$2', [randomUUID(), job.id]);
    if (kind === 'expiry') await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    if (kind === 'worker') await db.query("update public.jobs set worker_id='other' where id=$1", [job.id]);
    if (kind === 'role-oid') await db.exec('update fluid_private.logo_storage_principals set role_oid=0');
    if (kind === 'cancel') await f.rpc('request_job_cancel', [job.id]);
    expect(await f.read(r)).toEqual([]); await expect(f.authorize(job, r, 'read')).rejects.toMatchObject({ code: '42501' });
  });
  it('keeps frozen reference membership when a newer head selects different uploaded images', async () => {
    const { job, reservations } = await f.prepareConcept(), r = reservations[0]!; await f.enable();
    const before = await f.workspace(job.projectId), next = await f.uploadReference(before, 7);
    await f.rpc('apply_logo_workspace_command', [job.projectId, { method: 'saveLogoReferences', body: { requestKey: randomUUID(), expected: before.heads, selections: [{ referenceId: next.reference.referenceId, aspects: ['shape'] }] } }]);
    await f.authorize(job, r, 'read'); expect(await f.read(r)).toHaveLength(1);
    await expect(f.authorize(job, next.reservation, 'read')).rejects.toMatchObject({ code: '42501' });
  });
  it.each(['references', 'instruction', 'source', 'admission'])('rejects modified frozen %s bindings even with matching IDs', async kind => {
    const prepared = kind === 'references' || kind === 'admission' ? await f.prepareConcept(2) : await f.prepareRefinement();
    const { job, reservations } = prepared; await f.enable(job.operation === 'identity.logo_concept' ? conceptCapability : refinementCapability);
    await db.exec('set session_replication_role=replica');
    try {
      if (kind === 'references') await db.query("update public.jobs set input=jsonb_set(input,'{references}',jsonb_build_array(input#>'{references,1}',input#>'{references,0}')) where id=$1", [job.id]);
      if (kind === 'instruction') await db.query("update public.jobs set input=jsonb_set(input,'{instruction}','\"Not the admitted instruction\"') where id=$1", [job.id]);
      if (kind === 'source') await db.query("update public.jobs set input=jsonb_set(input,'{source,raster,attemptId}',to_jsonb($1::text)) where id=$2", [randomUUID(), job.id]);
      if (kind === 'admission') await db.query("update public.logo_operation_requests set receipt=jsonb_set(receipt,'{jobIds}','[]') where quote_id=($1::jsonb->>'quoteId')::uuid", [job.input]);
    } finally { await db.exec('set session_replication_role=origin'); }
    await expect(f.authorize(job, reservations[0]!, 'read')).rejects.toMatchObject({ code: '42501' });
  });
  it('rejects curated reference metadata even when an upload rights UUID is present', async () => {
    const { job, reservations } = await f.prepareConcept(), r = reservations[0]!; await f.enable();
    await db.exec('set session_replication_role=replica');
    try {
      await db.query("update public.logo_reference_sources set source_kind='curated' where version_id=$1", [r.reference.versionId]);
      await db.query("update public.logo_reference_snapshots set snapshot=jsonb_set(snapshot,'{references,0,sourceKind}','\"curated\"') where id=($1::jsonb->>'referenceSnapshotId')::uuid", [job.input]);
      await db.query("update public.logo_cost_quotes set source_inputs=jsonb_set(source_inputs,'{referenceSnapshot,references,0,sourceKind}','\"curated\"') where id=($1::jsonb->>'quoteId')::uuid", [job.input]);
    } finally { await db.exec('set session_replication_role=origin'); }
    await expect(f.authorize(job, r, 'read')).rejects.toMatchObject({ code: '42501' });
  });
  it('revokes prior grants when the Auth binding changes to another otherwise valid role and OID', async () => {
    const { job, reservations } = await f.prepareConcept(), r = reservations[0]!; await f.enable(); await f.authorize(job, r, 'read');
    // This pre-existing fixture role is a valid restricted login. Merely
    // checking the new binding's validity must not retain an old role's grant.
    // This proves grant-time binding continuity only: existing job rows do not
    // persist the original claimant-role OID, which this slice does not add.
    await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_subscription_worker_a'", [OWNER_A]);
    await db.exec("update fluid_private.logo_storage_principals set role_name='fixture_subscription_worker_a',role_oid=(select oid from pg_roles where rolname='fixture_subscription_worker_a')");
    expect(await f.read(r)).toEqual([]);
    await expect(f.authorize(job, r, 'read')).rejects.toMatchObject({ code: '42501' });
  });
  it('keeps sessions/owners separate and denies list/sign/info/update/delete despite permissive competitors', async () => {
    const { job, reservations } = await f.prepareConcept(), r = reservations[0]!; await f.enable(); await f.authorize(job, r, 'read');
    const secondSession = randomUUID(); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [secondSession, authUser]);
    expect(await f.read(r, 'object.get_authenticated', { session_id: secondSession })).toEqual([]);
    await expect(f.authorize(job, r, 'read', {}, OWNER_B)).rejects.toMatchObject({ code: '42501' });
    await db.exec('create policy fixture_generative_overbroad on storage.objects for all to authenticated using(true) with check(true)');
    try {
      for (const operation of ['', 'object.list', 'object.list_v2', 'object.sign', 'object.get_authenticated_info', 'object.update', 'object.delete']) expect(await f.read(r, operation)).toEqual([]);
      for (const operation of ['object.get_authenticated', 'object.upload']) {
        expect((await f.object(operation, () => db.query('update storage.objects set name=name returning name'))).rows).toEqual([]);
        expect((await f.object(operation, () => db.query('delete from storage.objects returning name'))).rows).toEqual([]);
      }
      expect(await f.read(r, 'object.list', {}, OWNER_A)).toHaveLength(1);
    } finally { await db.exec('drop policy fixture_generative_overbroad on storage.objects'); }
  });
  it('revokes generative-only writes/readback while retaining a separately granted legacy concept route', async () => {
    const { job } = await f.prepareConcept(0), { reservation } = await f.reserve(job); await f.enable();
    await f.authorize(job, reservation, 'write'); await f.insert(reservation);
    await db.exec('update fluid_private.logo_generative_storage_capabilities set enabled=false');
    expect(await f.read(reservation)).toEqual([]);
    await expect(f.authorize(job, reservation, 'write')).rejects.toMatchObject({ code: '42501' });
    const { reservation: legacy } = await f.reserve(job, { requestKey: randomUUID() });
    await f.auth(() => db.query('select public.authorize_logo_storage_reservation($1,$2,$3)', [job.id, job.leaseToken, legacy.id]));
    await f.insert(legacy); expect(await f.read(legacy)).toHaveLength(1);
    expect(await f.read(reservation)).toEqual([]);
    expect((await db.query('select * from fluid_private.logo_storage_grants')).rows).toHaveLength(1);
  });
  it('preserves the independent production broker after generative activation', async () => {
    const { job, original } = await f.prepareVector();
    const capability = (await db.query<{v: unknown}>("select fluid_private.logo_policy_descriptor(p) v from fluid_private.logo_runtime_policies p where operation='identity.logo_vectorize'")).rows[0]!.v as {operation: string; policyIdentity: string};
    await db.query('insert into fluid_private.logo_production_storage_capabilities(auth_user_id,operation,policy_identity,enabled) values($1,$2,$3,true)', [authUser, capability.operation, capability.policyIdentity]);
    await f.auth(() => db.query("select public.authorize_logo_production_storage($1,$2,$3,'read')", [job.id, job.leaseToken, original.id]));
    expect(await f.read(original)).toHaveLength(1);
    await expect(f.authorize(job, original, 'read')).rejects.toMatchObject({ code: '42501' });
    expect((await db.query('select * from fluid_private.logo_generative_storage_grants')).rows).toEqual([]);
  });
  it('leaves old brokers, ordinary tenant rights, default ACLs and UPDATE/DELETE fences unchanged', async () => {
    expect((await db.query('select * from pg_default_acl order by oid')).rows).toEqual(baseline.defaultsBefore);
    expect(baseline.policiesAfterCandidate).toEqual(baseline.policiesBefore);
    expect((await db.query("select oid,prosrc,proacl from pg_proc where proname in('authorize_logo_storage_reservation','authorize_logo_production_storage','logo_storage_object_allowed','logo_production_storage_object_allowed') order by oid")).rows).toEqual(baseline.brokersBefore);
    const after = (await db.query("select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='storage' order by policyname")).rows;
    for (const p of baseline.policiesBefore as {policyname: string}[]) if (!['fluid_logo_worker_storage_read_fence','fluid_logo_worker_storage_insert_fence'].includes(p.policyname)) expect(after).toContainEqual(p);
    for (const role of ['authenticated','anon','service_role','fixture_production_acl_probe']) {
      for (const table of ['logo_generative_storage_capabilities','logo_generative_storage_grants']) expect((await db.query<{ok: boolean}>(`select has_table_privilege($1,'fluid_private.${table}','select,insert,update,delete') ok`, [role])).rows[0]!.ok).toBe(false);
      if (role !== 'authenticated') expect((await db.query<{ok: boolean}>("select has_function_privilege($1,'public.authorize_logo_generative_storage(uuid,uuid,uuid,text)','execute') ok", [role])).rows[0]!.ok).toBe(false);
    }
  });
});
