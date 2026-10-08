import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoGenerativeAssetStore } from '../../worker/logo-generative-asset-store';
import type { LogoGenerativeStorageAuthorization } from '../../worker/logo-generative-storage-authorization';
import type { ClaimedJob } from '../../src/domain/jobs';
import type { IdentityAssetPublication } from '../../src/domain/logo-deliverables';
import type { IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import { syntheticConversionInput } from '../features/logo-vector/raster-fixtures';
import { syntheticLogoJob, syntheticResolvedLogoConcept } from '../fixtures/logo-creation';
const uuid = randomUUID, hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const resolved = syntheticResolvedLogoConcept(), job = { ...syntheticLogoJob(), input: resolved.input }, ownerId = job.ownerId, projectId = job.projectId;
  const rows = new Map<string, IdentityAssetReservation>(), files = new Map<string, { bytes: Uint8Array; mimeType: string }>(), calls: string[] = [];
  const state = { live: true, observeUnknown: false, putUnknown: false, corrupt: false, afterRead: undefined as undefined | (() => void) }; const lease = () => { if (!state.live) throw Error('Synthetic stale lease'); };
  const authorization: LogoGenerativeStorageAuthorization = { ownerId, capability: { operation: 'identity.logo_concept', policyIdentity: resolved.input.policyIdentity, handlerVersion: 'logo-image-v1', engine: null, provider: 'openai', model: 'gpt-image-2.5-sunburst-2026-09-08', maxCostMicrousd: 100_000 }, close() {}, async assertAvailable() { lease(); calls.push('probe'); },
    async authorizeRead({ reservation }) { lease(); calls.push('authorize-read'); if (reservation.publicationState !== 'committed') throw Error('Synthetic source unavailable'); return { async read() { lease(); const value = files.get(reservation.storagePath)!; calls.push('read-source'); state.afterRead?.(); return value; } }; },
    async authorizeWrite({ job: j, reservation, publication }) { lease(); expect((j.input as typeof resolved.input).attemptId).toBe(reservation.requestKey); expect(publication.requestKey).toBe(reservation.requestKey); calls.push('authorize-write'); return {
      async putIfAbsent(bytes, mimeType) { lease(); calls.push('write'); if (!files.has(reservation.storagePath)) files.set(reservation.storagePath, { bytes: new Uint8Array(bytes), mimeType }); if (state.putUnknown) throw Error('Synthetic lost put acknowledgement'); },
      async read() { lease(); calls.push('readback'); const file = files.get(reservation.storagePath)!; state.afterRead?.(); return { ...file, bytes: state.corrupt ? new Uint8Array([0]) : file.bytes }; },
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
  const store = createLogoGenerativeAssetStore({ connection, authorization })!;
  const publication = (bytes: Uint8Array, j = job): IdentityAssetPublication => ({ requestKey: (j.input as typeof resolved.input).attemptId, inputRevisions: resolved.inputRevisions, mimeType: 'image/png', contentHash: hash(bytes), byteLength: bytes.length, source: { kind: 'concept', sourceId: (j.input as typeof resolved.input).attemptId } });
  async function source() {
    const bytes = syntheticConversionInput('mascot').source.bytes, receipt = await store.publishLeasedAsset(job, publication(bytes), bytes), row = rows.get(receipt.sourceReceiptId)!;
    row.publicationState = 'committed'; row.purpose = 'reference_media'; row.rightsEvidenceId = uuid(); calls.length = 0;
    return { receipt, bytes, row };
  }
  return { job, rows, files, calls, state, authorization, connection, store, publication, source };
}
describe('per-call generative asset composition with synthetic metadata ports', () => {
  it('is disabled by default and denies owner/browser methods and incompatible operations', async () => {
    expect(createLogoGenerativeAssetStore(null)).toBeNull(); const f = fixture(); expect(f.calls).toEqual([]);
    expect(createLogoGenerativeAssetStore({ ...f, authorization: { ...f.authorization, capability: { ...f.authorization.capability, model: 'wrong' } } })).toBeNull();
    await expect(f.store.readOwnedAsset({} as never, {} as never)).rejects.toThrow(); await expect(f.store.stageOwnedAsset({} as never, '', {} as never, new Uint8Array())).rejects.toThrow(); await expect(f.store.publishOwnedUpload({} as never, '', {} as never, new Uint8Array())).rejects.toThrow();
    await expect(f.store.readLeasedAsset({ ...f.job, operation: 'strategy' } as ClaimedJob, {} as never)).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it('keeps concurrent jobs in separate exact capabilities and returns staged receipts', async () => {
    const f = fixture(), bytes = syntheticConversionInput('mascot').source.bytes, other = { ...f.job, id: uuid(), leaseToken: uuid(), input: { ...f.job.input as object, attemptId: uuid() } } as typeof f.job;
    const [a, b] = await Promise.all([f.store.publishLeasedAsset(f.job, f.publication(bytes), bytes), f.store.publishLeasedAsset(other, f.publication(bytes, other), bytes)]);
    expect(a.id).not.toBe(b.id); expect(f.rows.size).toBe(2); expect(f.files.size).toBe(2); expect(f.calls.filter(c => c === 'authorize-write')).toHaveLength(2); expect(a.publicationState).toBe('staged');
    expect(f.calls.filter(c => c === 'readback')).toHaveLength(2); expect(f.calls).not.toContain('authorize-read');
  });
  it('rejects foreign sources/request IDs, non-PNG, over-limit or malformed bytes before metadata', async () => {
    const f = fixture(), bytes = syntheticConversionInput('mascot').source.bytes, p = f.publication(bytes);
    for (const delta of [{ requestKey: uuid() }, { source: { kind: 'concept', sourceId: uuid() } }, { mimeType: 'image/jpeg' }, { byteLength: 8_388_609 }]) await expect(f.store.publishLeasedAsset(f.job, { ...p, ...delta } as IdentityAssetPublication, bytes)).rejects.toThrow();
    const bad = new Uint8Array([1, 2, 3]); await expect(f.store.publishLeasedAsset(f.job, f.publication(bad), bad)).rejects.toThrow(); expect(f.rows.size).toBe(0); expect(f.files.size).toBe(0); expect(f.calls).toEqual([]);
  });
  it.each(['putUnknown', 'observeUnknown', 'corrupt'] as const)('retains original reservation on %s without retry or successful receipt', async kind => {
    const f = fixture(), bytes = syntheticConversionInput('mascot').source.bytes, p = f.publication(bytes); f.state[kind] = true;
    await expect(f.store.publishLeasedAsset(f.job, p, bytes)).rejects.toMatchObject({ name: 'IdentityAssetUncertainPublicationError', requestKey: p.requestKey, reservationId: expect.any(String) }); expect(f.files.size).toBe(1); expect(f.rows.size).toBe(1); expect(f.calls.filter(c => c === 'write')).toHaveLength(1);
  });
  it('rechecks duplicate existing bytes and observes only verified immutable content', async () => {
    const f = fixture(), bytes = syntheticConversionInput('mascot').source.bytes, p = f.publication(bytes), first = await f.store.publishLeasedAsset(f.job, p, bytes);
    const second = await f.store.publishLeasedAsset(f.job, p, bytes); expect(second.id).toBe(first.id); expect(f.files.size).toBe(1); expect(f.calls.filter(c => c === 'readback')).toHaveLength(2);
    f.files.set([...f.files.keys()][0]!, { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }); await expect(f.store.publishLeasedAsset(f.job, p, bytes)).rejects.toMatchObject({ name: 'IdentityAssetUncertainPublicationError', reservationId: first.id });
  });
  it('never uses staged output as a source through readLeasedAsset', async () => {
    const f = fixture(), bytes = syntheticConversionInput('mascot').source.bytes, receipt = await f.store.publishLeasedAsset(f.job, f.publication(bytes), bytes); f.calls.length = 0;
    await expect(f.store.readLeasedAsset(f.job, receipt.reference)).rejects.toThrow(); expect(f.calls).not.toContain('authorize-read'); expect(f.calls).not.toContain('readback');
  });
  it('uses lease metadata on both sides of each source read and rejects a late loss', async () => {
    const f = fixture(), { receipt, bytes } = await f.source(); expect((await f.store.readLeasedAsset(f.job, receipt.reference)).bytes).toEqual(bytes);
    expect(f.calls.filter(c => c.includes('read_logo_asset_publication'))).toHaveLength(2); expect(f.calls.filter(c => c === 'probe')).toHaveLength(2);
    f.state.afterRead = () => { f.state.live = false; }; await expect(f.store.readLeasedAsset(f.job, receipt.reference)).rejects.toThrow();
  });
  it('rejects changed publication authority after the source read', async () => {
    const f = fixture(), { receipt, row } = await f.source(); f.state.afterRead = () => { row.rightsEvidenceId = uuid(); };
    await expect(f.store.readLeasedAsset(f.job, receipt.reference)).rejects.toThrow();
  });
});
