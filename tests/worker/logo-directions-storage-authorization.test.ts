import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoDirectionsStorageAuthorization, qualifiedLogoDirectionsStorageCapability } from '../../worker/logo-directions-storage-authorization';
import type { IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import { canonicalLogoDocumentBytes } from '../../src/features/logo-vector/model/canonical';
import { separatedLogoDocument } from '../features/logo-vector/fixtures';
import { fontBytes } from '../features/identity-directions/fixtures';
import { subscriptionFixture } from '../features/identity-directions/subscription-fixtures';
const ORIGIN = 'https://fricsfwqibyhemknqgyf.supabase.co', uuid = randomUUID;
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** Synthetic Auth/SQL transport only; real canonical document and font bytes. */
function fixture(font = false) {
  const f = subscriptionFixture(), job = structuredClone(f.job), authUserId = uuid(), sessionId = uuid();
  const capability = { operation: 'identity.logo_directions', policyIdentity: 'b'.repeat(64), handlerVersion: f.policy.handlerVersion, provider: 'openai', model: f.policy.model, engine: null, maxCostMicrousd: 0, billingMode: 'chatgpt_subscription', policy: f.policy };
  const bytes = font ? fontBytes() : canonicalLogoDocumentBytes(separatedLogoDocument());
  const reference = font ? f.input.permittedFonts[0]!.asset : { ownerId: job.ownerId, projectId: job.projectId, assetId: uuid(), versionId: uuid(), contentHash: digest(bytes) };
  const row: IdentityAssetReservation = { id: uuid(), requestKey: uuid(), reference, storagePath: `${reference.ownerId}/${reference.projectId}/${reference.assetId}/${reference.versionId}`, mimeType: font ? 'font/ttf' : 'application/json', byteLength: bytes.length, purpose: 'brand_asset', sourceReceiptId: uuid(), rightsEvidenceId: font ? f.input.permittedFonts[0]!.rights.id : null, publicationState: 'committed' };
  const context = { ownerId: job.ownerId, authUserId, sessionId, workerRoleName: 'fluid_logo_worker_directions_fixture', workerRoleOid: 12345, workerId: 'synthetic-directions' };
  const claims = { sub: authUserId, session_id: sessionId, role: 'authenticated', aud: 'authenticated', iss: `${ORIGIN}/auth/v1`, exp: 2_000_000_000, is_anonymous: false };
  const token = (value = claims) => `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify(value)).toString('base64url')}.synthetic_signature`;
  const configuration = { ownerId: job.ownerId, authUserId, workerRoleName: context.workerRoleName, workerRoleOid: context.workerRoleOid, workerId: context.workerId, publishableKey: 'sb_publishable_synthetic', accessToken: token(), capability };
  const member = font ? { kind: 'font', font: f.input.permittedFonts[0] } : { kind: 'logo-document' };
  const requests: { url: string; init: RequestInit }[] = [];
  const state = { live: true, now: 1_900_000_000_000, bytes, mime: row.mimeType, auth: { id: authUserId, is_anonymous: false } as unknown,
    alter: (v: object): unknown => v, afterGet: undefined as undefined | (() => void), response: undefined as undefined | Response, rpcBody: undefined as undefined | string, rpcLost: false };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input); requests.push({ url, init });
    if (state.response) return state.response;
    if (url.endsWith('/auth/v1/user')) return Response.json(state.auth);
    if (url.endsWith('/rpc/authorize_logo_directions_storage')) {
      if (state.rpcLost) throw Error('synthetic acknowledgement lost');
      if (!state.live) return Response.json({}, { status: 403 });
      if (state.rpcBody) return new Response(state.rpcBody);
      const mode = JSON.parse(String(init.body)).p_mode;
      return Response.json(state.alter({ ...context, capability, jobId: job.id, leaseToken: job.leaseToken, inputRevision: job.inputRevision, jobInput: job.input, mode, reservation: mode === 'probe' ? null : row, member: mode === 'probe' ? null : member }));
    }
    expect(url).toBe(`${ORIGIN}/storage/v1/object/fluid-assets/${row.storagePath}`); expect(init.method).toBe('GET');
    const response = new Response(new Uint8Array(state.bytes), { headers: { 'content-type': state.mime } }); state.afterGet?.(); return response;
  };
  const authorization = createLogoDirectionsStorageAuthorization(configuration, { fetch: fetcher, now: () => state.now })!;
  return { ...f, job, capability, configuration, claims, token, row, bytes, context, member, requests, state, fetcher, authorization, scope: { job, reservation: row } };
}

