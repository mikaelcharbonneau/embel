import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoProductionStorageAuthorization } from '../../worker/logo-production-storage-authorization';
import type { ClaimedJob } from '../../src/domain/jobs';
import type { IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import type { IdentityAssetPublication } from '../../src/domain/logo-deliverables';
import { LOGO_EXPORT_POLICY_IDENTITY } from '../../worker/handlers/logo-exports';
import { QUALIFIED_VTRACER } from '../../worker/logo-vector/engine';
import { syntheticConversionInput } from '../features/logo-vector/raster-fixtures';
const uuid = randomUUID, hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ORIGIN = 'https://fricsfwqibyhemknqgyf.supabase.co', owner = uuid(), authUser = uuid(), sessionId = uuid(), project = uuid();
const vector = { operation: 'identity.logo_vectorize', policyIdentity: 'a'.repeat(64), handlerVersion: '1', provider: null, model: null, engine: { id: 'vtracer', version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm }, maxCostMicrousd: 0 };
const exports = { operation: 'identity.logo_export', policyIdentity: LOGO_EXPORT_POLICY_IDENTITY, handlerVersion: 'logo-export-v1', provider: null, model: null, engine: null, maxCostMicrousd: 0 };
const claims = { sub: authUser, session_id: sessionId, role: 'authenticated', aud: 'authenticated', iss: `${ORIGIN}/auth/v1`, exp: 2_000_000_000, is_anonymous: false };
const token = (c = claims) => `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify(c)).toString('base64url')}.synthetic_signature`;
const config = { ownerId: owner, authUserId: authUser, workerRoleName: 'fluid_logo_worker_storage_fixture', workerRoleOid: 12345, workerId: 'fixture', publishableKey: 'sb_publishable_synthetic', accessToken: token(), capability: vector };
const context = { ownerId: owner, authUserId: authUser, sessionId, workerRoleName: config.workerRoleName, workerRoleOid: config.workerRoleOid, workerId: config.workerId };
function setup(options: { export?: boolean; bytes?: Uint8Array; mime?: string; read?: boolean; configuration?: unknown; fetch?: typeof fetch } = {}) {
  const cap = options.export ? exports : vector;
  const common = { version: 2, ownerId: owner, projectId: project, requestKey: uuid(), policyIdentity: cap.policyIdentity, handlerVersion: cap.handlerVersion, inputHash: 'b'.repeat(64), operation: cap.operation };
  const job: ClaimedJob = { id: uuid(), ownerId: owner, projectId: project, operation: cap.operation as ClaimedJob['operation'], leaseToken: uuid(), inputRevision: 1, status: 'running', reservedCostMicrousd: 0, actualCostMicrousd: 0,
    input: options.export ? { ...common, approvedLogoId: uuid(), directionApprovalId: uuid(), variantSetId: uuid(), variantReviewId: uuid(), sourceSnapshotHash: 'c'.repeat(64) }
      : { ...common, quoteId: uuid(), source: { kind: 'refinement', rasterRevisionId: uuid() }, settings: syntheticConversionInput('mascot').settings, engine: cap.engine } };
  const bytes = options.bytes ?? syntheticConversionInput('mascot').source.bytes;
  const reference = { ownerId: owner, projectId: project, assetId: uuid(), versionId: uuid(), contentHash: hash(bytes) };
  const row: IdentityAssetReservation = { id: uuid(), requestKey: uuid(), reference, storagePath: `${owner}/${project}/${reference.assetId}/${reference.versionId}`, mimeType: options.mime ?? 'image/png', byteLength: bytes.length, purpose: 'brand_asset', sourceReceiptId: options.read ? uuid() : job.id, rightsEvidenceId: null, publicationState: options.read ? 'committed' : 'staged' };
  const publication: IdentityAssetPublication = { requestKey: row.requestKey, contentHash: reference.contentHash, mimeType: row.mimeType, byteLength: row.byteLength, inputRevisions: [], source: { kind: options.export ? 'export' : 'vector', sourceId: row.sourceReceiptId } };
  const scope = { job, reservation: row }, write = { ...scope, publication };
  const state = { live: true, corrupt: false, mime: row.mimeType, afterIO: undefined as undefined | (() => void), grant: (value: object) => value as unknown,
    auth: { id: authUser, is_anonymous: false } as unknown, failPost: false, now: 1_900_000_000_000 };
  const requests: { url: string; init: RequestInit }[] = [], blobs = new Map<string, Uint8Array>();
  if (options.read) blobs.set(row.storagePath, new Uint8Array(bytes));
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith('/auth/v1/user')) return Response.json(state.auth);
    if (url.endsWith('/rpc/authorize_logo_production_storage')) {
      if (!state.live) return Response.json({ code: '42501' }, { status: 403 }); const body = JSON.parse(String(init.body));
      return Response.json(state.grant({ ...context, capability: cap, jobId: job.id, leaseToken: job.leaseToken, inputRevision: job.inputRevision, jobInput: job.input, mode: body.p_mode, reservation: body.p_mode === 'probe' ? null : row, publication: ['write', 'readback'].includes(body.p_mode) ? publication : null }));
    }
    const path = url.split('/fluid-assets/')[1]!;
    if (init.method === 'POST') {
      if (blobs.has(path)) return Response.json({ code: 'ResourceAlreadyExists' }, { status: 409 });
      blobs.set(path, new Uint8Array(init.body as Uint8Array)); state.afterIO?.(); if (state.failPost) throw Error('Synthetic acknowledgement lost');
      return Response.json({ Id: uuid(), Key: `fluid-assets/${path}` });
    }
    state.afterIO?.(); return new Response(new Uint8Array(state.corrupt ? [1, 2, 3] : blobs.get(path)!), { headers: { 'content-type': state.mime } });
  };
  const authorization = createLogoProductionStorageAuthorization(options.configuration ?? { ...config, capability: cap }, { fetch: options.fetch ?? fetcher, now: () => state.now });
  return { authorization, job, cap, bytes, row, scope, write, state, requests, blobs };
}
const artifact = (name: string, directory = 'logo-vector/runtime-adapter') => readFile(new URL(`../../docs/evidence/${directory}/${name}`, import.meta.url)).then(b => new Uint8Array(b));

