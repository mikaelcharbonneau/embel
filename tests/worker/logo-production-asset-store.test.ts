import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoProductionAssetStore } from '../../worker/logo-production-asset-store';
import type { LogoProductionStorageAuthorization } from '../../worker/logo-production-storage-authorization';
import type { ClaimedJob } from '../../src/domain/jobs';
import type { IdentityAssetPublication } from '../../src/domain/logo-deliverables';
import type { IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import { LOGO_EXPORT_POLICY_IDENTITY } from '../../worker/handlers/logo-exports';
import { syntheticConversionInput } from '../features/logo-vector/raster-fixtures';
const uuid = randomUUID, hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const ownerId = uuid(), projectId = uuid();
  const job: ClaimedJob = { id: uuid(), ownerId, projectId, input: {}, operation: 'identity.logo_export', inputRevision: 1, leaseToken: uuid(), status: 'running', reservedCostMicrousd: 0, actualCostMicrousd: 0 };
  const rows = new Map<string, IdentityAssetReservation>(), files = new Map<string, { bytes: Uint8Array; mimeType: string }>(), calls: string[] = [];
  const state = { live: true, observeUnknown: false, putUnknown: false, corrupt: false }; const lease = () => { if (!state.live) throw Error('Synthetic stale lease'); };
  const authorization: LogoProductionStorageAuthorization = { ownerId, capability: { operation: 'identity.logo_export', policyIdentity: LOGO_EXPORT_POLICY_IDENTITY, handlerVersion: 'logo-export-v1', engine: null, provider: null, model: null, maxCostMicrousd: 0 }, close() {}, async assertAvailable() { lease(); },
    async authorizeRead({ job: j, reservation }) { lease(); expect(j.id).toBe(job.id); calls.push('authorize-read'); return { async read() { lease(); return files.get(reservation.storagePath)!; } }; },
    async authorizeReadback({ job: j, reservation }) { lease(); expect(j.id).toBe(job.id); calls.push('authorize-readback'); return { async read() { lease(); return files.get(reservation.storagePath)!; } }; },
    async authorizeWrite({ job: j, reservation, publication }) { lease(); expect(j.id).toBe(job.id); expect(publication.requestKey).toBe(reservation.requestKey); calls.push('authorize-write'); return {
      async putIfAbsent(bytes, mimeType) { lease(); calls.push('write'); if (!files.has(reservation.storagePath)) files.set(reservation.storagePath, { bytes: new Uint8Array(bytes), mimeType }); if (state.putUnknown) throw Error('Synthetic lost put acknowledgement'); },
      async read() { lease(); const file = files.get(reservation.storagePath)!; return { ...file, bytes: state.corrupt ? new Uint8Array([0]) : file.bytes }; },
    }; },
  };
  const connection = { async query<Row>(sql: string, parameters: unknown[] = []) {
    lease(); calls.push(sql); let value: unknown;
    if (sql.includes('prepare_logo_asset')) {
      const write = JSON.parse(parameters[1] as string), p = write.publication as IdentityAssetPublication;
      const previous = rows.get(p.requestKey); if (previous) value = previous;
      else { const reference = { ownerId, projectId, assetId: uuid(), versionId: uuid(), contentHash: p.contentHash };
        value = { id: uuid(), requestKey: p.requestKey, reference, storagePath: `${ownerId}/${projectId}/${reference.assetId}/${reference.versionId}`, mimeType: p.mimeType, byteLength: p.byteLength, purpose: 'brand_asset', sourceReceiptId: p.source.sourceId, rightsEvidenceId: null, publicationState: 'staged' }; rows.set(p.requestKey, value as IdentityAssetReservation); }
    } else if (sql.includes('observe_logo_asset')) {
      if (state.observeUnknown) throw Error('Synthetic lost observation acknowledgement'); const r = [...rows.values()].find(r => r.id === parameters[0])!;
      value = { id: r.id, reference: r.reference, purpose: r.purpose, sourceReceiptId: r.sourceReceiptId, rightsEvidenceId: r.rightsEvidenceId, publicationState: r.publicationState, verification: JSON.parse(parameters[1] as string) };
    } else if (sql.includes('read_logo_asset_publication')) { const ref = JSON.parse(parameters[1] as string); value = [...rows.values()].find(r => r.reference.versionId === ref.versionId); }
    else throw Error('Unexpected synthetic query'); return { rows: [{ value }] as Row[] };
  } };
  const store = createLogoProductionAssetStore({ connection, authorization })!;
  const publication = (bytes: Uint8Array, mimeType: string): IdentityAssetPublication => ({ requestKey: uuid(), inputRevisions: [], mimeType, contentHash: hash(bytes), byteLength: bytes.length, source: { kind: 'export', sourceId: job.id } });
  return { job, rows, files, calls, state, authorization, connection, store, publication };
}
describe('per-call production asset broker with disposable storage', () => {
  it('denies missing/unqualified ports, owned/browser methods and text-worker jobs', async () => {
    expect(createLogoProductionAssetStore(null)).toBeNull(); const f = fixture(); expect(f.calls).toEqual([]);
    expect(createLogoProductionAssetStore({ ...f, authorization: { ...f.authorization, capability: { ...f.authorization.capability, policyIdentity: 'f'.repeat(64) } } })).toBeNull();
    await expect(f.store.readOwnedAsset({} as never, {} as never)).rejects.toThrow(); await expect(f.store.stageOwnedAsset({} as never, '', {} as never, new Uint8Array())).rejects.toThrow(); await expect(f.store.publishOwnedUpload({} as never, '', {} as never, new Uint8Array())).rejects.toThrow();
    await expect(f.store.readLeasedAsset({ ...f.job, operation: 'strategy' } as ClaimedJob, {} as never)).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it('keeps concurrent publications in independent exact capabilities and staged receipts', async () => {
    const f = fixture(), bytes = syntheticConversionInput('mascot').source.bytes;
    const [a, b] = await Promise.all([f.store.publishLeasedAsset(f.job, f.publication(bytes, 'image/png'), bytes), f.store.publishLeasedAsset(f.job, f.publication(bytes, 'image/png'), bytes)]);
    expect(a.id).not.toBe(b.id); expect(f.rows.size).toBe(2); expect(f.files.size).toBe(2); expect(f.calls.filter(c => c === 'authorize-write')).toHaveLength(2); expect(a.publicationState).toBe('staged');
  });
  it('installs actual PDF/ZIP validators before reservation', async () => {
    for (const mime of ['application/pdf', 'application/zip']) {
      const f = fixture(), bad = new Uint8Array([1, 2, 3]); await expect(f.store.publishLeasedAsset(f.job, f.publication(bad, mime), bad)).rejects.toThrow(); expect(f.rows.size).toBe(0); expect(f.files.size).toBe(0);
      const name = mime === 'application/pdf' ? 'synthetic-primary-color.pdf' : 'synthetic-logo-pack.zip', bytes = new Uint8Array(await readFile(new URL(`../../docs/evidence/logo-exports/runtime-adapter/${name}`, import.meta.url)));
      expect((await f.store.publishLeasedAsset(f.job, f.publication(bytes, mime), bytes)).verification.contentHash).toBe(hash(bytes));
    }
  });
  it.each(['putUnknown', 'observeUnknown', 'corrupt'] as const)('retains original reservation on %s with no retry/success', async kind => {
    const f = fixture(), bytes = syntheticConversionInput('mascot').source.bytes, p = f.publication(bytes, 'image/png'); f.state[kind] = true;
    await expect(f.store.publishLeasedAsset(f.job, p, bytes)).rejects.toMatchObject({ name: 'IdentityAssetUncertainPublicationError', requestKey: p.requestKey, reservationId: expect.any(String) }); expect(f.files.size).toBe(1); expect(f.rows.size).toBe(1); expect(f.calls.filter(c => c === 'write')).toHaveLength(1);
  });
  it('routes immediate staged publisher readback only through the dedicated readback capability', async () => {
    const f=fixture(),bytes=syntheticConversionInput('mascot').source.bytes,p=f.publication(bytes,'image/png');
    const receipt=await f.store.publishLeasedAsset(f.job,p,bytes);
    expect((await f.store.readLeasedAsset(f.job,receipt.reference)).bytes).toEqual(bytes);
    expect(f.calls.filter(c=>c==='authorize-readback')).toHaveLength(1); expect(f.calls.filter(c=>c==='authorize-read')).toHaveLength(0);
  });
  it('checks lease through metadata on both sides of frozen reads', async () => {
    const f = fixture(), bytes = syntheticConversionInput('mascot').source.bytes, p = f.publication(bytes, 'image/png'), receipt = await f.store.publishLeasedAsset(f.job, p, bytes); f.rows.get(p.requestKey)!.publicationState = 'committed';
    expect((await f.store.readLeasedAsset(f.job, receipt.reference)).bytes).toEqual(bytes); expect(f.calls.filter(c => c.includes('read_logo_asset_publication'))).toHaveLength(2); f.state.live = false; await expect(f.store.readLeasedAsset(f.job, receipt.reference)).rejects.toThrow();
  });
});
