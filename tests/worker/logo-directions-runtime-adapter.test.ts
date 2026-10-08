import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const catalogFault = vi.hoisted(() => ({ mode: null as 'package' | 'font-hash' | 'license-hash' | null }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: async (...args: Parameters<typeof original.readFile>) => {
    const path = String(args[0]);
    if (catalogFault.mode === 'package' && path.endsWith('/geist/package.json')) return JSON.stringify({ version: '0.0.0' });
    if (catalogFault.mode === 'font-hash' && path.endsWith('Geist-Variable.ttf')) return Buffer.from('corrupt installed font');
    if (catalogFault.mode === 'license-hash' && path.endsWith('/geist/LICENSE.txt')) return 'corrupt installed license';
    return original.readFile(...args);
  } };
});
afterEach(() => { catalogFault.mode = null; });
import { createLogoDirectionsRuntimeAdapter } from '../../worker/logo-directions/runtime-adapter';
import { createLogoDirectionsHandler } from '../../worker/handlers/logo-directions';
import type { IdentityAssetStore } from '../../src/server/data/identity-asset-store';
import type { LogoWorkerConnection } from '../../src/server/data/logo-jobs';
import type { ChatGPTTransport } from '../../src/server/ai/chatgpt-transport';
import { canonicalLogoDocumentBytes } from '../../src/features/logo-vector/model/canonical';
import { serializeLogoSvg } from '../../src/features/logo-vector/model/svg';
import { subscriptionFixture } from '../features/identity-directions/subscription-fixtures';
import { fontBytes, id } from '../features/identity-directions/fixtures';
const signal = () => new AbortController().signal, digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** Concrete provider/load/stage functions, synthetic DB/Storage/Responses ports. */
function fixture() {
  const f = subscriptionFixture(), bytes = canonicalLogoDocumentBytes(f.input.logo), svg = serializeLogoSvg(f.input.logo);
  const reference = (n: number, hash: string) => ({ ownerId: f.job.ownerId, projectId: f.job.projectId, assetId: id(n), versionId: id(n + 1), contentHash: hash });
  const source = { ...f.input, logoRevision: { id: f.input.approvedLogo.vectorRevisionId, ownerId: f.job.ownerId, projectId: f.job.projectId, parentRevisionId: null, source: { kind: 'refinement', rasterRevisionId: id(86) }, sourcePreview: reference(94, 'd'.repeat(64)), documentAsset: reference(90, digest(bytes)), svgAsset: reference(92, digest(svg)), documentHash: digest(bytes), proof: { version: 1, documentHash: digest(bytes), svgContentHash: digest(svg), validator: { id: 'fluid.logo-vector', version: '1' }, viewBox: f.input.logo.viewBox, pathCount: 2, componentCount: 2, externalFontDependencies: [] }, locks: [], inputRevisions: [], reviewStatus: 'review_required', createdAt: '2026-10-07T00:00:00Z' } };
  delete (source as Partial<typeof source>).logo;
  const events: string[] = [], stagePayloads: unknown[][] = [], responses: unknown[] = [];
  const state = { ready: true as unknown, available: true, corruptFont: false, account: f.policy.registrationId, responseId: 'resp_directions_fixture', beforeDispatch: undefined as undefined | (() => void), recordLost: false, stageLost: false };
  const connection: LogoWorkerConnection = { async query<Row>(sql: string, args: unknown[] = []) {
    events.push(sql); expect(args[0]).toBe(f.job.id); expect(args[1]).toBe(f.job.leaseToken); let value: unknown;
    if (sql.includes('read_leased_logo_record')) { expect(args[2]).toBe('runtime_readiness'); value = state.ready; }
    else if (sql.includes('load_logo_direction_inputs')) value = source;
    else if (sql.includes('record_logo_provider_response')) { const observation = JSON.parse(args[2] as string); responses.push(observation); if (state.recordLost) throw Error('Synthetic record acknowledgement lost'); value = { ...observation, id: id(110), ownerId: f.job.ownerId, projectId: f.job.projectId, jobId: f.job.id, leaseToken: f.job.leaseToken }; }
    else if (sql.includes('stage_logo_directions')) { stagePayloads.push(args); if (state.stageLost) throw Error('Synthetic stage acknowledgement lost'); value = { id: id(111), ownerId: f.job.ownerId, projectId: f.job.projectId, jobId: f.job.id, inputHash: 'a'.repeat(64), directionIds: JSON.parse(args[2] as string).directions.map((d: { id: string }) => d.id), publicationState: 'staged' }; }
    else throw Error('Unexpected SQL'); return { rows: [{ value }] as Row[] };
  } };
  const denied = async (): Promise<never> => { throw Error('No fixture writes'); };
  const assets: IdentityAssetStore = { publishLeasedAsset: denied, stageOwnedAsset: denied, publishOwnedUpload: denied, readOwnedAsset: denied, async readLeasedAsset(job, ref) {
    events.push('read'); expect(job).toEqual(f.job); const document = ref.assetId === source.logoRevision.documentAsset.assetId; const value = document ? bytes : state.corruptFont ? new Uint8Array([1]) : fontBytes(), mimeType = document ? 'application/json' : 'font/ttf';
    return { reference: ref, bytes: Uint8Array.from(value), mimeType, verification: { status: 'verified', contentHash: ref.contentHash, byteLength: value.length, mimeType, checkedAt: '2026-10-07T00:00:00Z' } };
  } };
  const transport: ChatGPTTransport = { listModels: vi.fn(), streamResponse: vi.fn(async (_request, options) => {
    state.beforeDispatch?.(); await options.beforeDispatch?.(); events.push('provider');
    return { status: 'completed' as const, response: { id: state.responseId, status: 'completed', model: f.policy.model, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(f.candidate) }] }] }, partialText: '', requestId: null, responseId: 'resp_directions_fixture', accountId: state.account };
  }) };
  const options = { ownerId: f.job.ownerId, policyIdentity: 'b'.repeat(64), policy: f.policy, expectedAccountId: f.policy.registrationId, transport, connection, assets, async assertAvailable() { events.push('available'); if (!state.available) throw Error('Synthetic rights revoked'); } };
  const adapter = createLogoDirectionsRuntimeAdapter(options)!;
  const execute = async () => createLogoDirectionsHandler(adapter.dependencies).steps(f.job)[0]!.execute({ job: f.job, signal: signal() });
  return { ...f, source, events, stagePayloads, responses, state, options, adapter, execute, transport };
}