describe('operation-specific production Storage authorization with synthetic transport', () => {
  it('stays inactive without an explicitly qualified zero-cost capability', () => {
    for (const configuration of [null, {}, { ...config, capability: undefined }, { ...config, capability: { ...vector, engine: null } }, { ...config, capability: { ...exports, policyIdentity: 'f'.repeat(64) } },
      { ...config, capability: { ...vector, maxCostMicrousd: 1 } }, { ...config, capability: { ...vector, operation: 'identity.logo_concept' } }, { ...config, workerRoleName: 'fixture_subscription_worker_a' },
      { ...config, authUserId: owner }, { ...config, accessToken: token({ ...claims, is_anonymous: true }) }]) expect(createLogoProductionStorageAuthorization(configuration)).toBeNull();
    const f = setup({ read: true }); expect(f.authorization).not.toBeNull(); expect(f.requests).toEqual([]);
  });
  it('grants GET-only exact sources and rechecks after byte I/O without client ownership proofs', async () => {
    const f = setup({ read: true }); await f.authorization!.assertAvailable(f.job); const reader = await f.authorization!.authorizeRead(f.scope);
    expect(reader).not.toHaveProperty('putIfAbsent'); expect(await reader.read()).toEqual({ bytes: f.bytes, mimeType: 'image/png' });
    const io = f.requests.filter(r => r.url.includes('/storage/')); expect(io).toHaveLength(1); expect(io[0]!.url).toBe(`${ORIGIN}/storage/v1/object/fluid-assets/${f.row.storagePath}`); expect(io[0]!.init.method).toBe('GET');
    expect(f.requests.at(-1)!.url.endsWith('/rpc/authorize_logo_production_storage')).toBe(true);
    for (const r of f.requests) expect({ redirect: r.init.redirect, cache: r.init.cache, credentials: r.init.credentials }).toEqual({ redirect: 'error', cache: 'no-store', credentials: 'omit' });
    const request = JSON.parse(String(f.requests.find(r => r.url.endsWith('/rpc/authorize_logo_production_storage') && String(r.init.body).includes('"read"'))!.init.body));
    expect(request).toEqual({ p_job: f.job.id, p_lease: f.job.leaseToken, p_reservation: f.row.id, p_mode: 'read' });
  });
  it.each(['synthetic-converted.svg', 'synthetic-document.json'])('validates vector %s before create-only writes', async name => {
    const bytes = await artifact(name), mime = name.endsWith('.svg') ? 'image/svg+xml' : 'application/json', f = setup({ bytes, mime });
    const writer = await f.authorization!.authorizeWrite(f.write); await writer.putIfAbsent(bytes, mime); expect(await writer.read()).toEqual({ bytes, mimeType: mime });
    expect(new Headers(f.requests.find(r => r.url.includes('/storage/') && r.init.method === 'POST')!.init.headers).get('x-upsert')).toBe('false'); expect(f.blobs.size).toBe(1);
  });
  it.each(['application/pdf', 'application/zip'])('runs real export %s byte validation', async mime => {
    const bytes = await artifact(mime === 'application/pdf' ? 'synthetic-primary-color.pdf' : 'synthetic-logo-pack.zip', 'logo-exports/runtime-adapter');
    const f = setup({ export: true, bytes, mime }), writer = await f.authorization!.authorizeWrite(f.write); await writer.putIfAbsent(bytes, mime); expect((await writer.read()).bytes).toEqual(bytes);
    const bad = setup({ export: true, mime, bytes: new Uint8Array([1, 2, 3]) }), denied = await bad.authorization!.authorizeWrite(bad.write);
    await expect(denied.putIfAbsent(bad.bytes, mime)).rejects.toThrow(); expect(bad.blobs.size).toBe(0);
  });
  it('denies malformed raster, noncanonical JSON, unsafe SVG and wrong operation MIME', async () => {
    for (const [exported, mime, value] of [[false, 'image/png', 'invalid'], [false, 'application/json', '{}'], [false, 'image/svg+xml', '<svg><image href="http://example.test/a"/></svg>'], [true, 'application/json', '{}']] as const) {
      const f = setup({ export: exported, mime, bytes: new TextEncoder().encode(value) }); await expect((async () => { const w = await f.authorization!.authorizeWrite(f.write); await w.putIfAbsent(f.bytes, mime); })()).rejects.toThrow(); expect(f.blobs.size).toBe(0);
    }
  });
  it('rejects owner, project, operation, policy, handler, lease, cost and path before network', async () => {
    const f = setup({ read: true });
    for (const delta of [{ ownerId: authUser }, { projectId: uuid() }, { operation: 'identity.logo_concept' }, { leaseToken: 'bad' }, { status: 'cancel_requested' }, { actualCostMicrousd: 1 }, { reservedCostMicrousd: 1 }, { input: { ...f.job.input as object, policyIdentity: 'f'.repeat(64) } }, { input: { ...f.job.input as object, handlerVersion: 'wrong' } }])
      await expect(f.authorization!.authorizeRead({ ...f.scope, job: { ...f.job, ...delta } as ClaimedJob })).rejects.toThrow();
    await expect(f.authorization!.authorizeRead({ ...f.scope, reservation: { ...f.row, storagePath: f.row.storagePath + '/extra' } })).rejects.toThrow(); expect(f.requests).toEqual([]);
  });
  it.each(['sessionId', 'workerId', 'jobId', 'leaseToken', 'inputRevision', 'jobInput', 'capability', 'reservation', 'mode', 'publication'])('rejects authoritative %s mismatch', async field => {
    const f = setup({ read: true }); f.state.grant = value => ({ ...value, [field]: 'wrong' }); await expect(f.authorization!.authorizeRead(f.scope)).rejects.toThrow(); expect(f.requests.some(r => r.url.includes('/storage/'))).toBe(false);
  });
  it('rejects anonymous/foreign Auth and lease loss after GET started', async () => {
    for (const auth of [{ id: authUser, is_anonymous: true }, { id: owner, is_anonymous: false }]) { const f = setup({ read: true }); f.state.auth = auth; await expect(f.authorization!.authorizeRead(f.scope)).rejects.toThrow(); expect(f.requests).toHaveLength(1); }
    const f = setup({ read: true }), reader = await f.authorization!.authorizeRead(f.scope); f.state.afterIO = () => { f.state.live = false; }; await expect(reader.read()).rejects.toThrow();
  });
  it('snapshots exact reservation and frozen input against caller mutation', async () => {
    const f = setup({ read: true }), path = f.row.storagePath, reader = await f.authorization!.authorizeRead(f.scope);
    const authoritative = { ...context, capability: f.cap, jobId: f.job.id, leaseToken: f.job.leaseToken, inputRevision: 1, jobInput: structuredClone(f.job.input), mode: 'read', reservation: structuredClone(f.row), publication: null };
    f.state.grant = () => authoritative; f.row.storagePath = 'different'; (f.job.input as Record<string, unknown>).inputHash = 'f'.repeat(64);
    expect((await reader.read()).bytes).toEqual(f.bytes); expect(f.requests.filter(r => r.url.includes('/storage/')).every(r => r.url.endsWith(path))).toBe(true);
  });
  it('does not retry ambiguous POST and rejects work after close', async () => {
    const bytes = await artifact('synthetic-converted.svg'), f = setup({ bytes, mime: 'image/svg+xml' }), writer = await f.authorization!.authorizeWrite(f.write);
    f.state.failPost = true; await expect(writer.putIfAbsent(bytes, 'image/svg+xml')).rejects.toThrow(); expect(f.blobs.size).toBe(1); expect(f.requests.filter(r => r.url.includes('/storage/') && r.init.method === 'POST')).toHaveLength(1);
    f.authorization!.close(); const n = f.requests.length; await expect(writer.read()).rejects.toThrow(); expect(f.requests).toHaveLength(n);
  });
  it('denies corruption, wrong response MIME and retained caller cancellation', async () => {
    const f = setup({ read: true }), controller = new AbortController(), reader = await f.authorization!.authorizeRead(f.scope, controller.signal);
    f.state.corrupt = true; await expect(reader.read()).rejects.toThrow(); f.state.corrupt = false; f.state.mime = 'image/jpeg'; await expect(reader.read()).rejects.toThrow(); controller.abort(); const n = f.requests.length; await expect(reader.read()).rejects.toThrow(); expect(f.requests).toHaveLength(n);
  });
  it('exposes staged output readback as GET-only with exact immutable publication validation', async () => {
    const bytes = await artifact('synthetic-logo-pack.zip', 'logo-exports/runtime-adapter'), f = setup({export:true,bytes,mime:'application/zip'});
    const writer = await f.authorization!.authorizeWrite(f.write); await writer.putIfAbsent(bytes,'application/zip');
    const reader = await f.authorization!.authorizeReadback(f.scope); expect(reader).not.toHaveProperty('putIfAbsent');
    const before = f.requests.filter(r=>r.url.includes('/storage/')&&r.init.method==='POST').length;
    expect((await reader.read()).bytes).toEqual(bytes); expect(f.requests.filter(r=>r.url.includes('/storage/')&&r.init.method==='POST')).toHaveLength(before);
    await expect(f.authorization!.authorizeRead(f.scope)).rejects.toThrow();
    f.state.grant = value => ({...value,publication:{...f.write.publication,inputRevisions:[{stage:'vector',id:uuid(),revision:1}]}});
    await expect(reader.read()).rejects.toThrow();
  });
  it('denies foreign-job staged readback and committed historical assets before network', async () => {
    const f = setup({export:true,bytes:new Uint8Array([1]),mime:'application/pdf'});
    await expect(f.authorization!.authorizeReadback({...f.scope,reservation:{...f.row,sourceReceiptId:uuid()}})).rejects.toThrow();
    const source = setup({read:true}); await expect(source.authorization!.authorizeReadback(source.scope)).rejects.toThrow();
    expect(f.requests).toEqual([]); expect(source.requests).toEqual([]);
  });
  it('fences expiry and cancels ignored-abort transports without retaining secrets', async () => {
    const f = setup({ read: true }), reader = await f.authorization!.authorizeRead(f.scope); f.state.now = 2_000_000_000_000; const n = f.requests.length; await expect(reader.read()).rejects.toThrow(); expect(f.requests).toHaveLength(n);
    const blocked = setup({ read: true, fetch: async () => new Promise<Response>(() => {}) }), pending = blocked.authorization!.authorizeRead(blocked.scope); await Promise.resolve(); blocked.authorization!.close(); await expect(pending).rejects.toEqual(new Error('Logo production Storage is unavailable.'));
  });
});
