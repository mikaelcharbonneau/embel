import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {asRole,createTestDatabase,OWNER_A,OWNER_B,type TestDatabase} from './local-supabase';
import {proposalAdmissionFixture,proposalLogin,WEB,WORKER} from './logo-vector-proposal-admission-fixture';
import {completionLedger,proposalCompletionFixture,retained,resultFor} from './logo-vector-proposal-completion-fixture';
import {proposalFixture} from '../features/logo-vector/proposal-fixtures';
import {proposalObservation} from '../server/logo-vector-proposal-fixtures';
import {logoCostQuoteSchema,logoDispatchReceiptSchema} from '@/domain/logo-jobs';
import {logoVectorProposalProviderReceiptSchema} from '@/domain/logo-vector-proposal-jobs';
import {logoVectorProposalObservedResultSchema,logoVectorProposalPreparedReceiptSchema} from '@/domain/logo-vector-proposal-evidence';
import {createLogoVectorProposalService} from '@/server/data/logo-vector-proposals';
import type {AuthenticatedContext} from '@/server/auth/context';

const candidates=await Promise.all(['logo-vector-proposals.sql','logo-vector-proposal-quotes.sql','logo-vector-proposal-admission.sql','logo-vector-proposal-observations.sql','logo-vector-proposal-completion.sql'].map(name=>readFile(new URL('../../supabase/candidates/'+name,import.meta.url),'utf8')));
let db:TestDatabase;
beforeAll(async()=>{db=await createTestDatabase({additionalMigrations:candidates});},60_000);
afterAll(async()=>{await db?.close();});
const stepOutput=(p:{id:string;providerResponseReceiptId:string})=>({version:1,kind:'logo_vector_proposal',preparedId:p.id,providerResponseReceiptId:p.providerResponseReceiptId});

/** Test-only normal DAL adapter. Every read executes with the actual authenticated
 * SQL role and owner JWT fixture, never a service-role read or a saved JS record. */
function auth(owner:string):AuthenticatedContext {
 return {userId:owner,client:{rpc:async(name:string,args:Record<string,unknown>)=>{
  const detail=name==='read_logo_vector_proposal';
  if(!detail&&name!=='list_logo_vector_proposals')throw Error('Unexpected fixture RPC');
  const data=await asRole(db,'authenticated',owner,async()=>(await db.query<{v:unknown}>(`select public.${name}($1,$2) v`,[args.p_project_id,detail?args.p_proposal_id:args.p_query])).rows[0]!.v);
  return {data,error:null};
 }}} as unknown as AuthenticatedContext;
}
function freshSource(){
 const source=proposalFixture();source.revision.id=randomUUID();
 for(const ref of [source.revision.sourcePreview,source.revision.documentAsset,source.revision.svgAsset]){ref.assetId=randomUUID();ref.versionId=randomUUID();}
 for(const font of source.fonts){font.id=randomUUID();font.asset.assetId=randomUUID();font.asset.versionId=randomUUID();font.rights.id=randomUUID();}
 return source;
}
/** All proposal rows come from trusted quote, owner admission, original restricted
 * worker dispatch/observation/stage/completion and finish. No row insert shortcut. */