describe('subscription directions runtime adapter', () => {
  it('constructs exact frozen capability without I/O and rejects absent/mismatched injection', () => {
    const f = fixture(); expect(f.adapter).not.toBeNull(); expect(f.events).toEqual([]); expect(createLogoDirectionsRuntimeAdapter()).toBeNull();
    for (const key of ['transport', 'connection', 'assets', 'assertAvailable'] as const) expect(createLogoDirectionsRuntimeAdapter({ ...f.options, [key]: null })).toBeNull();
    for (const patch of [{ ownerId: 'bad' }, { policyIdentity: 'bad' }, { expectedAccountId: 'wrong' }, { policy: { ...f.policy, apiCharge: 'unknown' } }]) expect(createLogoDirectionsRuntimeAdapter({ ...f.options, ...patch } as typeof f.options)).toBeNull();
    expect(f.adapter.capability).toEqual({ operation: 'identity.logo_directions', policyIdentity: 'b'.repeat(64), handlerVersion: f.policy.handlerVersion, provider: 'openai', model: f.policy.model, engine: null, maxCostMicrousd: 0, billingMode: 'chatgpt_subscription', policy: f.policy });
    expect(Object.isFrozen(f.adapter.capability.policy?.limits)).toBe(true); f.options.policy.limits.maxQueuedJobs = 1; expect(f.adapter.capability.policy!.limits.maxQueuedJobs).toBe(3);
  });
  it.each(['owner', 'project', 'operation', 'lease', 'inputRevision', 'state', 'reserved', 'actual', 'policy', 'identity', 'billing', 'fonts'])('rejects wrong %s before any I/O', async mismatch => {
    const f = fixture(), job = structuredClone(f.job), input = job.input as Record<string, unknown>;
    if (mismatch === 'owner') job.ownerId = randomUUID(); if (mismatch === 'project') job.projectId = randomUUID(); if (mismatch === 'operation') job.operation = 'strategy'; if (mismatch === 'lease') job.leaseToken = 'bad'; if (mismatch === 'inputRevision') job.inputRevision = 0; if (mismatch === 'state') job.status = 'cancel_requested'; if (mismatch === 'reserved') job.reservedCostMicrousd = 1; if (mismatch === 'actual') job.actualCostMicrousd = 1; if (mismatch === 'policy') input.policy = { ...f.policy, model: 'wrong' }; if (mismatch === 'identity') input.policyIdentity = 'c'.repeat(64); if (mismatch === 'billing') { delete input.policy; delete input.billingMode; } if (mismatch === 'fonts') input.fontVersionIds = [];
    await expect(f.adapter.dependencies.loadInput(job)).rejects.toThrow(); await expect(f.adapter.dependencies.assertReady(job)).rejects.toThrow(); expect(f.events).toEqual([]);
  });
  it('requires actual availability and exact boolean runtime readiness', async () => {
    const f = fixture(); f.state.available = false; await expect(f.adapter.dependencies.assertReady(f.job)).rejects.toThrow(); expect(f.events).toEqual(['available']);
    f.state.available = true; for (const value of [false, null, 'true', 1]) { f.state.ready = value; await expect(f.adapter.dependencies.assertReady(f.job)).rejects.toThrow(); } f.state.ready = true; await expect(f.adapter.dependencies.assertReady(f.job)).resolves.toBeUndefined();
  });
  it('runs actual handler/provider/loaders/font checks and stages exactly three coherent directions', async () => {
    const f = fixture(), outcome = await f.execute(); expect(outcome.status).toBe('succeeded'); expect(outcome.costMicrousd).toBe(0); expect(f.transport.streamResponse).toHaveBeenCalledTimes(1); expect(f.transport.listModels).not.toHaveBeenCalled();
    expect(f.stagePayloads).toHaveLength(1); const result = JSON.parse(f.stagePayloads[0]![2] as string), checks = JSON.parse(f.stagePayloads[0]![4] as string); for (const key of ['directions', 'palettes', 'typography', 'graphics']) expect(result[key]).toHaveLength(3); expect(checks).toHaveLength(3); expect(checks.every((c: { styleSupported: boolean; missingCodePoints: number[] }) => c.styleSupported && !c.missingCodePoints.length)).toBe(true);
    expect(f.responses[0]).toMatchObject({ billingMode: 'chatgpt_subscription', billing: { status: 'recorded', confirmedMicrousd: 0 }, registrationId: f.policy.registrationId });
    expect(f.events.some(e => e.includes('report_logo_worker_ready'))).toBe(false);
  });
  it('stops revoked rights before dispatch including final provider guard', async () => {
    const f = fixture(); f.state.beforeDispatch = () => { f.state.available = false; }; const result = await f.execute(); expect(result.status).not.toBe('succeeded'); expect(f.events).not.toContain('provider'); expect(f.stagePayloads).toEqual([]);
  });
  it.each(['corruptFont', 'recordLost', 'stageLost', 'wrongAccount', 'wrongResponse'])('retains actual response for %s without replay', async failure => {
    const f = fixture(); if (failure === 'corruptFont' || failure === 'recordLost' || failure === 'stageLost') f.state[failure] = true; if (failure === 'wrongAccount') f.state.account = 'wrong'; if (failure === 'wrongResponse') f.state.responseId = 'resp_other';
    const result = await f.execute(); expect(result.status).toBe('needs_reconciliation'); expect(result).toHaveProperty('result.kind', 'logo_directions_unpublished'); expect(result).toHaveProperty('result.payload'); expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
  });
  it('creates project-bound provider per validated leased job, without a fixed project or mutable shared job', async () => {
    const f = fixture(), other = structuredClone(f.job), input = structuredClone(f.input); other.id = randomUUID(); other.projectId = randomUUID(); (other.input as Record<string, unknown>).projectId = other.projectId; input.approvedLogo.projectId = other.projectId; input.brief.projectId = other.projectId; input.references.projectId = other.projectId; input.permittedFonts.forEach(font => { font.asset.projectId = other.projectId; });
    const dispatches: string[] = [];
    const outcome = await f.adapter.dependencies.provider.propose(input, signal(), { job: other, async beforeDispatch(job) { dispatches.push(job.projectId); } });
    expect(outcome.outcome.status).toBe('succeeded'); expect(dispatches).toEqual([other.projectId]);
  });
  it.each(['package', 'font-hash', 'license-hash'] as const)('retains response rather than silently substituting a font on installed catalog %s mismatch', async mode => {
    const f = fixture(); catalogFault.mode = mode;
    const outcome = await f.execute(); expect(outcome.status).toBe('needs_reconciliation'); expect(outcome).toHaveProperty('result.kind', 'logo_directions_unpublished');
    expect(f.stagePayloads).toEqual([]); expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
  });

  it('passes the host lifecycle to the actual final transport gate without fabricating response evidence', async () => {
    const f = fixture(); let accepting = true, dispatches = 0;
    f.transport.streamResponse = async (_request, options) => {
      await options.beforeDispatch?.(); accepting = false;
      const guard = (options as typeof options & { acceptingWork?: () => boolean }).acceptingWork;
      if (guard && !guard()) return { status: 'unavailable', partialText: '', failure: { code: 'runtime_policy_unavailable', providerCode: null, providerParam: null, httpStatus: null, bodyShape: 'empty', requestId: null, responseId: null, dispatched: false, recovery: 'manual_review' } };
      dispatches++;
      return { status: 'completed', partialText: '', responseId: 'resp_guard_fixture', requestId: null, accountId: f.policy.registrationId, response: { id: 'resp_guard_fixture', status: 'completed', model: f.policy.model, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(f.candidate) }] }] } };
    };
    const options = { ...f.options, acceptingWork: () => accepting }, adapter = createLogoDirectionsRuntimeAdapter(options)!;
    const outcome = await createLogoDirectionsHandler(adapter.dependencies).steps(f.job)[0]!.execute({ job: f.job, signal: signal() });
    expect(dispatches).toBe(0); expect(outcome).toMatchObject({ status: 'failed', code: 'not_dispatched', costMicrousd: 0 }); expect(f.responses).toEqual([]); expect(f.stagePayloads).toEqual([]);
  });
  it('keeps already-invoked response evidence drainable after the host stops accepting new work', async () => {
    const f = fixture(); let accepting = true;
    const original = f.transport.streamResponse.bind(f.transport);
    f.transport.streamResponse = async (request, options) => { const result = await original(request, options); accepting = false; return result; };
    const options = { ...f.options, acceptingWork: () => accepting }, adapter = createLogoDirectionsRuntimeAdapter(options)!;
    const outcome = await createLogoDirectionsHandler(adapter.dependencies).steps(f.job)[0]!.execute({ job: f.job, signal: signal() });
    expect(outcome.status).toBe('succeeded'); expect(f.responses).toHaveLength(1); expect(f.stagePayloads).toHaveLength(1);
  });

});
