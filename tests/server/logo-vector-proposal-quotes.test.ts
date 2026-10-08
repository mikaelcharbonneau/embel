import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoVectorProposalQuoteService, type LogoVectorProposalQuoteDependencies } from '@/features/logo-vector/server/proposal-quotes';
import { logoDispatchReceiptSchema } from '@/domain/logo-jobs';
import { canonicalLogoDocumentBytes } from '@/features/logo-vector/server/revisions';
import { serializeLogoSvg } from '@/features/logo-vector/model/svg';
import type { VerifiedAssetBytes } from '@/domain/logo-deliverables';
import type { LogoWorkspaceV2 } from '@/domain/logo-workspace';
import { proposalId, proposalHeads } from '../features/logo-vector/proposal-fixtures';
import { proposalPolicy } from './logo-vector-proposal-fixtures';
import { textEditFixture } from '../features/logo-vector/text-edit-fixtures';
async function fixture() {
 const f = await textEditFixture(), events: string[] = [], files = new Map<string, VerifiedAssetBytes>();
 for (const [reference, bytes, mimeType] of [[f.revision.documentAsset, canonicalLogoDocumentBytes(f.document), 'application/json'], [f.revision.svgAsset, serializeLogoSvg(f.document), 'image/svg+xml']] as const) files.set(reference.versionId, { reference, bytes: Uint8Array.from(bytes), mimeType, verification: { status: 'verified', contentHash: reference.contentHash, mimeType, byteLength: bytes.length, checkedAt: '2026-10-08T00:00:00Z' } });
 files.set(f.raster.reference.versionId, f.raster);
 const heads = { ...proposalHeads, stageRevisions: { ...proposalHeads.stageRevisions, concepts: 0, vector: 0 } };
 const workspace: LogoWorkspaceV2 = { version: 2, ownerId: f.revision.ownerId, projectId: f.projectId, heads, stages: { brief_references: { id: f.brief.id, revision: 1, stage: 'brief_references' }, concepts: null, vector: null, refinements: null, directions: null, deliverables: null }, approvedLogo: null, staleStages: [], capabilities: { save: { status: 'available' }, upload: { status: 'unavailable', reason: 'fixture' }, generate: { status: 'unavailable', reason: 'fixture' }, convert: { status: 'unavailable', reason: 'fixture' }, export: { status: 'unavailable', reason: 'fixture' } } };
 const request = { operation: 'propose_vector_edit', expected: heads, baseVectorRevisionId: f.revision.id, instruction: 'Rotate the symbol', targetComponentIds: ['synthetic-symbol'] };
 const quote = { id: proposalId(88), ownerId: f.revision.ownerId, projectId: f.projectId, request, inputHash: 'a'.repeat(64), expected: request.expected, policyIdentity: 'b'.repeat(64), handlerVersion: 'logo-vector-propose-v1', provider: 'openai', model: 'gpt-6.1-sol', engine: null, estimatedCostMicrousd: 122880, maxCostMicrousd: 122880, externalProviderCostMicrousd: 122880, expiresAt: '2026-10-08T12:00:00Z', conceptPlan: null, targetSlotIds: [], textPolicy: proposalPolicy() };
 let evidence: unknown;
 const deps: LogoVectorProposalQuoteDependencies = {
  assets: { readOwnedAsset: async (_a, ref) => { events.push('asset'); return files.get(ref.versionId)!; } },
  getWorkspace: async () => workspace, readCurrentVectorRevisionId: async () => f.revision.id,
  readVectorDetail: async () => ({ revision: f.revision, document: f.document, sourcePreview: f.refinement.preview! }),
  readBriefRevision: async () => f.brief, listFonts: async () => [f.input.font.record],
  resolveFont: async () => { events.push('font'); return { ...f.input.font, purpose: 'outline' }; },
  connections: { acquire: async () => { events.push('acquire'); return { binding: { ownerId: f.revision.ownerId, roleName: 'fixture_quote', roleOid: 91 }, connection: {
   query: async (sql, args) => { events.push(sql); if (sql.includes('session_user')) return { rows: [{ role_name: 'fixture_quote', role_oid: 91 }] }; evidence = JSON.parse(String(args?.[1])); return { rows: [{ value: quote }] }; }, release: async discard => { events.push(`release:${discard}`); }, discard: async () => { events.push('discard'); },
  } }; } },
 };
 return { f, deps, events, files, workspace, request, quote, evidence: () => evidence, run: (signal?: AbortSignal) => createLogoVectorProposalQuoteService(deps).quoteLogoVectorProposal(f.auth, f.projectId, request, signal) };
}
describe('verified owner-bound vector proposal quote producer', () => {
 it('reads actual source bytes and permitted fonts before using one fixed trusted quote helper', async () => {
  const f = await fixture(); expect(await f.run()).toEqual(f.quote);
  expect(f.events.filter(x => x === 'asset')).toHaveLength(3); expect(f.events.indexOf('font')).toBeLessThan(f.events.indexOf('acquire'));
  expect(f.events.filter(x => x.includes('quote_logo_vector_proposal'))).toHaveLength(1);
  expect(f.evidence()).toMatchObject({ request: f.request, context: { baseVectorRevisionId: f.f.revision.id, documentHash: f.f.revision.documentHash }, baseRevision: f.f.revision, brief: f.f.brief, fonts: [f.f.input.font.record] });
  expect(JSON.stringify(f.evidence())).not.toContain('"bytes"'); expect(JSON.stringify(f.evidence())).not.toContain('"paths"');
 });
 it.each(['document', 'svg', 'raster'])('rejects corrupted %s bytes before any quote write', async kind => {
  const f = await fixture(), ref = kind === 'document' ? f.f.revision.documentAsset : kind === 'svg' ? f.f.revision.svgAsset : f.f.raster.reference;
  f.files.get(ref.versionId)!.bytes = new Uint8Array([1, 2, 3]); await expect(f.run()).rejects.toBeDefined(); expect(f.events).not.toContain('acquire');
 });
 it.each(['heads', 'base', 'font', 'brief', 'owner'])('rejects changed %s source before the trusted helper', async changed => {
  const f = await fixture();
  if (changed === 'heads') f.deps.getWorkspace = async () => ({ ...f.workspace, heads: { ...f.workspace.heads, workspaceRevision: 9 } });
  if (changed === 'base') f.deps.readCurrentVectorRevisionId = async () => proposalId(90);
  if (changed === 'font') f.deps.resolveFont = async () => ({ ...f.f.input.font, purpose: 'outline', record: { ...f.f.input.font.record, family: 'Substituted' } });
  if (changed === 'brief') f.deps.readBriefRevision = async () => ({ ...f.f.brief, id: proposalId(91) });
  if (changed === 'owner') f.deps.readVectorDetail = async () => ({ revision: { ...f.f.revision, ownerId: proposalId(91) }, document: f.f.document, sourcePreview: f.f.refinement.preview! });
  await expect(f.run()).rejects.toBeDefined(); expect(f.events).not.toContain('acquire');
 });
 it('has no quote fallback when dependencies are absent or the request is aborted', async () => {
  const f = await fixture(); await expect(createLogoVectorProposalQuoteService(null).quoteLogoVectorProposal(f.f.auth, f.f.projectId, f.request)).rejects.toMatchObject({ code: 'integration_unavailable' });
  const controller = new AbortController(); controller.abort(); await expect(f.run(controller.signal)).rejects.toBeDefined(); expect(f.events).toEqual([]);
 });
});
it('a proposal dispatch receipt has exactly one job without changing existing concept receipts', () => {
 const receipt = { ownerId: proposalId(1), projectId: proposalId(2), requestKey: proposalId(3), operation: 'identity.logo_vector_propose', batchId: null, jobIds: [proposalId(4), proposalId(5)], inputHash: 'a'.repeat(64) };
 expect(logoDispatchReceiptSchema.safeParse(receipt).success).toBe(false);
 expect(logoDispatchReceiptSchema.safeParse({ ...receipt, jobIds: [proposalId(4)] }).success).toBe(true);
 expect(logoDispatchReceiptSchema.safeParse({ ...receipt, operation: 'identity.logo_concept', batchId: proposalId(6) }).success).toBe(true);
});
it('rejects a changed role binding and releases the exact acquired connection',async()=>{
 const f=await fixture(),original=f.deps.connections.acquire;
 f.deps.connections.acquire=async(...args)=>{const acquired=await original(...args);return{...acquired,binding:{...acquired.binding,roleOid:92}};};
 await expect(f.run()).rejects.toMatchObject({code:'integration_unavailable'});expect(f.events.filter(e=>e.includes('quote_logo_vector_proposal'))).toEqual([]);expect(f.events).toContain('release:true');
});
it('rechecks heads after byte and font work, before acquiring the quote connection',async()=>{
 const f=await fixture();let reads=0;f.deps.getWorkspace=async()=>++reads===1?f.workspace:{...f.workspace,heads:{...f.workspace.heads,workspaceRevision:99}};
 await expect(f.run()).rejects.toMatchObject({code:'conflict'});expect(f.events).toContain('font');expect(f.events).not.toContain('acquire');
});
it('does not return a quote after cancellation while its connection release is awaited',async()=>{
 const f=await fixture(),controller=new AbortController(),original=f.deps.connections.acquire;
 f.deps.connections.acquire=async(...args)=>{const acquired=await original(...args),release=acquired.connection.release.bind(acquired.connection);acquired.connection.release=async(discard)=>{await release(discard);controller.abort();};return acquired;};
 await expect(f.run(controller.signal)).rejects.toMatchObject({code:'integration_unavailable'});expect(f.events.filter(e=>e.includes('quote_logo_vector_proposal'))).toHaveLength(1);
});