async function commitNext(f:Awaited<ReturnType<typeof proposalAdmissionFixture>>){
 const quote=logoCostQuoteSchema.parse((await proposalLogin(db,WEB,()=>db.query<{v:unknown}>('select fluid_private.quote_logo_vector_proposal($1,$2) v',[f.workspace.projectId,f.evidence]))).rows[0]!.v);
 const dispatch=logoDispatchReceiptSchema.parse(await f.admit({...f.intent,requestKey:randomUUID(),quoteId:quote.id}));
 const job=(await f.claim())!;expect(dispatch.jobIds).toEqual([job.id]);
 await f.worker(()=>db.query("select public.begin_logo_job_step($1,$2,'propose-vector-edit','once',122880)",[job.id,job.lease_token]));
 const receipt=logoVectorProposalProviderReceiptSchema.parse((await f.worker(()=>db.query<{v:unknown}>('select public.record_logo_provider_response($1,$2,$3) v',[job.id,job.lease_token,proposalObservation()]))).rows[0]!.v);
 const result=resultFor(f.context.components[0]!.id);
 const prepared=logoVectorProposalPreparedReceiptSchema.parse((await f.worker(()=>db.query<{v:unknown}>('select fluid_private.stage_logo_vector_proposal($1,$2,$3,$4) v',[job.id,job.lease_token,result,receipt.id]))).rows[0]!.v);
 await f.worker(()=>db.query("select public.complete_logo_job_step($1,$2,'propose-vector-edit','succeeded',34,$3,$4)",[job.id,job.lease_token,stepOutput(prepared),proposalObservation().providerRequestId]));
 await f.worker(()=>db.query("select public.finish_logo_job($1,$2,'succeeded')",[job.id,job.lease_token]));
 expect(await completionLedger(db,job.id)).toMatchObject({job:{state:'succeeded',actual_cost_microusd:34,lease_token:null},reservation:{state:'settled',actual_microusd:34}});
 return prepared.id;
}

it('settles a completed unsupported answer through restricted SQL and normal owned read, retaining its charge without a candidate',async()=>{
 const f=await proposalCompletionFixture(db);
 const payload={version:1,status:'unsupported',code:'multiple_changes',explanation:'This synthetic request asks for more than one independent edit.'};
 const result=logoVectorProposalObservedResultSchema.parse({status:'valid',payload,reason:null,retainedOutput:retained(JSON.stringify(payload))});
 const before=await completionLedger(db,f.j.id),prepared=await f.stage(result);
 expect(await f.stage(result)).toEqual(prepared);
 const completed=await f.complete('succeeded',34,stepOutput(prepared));
 expect(await f.complete('succeeded',34,stepOutput(prepared))).toEqual(completed);
 await f.finish('succeeded');
 expect(await f.complete('succeeded',34,stepOutput(prepared))).toEqual(completed);
 const record=await createLogoVectorProposalService().readLogoVectorProposal(auth(OWNER_A),f.workspace.projectId,prepared.id);
 expect(record).toMatchObject({id:prepared.id,jobId:f.j.id,state:'succeeded',payload,providerReceipt:f.receipt,actualCostMicrousd:34,reason:null,materialization:'unavailable'});
 expect(record.payload).not.toHaveProperty('edit');
 expect((await db.query<{result:unknown}>('select result from fluid_private.logo_vector_proposal_prepared_results where id=$1',[prepared.id])).rows[0]!.result).toEqual(result);
 expect(await completionLedger(db,f.j.id)).toMatchObject({job:{state:'succeeded',actual_cost_microusd:34,lease_token:null},reservation:{state:'settled',actual_microusd:34,captured_microusd:34},account:{spent_microusd:34,provider_actual_microusd:34,reserved_microusd:0}});
 expect(before.account).toMatchObject({spent_microusd:34,provider_actual_microusd:34});
 expect((await db.query('select id from public.logo_provider_responses where job_id=$1',[f.j.id])).rows).toHaveLength(1);
 expect((await db.query('select id from fluid_private.logo_vector_proposals where job_id=$1',[f.j.id])).rows).toHaveLength(1);
 expect((await db.query('select id from public.logo_vector_revisions')).rows).toEqual([{id:f.context.baseVectorRevisionId}]);
 expect((await db.query('select * from public.logo_asset_publications')).rows).toEqual([]);
 expect(await f.rpc('get_logo_workspace',[f.workspace.projectId])).toMatchObject({heads:f.workspace.heads});
});

