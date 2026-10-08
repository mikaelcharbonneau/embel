import { randomUUID } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { proposalMutationFixture } from './proposal-mutation-fixtures';
import { canonicalLogoDocumentBytes,verifyLogoVectorRevision } from '@/features/logo-vector/server/revisions';
import { assertLogoProposalCandidatePreservation } from '@/features/logo-vector/server/proposal-mutations';
import { proposalHash } from './proposal-fixtures';

describe('authenticated zero-AI proposal candidate preparation',()=>{
 it.each(['size','rotation','color','arrangement','font','spacing'] as const)('materializes exactly one %s through actual bytes and preserves originals',async kind=>{
  const f=await proposalMutationFixture(undefined,['font','spacing'].includes(kind));
  const target=kind==='font'||kind==='spacing'?'synthetic-lettering':'synthetic-symbol';
  const edit=kind==='size'?{kind,componentId:target,scale:1.15}:kind==='rotation'?{kind,componentId:target,degrees:10}:kind==='color'?{kind,componentId:target,fill:'#123456',stroke:null}:kind==='arrangement'?{kind,order:f.document.components.map(c=>c.id),placements:[{componentId:target,transform:{...f.document.components[0]!.transform,x:20}}]}:kind==='font'?{kind,componentId:target,fontVersionId:f.fonts[1]!.record.id}:{kind,componentId:target,letterSpacing:2,lineHeight:1};
  f.application.proposal.payload={version:1,status:'proposed',edit,explanation:'One bounded test edit'};
  const before=canonicalLogoDocumentBytes(f.document),evidence=await f.run();expect(f.publications).toHaveLength(2);
  const d=f.publications[0]!,s=f.publications[1]!;
  const result=await verifyLogoVectorRevision({revision:{...f.revision,id:randomUUID(),parentRevisionId:f.revision.id,documentAsset:d.receipt.reference,svgAsset:s.receipt.reference,documentHash:evidence.documentHash,proof:evidence.proof},document:{reference:d.receipt.reference,bytes:Uint8Array.from(d.bytes),mimeType:d.publication.mimeType,verification:d.receipt.verification},svg:{reference:s.receipt.reference,bytes:Uint8Array.from(s.bytes),mimeType:s.publication.mimeType,verification:s.receipt.verification}});
  expect(canonicalLogoDocumentBytes(f.document)).toEqual(before);expect(proposalHash(d.bytes)).not.toBe(f.revision.documentHash);
  expect(result.components.find(c=>c.id!==target)).toEqual(f.document.components.find(c=>c.id!==target));
  if(kind==='font'||kind==='spacing'){const c=result.components.find(c=>c.id===target)!;expect(c.editingKind==='editable_text'&&c.textSource.text).toBe(f.brief.payload.name);expect(c.paths).not.toEqual(f.document.components[1]!.paths);}
  else expect(result.components.map(c=>c.paths.map(p=>p.d))).toEqual(f.document.components.map(c=>c.paths.map(p=>p.d)));
  expect(evidence).toMatchObject({proposalId:f.application.proposal.id,preparedId:f.application.preparedId,providerResponseReceiptId:f.application.providerResponseReceiptId,baseVectorRevisionId:f.revision.id,baseRevision:f.revision,locks:[]});
  expect(f.workspace.approvedLogo).toBeNull();expect(f.application.proposal.materialization).toBe('unavailable');
  expect(f.events.indexOf('application')).toBeLessThan(f.events.indexOf('asset'));expect(f.events.filter(e=>e==='stage')).toHaveLength(2);
 });
 it.each(['document','svg','raster','font'] as const)('rejects corrupted actual %s bytes before staging',async kind=>{
  const f=await proposalMutationFixture();if(kind==='font')f.fonts[0]!.bytes=new Uint8Array([1,2,3]);else f.files.get((kind==='document'?f.revision.documentAsset:kind==='svg'?f.revision.svgAsset:f.raster.reference).versionId)!.bytes=new Uint8Array([1,2,3]);
  await expect(f.run()).rejects.toBeDefined();expect(f.publications).toHaveLength(0);
 });
 it.each(['unsettled','unsupported','foreign','prepared','provider','duplicate'] as const)('rejects %s authority before source/font I/O',async reason=>{
  const f=await proposalMutationFixture();if(reason==='unsettled')f.application.eligible=false;if(reason==='unsupported')f.application.proposal.payload={version:1,status:'unsupported',code:'multiple_changes',explanation:'Split the request'};
  if(reason==='foreign')f.application.proposal.ownerId=randomUUID();if(reason==='prepared')f.application.preparedId=randomUUID();if(reason==='provider')f.application.providerResponseReceiptId=randomUUID();
  if(reason==='duplicate')f.application.materialization={version:1,ownerId:f.revision.ownerId,projectId:f.projectId,proposalId:f.application.proposal.id,requestKey:randomUUID(),vectorRevisionId:randomUUID(),revisionId:randomUUID(),createdAt:'2026-10-08T00:00:00Z'};
  await expect(f.run()).rejects.toBeDefined();expect(f.events).not.toContain('asset');expect(f.events).not.toContain('font');expect(f.publications).toHaveLength(0);
 });
 it.each(['heads','base','brief','rights','font_record','context'] as const)('rejects a changed %s basis',async reason=>{
  const f=await proposalMutationFixture();if(reason==='heads')f.workspace.heads.workspaceRevision++;if(reason==='base')f.deps.readCurrentVectorRevisionId=async()=>randomUUID();if(reason==='brief')f.brief.payload.name='Changed';
  if(reason==='rights')f.fonts[0]!.record.rights.permissions.outline='denied';if(reason==='font_record')f.fonts[0]!.record.family='Changed';if(reason==='context')f.application.proposal.context.documentHash='a'.repeat(64);
  await expect(f.run()).rejects.toBeDefined();expect(f.publications).toHaveLength(0);
 });
 it('rejects font and spacing on outlined custom lettering without presenting it as text',async()=>{
  for(const kind of ['font','spacing'] as const){const f=await proposalMutationFixture();f.application.proposal.payload={version:1,status:'proposed',edit:kind==='font'?{kind,componentId:'synthetic-lettering',fontVersionId:f.fonts[1]!.record.id}:{kind,componentId:'synthetic-lettering',letterSpacing:2,lineHeight:1},explanation:'Not supported'};await expect(f.run()).rejects.toBeDefined();expect(f.publications).toHaveLength(0);}
 });
 it('preserves a saved neighboring lock and rejects indirect occlusion and equivalent rotation',async()=>{
  const f=await proposalMutationFixture();f.seal(['synthetic-lettering']);await f.run();expect(f.publications).toHaveLength(2);
  for(const edit of [{kind:'rotation',componentId:'synthetic-symbol',degrees:360},{kind:'arrangement',order:f.document.components.map(c=>c.id),placements:[{componentId:'synthetic-symbol',transform:{...f.document.components[0]!.transform,x:80}}]}]){const g=await proposalMutationFixture();g.seal(['synthetic-lettering']);g.application.proposal.payload={version:1,status:'proposed',edit:edit as never,explanation:'Rejected edit'};await expect(g.run()).rejects.toBeDefined();expect(g.publications).toHaveLength(0);}
 });
 it.each(['before','after_document','after_svg'] as const)('fences cancellation %s and never returns publication evidence',async when=>{
  const f=await proposalMutationFixture(),c=new AbortController();if(when==='before')c.abort();else {const original=f.deps.assetStore.stageOwnedAsset;f.deps.assetStore.stageOwnedAsset=async(...args)=>{const r=await original(...args);if(f.publications.length===(when==='after_document'?1:2))c.abort();return r;};}
  await expect(f.run(c.signal)).rejects.toBeDefined();expect(f.publications.length).toBe(when==='before'?0:when==='after_document'?1:2);
 });
 it('rechecks current heads after shaping and before publishing',async()=>{
  const f=await proposalMutationFixture(),original=f.deps.textEdits.resolveFont;f.deps.textEdits.resolveFont=async(...args)=>{const r=await original(...args);f.workspace.heads.workspaceRevision++;return r;};await expect(f.run()).rejects.toBeDefined();expect(f.publications).toHaveLength(0);
 });
 it('reuses exact member keys and immutable bytes on a repeated uncommitted intent',async()=>{const f=await proposalMutationFixture(),first=await f.run();expect(await f.run()).toEqual(first);expect(f.publications).toHaveLength(2);});
 it.each(['root','delete','alias','neighbor','path','spelling'] as const)('defensive non-target preservation rejects %s substitution',async variation=>{
  const f=await proposalMutationFixture(undefined,true),candidate=structuredClone(f.document),edit={kind:'rotation' as const,componentId:'synthetic-symbol',degrees:10};candidate.components[0]!.transform.rotation=10;
  if(variation==='root')candidate.viewBox[2]++;if(variation==='delete')candidate.components.pop();if(variation==='alias')candidate.components[1]!.id='different';if(variation==='neighbor')candidate.components[1]!.transform.x++;if(variation==='path')candidate.components[0]!.paths[0]!.d='M0 0L10 0L0 10Z';
  if(variation==='spelling'){const c=candidate.components[1]!;if(c.editingKind==='editable_text')c.textSource.text='Other';}
  expect(()=>assertLogoProposalCandidatePreservation(f.document,candidate,edit)).toThrow();
 });
});

