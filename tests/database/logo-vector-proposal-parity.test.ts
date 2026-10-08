import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createTestDatabase,type TestDatabase} from './local-supabase';
import {proposalCompletionFixture,retained,completionLedger} from './logo-vector-proposal-completion-fixture';
import {proposalFixture,proposed} from '../features/logo-vector/proposal-fixtures';
import {proposalObservation} from '../server/logo-vector-proposal-fixtures';
import {validateLogoVectorProposal} from '@/features/logo-vector/model/proposal';
const candidates=await Promise.all(['logo-vector-proposals.sql','logo-vector-proposal-quotes.sql','logo-vector-proposal-admission.sql','logo-vector-proposal-observations.sql','logo-vector-proposal-completion.sql'].map(name=>readFile(new URL('../../supabase/candidates/'+name,import.meta.url),'utf8')));
let db:TestDatabase;
beforeAll(async()=>{db=await createTestDatabase({additionalMigrations:candidates});},60_000);afterAll(async()=>{await db?.close();});
async function invalid(kind:'identity'|'equivalent'|'overlap'|'malformed'|'whitespace_nbsp'|'whitespace_tab'|'no_controls'){
 const source=proposalFixture();if(kind==='equivalent')source.document.components[0]!.transform={x:100,y:100,scale:1,rotation:180};if(kind==='no_controls')source.document.components[1]!.paths[0]!.fill!.opacity=0;source.seal(kind==='overlap'?[source.document.components[1]!.id]:[]);
 const f=await proposalCompletionFixture(db,{source}),components=f.context.components,placements=components.map(c=>({componentId:c.id,transform:{...c.transform}}));
 if(kind==='equivalent'){placements[0]!.transform.rotation=-180;placements[1]!.transform.x+=10;}
 if(kind==='overlap'){placements.splice(1);placements[0]!.transform.x=70;}
 if(kind==='no_controls')placements.splice(1);
 const edit=kind==='malformed'?{kind:'locks',componentIds:[]}:{kind:'arrangement',placements,order:kind==='no_controls'?components.map(c=>c.id).reverse():components.map(c=>c.id)},payload=proposed(kind.startsWith('whitespace')?{kind:'rotation',componentId:components[0]!.id,degrees:10}:edit);
 if(kind==='whitespace_nbsp')payload.explanation='\u00a0';if(kind==='whitespace_tab')payload.explanation='\t';
 const result={status:'valid',payload,reason:null,retainedOutput:retained(JSON.stringify(payload))};
 expect(()=>validateLogoVectorProposal(payload,f.context)).toThrow();if(kind==='no_controls')expect(()=>validateLogoVectorProposal(payload,f.context)).toThrow('This component does not support the requested control.');return{...f,result};
}
it.each(['identity','equivalent','overlap','whitespace_nbsp','whitespace_tab','no_controls'] as const)('rejects the core-invalid %s intent in actual restricted staging',async kind=>{
 const f=await invalid(kind);await expect(f.stage(f.result)).rejects.toMatchObject({code:'22023'});expect((await db.query('select * from fluid_private.logo_vector_proposal_prepared_results')).rows).toEqual([]);expect((await db.query('select * from fluid_private.logo_vector_proposals')).rows).toEqual([]);expect((await completionLedger(db,f.j.id)).account).toMatchObject({provider_actual_microusd:34,reserved_microusd:122846});
});
it.each(['identity','equivalent','overlap','malformed','whitespace_nbsp','whitespace_tab','no_controls'] as const)('retains a rejected %s intent only as incomplete raw diagnostics through ambiguous unpublished recovery',async kind=>{
 const f=await invalid(kind),outcome={error:'publication_unconfirmed',result:{version:1,kind:'logo_vector_proposal_unpublished',reason:'publication_unconfirmed',observation:proposalObservation(),result:f.result}};
 await f.complete('ambiguous',34,outcome);const p=(await db.query<{id:string;result:unknown}>('select id,result from fluid_private.logo_vector_proposal_prepared_results where job_id=$1',[f.j.id])).rows[0]!;
 expect(p.result).toEqual({status:'incomplete',payload:null,reason:'provider_outcome_unknown',retainedOutput:f.result.retainedOutput});expect(await f.read(p.id)).toMatchObject({state:'needs_reconciliation',payload:null,actualCostMicrousd:34,materialization:'unavailable'});await f.complete('ambiguous',34,outcome);
 expect((await completionLedger(db,f.j.id)).account).toEqual({spent_microusd:34,provider_actual_microusd:34,reserved_microusd:122846});expect((await completionLedger(db,f.j.id)).reservation).toMatchObject({state:'active'});
});
it.each(['size','rotation','spacing'] as const)('rejects SQL decimal precision that becomes a no-change %s in the normal JavaScript/core reader',async kind=>{
 const source=proposalFixture(kind==='spacing');if(kind==='rotation')source.document.components[0]!.transform.rotation=10;if(kind==='spacing'&&source.document.components[1]!.editingKind==='editable_text')source.document.components[1]!.textSource.letterSpacing=0.1;source.seal();
 const f=await proposalCompletionFixture(db,{source}),edit=kind==='size'?'"kind":"size","componentId":"synthetic-symbol","scale":1.00000000000000000001':kind==='rotation'?'"kind":"rotation","componentId":"synthetic-symbol","degrees":10.00000000000000000001':'"kind":"spacing","componentId":"synthetic-lettering","letterSpacing":0.100000000000000000001,"lineHeight":1';
 const payload=`{"version":1,"status":"proposed","edit":{${edit}},"explanation":"Synthetic decimal parity."}`;
 expect(()=>validateLogoVectorProposal(JSON.parse(payload),f.context)).toThrow();
 const raw=`{"status":"valid","payload":${payload},"reason":null,"retainedOutput":${JSON.stringify(retained(payload))}}`;
 await expect(f.stage(raw)).rejects.toMatchObject({code:'22023'});expect((await db.query('select * from fluid_private.logo_vector_proposal_prepared_results')).rows).toEqual([]);
});
it.each(['size','rotation','color','arrangement','font','spacing'] as const)('keeps a genuine %s intent readable through the normal owned DAL after SQL completion',async kind=>{
 const source=proposalFixture(kind==='font'||kind==='spacing');source.seal(kind==='arrangement'?[source.document.components[1]!.id]:[]);
 const f=await proposalCompletionFixture(db,{source}),symbol=f.context.components[0]!,lettering=f.context.components[1]!;
 const edit=kind==='size'?{kind,componentId:symbol.id,scale:1.2}:kind==='rotation'?{kind,componentId:symbol.id,degrees:10}:kind==='color'?{kind,componentId:symbol.id,fill:'#112233',stroke:null}:kind==='arrangement'?{kind,placements:[{componentId:symbol.id,transform:{...symbol.transform,x:10}}],order:f.context.components.map(c=>c.id)}:kind==='font'?{kind,componentId:lettering.id,fontVersionId:f.context.fonts[1]!.id}:{kind,componentId:lettering.id,letterSpacing:1,lineHeight:lettering.text!.lineHeight};
 const payload=validateLogoVectorProposal(proposed(edit),f.context),result={status:'valid',payload,reason:null,retainedOutput:retained(JSON.stringify(payload))},p=await f.stage(result);
 await f.complete('succeeded',34,{version:1,kind:'logo_vector_proposal',preparedId:p.id,providerResponseReceiptId:p.providerResponseReceiptId});expect(await f.read(p.id)).toMatchObject({state:'succeeded',payload,materialization:'unavailable'});await f.finish('succeeded');
});
it('does not overwrite a prepared receipt or retain false-hash bytes through diagnostic fallback',async()=>{
 const f=await proposalCompletionFixture(db),p=await f.stage();const malformed=proposed({kind:'locks',componentIds:[]}),rejected={status:'valid',payload:malformed,reason:null,retainedOutput:retained(JSON.stringify(malformed))};
 const envelope=(result:unknown)=>({error:'publication_unconfirmed',result:{version:1,kind:'logo_vector_proposal_unpublished',reason:'publication_unconfirmed',observation:proposalObservation(),result}});
 await expect(f.complete('ambiguous',34,envelope(rejected))).rejects.toMatchObject({code:'PT409'});expect((await db.query<{result:unknown}>('select result from fluid_private.logo_vector_proposal_prepared_results where id=$1',[p.id])).rows[0]!.result).toEqual(f.result);
 const next=await invalid('malformed');await expect(next.complete('ambiguous',34,envelope({...next.result,retainedOutput:{...next.result.retainedOutput,sha256:'0'.repeat(64)}}))).rejects.toMatchObject({code:'22023'});expect((await db.query('select * from fluid_private.logo_vector_proposal_prepared_results')).rows).toEqual([]);
});
