import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import type { ClaimedJob } from '../../src/domain/jobs';
import type { IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import type { IdentityAssetPublication } from '../../src/domain/logo-deliverables';
import { syntheticConversionInput } from '../features/logo-vector/raster-fixtures';
import { syntheticLogoJob, syntheticResolvedLogoConcept } from '../fixtures/logo-creation';
import { IMAGE_INPUT_LIMITS } from '../../src/server/logo-creation/openai-image-transport';
import * as broker from '../../worker/logo-generative-storage-authorization';
const uuid = randomUUID, hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ORIGIN = 'https://fricsfwqibyhemknqgyf.supabase.co', authUser = uuid(), sessionId = uuid();
const base = syntheticResolvedLogoConcept(), owner = base.input.ownerId, project = base.input.projectId;
const concept = { operation: 'identity.logo_concept', policyIdentity: base.input.policyIdentity, handlerVersion: 'logo-image-v1', provider: 'openai', model: 'gpt-image-2.5-sunburst-2026-09-08', engine: null, maxCostMicrousd: 100_000 };
const refine = { ...concept, operation: 'identity.logo_refine' };
const claims = { sub: authUser, session_id: sessionId, role: 'authenticated', aud: 'authenticated', iss: `${ORIGIN}/auth/v1`, exp: 2_000_000_000, is_anonymous: false };
const token = (c = claims) => `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify(c)).toString('base64url')}.synthetic_signature`;
const config = { ownerId: owner, authUserId: authUser, workerRoleName: 'fluid_logo_worker_generative_fixture', workerRoleOid: 12345, workerId: 'fixture', publishableKey: 'sb_publishable_synthetic', accessToken: token(), capability: concept };
const context = { ownerId: owner, authUserId: authUser, sessionId, workerRoleName: config.workerRoleName, workerRoleOid: config.workerRoleOid, workerId: config.workerId };
function setup(options: { refinement?: boolean; bytes?: Uint8Array; mime?: string; read?: boolean; base?: boolean; configuration?: unknown; fetch?: typeof fetch } = {}) {
  const cap = options.refinement ? refine : concept;
  const input = options.refinement ? { version: 2, ownerId: owner, projectId: project, requestKey: uuid(), quoteId: uuid(), policyIdentity: cap.policyIdentity, handlerVersion: cap.handlerVersion, inputHash: 'b'.repeat(64), operation: cap.operation,
    rasterRevisionId: uuid(), instruction: 'Simplify the silhouette', briefRevisionId: base.input.briefRevisionId, referenceSnapshotId: base.input.referenceSnapshotId,
    source: { kind: 'preview', raster: { kind: 'refinement', rasterRevisionId: uuid() } } } : structuredClone(base.input);
  const job: ClaimedJob = { ...syntheticLogoJob(), id: uuid(), leaseToken: uuid(), input, operation: cap.operation as ClaimedJob['operation'], reservedCostMicrousd: 1000, actualCostMicrousd: 0 };
  const sourceId = 'attemptId' in input ? input.attemptId! : input.rasterRevisionId;
  const bytes = options.bytes ?? syntheticConversionInput('mascot').source.bytes;
  const reference = { ownerId: owner, projectId: project, assetId: uuid(), versionId: uuid(), contentHash: hash(bytes) };
  const row: IdentityAssetReservation = { id: uuid(), requestKey: options.read ? uuid() : sourceId, reference, storagePath: `${owner}/${project}/${reference.assetId}/${reference.versionId}`,
    mimeType: options.mime ?? 'image/png', byteLength: bytes.length, purpose: options.read && !options.base ? 'reference_media' : 'brand_asset', sourceReceiptId: options.read ? uuid() : sourceId,
    rightsEvidenceId: options.read && !options.base ? uuid() : null, publicationState: options.read ? 'committed' : 'staged' };
  if (!options.refinement && options.read) (job.input as typeof base.input).references = [reference];
  const publication: IdentityAssetPublication = { requestKey: row.requestKey, contentHash: reference.contentHash, mimeType: row.mimeType, byteLength: row.byteLength, inputRevisions: base.inputRevisions, source: { kind: 'concept', sourceId } };
  const scope = { job, reservation: row }, write = { ...scope, publication };
  const state = { live: true, corrupt: false, mime: row.mimeType, afterIO: undefined as undefined | (() => void), grant: (value: object) => value as unknown,
    auth: { id: authUser, is_anonymous: false } as unknown, failPost: false, now: 1_900_000_000_000, response: undefined as undefined | ((url: string, init: RequestInit) => Response | Promise<Response>) };
  const requests: { url: string; init: RequestInit }[] = [], blobs = new Map<string, Uint8Array>();
  if (options.read) blobs.set(row.storagePath, new Uint8Array(bytes));
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input); requests.push({ url, init });
    if (state.response) return state.response(url, init);
    if (url.endsWith('/auth/v1/user')) return Response.json(state.auth);
    if (url.endsWith('/rpc/authorize_logo_generative_storage')) {
      if (!state.live) return Response.json({ code: '42501' }, { status: 403 }); const body = JSON.parse(String(init.body));
      return Response.json(state.grant({ ...context, capability: cap, jobId: job.id, leaseToken: job.leaseToken, inputRevision: job.inputRevision, jobInput: job.input, mode: body.p_mode,
        member: body.p_mode === 'probe' ? null : body.p_mode === 'write' ? 'output' : options.base ? 'base' : 'reference', reservation: body.p_mode === 'probe' ? null : row, publication: body.p_mode === 'write' ? publication : null }));
    }
    const path = url.split('/fluid-assets/')[1]!;
    if (init.method === 'POST') {
      if (blobs.has(path)) return Response.json({ code: 'ResourceAlreadyExists' }, { status: 409 });
      blobs.set(path, new Uint8Array(init.body as Uint8Array)); state.afterIO?.(); if (state.failPost) throw Error('Synthetic acknowledgement lost');
      return Response.json({ Id: uuid(), Key: `fluid-assets/${path}` });
    }
    state.afterIO?.(); return new Response(new Uint8Array(state.corrupt ? [1, 2, 3] : blobs.get(path)!), { headers: { 'content-type': state.mime } });
  };
  const authorization = broker.createLogoGenerativeStorageAuthorization(options.configuration ?? { ...config, capability: cap }, { fetch: options.fetch ?? fetcher, now: () => state.now });
  return { authorization, job, cap, bytes, row, scope, write, state, requests, blobs };
}