describe('directions-only bounded Storage broker', () => {
  it('constructs without I/O only for exact subscription capability and dedicated injection', () => {
    const f = fixture(); expect(f.authorization).not.toBeNull(); expect(f.requests).toEqual([]);
    expect(createLogoDirectionsStorageAuthorization()).toBeNull();
    for (const configuration of [{}, { ...f.configuration, authUserId: f.job.ownerId }, { ...f.configuration, accessToken: f.token({ ...f.claims, is_anonymous: true }) }, { ...f.configuration, workerRoleName: 'postgres' }]) expect(createLogoDirectionsStorageAuthorization(configuration)).toBeNull();
    for (const patch of [{ operation: 'identity.logo_export' }, { provider: null }, { model: 'different' }, { billingMode: undefined, policy: undefined }, { maxCostMicrousd: 1 }, { engine: {} }, { policy: { ...f.policy, apiCharge: 'unknown' } }]) expect(qualifiedLogoDirectionsStorageCapability({ ...f.capability, ...patch })).toBeNull();
    expect(Object.isFrozen(f.authorization.capability.policy?.limits)).toBe(true);
  });
  it.each([false, true])('GET-only read validates real bytes (font=%s) and reauthorizes before/after GET', async font => {
    const f = fixture(font); await f.authorization.assertAvailable(f.job); const reader = await f.authorization.authorizeRead(f.scope);
    expect(Object.keys(reader)).toEqual(['read']); expect(await reader.read()).toEqual({ bytes: f.bytes, mimeType: f.row.mimeType });
    expect(f.requests.filter(r => r.url.includes('/storage/'))).toHaveLength(1);
    const last = f.requests.slice(-3); expect(last.map(r => r.url.split('/').at(-1))).toEqual(['authorize_logo_directions_storage', f.row.reference.versionId, 'authorize_logo_directions_storage']);
    for (const r of f.requests) expect({ method: r.init.method, redirect: r.init.redirect, credentials: r.init.credentials, cache: r.init.cache }).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(JSON.parse(String(last[0]!.init.body))).toEqual({ p_job: f.job.id, p_lease: f.job.leaseToken, p_reservation: f.row.id, p_mode: 'read' });
  });
  it.each(['ownerId', 'authUserId', 'sessionId', 'workerRoleName', 'workerRoleOid', 'workerId', 'jobId', 'leaseToken', 'inputRevision', 'jobInput', 'capability', 'reservation', 'mode', 'member'])('rejects authoritative %s disagreement before GET', async key => {
    const f = fixture(); f.state.alter = value => ({ ...value, [key]: 'wrong' });
    await expect(f.authorization.authorizeRead(f.scope)).rejects.toThrow(); expect(f.requests.some(r => r.url.includes('/storage/'))).toBe(false);
  });
  it('denies wrong scope, API route, empty frozen font set, staged input, foreign path and wrong MIME without I/O', async () => {
    const f = fixture();
    for (const patch of [{ ownerId: uuid() }, { projectId: uuid() }, { status: 'cancel_requested' }, { operation: 'identity.logo_concept' }, { reservedCostMicrousd: 1 }, { actualCostMicrousd: 1 }, { leaseToken: 'bad' }, { inputRevision: 0 }, { input: { ...f.job.input as object, fontVersionIds: [] } }, { input: { ...f.job.input as object, billingMode: undefined, policy: undefined } }, { input: { ...f.job.input as object, policyIdentity: 'c'.repeat(64) } }]) await expect(f.authorization.authorizeRead({ ...f.scope, job: { ...f.job, ...patch } as typeof f.job })).rejects.toThrow();
    for (const patch of [{ publicationState: 'staged' }, { storagePath: f.row.storagePath + '/extra' }, { mimeType: 'image/svg+xml' }, { purpose: 'reference_media' }]) await expect(f.authorization.authorizeRead({ ...f.scope, reservation: { ...f.row, ...patch } as IdentityAssetReservation })).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });
  it('binds exact font membership, rights and authoritative family', async () => {
    for (const patch of [{ id: uuid() }, { asset: { ...fixture(true).row.reference, versionId: uuid() } }, { source: 'user_upload' }, { rights: { ...fixture(true).input.permittedFonts[0]!.rights, reviewedAt: null } }, { rights: { ...fixture(true).input.permittedFonts[0]!.rights, permissions: { render: 'unknown', outline: 'unknown', embed: 'unknown', modify: 'unknown', redistribute: 'unknown' } } }]) {
      const f = fixture(true); f.state.alter = value => ({ ...value, member: { kind: 'font', font: { ...f.input.permittedFonts[0], ...patch } } });
      await expect(f.authorization.authorizeRead(f.scope)).rejects.toThrow(); expect(f.requests.some(r => r.url.includes('/storage/'))).toBe(false);
    }
    const f = fixture(true); f.state.alter = value => ({ ...value, member: { kind: 'font', font: { ...f.input.permittedFonts[0], family: 'False family' } } });
    const read = await f.authorization.authorizeRead(f.scope); await expect(read.read()).rejects.toThrow();
  });
  it('snapshots caller inputs and compares subsequent authoritative member without a mutable registry', async () => {
    const f = fixture(), reader = await f.authorization.authorizeRead(f.scope), original = structuredClone({ ...f.context, capability: f.capability, jobId: f.job.id, leaseToken: f.job.leaseToken, inputRevision: 1, jobInput: f.job.input, mode: 'read', reservation: f.row, member: f.member });
    f.state.alter = () => original; (f.job.input as Record<string, unknown>).inputHash = 'f'.repeat(64); f.row.requestKey = uuid();
    expect((await reader.read()).bytes).toEqual(f.bytes);
    f.state.alter = () => ({ ...original, member: { kind: 'font', font: f.input.permittedFonts[0] } }); await expect(reader.read()).rejects.toThrow();
  });
  it('denies changed Auth, lease loss during GET and expiration/close of issued readers', async () => {
    for (const auth of [{ id: uuid(), is_anonymous: false }, { id: fixture().context.authUserId, is_anonymous: true }]) { const f = fixture(); f.state.auth = auth; await expect(f.authorization.authorizeRead(f.scope)).rejects.toThrow(); }
    const f = fixture(), reader = await f.authorization.authorizeRead(f.scope); f.state.afterGet = () => { f.state.live = false; }; await expect(reader.read()).rejects.toThrow();
    for (const stop of [(f: ReturnType<typeof fixture>) => { f.state.now = 2_000_000_000_000; }, (f: ReturnType<typeof fixture>) => f.authorization.close()]) { const f = fixture(), r = await f.authorization.authorizeRead(f.scope); stop(f); const n = f.requests.length; await expect(r.read()).rejects.toThrow(); expect(f.requests).toHaveLength(n); }
  });
  it('rejects byte length/hash/MIME mismatch, invalid canonical geometry and corrupt font bytes', async () => {
    for (const mutation of [(f: ReturnType<typeof fixture>) => { f.state.bytes = new Uint8Array([1]); }, (f: ReturnType<typeof fixture>) => { f.state.bytes = new Uint8Array(f.bytes.length); }, (f: ReturnType<typeof fixture>) => { f.state.mime = 'text/plain'; }]) { const f = fixture(), r = await f.authorization.authorizeRead(f.scope); mutation(f); await expect(r.read()).rejects.toThrow(); }
    for (const font of [false, true]) { const f = fixture(font); f.state.bytes = new TextEncoder().encode(font ? 'not a valid font' : '{}'); f.row.byteLength = f.state.bytes.length; f.row.reference.contentHash = digest(f.state.bytes); if (font) { f.input.permittedFonts[0]!.rights.fontContentHash = f.row.reference.contentHash; }
      const reader = await f.authorization.authorizeRead(f.scope); await expect(reader.read()).rejects.toThrow(); }
  });
  it('stream-bounds authorization responses, permits bounded >16KiB input and never retries ambiguous RPC', async () => {
    const f = fixture(); f.state.rpcBody = ' '.repeat(20_000) + JSON.stringify({ ...f.context, capability: f.capability, jobId: f.job.id, leaseToken: f.job.leaseToken, inputRevision: 1, jobInput: f.job.input, mode: 'probe', reservation: null, member: null });
    await expect(f.authorization.assertAvailable(f.job)).resolves.toBeUndefined();
    f.state.rpcBody = ' '.repeat(81_921); await expect(f.authorization.assertAvailable(f.job)).rejects.toThrow();
    f.state.rpcBody = undefined; f.state.rpcLost = true; const n = f.requests.length; await expect(f.authorization.assertAvailable(f.job)).rejects.toThrow(); expect(f.requests.slice(n).filter(r => r.url.includes('/rpc/'))).toHaveLength(1);
  });
  it('denies redirect, cancellation and ignored-abort transports within bounded lifetime', async () => {
    const f = fixture(); f.state.response = new Response(null, { status: 302, headers: { location: 'https://example.test/' } }); await expect(f.authorization.assertAvailable(f.job)).rejects.toThrow();
    const c = new AbortController(), good = fixture(), reader = await good.authorization.authorizeRead(good.scope, c.signal); c.abort(); const n = good.requests.length; await expect(reader.read()).rejects.toThrow(); expect(good.requests).toHaveLength(n);
    const blocked = createLogoDirectionsStorageAuthorization(f.configuration, { fetch: async () => new Promise<Response>(() => {}), now: () => f.state.now })!;
    const pending = blocked.assertAvailable(f.job); await Promise.resolve(); blocked.close(); await expect(pending).rejects.toEqual(new Error('Logo directions Storage is unavailable.'));
  });
  it('times out an ignored-abort transport without exposing credentials', async () => {
    vi.useFakeTimers(); try {
      const f = fixture(), broker = createLogoDirectionsStorageAuthorization(f.configuration, { fetch: async () => new Promise<Response>(() => {}), now: () => f.state.now })!;
      const failure = expect(broker.assertAvailable(f.job)).rejects.toEqual(new Error('Logo directions Storage is unavailable.'));
      await vi.advanceTimersByTimeAsync(10_001); await failure; broker.close();
    } finally { vi.useRealTimers(); }
  });

});
