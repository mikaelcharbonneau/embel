import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from './local-supabase';
import { directionsStorageFixture, installDirectionsStorageFixture, authUser, workerRole, sessionId } from './logo-directions-storage-fixture';
import { vectorCapability } from './logo-production-storage-fixture';
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema, logoDispatchReceiptSchema, type LogoConceptJobInput } from '../../src/domain/logo-jobs';
import { logoWorkspaceV2Schema } from '../../src/domain/logo-workspace';
import type { IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import { parseClaimedJob } from '../../worker/postgres-store';
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";

describe('directions GET-only Storage authority', () => {
  let db: TestDatabase;
  let f: Awaited<ReturnType<typeof directionsStorageFixture>>;
  type Policy = { policyname: string; cmd: string; qual: string | null; with_check: string | null };
  let baselinePolicies: Policy[], candidatePolicies: Policy[], activePolicies: Policy[], candidateCallable: boolean, candidateRows: unknown[];
  beforeAll(async () => {
    db = await createTestDatabase(); await installDirectionsStorageFixture(db, { installDirections: false });
    const policies = async () => (await db.query<Policy>("select policyname,cmd,qual,with_check from pg_policies where schemaname='storage' and tablename='objects' order by policyname")).rows;
    baselinePolicies = await policies();
    await db.exec(await readFile(new URL('../../supabase/candidates/logo_directions_storage.sql', import.meta.url), 'utf8'));
    candidatePolicies = await policies(); candidateRows = (await db.query('select * from fluid_private.logo_directions_storage_capabilities')).rows;
    candidateCallable = (await db.query<{ allowed: boolean }>("select has_function_privilege('authenticated','public.authorize_logo_directions_storage(uuid,uuid,uuid,text)','EXECUTE') allowed")).rows[0]!.allowed;
    await db.exec(await readFile(new URL('../../supabase/activation/logo_directions_storage.sql', import.meta.url), 'utf8'));
    activePolicies = await policies();
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); f = await directionsStorageFixture(db); }, 60_000);
  it('installs the dedicated directions authority', async () => {
    const result = await db.query<{ signature: string | null }>("select to_regprocedure('public.authorize_logo_directions_storage(uuid,uuid,uuid,text)')::text signature");
    expect(result.rows[0]!.signature).toBe('authorize_logo_directions_storage(uuid,uuid,uuid,text)');
  });
  it('keeps the candidate inert and changes only the GET read fence at separate activation', () => {
    expect(candidateCallable).toBe(false); expect(candidateRows).toEqual([]); expect(candidatePolicies).toEqual(baselinePolicies);
    expect(activePolicies.filter(policy => policy.cmd !== 'SELECT')).toEqual(baselinePolicies.filter(policy => policy.cmd !== 'SELECT'));
    const before = baselinePolicies.find(policy => policy.policyname === 'fluid_logo_worker_storage_read_fence')!;
    const after = activePolicies.find(policy => policy.policyname === before.policyname)!;
    for (const fn of ['logo_storage_object_allowed', 'logo_production_storage_object_allowed', 'logo_generative_storage_object_allowed']) {
      expect(before.qual).toContain(fn); expect(after.qual).toContain(fn);
    }
    expect(after.qual).toContain('logo_directions_storage_object_allowed');
  });
  it('admits only the exact approved JSON and genuinely imported catalog font', async () => {
    const x = await f.prepareDirections();
    await expect(f.authorize(x.job, null, 'probe')).rejects.toMatchObject({ code: '42501' });
    await f.enable();
    expect(await f.authorize(x.job, null, 'probe')).toMatchObject({ ownerId: OWNER_A, authUserId: authUser, jobId: x.job.id, leaseToken: x.job.leaseToken, capability: f.capability, mode: 'probe', reservation: null, member: null });
    for (const [r, member] of [[x.document, { kind: 'logo-document' }], [x.fontReservation!, { kind: 'font', font: x.font }]] as const) {
      expect(await f.read(r)).toEqual([]);
      expect(await f.authorize(x.job, r)).toMatchObject({ reservation: r, member, jobInput: x.job.input });
      expect(await f.read(r)).toHaveLength(1);
      expect(await f.authorize(x.job, r)).toMatchObject({ reservation: r, member });
    }
    expect((await db.query('select * from fluid_private.logo_directions_storage_grants')).rows).toHaveLength(2);
    expect((await db.query('select font_record_id from public.logo_input_receipts')).rows).toEqual([{ font_record_id: x.font!.id }]);
    expect((await db.query('select state from fluid_private.logo_vector_publications')).rows).toEqual([{ state: 'committed' }]);
    expect(x.workspace.approvedLogo!.vectorRevisionId).toBe(x.revision.id);
  });
  it('rejects SVG, preview, other-owner, same-hash newly imported and same-owner nonmembers', async () => {
    const x = await f.prepareDirections(); await f.enable();
    const newer = await f.importFont(x.job.projectId);
    expect(newer.font.asset.contentHash).toBe(x.font!.asset.contentHash);
    for (const r of [x.svg, x.original, newer.reservation]) {
      await expect(f.authorize(x.job, r)).rejects.toMatchObject({ code: '42501' }); expect(await f.read(r)).toEqual([]);
    }
    const other = await f.prepareDirections();
    await expect(f.authorize(x.job, other.document)).rejects.toMatchObject({ code: '42501' });
    const foreign = { ...x.document, storagePath: x.document.storagePath.replace(OWNER_A, OWNER_B) };
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [foreign.storagePath, authUser]);
    expect(await f.read(foreign)).toEqual([]);
    await expect(f.authorize(x.job, x.document, 'read', {}, OWNER_B)).rejects.toMatchObject({ code: '42501' });
  });
  it('requires a nonempty frozen font set before probe or any source read', async () => {
    const x = await f.prepareDirections({ withFont: false }); await f.enable();
    await expect(f.authorize(x.job, null, 'probe')).rejects.toMatchObject({ code: '42501' });
    await expect(f.authorize(x.job, x.document)).rejects.toMatchObject({ code: '42501' });
  });
  it('probes every frozen font and preserves the exact ordered font ID projection', async () => {
    const x = await f.prepareDirections({ catalogFontIds: ['geist-sans-variable', 'geist-mono-variable'] }); await f.enable();
    expect(await f.authorize(x.job, null, 'probe')).toMatchObject({ jobId: x.job.id });
    const input = x.job.input as { fontVersionIds: string[] };
    expect(input.fontVersionIds).toHaveLength(2);
    await db.query("update public.jobs set input=jsonb_set(input,'{fontVersionIds}',$1::jsonb) where id=$2", [[...input.fontVersionIds].reverse(), x.job.id]);
    await expect(f.authorize(x.job, null, 'probe')).rejects.toMatchObject({ code: '42501' });
    await db.query("update public.jobs set input=jsonb_set(input,'{fontVersionIds}',$1::jsonb) where id=$2", [input.fontVersionIds, x.job.id]);
    await f.authorize(x.job, x.document);
    await db.exec('alter table public.logo_input_receipts disable trigger user');
    try { await db.query('delete from public.logo_input_receipts where font_record_id=$1', [x.fonts[1]!.id]); }
    finally { await db.exec('alter table public.logo_input_receipts enable trigger user'); }
    await expect(f.authorize(x.job, null, 'probe')).rejects.toMatchObject({ code: '42501' });
    expect(await f.read(x.document)).toEqual([]);
  });
  it('rechecks owner-wide subscription quota without counting its own admission twice', async () => {
    const x = await f.prepareDirections(); await f.enable(); await f.authorize(x.job, x.document);
    await db.query("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd,max_attempts,billing_mode,policy_identity) select owner_id,project_id,operation,input_revision,input_hash,input,gen_random_uuid()::text,'queued',0,1,billing_mode,policy_identity from public.jobs cross join generate_series(1,3) where id=$1", [x.job.id]);
    await expect(f.authorize(x.job, null, 'probe')).rejects.toMatchObject({ code: '42501' }); expect(await f.read(x.document)).toEqual([]);
  });
  it.each(['receipt', 'rights', 'license', 'request', 'record', 'catalog', 'document-proof', 'version-provenance', 'frozen-source', 'font-projection'] as const)('rechecks complete %s evidence before dispatch and every Storage GET', async kind => {
    const x = await f.prepareDirections(); await f.enable(); await f.authorize(x.job, x.document); await f.authorize(x.job, x.fontReservation!);
    // Deliberate privileged corruption inside a disposable fixture only. A row
    // that looks plausible never substitutes for the full immutable import.
    const mutate = async (table: string, sql: string, args: unknown[]) => {
      await db.exec(`alter table ${table} disable trigger user`);
      try { await db.query(sql, args); } finally { await db.exec(`alter table ${table} enable trigger user`); }
    };
    if (kind === 'receipt') await mutate('public.logo_input_receipts', 'delete from public.logo_input_receipts where font_record_id=$1', [x.font!.id]);
    if (kind === 'rights') await mutate('public.logo_input_rights', "update public.logo_input_rights set source_kind='user_declaration',catalog_id=null where id=$1", [x.font!.rights.id]);
    if (kind === 'license') await mutate('public.logo_input_rights', "update public.logo_input_rights set license_text='fabricated license',license_text_hash=encode(sha256(convert_to('fabricated license','UTF8')),'hex') where id=$1", [x.font!.rights.id]);
    if (kind === 'request') await mutate('public.logo_input_requests', "update public.logo_input_requests set request=jsonb_set(request,'{input,catalogFontId}','\"geist-mono-variable\"') where request_key=$1", [x.fontReservation!.requestKey]);
    if (kind === 'record') await mutate('public.logo_font_records', "update public.logo_font_records set record=jsonb_set(record,'{family}','\"Fabricated family\"') where record_id=$1", [x.font!.id]);
    if (kind === 'catalog') await mutate('public.logo_input_rights', "update public.logo_input_rights set catalog_id='geist-mono-variable' where id=$1", [x.font!.rights.id]);
    if (kind === 'document-proof') await mutate('public.logo_vector_revisions', "update public.logo_vector_revisions set record=jsonb_set(record,'{proof,documentHash}',to_jsonb($1::text)) where id=$2", ['f'.repeat(64), x.revision.id]);
    if (kind === 'version-provenance') await mutate('public.asset_versions', "update public.asset_versions set provenance=jsonb_set(provenance,'{publicationId}',to_jsonb($1::text)) where id=$2", [randomUUID(), x.document.reference.versionId]);
    if (kind === 'frozen-source') await mutate('public.logo_direction_inputs', "update public.logo_direction_inputs set source=jsonb_set(source,'{targetCount}','2') where job_id=$1", [x.job.id]);
    if (kind === 'font-projection') await db.query("update public.jobs set input=jsonb_set(input,'{fontVersionIds}','[]') where id=$1", [x.job.id]);
    await expect(f.authorize(x.job, null, 'probe')).rejects.toMatchObject({ code: '42501' });
    await expect(f.authorize(x.job, x.document)).rejects.toMatchObject({ code: '42501' });
    expect(await f.read(x.document)).toEqual([]); expect(await f.read(x.fontReservation!)).toEqual([]);
  });
  it.each(['lease', 'expiry', 'cancel', 'session', 'session-expiry', 'binding', 'role', 'worker', 'readiness', 'registration', 'account', 'policy', 'billing', 'capability'] as const)('revokes previously acquired reads on %s loss', async kind => {
    const x = await f.prepareDirections(); await f.enable(); await f.authorize(x.job, x.document);
    if (kind === 'lease') await db.query('update public.jobs set lease_token=$1 where id=$2', [randomUUID(), x.job.id]);
    if (kind === 'expiry') await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [x.job.id]);
    if (kind === 'cancel') await db.query("update public.jobs set state='cancel_requested',cancel_requested_at=clock_timestamp() where id=$1", [x.job.id]);
    if (kind === 'session') await db.query('delete from auth.sessions where id=$1', [sessionId]);
    if (kind === 'session-expiry') await db.query("update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1", [sessionId]);
    if (kind === 'binding') await db.exec('update fluid_private.logo_storage_principals set enabled=false');
    if (kind === 'role') await db.exec('update fluid_private.logo_storage_principals set role_oid=0');
    if (kind === 'worker') await db.query("update public.jobs set worker_id='another-worker' where id=$1", [x.job.id]);
    if (kind === 'readiness') await db.exec("update fluid_private.logo_worker_readiness set ready_until=clock_timestamp()-interval '1 second'");
    if (kind === 'registration') await db.exec('update fluid_private.subscription_registrations set connected=false');
    if (kind === 'account') await db.query('update fluid_private.subscription_registrations set owner_id=$1 where registration_id=$2', [OWNER_B, f.policy.registrationId]);
    if (kind === 'policy') await db.exec("update fluid_private.logo_runtime_policies set enabled=false where operation='identity.logo_directions'");
    if (kind === 'billing') await db.query("update public.jobs set billing_mode='openai_api',policy_identity=null,input=input-'billingMode'-'policy' where id=$1", [x.job.id]);
    if (kind === 'capability') await db.exec('update fluid_private.logo_directions_storage_capabilities set enabled=false');
    expect(await f.read(x.document)).toEqual([]);
    await expect(f.authorize(x.job, null, 'probe')).rejects.toMatchObject({ code: '42501' });
  });
  it('rejects wrong session, JWT, role, operation and malformed modes without grants', async () => {
    const x = await f.prepareDirections(); await f.enable();
    for (const claims of [{ is_anonymous: true }, { role: 'service_role' }, { exp: 0 }, { session_id: randomUUID() }, { sub: OWNER_A }]) await expect(f.authorize(x.job, x.document, 'read', claims)).rejects.toMatchObject({ code: '42501' });
    for (const mode of ['write', 'readback', 'upload', 'list', 'sign', '', 'probe']) await expect(f.authorize(x.job, x.document, mode)).rejects.toMatchObject({ code: '42501' });
    await expect(f.authorize(x.job, null, 'read')).rejects.toMatchObject({ code: '42501' });
    await expect(f.authorize({ ...x.job, leaseToken: randomUUID() }, x.document)).rejects.toMatchObject({ code: '42501' });
    await expect(asRole(db, 'anon', null, () => db.query("select public.authorize_logo_directions_storage($1,$2,$3,'read')", [x.job.id, x.job.leaseToken, x.document.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(f.connection.query("select public.authorize_logo_directions_storage($1,$2,$3,'read')", [x.job.id, x.job.leaseToken, x.document.id])).rejects.toMatchObject({ code: '42501' });
    expect((await db.query('select * from fluid_private.logo_directions_storage_grants')).rows).toEqual([]);
  });
  it('allows only object GET even beneath a hostile permissive policy, preserving ordinary owners', async () => {
    const x = await f.prepareDirections(); await f.enable(); await f.authorize(x.job, x.document);
    await db.exec('create policy fixture_directions_overbroad on storage.objects for all to authenticated using(true) with check(true)');
    // RLS stores resolved function OIDs, whereas a direct client SQL spelling
    // requires private-schema USAGE. This disposable wrapper tests the helper's
    // own operation guard without adding that deliberately absent schema grant.
    await db.exec(`create function public.fixture_directions_predicate(p_name text) returns boolean language sql security definer set search_path='' as $$select fluid_private.logo_directions_storage_object_allowed('fluid-assets',p_name)$$;
      revoke all on function public.fixture_directions_predicate(text) from public,anon,authenticated,service_role,fixture_production_acl_probe;
      grant execute on function public.fixture_directions_predicate(text) to authenticated;`);
    try {
      for (const operation of ['', 'object.list', 'object.list_v2', 'object.sign', 'object.get_authenticated_info', 'object.upload', 'object.update', 'object.delete']) {
        expect(await f.read(x.document, operation)).toEqual([]);
        const predicate = await f.object(operation, () => db.query<{ allowed: boolean }>('select public.fixture_directions_predicate($1) allowed', [x.document.storagePath]));
        expect(predicate.rows[0]!.allowed).toBe(false);
      }
      for (const operation of ['object.upload', 'object.get_authenticated']) {
        expect(await f.object(operation, async () => (await db.query('update storage.objects set name=name returning name')).rows)).toEqual([]);
        expect(await f.object(operation, async () => (await db.query('delete from storage.objects returning name')).rows)).toEqual([]);
      }
      await expect(f.insert({ ...x.document, storagePath: `${x.document.storagePath}-other` })).rejects.toMatchObject({ code: '42501' });
      expect(await f.read(x.document, 'object.list', {}, OWNER_A)).toHaveLength(1);
      await db.exec('update fluid_private.logo_directions_storage_capabilities set enabled=false');
      expect(await f.read(x.document)).toEqual([]); expect(await f.read(x.document, 'object.get_authenticated', {}, OWNER_A)).toHaveLength(1);
    } finally { await db.exec('drop policy fixture_directions_overbroad on storage.objects; drop function public.fixture_directions_predicate(text)'); }
  });
  it('pins both the actual Auth session and the complete grant-time role binding', async () => {
    const x = await f.prepareDirections(); await f.enable(); await f.authorize(x.job, x.document);
    const nextSession = randomUUID(); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [nextSession, authUser]);
    expect(await f.read(x.document, 'object.get_authenticated', { session_id: nextSession })).toEqual([]);
    const role = 'fixture_directions_rebound';
    await db.exec(`create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant usage on schema public,fluid_private to ${role}; grant execute on function public.report_logo_worker_ready(text,jsonb,integer) to ${role}`);
    await db.query('insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2', [OWNER_A, role]);
    await db.exec(`set session authorization ${role}`);
    try { await db.query('select public.report_logo_worker_ready($1,$2,90)', [f.authConfiguration().workerId, [f.capability]]); }
    finally { await db.exec('set session authorization postgres'); }
    await db.query('update fluid_private.logo_storage_principals set role_name=$1,role_oid=(select oid from pg_roles where rolname=$1) where auth_user_id=$2', [role, authUser]);
    expect(await f.read(x.document)).toEqual([]);
    await expect(f.authorize(x.job, x.document)).rejects.toMatchObject({ code: '42501' });
  });
  it('retains admitted membership after a newer workspace head and another font import', async () => {
    const x = await f.prepareDirections(); await f.enable();
    await f.rpc('apply_logo_workspace_command', [x.job.projectId, { method: 'saveLogoBrief', body: { requestKey: randomUUID(), expected: x.workspace.heads, brief: { name: 'Newer brief', activity: 'Test', audience: 'Test', personality: 'New', logoTypes: ['wordmark'] } } }]);
    const imported = await f.importFont(x.job.projectId);
    expect(await f.authorize(x.job, x.document)).toMatchObject({ reservation: x.document });
    expect(await f.authorize(x.job, x.fontReservation!)).toMatchObject({ member: { kind: 'font', font: x.font } });
    await expect(f.authorize(x.job, imported.reservation)).rejects.toMatchObject({ code: '42501' });
  });
  it('preserves independent production reads and rejects directions-to-production cross-lane authority', async () => {
    const vector = await f.prepareVector();
    await db.query('insert into fluid_private.logo_production_storage_capabilities(auth_user_id,operation,policy_identity,enabled) values($1,$2,$3,true)', [authUser, vectorCapability.operation, vectorCapability.policyIdentity]);
    await f.auth(() => db.query("select public.authorize_logo_production_storage($1,$2,$3,'read')", [vector.job.id, vector.job.leaseToken, vector.original.id]));
    expect(await f.read(vector.original)).toHaveLength(1);
    await f.enable(); await expect(f.authorize(vector.job, vector.original)).rejects.toMatchObject({ code: '42501' });
    await db.exec('update fluid_private.logo_directions_storage_capabilities set enabled=false');
    expect(await f.read(vector.original)).toHaveLength(1);
  });
  it('preserves independent legacy-concept and generative grants through the combined read fence', async () => {
    const w = logoWorkspaceV2Schema.parse(await startLogoFixture(ownerQuery(db), { requestKey: randomUUID(), brief: { name: 'Cross-lane fixture', activity: 'Test', audience: 'Test', personality: 'Calm', logoTypes: ['wordmark'] } }));
    const snapshot = (await db.query<{ id: string }>('select reference_snapshot_id id from public.logo_stage_revisions where id=$1', [w.stages.brief_references!.id])).rows[0]!.id;
    const quote = logoCostQuoteSchema.parse(await f.rpc('quote_logo_operation', [w.projectId, { operation: 'concepts', expected: w.heads, briefRevisionId: w.stages.brief_references!.id, referenceSnapshotId: snapshot }]));
    const admission = logoDispatchReceiptSchema.parse(await f.rpc('admit_logo_operation', [w.projectId, { requestKey: randomUUID(), quoteId: quote.id, expected: w.heads, acceptedMaxCostMicrousd: quote.maxCostMicrousd }]));
    const job = parseClaimedJob((await f.connection.query('select * from public.claim_logo_job($1,300)', [f.authConfiguration().workerId])).rows[0]);
    expect(admission.jobIds).toContain(job.id);
    const input = job.input as LogoConceptJobInput;
    const inputRevisions = (await f.connection.query<{ value: unknown }>("select public.read_leased_logo_record($1,$2,'input_revisions',null) value", [job.id, job.leaseToken])).rows[0]!.value;
    const reservations: IdentityAssetReservation[] = [];
    await db.query("insert into fluid_private.logo_generative_storage_capabilities(auth_user_id,operation,policy_identity,enabled) values($1,'identity.logo_concept',$2,true)", [authUser, 'a'.repeat(64)]);
    for (const route of ['legacy', 'generative']) {
      const publication = { requestKey: route === 'legacy' ? randomUUID() : input.attemptId, inputRevisions, mimeType: 'image/png', contentHash: 'd'.repeat(64), byteLength: 3, source: { kind: 'concept', sourceId: input.attemptId } };
      const r = (await f.connection.query<{ value: IdentityAssetReservation }>('select fluid_private.prepare_logo_asset($1,$2,$3,$4) value', [w.projectId, { kind: 'stage', publication }, job.id, job.leaseToken])).rows[0]!.value;
      await f.auth(() => route === 'legacy' ? db.query('select public.authorize_logo_storage_reservation($1,$2,$3)', [job.id, job.leaseToken, r.id]) : db.query("select public.authorize_logo_generative_storage($1,$2,$3,'write')", [job.id, job.leaseToken, r.id]));
      await f.insert(r); expect(await f.read(r)).toHaveLength(1); reservations.push(r);
    }
    await f.enable(); await expect(f.authorize(job, reservations[0]!)).rejects.toMatchObject({ code: '42501' });
    await db.exec('update fluid_private.logo_directions_storage_capabilities set enabled=false');
    for (const r of reservations) expect(await f.read(r)).toHaveLength(1);
  });
  it('scrubs hostile inherited ACLs and grants only the two Auth execution surfaces', async () => {
    for (const table of ['logo_directions_storage_capabilities', 'logo_directions_storage_grants']) for (const role of ['anon', 'authenticated', 'service_role', workerRole, 'fixture_production_acl_probe']) {
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role, `fluid_private.${table}`])).rows[0]!.allowed).toBe(false);
    }
    const signatures = ['fluid_private.logo_directions_storage_job(jsonb,uuid,uuid)', 'fluid_private.logo_directions_storage_member(public.jobs,public.logo_asset_publications)', 'public.authorize_logo_directions_storage(uuid,uuid,uuid,text)', 'fluid_private.logo_directions_storage_object_allowed(text,text)'];
    for (const signature of signatures) for (const role of ['anon', 'authenticated', 'service_role', workerRole, 'fixture_production_acl_probe']) {
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0]!.allowed).toBe(role === 'authenticated' && (signature.startsWith('public.authorize') || signature.includes('object_allowed')));
    }
    expect((await db.query("select column_default from information_schema.columns where table_schema='fluid_private' and table_name='logo_directions_storage_capabilities' and column_name='enabled'")).rows).toEqual([{ column_default: 'false' }]);
    await db.exec('create table public.fixture_directions_default_acl_sentinel(id integer)');
    try { expect((await db.query<{ allowed: boolean }>("select has_table_privilege('fixture_production_acl_probe','public.fixture_directions_default_acl_sentinel','SELECT') allowed")).rows[0]!.allowed).toBe(true); }
    finally { await db.exec('drop table public.fixture_directions_default_acl_sentinel'); }
  });
});
