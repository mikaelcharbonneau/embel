import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createTestDatabase,type TestDatabase,OWNER_B} from './local-supabase';
import {proposalCompletionFixture,completionLedger,retained} from './logo-vector-proposal-completion-fixture';
import {proposalObservation} from '../server/logo-vector-proposal-fixtures';
import {logoVectorProposalUsageCost} from '@/domain/logo-vector-proposal-jobs';
const candidates=await Promise.all(['logo-vector-proposals.sql','logo-vector-proposal-quotes.sql','logo-vector-proposal-admission.sql','logo-vector-proposal-observations.sql','logo-vector-proposal-completion.sql'].map(name=>readFile(new URL('../../supabase/candidates/'+name,import.meta.url),'utf8').catch(()=>'')));
let db:TestDatabase;
beforeAll(async()=>{db=await createTestDatabase({additionalMigrations:candidates});},60_000);afterAll(async()=>{await db?.close();});
const output=(p:{id:string;providerResponseReceiptId:string})=>({version:1,kind:'logo_vector_proposal',preparedId:p.id,providerResponseReceiptId:p.providerResponseReceiptId});
it('stages and completes one owned provisional result without recapturing the bill or creating artwork',async()=>{
 const f=await proposalCompletionFixture(db),before=await completionLedger(db,f.j.id),p=await f.stage();
 expect(await f.stage()).toEqual(p);expect((await db.query('select * from fluid_private.logo_vector_proposals')).rows).toEqual([]);
 const first=await f.complete('succeeded',34,output(p));expect(await f.complete('succeeded',34,output(p))).toEqual(first);expect((await completionLedger(db,f.j.id)).account).toEqual(before.account);
 const r=await f.read(p.id);expect(r).toMatchObject({state:'succeeded',payload:f.result.payload,providerReceipt:f.receipt,actualCostMicrousd:34,materialization:'unavailable',reason:null});
 await f.finish('succeeded');expect(await f.complete('succeeded',34,output(p))).toEqual(first);
 expect(await completionLedger(db,f.j.id)).toMatchObject({job:{state:'succeeded',actual_cost_microusd:34,lease_token:null},reservation:{state:'settled',actual_microusd:34},account:{provider_actual_microusd:34,spent_microusd:34,reserved_microusd:0}});
 expect((await db.query('select * from public.logo_asset_publications')).rows).toEqual([]);expect((await db.query('select id from public.logo_vector_revisions')).rows).toHaveLength(1);
 await expect(f.rpc('read_logo_vector_proposal',[f.workspace.projectId,p.id],OWNER_B)).rejects.toMatchObject({code:'P0002'});
});
it('retains billed invalid UTF-8/NUL output as a failed result with known expense',async()=>{
 const f=await proposalCompletionFixture(db),result={status:'invalid',payload:null,reason:'invalid_output',retainedOutput:retained(new Uint8Array([0,255,97]))},p=await f.stage(result);
 await f.complete('failed',34,{error:'invalid_output',result:output(p)});await f.finish('failed');expect(await f.read(p.id)).toMatchObject({state:'failed',payload:null,reason:'invalid_output',actualCostMicrousd:34});
 expect((await db.query<{result:unknown}>('select result from fluid_private.logo_vector_proposal_prepared_results where id=$1',[p.id])).rows[0]!.result).toEqual(result);
 expect((await completionLedger(db,f.j.id)).account).toEqual({spent_microusd:34,provider_actual_microusd:34,reserved_microusd:0});
});
it('retains unknown usage and full reservation through prepared output and completion',async()=>{
 const observation={...proposalObservation(),usage:null,billing:{status:'unknown',confirmedMicrousd:null}},f=await proposalCompletionFixture(db,{observation}),p=await f.stage();
 await f.complete('ambiguous',0,{error:'provider_evidence_incomplete',result:output(p)});expect(await f.read(p.id)).toMatchObject({state:'needs_reconciliation',payload:f.result.payload,actualCostMicrousd:0});
 expect(await completionLedger(db,f.j.id)).toMatchObject({job:{state:'needs_reconciliation',actual_cost_microusd:0},reservation:{state:'active'},account:{reserved_microusd:122880,provider_actual_microusd:0}});
 await expect(f.finish('failed')).rejects.toBeDefined();
});
it('permits free failure only for exact positive nondispatch without conflicting provider evidence',async()=>{
 const f=await proposalCompletionFixture(db,{observe:false});await f.complete('failed',0,{error:'not_dispatched'},null);await f.finish('failed');expect((await completionLedger(db,f.j.id)).account).toEqual({spent_microusd:0,provider_actual_microusd:0,reserved_microusd:0});expect((await db.query('select * from fluid_private.logo_vector_proposals')).rows).toEqual([]);
 const paid=await proposalCompletionFixture(db);await expect(paid.complete('failed',0,{error:'not_dispatched'},null)).rejects.toBeDefined();expect((await completionLedger(db,paid.j.id)).account).toMatchObject({provider_actual_microusd:34,reserved_microusd:122846});
});
it('retains a late callback bill and bounded output after bare runner uncertainty, preserving original zero-cost replay',async()=>{
 const f=await proposalCompletionFixture(db,{observe:false}),bare={error:'provider_outcome_unknown'};await f.complete('ambiguous',0,bare,null);
 const receipt=await f.record(),p=await f.stage(f.result,receipt.id);expect(await f.read(p.id)).toMatchObject({state:'needs_reconciliation',payload:f.result.payload,actualCostMicrousd:34,providerReceipt:receipt});
 await expect(f.complete('ambiguous',0,bare,null)).resolves.toBeDefined();await expect(f.complete('ambiguous',34,bare,null)).rejects.toBeDefined();
 expect((await completionLedger(db,f.j.id)).account).toEqual({spent_microusd:34,provider_actual_microusd:34,reserved_microusd:122846});
});
it('recovers lost observation and stage acknowledgments from the exact unpublished envelope with no second capture',async()=>{
 for(const saved of [false,true]){
  const f=await proposalCompletionFixture(db,{observe:saved});if(saved)await f.stage();const reason=saved?'publication_unconfirmed':'provider_evidence_unconfirmed';
  const value={error:reason,result:{version:1,kind:'logo_vector_proposal_unpublished',reason,observation:proposalObservation(),result:f.result}};
  await f.complete('ambiguous',34,value);await f.complete('ambiguous',34,value);
  const p=(await db.query<{id:string}>('select id from fluid_private.logo_vector_proposal_prepared_results where job_id=$1',[f.j.id])).rows[0]!;expect(await f.read(p.id)).toMatchObject({state:'needs_reconciliation',payload:f.result.payload,actualCostMicrousd:34});
  expect((await db.query('select * from public.logo_provider_responses')).rows).toHaveLength(1);expect((await db.query('select * from fluid_private.logo_vector_proposals')).rows).toHaveLength(1);expect((await completionLedger(db,f.j.id)).account).toEqual({spent_microusd:34,provider_actual_microusd:34,reserved_microusd:122846});
 }
});
it('never turns known overage or inconsistent accounting into successful settlement',async()=>{
 for(const anomaly of ['overage','ledger']){
  const usage={inputTokens:100000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:3},o=anomaly==='overage'?{...proposalObservation(),usage,billing:{status:'recorded',confirmedMicrousd:logoVectorProposalUsageCost(usage)}}:proposalObservation();
  const f=await proposalCompletionFixture(db,{observe:false});if(anomaly==='ledger')await db.query('update public.usage_accounts set reserved_microusd=100 where owner_id=$1',[f.j.owner_id]);const r=await f.record(o),p=await f.stage(f.result,r.id);
  await expect(f.complete('succeeded',o.billing.confirmedMicrousd,output(p))).rejects.toBeDefined();await f.complete('ambiguous',o.billing.confirmedMicrousd,{error:'provider_cost_exceeded',result:output(p)});
  expect(await f.read(p.id)).toMatchObject({state:'needs_reconciliation',actualCostMicrousd:o.billing.confirmedMicrousd});expect((await completionLedger(db,f.j.id)).reservation).toMatchObject({state:'active'});
 }
});
it('projects a committed prepared result after a worker crash, and expiry/recovery cannot capture twice or replace it',async()=>{
 const f=await proposalCompletionFixture(db),p=await f.stage(),before=(await completionLedger(db,f.j.id)).account;await f.expire();
 const first=await f.read(p.id);expect(first).toMatchObject({state:'needs_reconciliation',reason:'lease_expired_with_prepared_result',payload:f.result.payload,actualCostMicrousd:34});
 expect((await completionLedger(db,f.j.id)).account).toEqual(before);expect((await completionLedger(db,f.j.id)).reservation).toMatchObject({state:'active'});
 await f.worker(()=>db.query('select public.expire_logo_job_leases()'));expect(await f.read(p.id)).toEqual(first);expect(await f.stage()).toEqual(p);expect(await f.record()).toEqual(f.receipt);
 await f.complete('ambiguous',34,{error:'provider_evidence_incomplete',result:output(p)});await f.complete('ambiguous',34,{error:'provider_evidence_incomplete',result:output(p)});expect(await f.read(p.id)).toEqual(first);expect((await completionLedger(db,f.j.id)).account).toEqual(before);
 await expect(f.stage({...f.result,reason:'changed'},p.providerResponseReceiptId)).rejects.toMatchObject({code:'PT409'});await expect(f.stage(f.result,'cccccccc-cccc-4ccc-8ccc-cccccccccccc')).rejects.toMatchObject({code:'PT409'});
});
it('rejects missing/substituted receipts, noncanonical or false hashes, extra fields, and forbidden replacement commands directly in restricted SQL',async()=>{
 const next=await proposalCompletionFixture(db);
 await expect(next.worker(()=>db.query('select fluid_private.stage_logo_vector_proposal($1,$2,$3,null)',[next.j.id,next.j.lease_token,next.result]))).rejects.toMatchObject({code:'22023'});
 for(const value of [{...next.result,ownerId:OWNER_B},{...next.result,retainedOutput:{...next.result.retainedOutput,sha256:'0'.repeat(64)}},{...next.result,retainedOutput:{...next.result.retainedOutput,data:'AB==',byteLength:1}}])await expect(next.stage(value)).rejects.toMatchObject({code:'22023'});
 for(const edit of [{kind:'text',componentId:'synthetic-symbol',text:'Other brand'},{kind:'locks',componentIds:[]},{kind:'group_components',regions:[]},{kind:'replace_outlined_lettering',componentId:'synthetic-symbol',fontVersionId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',text:'Other brand'},{kind:'rotation',componentId:'foreign',degrees:10},{kind:'rotation',componentId:'synthetic-symbol',degrees:10,paths:[]}]){
  const payload={version:1,status:'proposed',edit,explanation:'Synthetic invalid direct command.'},value={status:'valid',payload,reason:null,retainedOutput:retained(JSON.stringify(payload))};await expect(next.stage(value)).rejects.toMatchObject({code:'22023'});
 }
 expect((await db.query('select * from fluid_private.logo_vector_proposal_prepared_results')).rows).toEqual([]);expect((await completionLedger(db,next.j.id)).account).toMatchObject({provider_actual_microusd:34,reserved_microusd:122846});
});
it('keeps original-dispatch evidence reads available after expiry while ordinary leased reads still fail',async()=>{
 const f=await proposalCompletionFixture(db);await f.expire();
 const frozen=(await f.worker(()=>db.query<{v:unknown}>("select public.read_leased_logo_record($1,$2,'vector_proposal_evidence_inputs',null) v",[f.j.id,f.j.lease_token]))).rows[0]!.v;expect(frozen).toEqual({input:f.j.input,context:f.context});
 await expect(f.worker(()=>db.query("select public.read_leased_logo_record($1,$2,'vector_proposal_inputs',null)",[f.j.id,f.j.lease_token]))).rejects.toMatchObject({code:'40001'});
 await expect(f.worker(()=>db.query("select public.read_leased_logo_record($1,$2,'vector_proposal_evidence_inputs',null)",[f.j.id,'cccccccc-cccc-4ccc-8ccc-cccccccccccc']))).rejects.toMatchObject({code:'42501'});
});
it('retains a completed provisional proposal through cancellation without applying or approving it',async()=>{
 const f=await proposalCompletionFixture(db),p=await f.stage();await f.rpc('request_job_cancel',[f.j.id]);await f.complete('succeeded',34,output(p));await f.finish('cancelled');
 expect(await f.read(p.id)).toMatchObject({state:'succeeded',payload:f.result.payload,materialization:'unavailable'});expect((await completionLedger(db,f.j.id)).job).toMatchObject({state:'cancelled',actual_cost_microusd:34});expect((await completionLedger(db,f.j.id)).reservation).toMatchObject({state:'settled'});
 expect((await db.query('select * from public.logo_asset_publications')).rows).toEqual([]);expect((await f.rpc('get_logo_workspace',[f.workspace.projectId]))).toMatchObject({heads:f.workspace.heads});
});