it('reloads every committed owned proposal across tied keyset pages without duplicates, omissions or foreign project/owner leakage',async()=>{
 const first=await proposalAdmissionFixture(db,freshSource());
 await db.exec(`grant execute on function fluid_private.stage_logo_vector_proposal(uuid,uuid,jsonb,uuid) to ${WORKER};`);
 // Disposable clock fixture only: set the creation default before staging so
 // genuine immutable rows tie. No history update or disabled trigger is used.
 await db.exec("alter table fluid_private.logo_vector_proposal_prepared_results alter column created_at set default '2026-10-08T12:00:00.123456Z'::timestamptz");
 try {
  const ids:string[]=[];for(let i=0;i<5;i++)ids.push(await commitNext(first));
  const otherProject=await proposalAdmissionFixture(db,freshSource(),{preserve:true});
  const otherIds=[await commitNext(otherProject),await commitNext(otherProject)];
  const foreign=await proposalAdmissionFixture(db,freshSource(),{preserve:true,owner:OWNER_B});
  const foreignIds=[await commitNext(foreign),await commitNext(foreign)];
  expect((await db.query('select id from fluid_private.logo_vector_proposals')).rows).toHaveLength(9);
  expect((await db.query('select distinct created_at from fluid_private.logo_vector_proposals')).rows).toHaveLength(1);
  const expected=[...ids].sort().reverse(),loaded:string[]=[];
  const service=createLogoVectorProposalService();let cursor:string|undefined;
  for(let pageNumber=0;pageNumber<3;pageNumber++){
   const query={limit:2,...(cursor?{cursor}:{})};
   const page=await service.listLogoVectorProposals(auth(OWNER_A),first.workspace.projectId,query);
   // Simulate reload with a fresh DAL/auth object and the exact opaque cursor.
   expect(await createLogoVectorProposalService().listLogoVectorProposals(auth(OWNER_A),first.workspace.projectId,query)).toEqual(page);
   expect(page).toMatchObject({ownerId:OWNER_A,projectId:first.workspace.projectId});
   expect(page.items.map(item=>item.id)).toEqual(expected.slice(pageNumber*2,pageNumber*2+2));
   for(const item of page.items){
    loaded.push(item.id);
    const record=await createLogoVectorProposalService().readLogoVectorProposal(auth(OWNER_A),first.workspace.projectId,item.id);
    expect(record).toMatchObject({id:item.id,jobId:item.jobId,state:'succeeded',materialization:'unavailable',actualCostMicrousd:34});
   }
   if(pageNumber<2){expect(page.nextCursor).toEqual(expect.any(String));expect(page.nextCursor).not.toBe(cursor);cursor=page.nextCursor!;}
   else expect(page.nextCursor).toBeNull();
  }
  expect(loaded).toEqual(expected);expect(new Set(loaded).size).toBe(5);
  expect(loaded.some(id=>otherIds.includes(id)||foreignIds.includes(id))).toBe(false);
  expect((await service.listLogoVectorProposals(auth(OWNER_A),otherProject.workspace.projectId,{limit:50})).items.map(item=>item.id)).toEqual([...otherIds].sort().reverse());
  expect((await service.listLogoVectorProposals(auth(OWNER_B),foreign.workspace.projectId,{limit:50})).items.map(item=>item.id)).toEqual([...foreignIds].sort().reverse());
  await expect(service.listLogoVectorProposals(auth(OWNER_B),first.workspace.projectId,{limit:2})).rejects.toMatchObject({code:'not_found'});
  await expect(service.listLogoVectorProposals(auth(OWNER_A),foreign.workspace.projectId,{limit:2})).rejects.toMatchObject({code:'not_found'});
  await expect(service.readLogoVectorProposal(auth(OWNER_A),first.workspace.projectId,otherIds[0]!)).rejects.toMatchObject({code:'not_found'});
  await expect(service.readLogoVectorProposal(auth(OWNER_A),first.workspace.projectId,foreignIds[0]!)).rejects.toMatchObject({code:'not_found'});
  expect((await db.query('select owner_id,spent_microusd,provider_actual_microusd,reserved_microusd from public.usage_accounts order by owner_id')).rows).toEqual([
   {owner_id:OWNER_A,spent_microusd:238,provider_actual_microusd:238,reserved_microusd:0},
   {owner_id:OWNER_B,spent_microusd:68,provider_actual_microusd:68,reserved_microusd:0},
  ]);
 } finally {await db.exec('alter table fluid_private.logo_vector_proposal_prepared_results alter column created_at set default clock_timestamp()');}
});