it('rejects a new glyph overlap with a locked neighbor only discoverable after real shaping',async()=>{
 const f=await proposalMutationFixture({kind:'spacing',componentId:'synthetic-lettering',letterSpacing:35,lineHeight:1},true);
 // Text starts at x=85. This independent locked ink is beyond its original
 // glyph bounds, but expanded real letter spacing intersects it.
 f.document.components.push({id:'locked-neighbor',role:'border',editingKind:'geometry',transform:{x:0,y:0,scale:1,rotation:0},paths:[{id:'neighbor-ink',d:'M280 80L310 80L310 145L280 145Z',fill:{color:'#000000',opacity:1},stroke:null,fillRule:'nonzero'}]});
 f.seal(['locked-neighbor']);
 await expect(f.run()).rejects.toMatchObject({code:'locked_component_changed'});expect(f.publications).toHaveLength(0);
});
it('preserves paint opacity, stroke width and absent channels rather than flattening target artwork',async()=>{
 const f=await proposalMutationFixture({kind:'color',componentId:'synthetic-symbol',fill:'#123456',stroke:'#ABCDEF'});
 const path=f.document.components[0]!.paths[0]!;path.fill!.opacity=0.3;path.stroke={color:'#111111',opacity:0.6,width:2,linecap:'round',linejoin:'bevel',miterLimit:5};f.seal();
 await f.run();const candidate=JSON.parse(new TextDecoder().decode(f.publications[0]!.bytes)),after=candidate.components[0].paths[0];
 expect(after.fill).toEqual({color:'#123456',opacity:0.3});expect(after.stroke).toEqual({...path.stroke,color:'#ABCDEF'});expect(after.d).toBe(path.d);
});
it('rejects zero geometric change even when syntactically valid and retains original spelling byte-for-byte',async()=>{
 const f=await proposalMutationFixture({kind:'rotation',componentId:'synthetic-symbol',degrees:0});await expect(f.run()).rejects.toMatchObject({code:'unsupported_edit'});expect(f.publications).toHaveLength(0);
 const text=await proposalMutationFixture({kind:'spacing',componentId:'synthetic-lettering',letterSpacing:1,lineHeight:1},true);await text.run();const candidate=JSON.parse(new TextDecoder().decode(text.publications[0]!.bytes));expect(candidate.components[1].textSource.text).toBe('A\u0301ster');expect(candidate.components[1].textSource.text).not.toBe('Áster');
});
