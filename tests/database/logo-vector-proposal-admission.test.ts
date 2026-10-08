import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createTestDatabase,type TestDatabase} from './local-supabase';
import {proposalAdmissionFixture} from './logo-vector-proposal-admission-fixture';
import {logoCostQuoteSchema,logoDispatchReceiptSchema} from '@/domain/logo-jobs';
import {logoVectorProposalJobInputSchema} from '@/domain/logo-vector-proposal-jobs';
import {createLogoVectorProposalAdmissionPorts} from '@/server/data/logo-vector-proposal-worker';
import {parseClaimedJob} from '../../worker/postgres-store';
const candidates=await Promise.all(['logo-vector-proposals.sql','logo-vector-proposal-quotes.sql','logo-vector-proposal-admission.sql'].map(name=>readFile(new URL('../../supabase/candidates/'+name,import.meta.url),'utf8').catch(()=>'')));
let db:TestDatabase;
beforeAll(async()=>{db=await createTestDatabase({additionalMigrations:candidates});},60_000);afterAll(async()=>{await db?.close();});
it('admits exactly one independently priced API job and one durable step, without abusing the subscription policy column',async()=>{
 const f=await proposalAdmissionFixture(db),receipt=await f.admitted();expect(receipt.jobIds).toHaveLength(1);
 const row=(await db.query<{input:unknown;policy_identity:null;max_attempts:number;billing_mode:string;plan_manifest:unknown}>('select * from public.jobs where id=$1',[receipt.jobIds[0]])).rows[0]!;
 expect(logoVectorProposalJobInputSchema.parse(row.input)).toMatchObject({operation:'identity.logo_vector_propose',requestKey:f.intent.requestKey,textPolicy:f.policy});
 expect(row).toMatchObject({policy_identity:null,max_attempts:1,billing_mode:'openai_api',plan_manifest:[{key:'propose-vector-edit',maximumCostMicrousd:122880}]});
 expect((await db.query('select reserved_microusd from public.usage_reservations')).rows).toEqual([{reserved_microusd:122880}]);
});
it('retains the original receipt before freshness checks and rejects changed-body reuse',async()=>{
 const f=await proposalAdmissionFixture(db),first=await f.admitted();
 await db.query('update public.logo_workspaces set revision=revision+1 where project_id=$1',[f.workspace.projectId]);await db.query('update fluid_private.logo_runtime_policies set enabled=false');
 expect(await f.admit()).toEqual(first);await expect(f.admit({...f.intent,acceptedMaxCostMicrousd:122881})).rejects.toMatchObject({code:'PT409'});
 expect((await db.query('select id from public.jobs')).rows).toHaveLength(1);
});

