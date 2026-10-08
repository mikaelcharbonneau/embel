import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoStorageAuthorization } from '../../worker/logo-storage-authorization';
import type { IdentityAssetReservation } from '@/server/data/identity-asset-store';

const ORIGIN = 'https://fricsfwqibyhemknqgyf.supabase.co';
const owner = randomUUID(), user = randomUUID(), session = randomUUID(), project = randomUUID();
const bytes = new Uint8Array([1, 2, 3]);
const claims = { sub: user, session_id: session, role: 'authenticated', aud: 'authenticated', iss: `${ORIGIN}/auth/v1`, exp: 2_000_000_000, is_anonymous: false };
const jwt = (c = claims) => `${Buffer.from('{"alg":"ES256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(c)).toString('base64url')}.synthetic_signature`;
const config = { ownerId: owner, authUserId: user, workerRoleName: 'fluid_logo_worker_fixture', workerRoleOid: 12345, workerId: 'fixture', publishableKey: 'sb_publishable_synthetic', accessToken: jwt() };
const context = { ownerId: owner, authUserId: user, sessionId: session, workerRoleName: config.workerRoleName, workerRoleOid: 12345, workerId: 'fixture' };
function reservation(): IdentityAssetReservation {
  const reference = { ownerId: owner, projectId: project, assetId: randomUUID(), versionId: randomUUID(), contentHash: createHash('sha256').update(bytes).digest('hex') };
  return { id: randomUUID(), requestKey: randomUUID(), reference, storagePath: `${owner}/${project}/${reference.assetId}/${reference.versionId}`, mimeType: 'image/png', byteLength: bytes.length, purpose: 'brand_asset', sourceReceiptId: randomUUID(), rightsEvidenceId: null, publicationState: 'staged' };
}
function setup(options: { configuration?: unknown; auth?: unknown; rpc?: unknown; grant?: (value: object) => unknown; body?: Uint8Array; duplicate?: boolean; fetch?: typeof fetch; now?: () => number } = {}) {
  const row = reservation(), scope = { ownerId: owner, projectId: project, jobId: randomUUID(), leaseToken: randomUUID(), reservation: row };
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith('/auth/v1/user')) return Response.json(options.auth ?? { id: user, is_anonymous: false });
    if (url.endsWith('/rpc/logo_storage_session')) return Response.json(options.rpc ?? context);
    if (url.endsWith('/rpc/authorize_logo_storage_reservation')) { const grant = { ...context, jobId: scope.jobId, leaseToken: scope.leaseToken, reservation: row }; return Response.json(options.grant ? options.grant(grant) : grant); }
    if (init.method === 'POST') return options.duplicate ? Response.json({ code: 'ResourceAlreadyExists' }, { status: 409 }) : Response.json({ Id: randomUUID(), Key: url.split('/object/')[1] });
    return new Response(new Uint8Array(options.body ?? bytes), { headers: { 'content-type': 'image/png' } });
  };
  const storage = createLogoStorageAuthorization(options.configuration ?? config, { fetch: options.fetch ?? fetcher, now: options.now ?? (() => 1_900_000_000_000) });
  return { storage, row, scope, requests };
}

