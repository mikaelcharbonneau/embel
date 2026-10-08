import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createTestDatabase,type TestDatabase,OWNER_A} from './local-supabase';
import {proposalAdmissionFixture,WORKER} from './logo-vector-proposal-admission-fixture';
import {proposalObservation} from '../server/logo-vector-proposal-fixtures';
import {logoVectorProposalProviderReceiptSchema,logoVectorProposalProviderObservationSchema,logoVectorProposalUsageCost} from '@/domain/logo-vector-proposal-jobs';
const candidates=await Promise.all(['logo-vector-proposals.sql','logo-vector-proposal-quotes.sql','logo-vector-proposal-admission.sql','logo-vector-proposal-observations.sql'].map(name=>readFile(new URL('../../supabase/candidates/'+name,import.meta.url),'utf8').catch(()=>'')));
let db:TestDatabase;
beforeAll(async()=>{db=await createTestDatabase({additionalMigrations:candidates});},60_000);afterAll(async()=>{await db?.close();});
async function fixture(start=true){
 const f=await proposalAdmissionFixture(db);await f.admitted();const j=(await f.claim())!;
 const begin=()=>f.worker(()=>db.query("select public.begin_logo_job_step($1,$2,'propose-vector-edit','once',122880)",[j.id,j.lease_token]));
 if(start)await begin();
 const record=(observation:unknown=proposalObservation(),lease=j.lease_token)=>f.worker(async()=>(await db.query<{v:unknown}>('select public.record_logo_provider_response($1,$2,$3) v',[j.id,lease,observation])).rows[0]!.v);
 const expire=async()=>{await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[j.id]);await f.worker(()=>db.query('select public.expire_logo_job_leases()'));};
 return{...f,j,begin,record,expire};
}
async function ledger(id:string){return{
 job:(await db.query('select state,actual_cost_microusd,lease_token from public.jobs where id=$1',[id])).rows[0],
 reservation:(await db.query('select state,reserved_microusd,actual_microusd,captured_microusd from public.usage_reservations where job_id=$1',[id])).rows[0],
 account:(await db.query('select spent_microusd,provider_actual_microusd,reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0],
};}
it('records immutable original dispatch authority only at the sole successful beginStep',async()=>{
 const f=await fixture(false);expect((await db.query('select * from fluid_private.logo_vector_proposal_dispatches')).rows).toEqual([]);
 await expect(f.record()).rejects.toMatchObject({code:'55000'});await f.begin();
 const a=(await db.query('select * from fluid_private.logo_vector_proposal_dispatches')).rows[0]!;
 expect(a).toMatchObject({job_id:f.j.id,owner_id:OWNER_A,project_id:f.workspace.projectId,role_name:WORKER,worker_id:'proposal-fixture',lease_token:f.j.lease_token,step_key:'propose-vector-edit',step_request_key:'once',input:f.j.input});
 await expect(f.begin()).rejects.toMatchObject({code:'55000'});expect((await db.query('select * from fluid_private.logo_vector_proposal_dispatches')).rows).toHaveLength(1);
});
it('captures a known expense once without completion or releasing the remaining reservation',async()=>{
 const f=await fixture(),raw=await f.record(),r=logoVectorProposalProviderReceiptSchema.parse(raw);
 expect(r).toMatchObject({ownerId:OWNER_A,projectId:f.workspace.projectId,jobId:f.j.id,leaseToken:f.j.lease_token,observation:proposalObservation()});
 const expected={job:{state:'running',actual_cost_microusd:34,lease_token:f.j.lease_token},reservation:{state:'active',reserved_microusd:122880,actual_microusd:34,captured_microusd:34},account:{spent_microusd:34,provider_actual_microusd:34,reserved_microusd:122846}};
 expect(await ledger(f.j.id)).toEqual(expected);expect(await f.record()).toEqual(raw);expect(await ledger(f.j.id)).toEqual(expected);
 expect((await db.query('select state,actual_cost_microusd from public.job_steps where job_id=$1',[f.j.id])).rows).toEqual([{state:'in_flight',actual_cost_microusd:34}]);
 expect((await db.query('select * from fluid_private.logo_vector_proposals')).rows).toEqual([]);
 await expect(f.record({...proposalObservation(),providerRequestId:'different'})).rejects.toMatchObject({code:'PT409'});
 await expect(f.worker(()=>db.query("select public.complete_logo_job_step($1,$2,'propose-vector-edit','failed',0,$3,null)",[f.j.id,f.j.lease_token,{error:'not_dispatched'}]))).rejects.toMatchObject({code:'55000',message:'logo_vector_proposal_evidence_unavailable'});
});
it('retains late original-authority evidence after expiry, cancellation and policy revocation',async()=>{
 const f=await fixture();await f.rpc('request_job_cancel',[f.j.id]);await db.query('update fluid_private.logo_runtime_policies set enabled=false');await f.report([]);await f.expire();
 const r=await f.record();expect(logoVectorProposalProviderReceiptSchema.parse(r).observation).toEqual(proposalObservation());
 expect(await ledger(f.j.id)).toMatchObject({job:{state:'needs_reconciliation',actual_cost_microusd:34,lease_token:null},reservation:{state:'active',actual_microusd:34},account:{reserved_microusd:122846}});
 expect(await f.record()).toEqual(r);expect(await f.claim()).toBeUndefined();
});
it('retains unknown identity and usage without fabricating requested model or releasing a reservation',async()=>{
 const f=await fixture(),o={...proposalObservation(),model:null,serviceTier:null,responseId:null,responseHash:null,responseComplete:false,toolCalls:null,usage:null,billing:{status:'unknown',confirmedMicrousd:null}};
 const r=logoVectorProposalProviderReceiptSchema.parse(await f.record(o));expect(r.observation).toEqual(o);
 expect(await ledger(f.j.id)).toMatchObject({job:{state:'needs_reconciliation',actual_cost_microusd:0,lease_token:null},reservation:{state:'active',actual_microusd:0},account:{reserved_microusd:122880,provider_actual_microusd:0}});
 expect((await db.query<{v:boolean}>('select fluid_private.api_text_paid_paused($1) v',[OWNER_A])).rows[0]!.v).toBe(true);
 expect(await f.rpc('reconcile_logo_request',[f.workspace.projectId,f.intent.requestKey])).toMatchObject({billing:{status:'unknown',confirmedMicrousd:null}});
 expect((await ledger(f.j.id)).reservation).toMatchObject({state:'active'});
});
it('retains known over-reservation/budget cost without negative balances, clipping expense or duplicate capture',async()=>{
 const f=await fixture(),usage={inputTokens:100000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:3},cost=logoVectorProposalUsageCost(usage);
 await db.query('update public.usage_accounts set limit_microusd=122880 where owner_id=$1',[OWNER_A]);
 const o={...proposalObservation(),usage,billing:{status:'recorded',confirmedMicrousd:cost}},r=await f.record(o);
 expect(await ledger(f.j.id)).toEqual({job:{state:'needs_reconciliation',actual_cost_microusd:cost,lease_token:null},reservation:{state:'active',reserved_microusd:122880,actual_microusd:cost,captured_microusd:122880},account:{spent_microusd:122880,provider_actual_microusd:cost,reserved_microusd:0}});
 expect(await f.record(o)).toEqual(r);expect((await ledger(f.j.id)).account).toMatchObject({provider_actual_microusd:cost});
 expect((await db.query<{v:boolean}>('select fluid_private.api_text_paid_paused($1) v',[OWNER_A])).rows[0]!.v).toBe(true);
});
it('fences wrong original tokens and exact replay by rebound or same-owner different principals',async()=>{
 const f=await fixture(),r=await f.record();expect(r).toBeDefined();await expect(f.record(proposalObservation(),randomUUID())).rejects.toMatchObject({code:'42501'});
 await db.exec('create role fixture_proposal_other login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;grant usage on schema public to fixture_proposal_other;grant execute on function public.record_logo_provider_response(uuid,uuid,jsonb) to fixture_proposal_other;');
 await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_proposal_other'",[OWNER_A]);
 await db.exec('set session authorization fixture_proposal_other');try{await expect(db.query('select public.record_logo_provider_response($1,$2,$3)',[f.j.id,f.j.lease_token,proposalObservation()])).rejects.toMatchObject({code:'42501'});}finally{await db.exec('set session authorization postgres');}
 await db.query('update fluid_private.logo_worker_principals set role_oid=(role_oid::bigint+100000)::oid where role_name=$1',[WORKER]);
 await expect(f.record()).rejects.toMatchObject({code:'42501'});expect((await ledger(f.j.id)).account).toMatchObject({provider_actual_microusd:34});
});
it('rejects fabricated cost, requested-model fallback, token contradictions, extraneous fields and unpriced high-input billing directly in SQL',async()=>{
 const f=await fixture();
 const bad=[{...proposalObservation(),billing:{status:'recorded',confirmedMicrousd:35}},{...proposalObservation(),model:null},{...proposalObservation(),toolCalls:null},{...proposalObservation(),serviceTier:'priority'},{...proposalObservation(),usage:{inputTokens:2,cachedInputTokens:3,cacheWriteInputTokens:0,outputTokens:3}},{...proposalObservation(),artifactHash:'a'.repeat(64)},{...proposalObservation(),providerRequestId:'x'.repeat(201)},{...proposalObservation(),observedAt:'9999-10-08T00:00:00Z'},{...proposalObservation(),billing:{status:'unknown',confirmedMicrousd:0}},{...proposalObservation(),usage:{inputTokens:272001,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:3},billing:{status:'recorded',confirmedMicrousd:544032}}];
 for(const o of bad)await expect(f.record(o)).rejects.toMatchObject({code:'22023'});
 expect((await db.query('select * from public.logo_provider_responses')).rows).toEqual([]);expect((await ledger(f.j.id)).account).toMatchObject({provider_actual_microusd:0,reserved_microusd:122880});
 const o=logoVectorProposalProviderObservationSchema.parse({...proposalObservation(),usage:{inputTokens:272001,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:3},billing:{status:'unknown',confirmedMicrousd:null}});
 expect(logoVectorProposalProviderReceiptSchema.parse(await f.record(o)).observation).toEqual(o);
});
it('retains in-cap cost from over-admitted usage and missing response identity as reconciliation-only',async()=>{
 for(const change of [{usage:{inputTokens:50000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:3}},{usage:{inputTokens:2,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:4100}},{responseId:null}]){
  const f=await fixture(),o={...proposalObservation(),...change};o.billing.confirmedMicrousd=logoVectorProposalUsageCost(o.usage);await f.record(o);
  expect(await ledger(f.j.id)).toMatchObject({job:{state:'needs_reconciliation',actual_cost_microusd:o.billing.confirmedMicrousd},reservation:{state:'active',actual_microusd:o.billing.confirmedMicrousd},account:{reserved_microusd:122880-o.billing.confirmedMicrousd}});
 }
});
it('holds known expense as accounting-unconfirmed when exact safe ledger capacity is exhausted',async()=>{
 const f=await fixture();await db.query('update public.usage_accounts set provider_actual_microusd=9007199254740991 where owner_id=$1',[OWNER_A]);
 const r=logoVectorProposalProviderReceiptSchema.parse(await f.record());expect(r.observation.billing).toEqual({status:'recorded',confirmedMicrousd:34});
 expect(await ledger(f.j.id)).toEqual({job:{state:'needs_reconciliation',actual_cost_microusd:34,lease_token:null},reservation:{state:'active',reserved_microusd:122880,actual_microusd:0,captured_microusd:0},account:{spent_microusd:0,provider_actual_microusd:9007199254740991,reserved_microusd:122880}});
 expect((await db.query('select error_code from public.jobs where id=$1',[f.j.id])).rows[0]).toEqual({error_code:'provider_accounting_unconfirmed'});
 const before=await ledger(f.j.id);await f.rpc('reconcile_logo_request',[f.workspace.projectId,f.intent.requestKey]);expect(await f.record()).toEqual(r);expect(await ledger(f.j.id)).toEqual(before);
});
it('checks the current principal and original worker/input/step bindings before any exact replay',async()=>{
 const f=await fixture(),r=await f.record();
 await db.query("update public.jobs set worker_id='changed-worker' where id=$1",[f.j.id]);await expect(f.record()).rejects.toMatchObject({code:'42501'});await db.query("update public.jobs set worker_id='proposal-fixture' where id=$1",[f.j.id]);
 await db.query("update public.jobs set input=jsonb_set(input,'{instruction}','\"changed\"') where id=$1",[f.j.id]);await expect(f.record()).rejects.toMatchObject({code:'42501'});await db.query('update public.jobs set input=$2 where id=$1',[f.j.id,f.j.input]);
 await db.query("update public.job_steps set request_key='changed-step' where job_id=$1",[f.j.id]);await expect(f.record()).rejects.toMatchObject({code:'42501'});await db.query("update public.job_steps set request_key='once' where job_id=$1",[f.j.id]);
 expect(await f.record()).toEqual(r);await db.query('delete from fluid_private.logo_worker_principals where role_name=$1',[WORKER]);await expect(f.record()).rejects.toMatchObject({code:'42501'});
});
it('preserves current-lease cancellation expense and stale-source evidence without publishing or settling',async()=>{
 const f=await fixture();await f.rpc('request_job_cancel',[f.j.id]);await db.query('update public.logo_workspaces set revision=revision+1 where project_id=$1',[f.workspace.projectId]);
 await f.record();expect(await ledger(f.j.id)).toMatchObject({job:{state:'cancel_requested',actual_cost_microusd:34,lease_token:f.j.lease_token},reservation:{state:'active'},account:{reserved_microusd:122846}});
 await expect(f.worker(()=>db.query("select public.finish_logo_job($1,$2,'cancelled')",[f.j.id,f.j.lease_token]))).rejects.toMatchObject({code:'55000',message:'unresolved_steps'});
 expect((await db.query('select * from public.logo_asset_publications')).rows).toEqual([]);expect((await db.query('select * from fluid_private.logo_vector_proposals')).rows).toEqual([]);
});
it('makes authority and provider evidence append-only even for privileged accidental mutations',async()=>{
 const f=await fixture();await f.record();
 for(const sql of ["update fluid_private.logo_vector_proposal_dispatches set worker_id='changed' where job_id=$1",'delete from fluid_private.logo_vector_proposal_dispatches where job_id=$1',"update public.logo_provider_responses set observation='{}' where job_id=$1",'delete from public.logo_provider_responses where job_id=$1'])await expect(db.query(sql,[f.j.id])).rejects.toBeDefined();
 expect((await db.query('select * from fluid_private.logo_vector_proposal_dispatches')).rows).toHaveLength(1);expect((await db.query('select * from public.logo_provider_responses')).rows).toHaveLength(1);
});
it('uses the real DAL to retain the original receipt after its lease is gone',async()=>{
 const {parseClaimedJob}=await import('../../worker/postgres-store'),{createLogoVectorProposalObservationPorts}=await import('@/server/data/logo-vector-proposal-worker');
 const f=await fixture(),job=parseClaimedJob(f.j);await f.expire();
 const ports=createLogoVectorProposalObservationPorts(db);expect((await f.worker(()=>ports.recordResponse(job,logoVectorProposalProviderObservationSchema.parse(proposalObservation())))).observation).toEqual(proposalObservation());
 expect((await ledger(job.id)).account).toMatchObject({provider_actual_microusd:34,reserved_microusd:122846});
});
it('retains 34 of known expense without capture when aggregate 100 cannot cover the full 122880 outstanding reservation',async()=>{
 const f=await fixture();await db.query('update public.usage_accounts set reserved_microusd=100 where owner_id=$1',[OWNER_A]);
 const r=logoVectorProposalProviderReceiptSchema.parse(await f.record());expect(r.observation.billing).toEqual({status:'recorded',confirmedMicrousd:34});
 expect(await ledger(f.j.id)).toEqual({job:{state:'needs_reconciliation',actual_cost_microusd:34,lease_token:null},reservation:{state:'active',reserved_microusd:122880,actual_microusd:0,captured_microusd:0},account:{spent_microusd:0,provider_actual_microusd:0,reserved_microusd:100}});
 expect((await db.query('select error_code from public.jobs where id=$1',[f.j.id])).rows[0]).toEqual({error_code:'provider_accounting_unconfirmed'});
 const before=await ledger(f.j.id);expect(await f.record()).toEqual(r);await f.rpc('reconcile_logo_request',[f.workspace.projectId,f.intent.requestKey]);expect(await ledger(f.j.id)).toEqual(before);
});