describe('generative Storage broker with synthetic transport', () => {
  it('is absent by default and qualifies exactly one reviewed raster image operation', () => {
    expect(broker.createLogoGenerativeStorageAuthorization()).toBeNull();
    for (const configuration of [null, {}, { ...config, capability: undefined }, { ...config, capability: { ...concept, engine: {} } }, { ...config, capability: { ...concept, provider: null, model: null } },
      { ...config, capability: { ...concept, model: 'other' } }, { ...config, capability: { ...concept, operation: 'identity.logo_directions' } }, { ...config, workerRoleName: 'fixture_subscription_worker_a' },
      { ...config, authUserId: owner }, { ...config, accessToken: token({ ...claims, is_anonymous: true }) }]) expect(broker.createLogoGenerativeStorageAuthorization(configuration)).toBeNull();
    const f = setup({ read: true }); expect(f.authorization).not.toBeNull(); expect(f.requests).toEqual([]);
  });
  it('rejects zero-cost image descriptors consistently with runtime qualification', () => {
    for (const capability of [concept, refine]) expect(broker.createLogoGenerativeStorageAuthorization({ ...config, capability: { ...capability, maxCostMicrousd: 0 } })).toBeNull();
  });
  it.each([false, true])('reads exact frozen references using fixed-origin GET only (refinement=%s)', async refinement => {
    const f = setup({ read: true, refinement }); await f.authorization!.assertAvailable(f.job); const reader = await f.authorization!.authorizeRead(f.scope);
    expect(reader).not.toHaveProperty('putIfAbsent'); expect(await reader.read()).toEqual({ bytes: f.bytes, mimeType: 'image/png' });
    expect(f.authorization).not.toHaveProperty('authorizeReadback');
    const io = f.requests.filter(r => r.url.includes('/storage/')); expect(io).toHaveLength(1); expect(io[0]!.url).toBe(`${ORIGIN}/storage/v1/object/fluid-assets/${f.row.storagePath}`); expect(io[0]!.init.method).toBe('GET');
    expect(f.requests.at(-1)!.url.endsWith('/rpc/authorize_logo_generative_storage')).toBe(true);
    for (const r of f.requests) expect({ redirect: r.init.redirect, cache: r.init.cache, credentials: r.init.credentials }).toEqual({ redirect: 'error', cache: 'no-store', credentials: 'omit' });
    const request = JSON.parse(String(f.requests.find(r => r.url.endsWith('/rpc/authorize_logo_generative_storage') && String(r.init.body).includes('"read"'))!.init.body));
    expect(request).toEqual({ p_job: f.job.id, p_lease: f.job.leaseToken, p_reservation: f.row.id, p_mode: 'read' });
  });
  it('allows only refinement bases and binds read membership to purpose and rights', async () => {
    const f = setup({ read: true, refinement: true, base: true }); expect((await (await f.authorization!.authorizeRead(f.scope)).read()).bytes).toEqual(f.bytes);
    for (const delta of [{ purpose: 'input_attachment' }, { rightsEvidenceId: uuid() }]) await expect(f.authorization!.authorizeRead({ ...f.scope, reservation: { ...f.row, ...delta } as IdentityAssetReservation })).rejects.toThrow();
    const g = setup({ read: true, base: true }); await expect(g.authorization!.authorizeRead(g.scope)).rejects.toThrow(); expect(g.requests).toEqual([]);
  });
  it.each([false, true])('creates PNG only at admitted source/request identity and reuses the exact write grant for GET (refinement=%s)', async refinement => {
    const f = setup({ refinement }); const writer = await f.authorization!.authorizeWrite(f.write); await writer.putIfAbsent(f.bytes, 'image/png'); expect(await writer.read()).toEqual({ bytes: f.bytes, mimeType: 'image/png' });
    expect(new Headers(f.requests.find(r => r.url.includes('/storage/') && r.init.method === 'POST')!.init.headers).get('x-upsert')).toBe('false'); expect(f.blobs.size).toBe(1);
    expect(f.requests.filter(r => r.url.includes('/rpc/')).every(r => JSON.parse(String(r.init.body)).p_mode === 'write')).toBe(true);
    await expect(f.authorization!.authorizeRead(f.scope)).rejects.toThrow();
  });
  it('denies arbitrary output source/request IDs, excessive output, and malformed PNG before byte I/O', async () => {
    for (const field of ['requestKey', 'sourceReceiptId'] as const) { const f = setup(); f.row[field] = uuid(); await expect(f.authorization!.authorizeWrite(f.write)).rejects.toThrow(); expect(f.requests).toEqual([]); }
    const f = setup(); f.write.publication.source.sourceId = uuid(); await expect(f.authorization!.authorizeWrite(f.write)).rejects.toThrow(); expect(f.requests).toEqual([]);
    const g = setup(); g.row.byteLength = IMAGE_INPUT_LIMITS.outputBytes + 1; g.write.publication.byteLength = g.row.byteLength; await expect(g.authorization!.authorizeWrite(g.write)).rejects.toThrow(); expect(g.requests).toEqual([]);
    for (const mime of ['image/jpeg', 'image/webp', 'image/svg+xml']) { const h = setup({ mime }); await expect(h.authorization!.authorizeWrite(h.write)).rejects.toThrow(); expect(h.requests).toEqual([]); }
    const invalid = setup({ bytes: new Uint8Array([1, 2, 3]) }), w = await invalid.authorization!.authorizeWrite(invalid.write); await expect(w.putIfAbsent(invalid.bytes, 'image/png')).rejects.toThrow(); expect(invalid.blobs.size).toBe(0);
  });
  it('rejects owner, project, operation, cost, vector source and path before network', async () => {
    const f = setup({ read: true });
    for (const delta of [{ ownerId: authUser }, { projectId: uuid() }, { operation: 'identity.logo_directions' }, { leaseToken: 'bad' }, { status: 'cancel_requested' }, { actualCostMicrousd: -1 }, { reservedCostMicrousd: concept.maxCostMicrousd + 1 }, { input: { ...f.job.input as object, policyIdentity: 'f'.repeat(64) } }, { input: { ...f.job.input as object, handlerVersion: 'wrong' } }])
      await expect(f.authorization!.authorizeRead({ ...f.scope, job: { ...f.job, ...delta } as ClaimedJob })).rejects.toThrow();
    await expect(f.authorization!.authorizeRead({ ...f.scope, reservation: { ...f.row, storagePath: f.row.storagePath + '/extra' } })).rejects.toThrow();
    const g = setup({ refinement: true, read: true }); (g.job.input as Record<string, unknown>).source = { kind: 'vector', vectorRevisionId: uuid() }; await expect(g.authorization!.authorizeRead(g.scope)).rejects.toThrow();
    expect(f.requests).toEqual([]); expect(g.requests).toEqual([]);
  });
  it.each(['ownerId', 'authUserId', 'sessionId', 'workerRoleName', 'workerRoleOid', 'workerId', 'jobId', 'leaseToken', 'inputRevision', 'jobInput', 'capability', 'reservation', 'mode', 'publication', 'member'])('rejects authoritative %s mismatch', async field => {
    const f = setup({ read: true }); f.state.grant = value => ({ ...value, [field]: 'wrong' }); await expect(f.authorization!.authorizeRead(f.scope)).rejects.toThrow(); expect(f.requests.some(r => r.url.includes('/storage/'))).toBe(false);
  });
  it('rejects anonymous/foreign Auth and grant loss after GET or POST started', async () => {
    for (const auth of [{ id: authUser, is_anonymous: true }, { id: owner, is_anonymous: false }]) { const f = setup({ read: true }); f.state.auth = auth; await expect(f.authorization!.authorizeRead(f.scope)).rejects.toThrow(); expect(f.requests).toHaveLength(1); }
    const f = setup({ read: true }), reader = await f.authorization!.authorizeRead(f.scope); f.state.afterIO = () => { f.state.live = false; }; await expect(reader.read()).rejects.toThrow();
    const g = setup(), writer = await g.authorization!.authorizeWrite(g.write); g.state.afterIO = () => { g.state.live = false; }; await expect(writer.putIfAbsent(g.bytes, 'image/png')).rejects.toThrow(); expect(g.blobs.size).toBe(1);
  });
  it('snapshots exact reservation and input against caller mutation', async () => {
    const f = setup({ read: true }), path = f.row.storagePath, reader = await f.authorization!.authorizeRead(f.scope);
    const authoritative = { ...context, capability: f.cap, jobId: f.job.id, leaseToken: f.job.leaseToken, inputRevision: f.job.inputRevision, jobInput: structuredClone(f.job.input), mode: 'read', member: 'reference', reservation: structuredClone(f.row), publication: null };
    f.state.grant = () => authoritative; f.row.storagePath = 'different'; (f.job.input as Record<string, unknown>).inputHash = 'f'.repeat(64);
    expect((await reader.read()).bytes).toEqual(f.bytes); expect(f.requests.filter(r => r.url.includes('/storage/')).every(r => r.url.endsWith(path))).toBe(true);
  });
  it('snapshots output bytes and publication before async validation', async () => {
    const f = setup(), writer = await f.authorization!.authorizeWrite(f.write), bytes = new Uint8Array(f.bytes), expected = new Uint8Array(bytes), pending = writer.putIfAbsent(bytes, 'image/png'); bytes.fill(0);
    await pending; expect(f.blobs.get(f.row.storagePath)).toEqual(expected);
  });
  it('does not retry ambiguous POST or let expiry/close revive capabilities', async () => {
    const f = setup(), writer = await f.authorization!.authorizeWrite(f.write); f.state.failPost = true; await expect(writer.putIfAbsent(f.bytes, 'image/png')).rejects.toThrow(); expect(f.blobs.size).toBe(1); expect(f.requests.filter(r => r.url.includes('/storage/') && r.init.method === 'POST')).toHaveLength(1);
    f.authorization!.close(); const n = f.requests.length; await expect(writer.read()).rejects.toThrow(); expect(f.requests).toHaveLength(n);
    const g = setup({ read: true }), reader = await g.authorization!.authorizeRead(g.scope); g.state.now = 2_000_000_000_000; const before = g.requests.length; await expect(reader.read()).rejects.toThrow(); expect(g.requests).toHaveLength(before);
  });
  it('denies corruption, response MIME changes and retained caller cancellation', async () => {
    const f = setup({ read: true }), controller = new AbortController(), reader = await f.authorization!.authorizeRead(f.scope, controller.signal);
    f.state.corrupt = true; await expect(reader.read()).rejects.toThrow(); f.state.corrupt = false; f.state.mime = 'image/jpeg'; await expect(reader.read()).rejects.toThrow(); controller.abort(); const n = f.requests.length; await expect(reader.read()).rejects.toThrow(); expect(f.requests).toHaveLength(n);
  });
  it('accepts admitted concept job shapes beyond the old 16KiB grant ceiling', async () => {
    const f = setup({ read: true }); const refs = [f.row.reference, ...Array.from({ length: 99 }, () => ({ ...f.row.reference, assetId: uuid(), versionId: uuid() }))];
    (f.job.input as typeof base.input).references = refs; expect(JSON.stringify(f.job.input).length).toBeGreaterThan(16_384); expect(JSON.stringify(f.job.input).length).toBeLessThan(32_768);
    expect((await (await f.authorization!.authorizeRead(f.scope)).read()).bytes).toEqual(f.bytes);
  });
  it('bounds auth/grant response streaming, content-length and encoding', async () => {
    for (const headers of [new Headers({ 'content-length': '16385' }), new Headers({ 'content-encoding': 'gzip' })]) { const f = setup({ read: true }); f.state.response = () => new Response('{}', { headers }); await expect(f.authorization!.authorizeRead(f.scope)).rejects.toThrow(); }
    const f = setup({ read: true }); f.state.response = url => url.endsWith('/auth/v1/user') ? Response.json(f.state.auth) : new Response(new Uint8Array(131_073)); await expect(f.authorization!.authorizeRead(f.scope)).rejects.toThrow(); expect(f.requests.some(r => r.url.includes('/storage/'))).toBe(false);
  });
  it('settles timeout and close even if injected transport ignores abort', async () => {
    vi.useFakeTimers(); try {
      const f = setup({ read: true, fetch: async () => new Promise<Response>(() => {}) }), pending = f.authorization!.authorizeRead(f.scope); const rejected = expect(pending).rejects.toEqual(new Error('Logo generative Storage is unavailable.'));
      await vi.advanceTimersByTimeAsync(10_001); await rejected;
      const g = setup({ read: true, fetch: async () => new Promise<Response>(() => {}) }), second = g.authorization!.authorizeRead(g.scope); g.authorization!.close(); await expect(second).rejects.toThrow();
    } finally { vi.useRealTimers(); }
  });
});