describe('dedicated Auth session Storage transport (synthetic network only)', () => {
  it('uses actual fixed-origin Auth/RPC/Storage requests and exact create-only reservation', async () => {
    const { storage, scope, requests, row } = setup(); expect(storage).not.toBeNull();
    await storage!.assertAvailable({ ownerId: owner, operation: 'identity.logo_concept' });
    const capability = await storage!.authorize(scope);
    await capability.putIfAbsent(bytes, 'image/png'); expect(await capability.read()).toEqual({ bytes, mimeType: 'image/png' });
    const upload = requests.find(r => r.url.includes('/storage/') && r.init.method === 'POST')!;
    expect(upload.url).toBe(`${ORIGIN}/storage/v1/object/fluid-assets/${row.storagePath}`);
    expect(new Headers(upload.init.headers).get('x-upsert')).toBe('false');
    expect(new Headers(upload.init.headers).get('authorization')).toBe(`Bearer ${config.accessToken}`);
    expect(requests.every(r => r.init.redirect === 'error' && r.init.credentials === 'omit' && r.init.cache === 'no-store')).toBe(true);
    const grant = requests.find(r => r.url.endsWith('/authorize_logo_storage_reservation'))!;
    expect(JSON.parse(String(grant.init.body))).toEqual({ p_job: scope.jobId, p_lease: scope.leaseToken, p_reservation: row.id });
    expect(JSON.stringify(storage)).not.toContain(config.accessToken);
  });
  it.each([null, {}, { ...config, accessToken: 'service_role' }, { ...config, publishableKey: 'sb_secret_wrong' }, { ...config, authUserId: owner }, { ...config, extra: true }, { ...config, accessToken: jwt({ ...claims, role: 'service_role' }) }, { ...config, accessToken: jwt({ ...claims, is_anonymous: true }) }, { ...config, accessToken: jwt({ ...claims, iss: 'https://other.example/auth/v1' }) }])('has an unavailable default for invalid configuration %#', configuration => {
    expect(createLogoStorageAuthorization(configuration)).toBeNull();
  });
  it.each([{ id: owner, is_anonymous: false }, { id: user, is_anonymous: true }])('rejects Auth identity mismatch %# before grant or bytes', async auth => {
    const { storage, scope, requests } = setup({ auth });
    await expect(storage!.authorize(scope)).rejects.toThrow('Logo Storage is unavailable.');
    expect(requests).toHaveLength(1);
  });
  it.each(['ownerId', 'authUserId', 'sessionId', 'workerRoleName', 'workerRoleOid', 'workerId'])('rejects mismatched authoritative %s', async field => {
    const { storage } = setup({ rpc: { ...context, [field]: field === 'workerRoleOid' ? 54321 : 'different' } });
    await expect(storage!.assertAvailable({ ownerId: owner, operation: 'identity.logo_concept' })).rejects.toThrow('Logo Storage is unavailable.');
  });
  it('rejects wrong paths, scope and malformed reservations before sending', async () => {
    const { storage, scope, requests } = setup();
    for (const changed of [{ ...scope, ownerId: user }, { ...scope, projectId: randomUUID() }, { ...scope, reservation: { ...scope.reservation, storagePath: `${scope.reservation.storagePath}/extra` } }, { ...scope, reservation: { ...scope.reservation, publicationState: 'committed' } }]) {
      await expect(storage!.authorize(changed as typeof scope)).rejects.toThrow('Logo Storage is unavailable.');
    }
    expect(requests).toHaveLength(0);
  });
  it('rejects mutated or wrong input bytes before upload and corrupt duplicate read-back', async () => {
    const { storage, scope, requests } = setup({ duplicate: true, body: new Uint8Array([3, 2, 1]) });
    const capability = await storage!.authorize(scope);
    await expect(capability.putIfAbsent(new Uint8Array([3, 2, 1]), 'image/png')).rejects.toThrow();
    expect(requests.filter(r => r.url.includes('/storage/'))).toHaveLength(0);
    await capability.putIfAbsent(bytes, 'image/png');
    await expect(capability.read()).rejects.toThrow('Logo Storage is unavailable.');
  });
  it('freezes exact capability scope despite caller reservation mutation', async () => {
    const { storage, scope, requests } = setup(); const path = scope.reservation.storagePath;
    const capability = await storage!.authorize(scope); scope.reservation.storagePath = 'different'; scope.reservation.reference.contentHash = 'f'.repeat(64);
    await capability.putIfAbsent(bytes, 'image/png'); expect((await capability.read()).bytes).toEqual(bytes);
    expect(requests.filter(r => r.url.includes('/storage/')).every(r => r.url.endsWith(path))).toBe(true);
  });
  it('stops expired sessions before network and does not refresh or retry', async () => {
    let now = 1_900_000_000_000;
    const { storage, scope, requests } = setup({ now: () => now }); const capability = await storage!.authorize(scope); const before = requests.length;
    now = 2_000_000_000_000; await expect(capability.read()).rejects.toThrow(); expect(requests).toHaveLength(before);
  });
  it('close cancels pending verification even when fetch ignores abort and rejects future work', async () => {
    let signal: AbortSignal | null | undefined;
    const { storage, scope } = setup({ fetch: async (_url, init) => { signal = init?.signal; return new Promise<Response>(() => {}); } });
    const pending = storage!.authorize(scope); await Promise.resolve(); storage!.close();
    await expect(pending).rejects.toThrow('Logo Storage is unavailable.'); expect(signal?.aborted).toBe(true);
    await expect(storage!.authorize(scope)).rejects.toThrow();
  });
  it('honors aborted callers before requests', async () => {
    const { storage, scope, requests } = setup(); const controller = new AbortController(); controller.abort('private reason');
    await expect(storage!.authorize(scope, controller.signal)).rejects.toThrow('Logo Storage is unavailable.'); expect(requests).toHaveLength(0);
  });
  it('sanitizes transport failures without retaining secret-bearing causes', async () => {
    const { storage, scope } = setup({ fetch: async () => { throw new Error(`secret ${config.accessToken}`); } });
    await expect(storage!.authorize(scope)).rejects.toEqual(new Error('Logo Storage is unavailable.'));
  });
  it.each(['sessionId', 'jobId', 'leaseToken', 'reservation'])('rejects a mismatched granted %s without byte requests', async field => {
    const { storage, scope, requests } = setup({ grant: value => ({ ...value, [field]: field === 'reservation' ? reservation() : randomUUID() }) });
    await expect(storage!.authorize(scope)).rejects.toThrow('Logo Storage is unavailable.');
    expect(requests.some(r => r.url.includes('/storage/'))).toBe(false);
  });
  it('rejects oversized Auth JSON before its contents can authorize a grant', async () => {
    const { storage, scope } = setup({ auth: { id: user, is_anonymous: false, extra: 'x'.repeat(17_000) } });
    await expect(storage!.authorize(scope)).rejects.toThrow('Logo Storage is unavailable.');
  });
  it('retains caller cancellation for already issued capabilities', async () => {
    const { storage, scope, requests } = setup(); const controller = new AbortController();
    const capability = await storage!.authorize(scope, controller.signal); const count = requests.length; controller.abort();
    await expect(capability.putIfAbsent(bytes, 'image/png')).rejects.toThrow();
    await expect(capability.read()).rejects.toThrow(); expect(requests).toHaveLength(count);
  });
});
