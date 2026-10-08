import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OWNER_A, type TestDatabase } from './local-supabase';
import { installProductionStorageFixture, productionStorageFixture, workerRole, workerId, authUser, sessionId, vectorCapability, exportCapability } from './logo-production-storage-fixture';
import { sqlSubscriptionPolicy, sqlPolicyIdentity } from './logo-directions-subscription-fixture';
import { SYNTHETIC_CONCEPT_READINESS } from './logo-readiness-fixture';
import type { ClaimedJob } from '../../src/domain/jobs';
import { logoCostQuoteSchema, logoDispatchReceiptSchema, type LogoDirectionsSubscriptionPolicy, type LogoResolvedDirectionInput } from '../../src/domain/logo-jobs';
import { fontRecordSchema } from '../../src/domain/logo-directions';
import { logoVectorRevisionSchema } from '../../src/domain/logo-vector';
import type { AssetVersionReference } from '../../src/domain/asset-library';
import { logoWorkspaceV2Schema, type LogoMutationReceipt } from '../../src/domain/logo-workspace';
import { createIdentityAssetStore, createPostgresIdentityAssetBackend, type IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import type { AuthenticatedContext } from '../../src/server/auth/context';
import type { IdentityConnectionFactory } from '../../src/server/data/identity-transaction';
import { createPostgresLogoInputRegistry } from '../../src/server/data/logo-inputs';
import { createLogoInputRegistration, validateLogoInputBytes } from '../../src/features/logo-inputs/server/registration';
import { readFreeCatalogFont } from '../../src/features/identity-directions/server/fonts';
import { createLogoTransactionService } from '../../src/server/data/logo-transaction';
import { createLogoWorkspaceService } from '../../src/server/data/logo-workspace';
import { createLogoVectorMutationProducers } from '../../src/features/logo-vector/server/mutations';
import { publishLogoVectorResult } from '../../src/features/logo-vector/server/publication';
import { validateLogoVectorCandidate, verifyLogoVectorRevision } from '../../src/features/logo-vector/server/revisions';
import type { LogoVectorConversionResult } from '../../src/features/logo-vector/server/converter';
import { QUALIFIED_VTRACER } from '../../worker/logo-vector/engine';
import { parseClaimedJob } from '../../worker/postgres-store';
import { separatedLogoDocument } from '../features/logo-vector/fixtures';

export { workerRole, workerId, authUser, sessionId };
export const directionsAccountId = 'synthetic-directions-account';

/** Disposable PGlite only. Real SQL boundaries, actual pinned catalog bytes and
 * real canonical vector publication; synthetic artwork, Auth and Storage HTTP. */
export async function installDirectionsStorageFixture(db: TestDatabase, options: { installDirections?: boolean } = {}) {
  await installProductionStorageFixture(db);
  await db.exec(`grant execute on function fluid_private.prepare_logo_input(uuid,jsonb),fluid_private.commit_logo_input(uuid,jsonb,jsonb,jsonb),
    fluid_private.read_logo_trusted_request(uuid,jsonb),public.load_logo_direction_inputs(uuid,uuid),public.stage_logo_directions(uuid,uuid,jsonb,uuid,jsonb),
    public.heartbeat_logo_job(uuid,uuid,integer),public.register_logo_job_plan(uuid,uuid,jsonb),public.expire_logo_job_leases() to ${workerRole};`);
  for (const kind of ['candidates', 'activation']) await db.exec(await readFile(new URL(`../../supabase/${kind}/logo_generative_storage.sql`, import.meta.url), 'utf8'));
  if (options.installDirections !== false) for (const kind of ['candidates', 'activation']) await db.exec(await readFile(new URL(`../../supabase/${kind}/logo_directions_storage.sql`, import.meta.url), 'utf8'));
}

export async function directionsStorageFixture(db: TestDatabase) {
  const base = await productionStorageFixture(db);
  const oid = (await db.query<{ oid: number }>('select oid::int oid from pg_roles where rolname=$1', [workerRole])).rows[0]!.oid;
  const policy = sqlSubscriptionPolicy() as LogoDirectionsSubscriptionPolicy;
  const policyIdentity = await sqlPolicyIdentity(db, policy);
  const capability = { operation: 'identity.logo_directions' as const, policyIdentity, handlerVersion: 'logo-directions-v1', provider: 'openai', model: policy.model, engine: null, maxCostMicrousd: 0, billingMode: 'chatgpt_subscription' as const, policy };
  await db.query('insert into fluid_private.subscription_registrations(registration_id,owner_id,connected,plan_usage_enabled) values($1,$2,true,true)', [policy.registrationId, OWNER_A]);
  await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled,subscription_policy) values($1,'identity.logo_directions',$2,'logo-directions-v1','openai',$3,0,true,$4)", [OWNER_A, policyIdentity, policy.model, policy]);
  const manifest = [SYNTHETIC_CONCEPT_READINESS, vectorCapability, exportCapability, capability];
  async function refreshReadiness() {
    const result = await base.connection.query<{ ready: boolean }>('select public.report_logo_worker_ready($1,$2,90) ready', [workerId, manifest]);
    if (result.rows[0]?.ready !== true) throw Error('Directions fixture readiness rejected');
  }
  await refreshReadiness();
  const owned: IdentityConnectionFactory = { async acquire(ownerId) {
    if (ownerId !== OWNER_A) throw Error('foreign_fixture_writer');
    await db.exec(`set session authorization ${workerRole}`);
    return { binding: { ownerId, roleName: workerRole, roleOid: oid }, connection: {
      query: (sql, args) => db.query(sql, args ? [...args] : undefined),
      release: async () => { await db.exec('set session authorization postgres'); },
      discard: async () => { await db.exec('set session authorization postgres'); },
    } };
  } };
  function ownerAuth(): AuthenticatedContext {
    return { userId: OWNER_A, client: { rpc(name: string, args: Record<string, unknown>) {
      const params = name === 'read_logo_asset' ? [args.p_reference] : name === 'read_logo_workspace_record' ? [args.p_project_id, args.p_kind, args.p_id] : [args.p_project_id];
      const result = base.rpc(name, params).then(data => ({ data, error: null })).catch(error => ({ data: null, error }));
      return Object.assign(result, { abortSignal: () => result });
    } } } as unknown as AuthenticatedContext;
  }
  const sourceAssets = createIdentityAssetStore({ backend: createPostgresIdentityAssetBackend({ owned, worker: base.connection }), validateBytes: validateLogoInputBytes, storage: {
    async putIfAbsent(path, bytes, mimeType) {
      const old = base.blobs.get(path);
      if (old && (!Buffer.from(old.bytes).equals(Buffer.from(bytes)) || old.mimeType !== mimeType)) throw Error('immutable_fixture_blob');
      if (!old) base.blobs.set(path, { bytes: Uint8Array.from(bytes), mimeType });
      await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2) on conflict(bucket_id,name) do nothing", [path, OWNER_A]);
    },
    async read(path) { const blob = base.blobs.get(path); if (!blob) throw Error('missing_fixture_blob'); return { bytes: Uint8Array.from(blob.bytes), mimeType: blob.mimeType }; },
  } });
  const register = createLogoInputRegistration({ assets: sourceAssets, registry: createPostgresLogoInputRegistry(owned) });
  const workspace = async (projectId: string) => logoWorkspaceV2Schema.parse(await base.rpc('get_logo_workspace', [projectId]));
  const reservation = async (reference: AssetVersionReference) => (await db.query<{ value: IdentityAssetReservation }>('select fluid_private.logo_asset_reservation(a) value from public.logo_asset_publications a where a.owner_id=$1 and a.project_id=$2 and a.version_id=$3', [reference.ownerId, reference.projectId, reference.versionId])).rows[0]!.value;
  async function importFont(projectId: string, catalogFontId = 'geist-sans-variable') {
    const catalog = await readFreeCatalogFont(catalogFontId), w = await workspace(projectId);
    const font = fontRecordSchema.parse(await register(ownerAuth(), projectId, { kind: 'font_catalog', input: { requestKey: randomUUID(), expected: w.heads, catalogFontId }, file: { contentHash: catalog.contentHash, mimeType: catalog.mimeType, byteLength: catalog.bytes.byteLength } }, catalog.bytes));
    return { font, reservation: await reservation(font.asset), catalog };
  }
  async function prepareDirections(options: { withFont?: boolean; claim?: boolean; catalogFontIds?: readonly string[] } = {}) {
    await refreshReadiness();
    const vector = await base.prepareVector();
    await base.connection.query("select public.begin_logo_job_step($1,$2,'convert-vector',$3,0)", [vector.job.id, vector.job.leaseToken, `${vector.job.id}:convert-vector`]);
    const verified = await sourceAssets.readLeasedAsset(vector.job, vector.original.reference), document = separatedLogoDocument();
    const derived = validateLogoVectorCandidate({ base: null, candidate: document, locks: [], expectedSource: verified.reference, source: verified });
    const settings = (vector.job.input as { settings: LogoVectorConversionResult['engine']['settings'] }).settings;
    const result: LogoVectorConversionResult = { source: verified.reference, sourceContentHash: verified.reference.contentHash, logoType: 'mascot', document, svg: derived.svg,
      engine: { name: '@visioncortex/vtracer', version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm, settings },
      raster: { inputFormat: 'png', inputWidth: 48, inputHeight: 40, width: 48, height: 40, originalOrientation: 1, autoOriented: false, inputColorSpace: 'srgb', outputColorSpace: 'srgb', rgbaContentHash: 'e'.repeat(64), alphaStrategy: 'exact-alpha-layers', alphaLevels: [255] } };
    const publication = await publishLogoVectorResult(base.connection, sourceAssets, vector.job, result);
    await base.connection.query("select public.complete_logo_job_step($1,$2,'convert-vector','succeeded',0,$3,null)", [vector.job.id, vector.job.leaseToken, { version: 2, kind: 'logo_vector', publicationId: publication.id }]);
    await base.connection.query("select public.finish_logo_job($1,$2,'succeeded')", [vector.job.id, vector.job.leaseToken]);
    const revision = logoVectorRevisionSchema.parse((await db.query<{ record: unknown }>('select record from public.logo_vector_revisions where project_id=$1', [vector.job.projectId])).rows[0]!.record);
    const reads = createLogoWorkspaceService({ assetStore: sourceAssets, verifyVectorRevision: verifyLogoVectorRevision });
    const mutations = createLogoTransactionService(owned, createLogoVectorMutationProducers({ assetStore: sourceAssets, readVectorDetail: reads.readLogoVectorDetail, getWorkspace: reads.getLogoWorkspace, readCurrentVectorRevisionId: reads.readLogoCurrentVectorRevisionId, readStageRevision: reads.getLogoStageRevision }));
    const before = await workspace(vector.job.projectId);
    const approved = await mutations.run(ownerAuth(), before.projectId, { method: 'acceptLogoVector', body: { requestKey: randomUUID(), expected: before.heads, vectorRevisionId: revision.id, acceptEarlierBasis: false } }) as LogoMutationReceipt;
    const imports = [];
    if (options.withFont !== false) for (const catalogId of options.catalogFontIds ?? ['geist-sans-variable']) imports.push(await importFont(before.projectId, catalogId));
    const imported = imports[0] ?? null;
    const w = approved.workspace;
    await refreshReadiness();
    const quote = logoCostQuoteSchema.parse(await base.rpc('quote_logo_operation', [w.projectId, { operation: 'directions', expected: w.heads, approvedLogoId: w.approvedLogo!.id }]));
    const admission = logoDispatchReceiptSchema.parse(await base.rpc('admit_logo_operation', [w.projectId, { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: 0, expected: w.heads }]));
    const job = options.claim === false ? null : parseClaimedJob((await base.connection.query('select * from public.claim_logo_job($1,300)', [workerId])).rows[0]);
    if (job && job.id !== admission.jobIds[0]) throw Error('Unexpected directions fixture claim');
    const source = (await db.query<{ source: Record<string, unknown> }>('select source from public.logo_direction_inputs where job_id=$1', [admission.jobIds[0]])).rows[0]!.source;
    const candidate = { directions: [0, 1, 2].map(n => ({ name: `Synthetic direction ${n + 1}`, palette: { swatches: [{ key: 'ink', name: 'Ink', hex: ['#191919', '#242424', '#333333'][n] }, { key: 'paper', name: 'Paper', hex: '#FFFFFF' }], pairings: [{ role: 'body', foregroundKey: 'ink', backgroundKey: 'paper' }] }, typography: { styles: [{ key: 'body', role: 'body', sampleText: 'Fluid', fontVersionId: imported?.font.id, weight: 400, style: 'normal', sizePx: 16, lineHeight: 1.5 }] }, graphics: { elements: [] } })) };
    const resolved = { ...source }; delete resolved.logoRevision;
    return { job: job!, workspace: w, source, revision, artwork: document, font: imported?.font ?? null, catalog: imported?.catalog ?? null, fontReservation: imported?.reservation ?? null, fonts: imports.map(item => item.font), fontReservations: imports.map(item => item.reservation), document: await reservation(revision.documentAsset), svg: await reservation(revision.svgAsset), original: vector.original, candidate, quote, admission,
      resolved: { ...resolved, logo: document } as unknown as LogoResolvedDirectionInput };
  }
  async function enable() { await db.query('insert into fluid_private.logo_directions_storage_capabilities(auth_user_id,policy_identity,enabled) values($1,$2,true) on conflict(auth_user_id) do update set policy_identity=excluded.policy_identity,enabled=true', [authUser, policyIdentity]); }
  const authorize = (job: ClaimedJob, r: IdentityAssetReservation | null, mode = 'read', claims = {}, user = authUser) => base.auth(async () => (await db.query<{ value: unknown }>('select public.authorize_logo_directions_storage($1,$2,$3,$4) value', [job.id, job.leaseToken, r?.id ?? null, mode])).rows[0]!.value, claims, user);
  const http = { auth: 0, rpc: 0, gets: 0, writes: 0, paths: [] as string[] };
  function authConfiguration() {
    const claims = { sub: authUser, session_id: sessionId, role: 'authenticated', aud: 'authenticated', iss: 'https://fricsfwqibyhemknqgyf.supabase.co/auth/v1', exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: false };
    const accessToken = `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic_signature`;
    return { ownerId: OWNER_A, authUserId: authUser, workerRoleName: workerRole, workerRoleOid: oid, workerId, publishableKey: 'sb_publishable_synthetic', accessToken, capability };
  }
  function transport(hooks: { beforeGet?: (path: string) => Promise<void>; afterGet?: (path: string) => Promise<void> } = {}): typeof fetch {
    return async (input, init = {}) => {
      const url = String(input), origin = 'https://fricsfwqibyhemknqgyf.supabase.co';
      if (!url.startsWith(`${origin}/`)) throw Error('Unexpected fixture HTTP origin');
      if (url === `${origin}/auth/v1/user` && (init.method ?? 'GET') === 'GET') { http.auth++; return Response.json({ id: authUser, is_anonymous: false }); }
      if (url === `${origin}/rest/v1/rpc/authorize_logo_directions_storage` && init.method === 'POST') {
        http.rpc++; const b = JSON.parse(String(init.body));
        try { return Response.json(await base.auth(async () => (await db.query<{ value: unknown }>('select public.authorize_logo_directions_storage($1,$2,$3,$4) value', [b.p_job, b.p_lease, b.p_reservation, b.p_mode])).rows[0]!.value)); }
        catch (error) { return Response.json({ code: (error as { code?: string }).code ?? '42501' }, { status: 403 }); }
      }
      const prefix = `${origin}/storage/v1/object/fluid-assets/`;
      if (!url.startsWith(prefix)) throw Error('Unexpected fixture HTTP target');
      if ((init.method ?? 'GET') !== 'GET') { http.writes++; throw Error('Directions attempted Storage write'); }
      const path = url.slice(prefix.length); http.gets++; http.paths.push(path); await hooks.beforeGet?.(path);
      const visible = await base.object('object.get_authenticated', () => db.query('select name from storage.objects where bucket_id=$1 and name=$2', ['fluid-assets', path]));
      const blob = base.blobs.get(path);
      if (!visible.rows.length || !blob) return new Response(null, { status: 404 });
      const bytes = Uint8Array.from(blob.bytes); await hooks.afterGet?.(path);
      return new Response(bytes, { headers: { 'content-type': blob.mimeType, 'content-length': String(bytes.byteLength) } });
    };
  }
  return { ...base, policy, policyIdentity, capability, manifest, refreshReadiness, owned, ownerAuth, sourceAssets, workspace, reservation, importFont, prepareDirections, enable, authorize, authConfiguration, transport, http };
}
