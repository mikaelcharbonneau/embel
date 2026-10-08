import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PermittedFont } from '@/domain/logo-directions';
import type { IdentityAssetPublication, IdentityAssetReceipt, VerifiedAssetBytes } from '@/domain/logo-deliverables';
import type { LogoVectorProposalEdit } from '@/domain/logo-vector-proposals';
import type { LogoWorkspaceV2 } from '@/domain/logo-workspace';
import type { IdentityAssetStore } from '@/server/data/identity-asset-store';
import { logoVectorProposalRecordSchema } from '@/domain/logo-vector-proposal-jobs';
import { createLogoVectorProposalMutationProducer, type LogoVectorProposalMutationDependencies } from '@/features/logo-vector/server/proposal-mutations';
import { buildLogoVectorProposalContext } from '@/features/logo-vector/server/proposal-context';
import { canonicalLogoDocumentBytes } from '@/features/logo-vector/server/revisions';
import { serializeLogoSvg } from '@/features/logo-vector/model/svg';
import { captureLogoComponentLocks } from '@/features/logo-vector/model/locks';
import { logoVectorProposalApplicationSchema, type ApplyLogoVectorProposalCommand } from '@/features/logo-vector/model/proposal-materialization';
import catalog from '@/features/identity-directions/catalog/free-fonts.json';
import { proposalObservation } from '../../server/logo-vector-proposal-fixtures';
import { proposalHash } from './proposal-fixtures';
import { textEditFixture } from './text-edit-fixtures';

/** Local owner records and provider metadata are synthetic. Font shaping uses real pinned OFL bytes. */
export async function proposalMutationFixture(edit?: LogoVectorProposalEdit, editable = false) {
 const f = await textEditFixture(editable), fonts: PermittedFont[] = [f.input.font];
 const entry = catalog.entries[2]!, bytes = new Uint8Array(readFileSync(`node_modules/geist/dist/fonts/${entry.file}`));
 if (proposalHash(bytes) !== entry.contentHash) throw Error('Pinned alternate font changed');
 fonts.push({ purpose: 'outline', bytes, contentHash: entry.contentHash, record: { ...structuredClone(f.input.font.record), id: randomUUID(), family: entry.family,
  asset: { ...f.input.font.record.asset, assetId: randomUUID(), versionId: randomUUID(), contentHash: entry.contentHash },
  rights: { ...f.input.font.record.rights, id: entry.rightsEvidenceId, fontContentHash: entry.contentHash } } });
 const expected = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 1, stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
 const workspace: LogoWorkspaceV2 = { version: 2, ownerId: f.revision.ownerId, projectId: f.projectId, heads: structuredClone(expected),
  stages: { brief_references: { stage: 'brief_references', id: f.brief.id, revision: 1 }, concepts: null, vector: null, refinements: null, directions: null, deliverables: null },
  approvedLogo: null, staleStages: [], capabilities: Object.fromEntries(['save','upload','generate','convert','export'].map(key => [key, {status:'available'}])) as LogoWorkspaceV2['capabilities'] };
 const context = buildLogoVectorProposalContext({ ...f, fonts: fonts.map(font => font.record), targetComponentIds: f.document.components.map(component => component.id) });
 const proposalId = randomUUID(), jobId = randomUUID(), providerId = randomUUID();
 const proposal = logoVectorProposalRecordSchema.parse({ version: 1, id: proposalId, ownerId: f.revision.ownerId, projectId: f.projectId, jobId, requestKey: randomUUID(), quoteId: randomUUID(),
  baseVectorRevisionId: f.revision.id, contextHash: 'f'.repeat(64), inputRevisions: f.revision.inputRevisions, expected: structuredClone(expected), context,
  state: 'succeeded', payload: {version:1,status:'proposed',edit:edit ?? {kind:'rotation',componentId:'synthetic-symbol',degrees:10},explanation:'One local test edit'},
  providerReceipt: {id:providerId,ownerId:f.revision.ownerId,projectId:f.projectId,jobId,leaseToken:randomUUID(),observation:proposalObservation()}, actualCostMicrousd:34,reason:null,createdAt:'2026-10-08T00:00:00Z',materialization:'unavailable' });
 const application = structuredClone(logoVectorProposalApplicationSchema.parse({proposal,preparedId:proposalId,providerResponseReceiptId:providerId,materialization:null,eligible:true}));
 const command: ApplyLogoVectorProposalCommand = {method:'applyLogoVectorProposal',body:{requestKey:randomUUID(),expected:structuredClone(expected),baseVectorRevisionId:f.revision.id,proposalId}};
 const files = new Map<string, VerifiedAssetBytes>(), publications: {publication:IdentityAssetPublication;bytes:Uint8Array;receipt:IdentityAssetReceipt}[] = [], events:string[]=[];
 function seal(locks:string[]=[]){
  f.seal(); f.revision.locks=structuredClone([...captureLogoComponentLocks(f.document,locks)]);
  for(const [reference, bytes, mimeType] of [[f.revision.documentAsset,canonicalLogoDocumentBytes(f.document),'application/json'],[f.revision.svgAsset,serializeLogoSvg(f.document),'image/svg+xml']] as const)
   files.set(reference.versionId,{reference,bytes:Uint8Array.from(bytes),mimeType,verification:{status:'verified',contentHash:reference.contentHash,mimeType,byteLength:bytes.length,checkedAt:'2026-10-08T00:00:00Z'}});
  files.set(f.raster.reference.versionId,f.raster);
  application.proposal.context=structuredClone(buildLogoVectorProposalContext({...f,fonts:fonts.map(font=>font.record),targetComponentIds:f.document.components.map(c=>c.id)}));
 }
 seal();
 const deps:LogoVectorProposalMutationDependencies={
  readApplication:async()=>{events.push('application');return application;},
  assetStore:{readOwnedAsset:async(_auth,ref)=>{events.push('asset');return files.get(ref.versionId)!;},stageOwnedAsset:async(_auth,_project,publication,bytes)=>{
   events.push('stage');const prior=publications.find(item=>item.publication.requestKey===publication.requestKey);if(prior){if(JSON.stringify(prior.publication)!==JSON.stringify(publication)||!Buffer.from(prior.bytes).equals(Buffer.from(bytes)))throw Error('Publication mismatch');return prior.receipt;}
   const receipt:IdentityAssetReceipt={id:randomUUID(),reference:{ownerId:f.revision.ownerId,projectId:f.projectId,assetId:randomUUID(),versionId:randomUUID(),contentHash:publication.contentHash},verification:{status:'verified',contentHash:publication.contentHash,mimeType:publication.mimeType,byteLength:bytes.length,checkedAt:'2026-10-08T00:00:00Z'},purpose:'brand_asset',sourceReceiptId:publication.source.sourceId,rightsEvidenceId:null,publicationState:'staged'};
   publications.push({publication,bytes:Uint8Array.from(bytes),receipt});return receipt;
  }} as IdentityAssetStore,
  readVectorDetail:async()=>({revision:f.revision,document:f.document,sourcePreview:f.refinement.preview!}),getWorkspace:async()=>workspace,readCurrentVectorRevisionId:async()=>f.revision.id,
  textEdits:{...f.deps,listFonts:async()=>fonts.map(font=>font.record),resolveFont:async(_auth,id)=>{events.push('font');return fonts.find(font=>font.record.id===id)!;}},
 };
 return {...f,fonts,workspace,application,command,files,publications,events,deps,seal,run:(signal?:AbortSignal)=>createLogoVectorProposalMutationProducer(deps)(f.auth,f.projectId,command,signal)};
}