import {randomUUID} from 'node:crypto';
import {asRole,OWNER_A,OWNER_B} from './local-supabase';
import {WEB,WORKER,proposalLogin} from './logo-vector-proposal-admission-fixture';
it('never substitutes missing proposal readiness with another lane',async()=>{
 const f=await proposalAdmissionFixture(db);expect(await f.report([])).toBe(true);
 await expect(f.admit()).rejects.toMatchObject({code:'55000'});expect((await db.query('select * from public.jobs')).rows).toEqual([]);
 await db.query('update fluid_private.logo_runtime_policies set enabled=false');expect(await f.admit()).toMatchObject({kind:'logo_admission_rejected'});expect((await db.query('select * from public.jobs')).rows).toEqual([]);
});
it('fences under-cap intent and foreign admission without creating a job',async()=>{
 const f=await proposalAdmissionFixture(db);await expect(f.admit(f.intent,OWNER_B)).rejects.toMatchObject({code:'P0002'});
 const low={...f.intent,acceptedMaxCostMicrousd:122879};const first=await f.admit(low);expect(first).toMatchObject({kind:'logo_admission_rejected',errorCode:'conflict'});
 expect(await f.admit(low)).toEqual(first);await expect(f.admit()).rejects.toMatchObject({code:'PT409'});expect((await db.query('select * from public.jobs')).rows).toEqual([]);expect((await db.query('select * from public.usage_reservations')).rows).toEqual([]);
});
it('rejects tampered immutable quote context independently of browser parsing',async()=>{
 const f=await proposalAdmissionFixture(db),id=randomUUID();
 await db.query("insert into public.logo_cost_quotes(id,owner_id,project_id,operation,record,input_revisions,source_inputs,expires_at) select $2,owner_id,project_id,operation,record||jsonb_build_object('id',$2::uuid),input_revisions,jsonb_set(source_inputs,'{context,documentHash}',to_jsonb(repeat('0',64))),expires_at from public.logo_cost_quotes where id=$1",[f.quote.id,id]);
 expect(await f.admit({...f.intent,quoteId:id})).toMatchObject({kind:'logo_admission_rejected',errorCode:'conflict'});expect((await db.query('select * from public.jobs')).rows).toEqual([]);
});
it('keeps generic claims isolated and exposes only the exact leased AI-safe context',async()=>{
 const f=await proposalAdmissionFixture(db);await f.admitted();expect((await asRole(db,'service_role',null,()=>db.query("select * from public.claim_job('generic',60)"))).rows).toEqual([]);
 const j=(await f.claim())!;expect(j).toBeDefined();expect(j).toMatchObject({max_attempts:1,attempts:1,policy_identity:null});
 const loaded=await f.worker(async()=>(await db.query<{v:{input:unknown;context:unknown}}>("select public.read_leased_logo_record($1,$2,'vector_proposal_inputs',null) v",[j.id,j.lease_token])).rows[0]!.v);
 expect(loaded).toEqual({input:j.input,context:f.context});const text=JSON.stringify(loaded);for(const field of ['"baseRevision"','"documentAsset"','"sourceUrl"','"paths"','"bytes"','"storagePath"'])expect(text).not.toContain(field);
 await expect(f.worker(()=>db.query("select public.read_leased_logo_record($1,$2,'vector_input',null)",[j.id,j.lease_token]))).rejects.toMatchObject({code:'22023'});
 await expect(f.worker(()=>db.query("select public.read_leased_logo_record($1,$2,'vector_proposal_inputs',null)",[j.id,randomUUID()]))).rejects.toMatchObject({code:'40001'});
 await expect(proposalLogin(db,WEB,()=>db.query("select public.read_leased_logo_record($1,$2,'vector_proposal_inputs',null)",[j.id,j.lease_token]))).rejects.toMatchObject({code:'42501'});
});
it('rechecks paid readiness before the sole dispatch boundary while allowing frozen reads after revocation',async()=>{
 const f=await proposalAdmissionFixture(db);await f.admitted();const j=(await f.claim())!;
 await db.query('update public.logo_workspaces set revision=revision+1 where project_id=$1',[f.workspace.projectId]);
 await expect(f.worker(()=>db.query("select public.begin_logo_job_step($1,$2,'propose-vector-edit','once',122880)",[j.id,j.lease_token]))).rejects.toMatchObject({code:'55000'});
 expect((await db.query('select * from public.job_steps')).rows).toEqual([]);
 expect((await f.worker(()=>db.query<{v:unknown}>("select public.read_leased_logo_record($1,$2,'vector_proposal_inputs',null) v",[j.id,j.lease_token]))).rows[0]!.v).toEqual({input:j.input,context:f.context});
});
it('explicitly blocks legacy evidence/completion and retains uncertain expired dispatch reservation',async()=>{
 const f=await proposalAdmissionFixture(db);await f.admitted();const j=(await f.claim())!;
 expect((await f.worker(()=>db.query<{v:string}>("select public.begin_logo_job_step($1,$2,'propose-vector-edit','once',122880) v",[j.id,j.lease_token]))).rows[0]!.v).toBe('started');
 await expect(f.worker(()=>db.query("select public.begin_logo_job_step($1,$2,'propose-vector-edit','once',122880)",[j.id,j.lease_token]))).rejects.toMatchObject({code:'55000'});
 const legacy={provider:'openai',model:'gpt-6.1-sol',providerRequestId:'local-legacy-proof',responseHash:'a'.repeat(64),observedAt:new Date().toISOString(),billing:{status:'recorded',confirmedMicrousd:10},artifactHash:null};
 await expect(f.worker(()=>db.query('select public.record_logo_provider_response($1,$2,$3)',[j.id,j.lease_token,legacy]))).rejects.toMatchObject({code:'55000',message:'logo_vector_proposal_evidence_unavailable'});
 await expect(f.worker(()=>db.query("select public.complete_logo_job_step($1,$2,'propose-vector-edit','failed',0,$3,null)",[j.id,j.lease_token,{error:'not_dispatched'}]))).rejects.toMatchObject({code:'55000',message:'logo_vector_proposal_evidence_unavailable'});
 await expect(f.worker(()=>db.query("select public.finish_logo_job($1,$2,'failed')",[j.id,j.lease_token]))).rejects.toMatchObject({code:'55000',message:'unresolved_steps'});
 expect((await db.query('select * from public.logo_provider_responses')).rows).toEqual([]);
 await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[j.id]);
 await asRole(db,'service_role',null,()=>db.query('select public.expire_job_leases()'));expect((await db.query('select state from public.jobs where id=$1',[j.id])).rows[0]).toEqual({state:'running'});
 await f.worker(()=>db.query('select public.expire_logo_job_leases()'));
 expect((await db.query('select state from public.jobs where id=$1',[j.id])).rows[0]).toEqual({state:'needs_reconciliation'});
 expect((await db.query('select state,reserved_microusd,actual_microusd from public.usage_reservations where job_id=$1',[j.id])).rows[0]).toEqual({state:'active',reserved_microusd:122880,actual_microusd:0});
 expect(await f.claim()).toBeUndefined();expect(await f.rpc('read_logo_request',[f.workspace.projectId,f.intent.requestKey])).toMatchObject({status:'needs_reconciliation',billing:{status:'unknown',confirmedMicrousd:null}});
});
it('cancel-before-claim settles undispatched work and never creates a retry',async()=>{
 const f=await proposalAdmissionFixture(db),r=await f.admitted();await f.rpc('request_job_cancel',[r.jobIds[0]]);expect(await f.claim()).toBeUndefined();
 expect((await db.query('select reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:0});expect(await f.admit()).toEqual(r);expect((await db.query('select id,state from public.jobs')).rows).toEqual([{id:r.jobIds[0],state:'cancelled'}]);
});
it('actual worker role/OID rebinds fail and the text job has no publication capability',async()=>{
 const f=await proposalAdmissionFixture(db);await f.admitted();const j=(await f.claim())!;
 const write={kind:'stage',publication:{requestKey:randomUUID(),inputRevisions:f.evidence.baseRevision.inputRevisions,mimeType:'application/json',contentHash:'a'.repeat(64),byteLength:2,source:{kind:'vector',sourceId:f.evidence.baseRevision.id}}};
 await expect(f.worker(()=>db.query('select fluid_private.prepare_logo_asset($1,$2,$3,$4)',[f.workspace.projectId,write,j.id,j.lease_token]))).rejects.toMatchObject({code:'55000',message:'logo_lease_invalid'});
 expect((await db.query('select * from public.logo_asset_publications')).rows).toEqual([]);
 await db.query('update fluid_private.logo_worker_principals set role_oid=(role_oid::bigint+100000)::oid where role_name=$1',[WORKER]);
 await expect(f.worker(()=>db.query("select public.read_leased_logo_record($1,$2,'vector_proposal_inputs',null)",[j.id,j.lease_token]))).rejects.toMatchObject({code:'42501'});
});
it('preserves six-child image admission and its original API policy-column/attempt behavior',async()=>{
 const f=await proposalAdmissionFixture(db);await f.admitted();
 const image={operation:'identity.logo_concept',policyIdentity:'a'.repeat(64),handlerVersion:'logo-image-v1',provider:'openai',model:'gpt-image-2.5-sunburst-2026-09-08',engine:null,maxCostMicrousd:100};
 await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_concept',$2,'logo-image-v1','openai',$3,100,true)",[OWNER_A,image.policyIdentity,image.model]);expect(await f.report([f.descriptor,image])).toBe(true);
 const request={operation:'concepts',expected:f.workspace.heads,briefRevisionId:f.evidence.brief.id,referenceSnapshotId:f.evidence.brief.payload.referenceSnapshotId};
 const q=logoCostQuoteSchema.parse(await f.rpc('quote_logo_operation',[f.workspace.projectId,request]));const r=logoDispatchReceiptSchema.parse(await f.rpc('admit_logo_operation',[f.workspace.projectId,{requestKey:randomUUID(),quoteId:q.id,acceptedMaxCostMicrousd:600,expected:f.workspace.heads}]));
 expect(r.jobIds).toHaveLength(6);const jobs=(await db.query<{max_attempts:number;policy_identity:null;billing_mode:string;input:Record<string,unknown>}>('select * from public.jobs where id=any($1)',[r.jobIds])).rows;expect(jobs).toHaveLength(6);for(const j of jobs){expect(j).toMatchObject({max_attempts:3,policy_identity:null,billing_mode:'openai_api'});expect(j.input).not.toHaveProperty('textPolicy');}
 expect((await db.query('select reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:123480});
});
it('one-attempt unstarted lease expiry is terminal free failure rather than automatic dispatch replay',async()=>{
 const f=await proposalAdmissionFixture(db);await f.admitted();const j=(await f.claim())!;await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[j.id]);await f.worker(()=>db.query('select public.expire_logo_job_leases()'));
 expect((await db.query('select state from public.jobs where id=$1',[j.id])).rows[0]).toEqual({state:'failed'});expect(await f.claim()).toBeUndefined();expect((await db.query('select reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:0});
});
it('uses the real leased DAL with the restricted principal and preserves the shared paid-uncertainty pause',async()=>{
 const f=await proposalAdmissionFixture(db);await f.admitted();const job=parseClaimedJob(await f.claim());
 const ports=createLogoVectorProposalAdmissionPorts(db),signal=new AbortController().signal;
 expect(await f.worker(()=>ports.loadInput(job,signal))).toEqual({input:job.input,context:f.context});
 await expect(f.worker(()=>ports.assertReady(job,signal))).resolves.toBeUndefined();
 await f.worker(()=>db.query("select public.begin_logo_job_step($1,$2,'propose-vector-edit','once',122880)",[job.id,job.leaseToken]));
 await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[job.id]);
 await f.worker(()=>db.query('select public.expire_logo_job_leases()'));
 expect((await db.query<{v:boolean}>('select fluid_private.api_text_paid_paused($1) v',[job.ownerId])).rows[0]!.v).toBe(true);
 await expect(f.worker(()=>ports.loadInput(job,signal))).rejects.toMatchObject({code:'40001'});
 // Another otherwise-current quote must not bypass the same owner-wide pause.
 await expect(proposalLogin(db,WEB,()=>db.query('select fluid_private.quote_logo_vector_proposal($1,$2)',[f.workspace.projectId,f.evidence]))).rejects.toMatchObject({code:'55000'});
});
it('enforces the one-attempt input contract directly at the database boundary',async()=>{
 const f=await proposalAdmissionFixture(db),r=await f.admitted(),id=r.jobIds[0];
 for(const [statement,code] of [["update public.jobs set max_attempts=2 where id=$1",'23514'],["update public.jobs set input=jsonb_set(input,'{textPolicy,maxInputTokens}','1') where id=$1",'23514'],["update public.jobs set plan_manifest='[]' where id=$1",'55000']]){
  await expect(db.query(statement!,[id])).rejects.toMatchObject({code});
 }
 expect((await db.query('select max_attempts from public.jobs where id=$1',[id])).rows[0]).toEqual({max_attempts:1});
});
