import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { asSubscriptionWorker,createTestDatabase,OWNER_A,OWNER_B,resetFixture,type TestDatabase } from './local-supabase';
import { approvedSqlDirectionFixture,bindSqlSubscriptionFixture,configureSqlSubscriptionFixture,installSqlSubscriptionFixture,logoSqlRpc,sqlObservation,sqlPolicyIdentity,sqlSubscriptionPolicy,sqlWorker } from './logo-directions-subscription-fixture';

type Quote={id:string;inputHash:string;billingMode?:string;policy?:unknown;maxCostMicrousd:number;externalProviderCostMicrousd:number;policyIdentity:string};
type Job={id:string;lease_token:string;input:Record<string,unknown>;billing_mode:string;policy_identity:string;max_attempts:number;reserved_cost_microusd:number;actual_cost_microusd:number};
describe('subscription directions SQL gates and durable evidence',()=>{
 let db:TestDatabase;
 beforeAll(async()=>{db=await createTestDatabase();await installSqlSubscriptionFixture(db);},60000);
 afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{await resetFixture(db);await bindSqlSubscriptionFixture(db);});
 const rpc=(name:string,args:unknown[],owner=OWNER_A)=>logoSqlRpc(db,name,args,owner);
 const claim=()=>sqlWorker(db,async()=>(await db.query<Job>("select * from public.claim_logo_job('subscription-fixture',60)")).rows);
 async function admission(policy=sqlSubscriptionPolicy()){
  const config=await configureSqlSubscriptionFixture(db,policy),f=await approvedSqlDirectionFixture(db);
  const q=await rpc('quote_logo_operation',[f.w.projectId,f.request]) as Quote;
  const intent={requestKey:randomUUID(),quoteId:q.id,acceptedMaxCostMicrousd:0,expected:f.w.heads};
  const receipt=await rpc('admit_logo_operation',[f.w.projectId,intent]) as {jobIds:string[]};
  return {...f,...config,q,intent,receipt};
 }
 async function started(policy=sqlSubscriptionPolicy()){
  const f=await admission(policy),j=(await claim())[0]!;
  await sqlWorker(db,()=>db.query("select public.begin_logo_job_step($1,$2,'propose-directions',$3,0)",[j.id,j.lease_token,`request-${j.id}`]));return {...f,j};
 }
 const record=(j:Job,o:unknown)=>sqlWorker(db,async()=>(await db.query<{v:{id:string}}>('select public.record_logo_provider_response($1,$2,$3) v',[j.id,j.lease_token,o])).rows[0]!.v);
 it('adds fail-closed registration qualification without changing existing configure behavior',async()=>{
  const names=(await db.query<{column_name:string}>("select column_name from information_schema.columns where table_schema='fluid_private' and table_name='subscription_registrations'")).rows.map(r=>r.column_name);
  expect(names).toEqual(expect.arrayContaining(['connected','plan_usage_enabled']));
  await db.query('insert into fluid_private.subscription_registrations(registration_id,owner_id) values($1,$2)',['new-unqualified',OWNER_A]);
  expect((await db.query('select connected,plan_usage_enabled from fluid_private.subscription_registrations')).rows).toEqual([{connected:false,plan_usage_enabled:false}]);
 });
 it('freezes exact policy, model, zero API amounts and one attempt without a monetary account',async()=>{
  await db.query('delete from public.usage_accounts where owner_id=$1',[OWNER_A]);
  const f=await admission();expect(f.q).toMatchObject({billingMode:'chatgpt_subscription',policy:f.policy,policyIdentity:f.hash,maxCostMicrousd:0,externalProviderCostMicrousd:0});
  const j=(await claim())[0]!;expect(j).toMatchObject({billing_mode:'chatgpt_subscription',policy_identity:f.hash,max_attempts:1,reserved_cost_microusd:0,actual_cost_microusd:0,input:{billingMode:'chatgpt_subscription',policy:f.policy}});
  expect((await db.query('select * from public.usage_reservations')).rows).toEqual([]);
  expect(await rpc('admit_logo_operation',[f.w.projectId,f.intent])).toEqual(f.receipt);
  await expect(rpc('admit_logo_operation',[f.w.projectId,f.intent],OWNER_B)).rejects.toMatchObject({code:'P0002'});
 });
 it('strict policy validation covers every limit, extra keys, attestation and safe identifiers',async()=>{
  const base=sqlSubscriptionPolicy();
  const invalid:unknown[]=[null,{}, {...base,extra:true},{...base,apiCharge:'unknown'},{...base,adapterVersion:'other'},{...base,registrationId:'bad/registration'},{...base,model:' bad model'}];
  for(const [key,min,max] of [['maxInputBytes',1024,131072],['maxOutputBytes',1024,262144],['maxStreamBytes',1024,2097152],['deadlineMs',1000,240000],['maxObservedWebSearchCalls',0,0],['maxRequestsPerHour',1,100],['maxQueuedJobs',1,10]] as const)for(const value of [min-1,max+1,1.1,null,'1'])invalid.push({...base,limits:{...base.limits,[key]:value}});
  for(const policy of invalid)expect((await db.query<{v:boolean}>('select fluid_private.valid_logo_directions_subscription_policy($1) v',[policy])).rows[0]!.v).toBe(false);
  expect((await db.query<{v:boolean}>('select fluid_private.valid_logo_directions_subscription_policy($1) v',[base])).rows[0]!.v).toBe(true);
 });
 it('constraints prohibit policy under non-directions, paid cap, wrong model and incomplete identity',async()=>{
  const {policy}=await configureSqlSubscriptionFixture(db);
  for(const [field,value] of [['operation','identity.logo_refine'],['max_cost_microusd',1],['model','wrong'],['policy_identity','a'.repeat(64)],['handler_version','other'],['provider','synthetic'],['engine',{}]] as const){await expect(db.query(`update fluid_private.logo_runtime_policies set ${field}=$1 where owner_id=$2`,[value,OWNER_A])).rejects.toMatchObject({code:'23514'});}
  const changed={...policy,registrationId:'other-owner'};await db.query('insert into fluid_private.subscription_registrations(registration_id,owner_id,connected,plan_usage_enabled) values($1,$2,true,true)',[changed.registrationId,OWNER_B]);
  await db.query('update fluid_private.logo_runtime_policies set subscription_policy=$1,policy_identity=$2 where owner_id=$3',[changed,await sqlPolicyIdentity(db,changed),OWNER_A]);
  const f=await approvedSqlDirectionFixture(db);await expect(rpc('quote_logo_operation',[f.w.projectId,f.request])).rejects.toMatchObject({code:'55000'});
 });
 it.each(['connected','plan_usage_enabled'] as const)('current registration %s blocks quote, claim and dispatch when false',async(column)=>{
  const f=await admission(),j=(await claim())[0]!;
  await db.query(`update fluid_private.subscription_registrations set ${column}=false where registration_id=$1`,[f.policy.registrationId]);
  await expect(rpc('quote_logo_operation',[f.w.projectId,f.request])).rejects.toMatchObject({code:'55000'});
  expect(await claim()).toEqual([]);
  await expect(sqlWorker(db,()=>db.query("select public.begin_logo_job_step($1,$2,'propose-directions','stop',0)",[j.id,j.lease_token]))).rejects.toMatchObject({code:'55000'});
  expect((await db.query('select * from public.job_steps')).rows).toEqual([]);
 });
 it('full policy and readiness mutation invalidate old quotes and immutable job inputs',async()=>{
  const f=await admission(),newPolicy={...f.policy,limits:{...f.policy.limits,maxStreamBytes:1000000}};
  await configureSqlSubscriptionFixture(db,newPolicy);expect(await claim()).toEqual([]);
  const pending=await rpc('quote_logo_operation',[f.w.projectId,f.request]) as Quote;
  await configureSqlSubscriptionFixture(db,{...newPolicy,registrationId:'second-fixture'});
  expect(await rpc('admit_logo_operation',[f.w.projectId,{...f.intent,requestKey:randomUUID(),quoteId:pending.id}])).toMatchObject({kind:'logo_admission_rejected'});
  expect(await rpc('admit_logo_operation',[f.w.projectId,f.intent])).toEqual(f.receipt);
  expect((await db.query<{input:{policy:unknown}}>('select input from public.jobs where id=$1',[f.receipt.jobIds[0]])).rows[0]!.input.policy).toEqual(f.policy);
 });
 it.each(['maxRequestsPerHour','maxQueuedJobs'] as const)('rechecks owner-wide %s at quote, admission and dispatch',async(limit)=>{
  const policy=sqlSubscriptionPolicy();policy.limits[limit]=1;
  await configureSqlSubscriptionFixture(db,policy);const f=await approvedSqlDirectionFixture(db);
  const q1=await rpc('quote_logo_operation',[f.w.projectId,f.request]) as Quote,q2=await rpc('quote_logo_operation',[f.w.projectId,f.request]) as Quote;
  const intent={requestKey:randomUUID(),quoteId:q1.id,acceptedMaxCostMicrousd:0,expected:f.w.heads};await rpc('admit_logo_operation',[f.w.projectId,intent]);
  await expect(rpc('quote_logo_operation',[f.w.projectId,f.request])).rejects.toMatchObject({message:'logo_subscription_quota_unavailable'});
  await expect(rpc('admit_logo_operation',[f.w.projectId,{...intent,requestKey:randomUUID(),quoteId:q2.id}])).rejects.toMatchObject({message:'logo_subscription_quota_unavailable'});
  const j=(await claim())[0]!;expect(j).toBeDefined();
  await db.query("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,billing_mode,policy_identity,max_attempts,reserved_cost_microusd) values($1,$2,'strategy.reformulate',1,$3,$4,$5,'chatgpt_subscription',$3,1,0)",[OWNER_A,f.w.projectId,await sqlPolicyIdentity(db,policy),{billingMode:'chatgpt_subscription',policy},randomUUID()]);
  await expect(sqlWorker(db,()=>db.query("select public.begin_logo_job_step($1,$2,'propose-directions','bounded',0)",[j.id,j.lease_token]))).rejects.toMatchObject({code:'55000'});
 });
 it('enforces bounded frozen input before any job is admitted',async()=>{
  const p=sqlSubscriptionPolicy();p.limits.maxInputBytes=1024;await configureSqlSubscriptionFixture(db,p);const f=await approvedSqlDirectionFixture(db);
  await expect(rpc('quote_logo_operation',[f.w.projectId,f.request])).rejects.toMatchObject({code:'22023',message:'logo_subscription_input_too_large'});
  expect((await db.query('select * from public.jobs')).rows).toEqual([]);
 });
 it('records nullable usage and header-free response identity then publishes only at atomic completion',async()=>{
  const f=await started(),obs={...sqlObservation(),usage:null},r=await record(f.j,obs);expect(await record(f.j,obs)).toEqual(r);
  const p=(await sqlWorker(db,()=>db.query<{v:{id:string}}>('select public.stage_logo_directions($1,$2,$3,$4,$5) v',[f.j.id,f.j.lease_token,f.result,r.id,f.checks]))).rows[0]!.v;
  expect((await db.query('select * from public.logo_direction_records')).rows).toEqual([]);
  await sqlWorker(db,async()=>{await db.query("select public.complete_logo_job_step($1,$2,'propose-directions','succeeded',0,$3,null)",[f.j.id,f.j.lease_token,{version:2,kind:'logo_directions',publicationId:p.id,providerResponseReceiptId:r.id}]);await db.query("select public.finish_logo_job($1,$2,'succeeded')",[f.j.id,f.j.lease_token]);});
  expect((await db.query('select state,actual_cost_microusd from public.jobs where id=$1',[f.j.id])).rows[0]).toEqual({state:'succeeded',actual_cost_microusd:0});
  expect((await db.query('select * from public.logo_direction_records')).rows).toHaveLength(12);
  expect((await db.query('select * from public.usage_reservations')).rows).toEqual([]);
 });
 it('rejects forged registration, model, usage, extra keys, paid billing and changed response replay',async()=>{
  const {j}=await started(),obs=sqlObservation();
  const invalid=[{...obs,registrationId:'foreign'},{...obs,model:'other'},{...obs,usage:{inputTokens:2,outputTokens:3,totalTokens:6}},{...obs,usage:{inputTokens:-1,outputTokens:3,totalTokens:2}},{...obs,usage:{inputTokens:0.1,outputTokens:1,totalTokens:1.1}},{...obs,usage:{inputTokens:9007199254740992,outputTokens:0,totalTokens:9007199254740992}},{...obs,usage:{inputTokens:2,outputTokens:3,totalTokens:5,remaining:10}},{...obs,responseId:'req_bad'},{...obs,billing:{status:'recorded',confirmedMicrousd:1}},{...obs,normalizedPixelHash:'c'.repeat(64)},{...obs,artifactHash:'c'.repeat(64)},{...obs,extra:true}];
  for(const bad of invalid)await expect(record(j,bad)).rejects.toMatchObject({code:'22023'});
  const {version:_v,billingMode:_b,registrationId:_r,responseId:_i,usage:_u,...legacy}=obs;void [_v,_b,_r,_i,_u];await expect(record(j,legacy)).rejects.toMatchObject({code:'22023'});
  const r=await record(j,obs);expect(r.id).toBeTruthy();await expect(record(j,{...obs,responseId:'resp_other'})).rejects.toMatchObject({code:'PT409'});
 });
 it.each(['interrupted','unknown_billing'] as const)('keeps %s at reconciliation even with zero API expense',async(mode)=>{
  const f=await started(),observation=mode==='interrupted'?{...sqlObservation(),responseId:null,responseHash:null}:{...sqlObservation(),billing:{status:'unknown',confirmedMicrousd:null}};
  await record(f.j,observation);
  await sqlWorker(db,()=>db.query("select public.complete_logo_job_step($1,$2,'propose-directions','failed',0,$3,null)",[f.j.id,f.j.lease_token,{error:'provider_outcome_unknown'}]));
  expect((await db.query('select state,actual_cost_microusd from public.jobs where id=$1',[f.j.id])).rows[0]).toEqual({state:'needs_reconciliation',actual_cost_microusd:0});
  expect((await db.query('select * from public.logo_direction_records')).rows).toEqual([]);
 });
 it('owner disconnect blocks new work while generic subscription worker cannot read or mutate logo steps',async()=>{
  const f=await started();
  await asSubscriptionWorker(db,OWNER_A,async()=>{
   expect((await db.query('select job_id,step_key,state,request_key from public.job_steps where job_id=$1',[f.j.id])).rows).toEqual([]);
   expect((await db.query<{v:boolean}>('select public.subscription_worker_can_read_step($1,$2) v',[f.j.id,OWNER_A])).rows[0]!.v).toBe(false);
   expect((await db.query('select * from public.claim_subscription_job($1,$2,$3,60)',['generic',OWNER_A,f.policy.registrationId])).rows).toEqual([]);
   await expect(db.query('select public.heartbeat_job($1,$2,60)',[f.j.id,f.j.lease_token])).rejects.toMatchObject({code:'42501'});
   await expect(db.query("select public.report_logo_worker_ready('generic',$1,60)",[[f.descriptor]])).rejects.toMatchObject({code:'42501'});
   await db.query('select public.disable_subscription_runtime($1,$2)',[OWNER_A,f.policy.registrationId]);
  });
  expect((await db.query('select connected,plan_usage_enabled from fluid_private.subscription_registrations')).rows).toEqual([{connected:false,plan_usage_enabled:false}]);
  expect((await db.query('select * from fluid_private.logo_worker_readiness')).rows).toEqual([]);
  expect((await db.query('select state from public.jobs where id=$1',[f.j.id])).rows[0]).toEqual({state:'cancel_requested'});
  await expect(rpc('quote_logo_operation',[f.w.projectId,f.request])).rejects.toMatchObject({code:'55000'});
  // In-flight evidence is still retained for reconciliation after disconnect.
  await record(f.j,{...sqlObservation(),responseId:null,responseHash:null});
 });
 it('rechecks actual logo principal even when a generic worker is accidentally granted a logo RPC',async()=>{
  const f=await started();await db.exec('grant execute on function public.record_logo_provider_response(uuid,uuid,jsonb),public.report_logo_worker_ready(text,jsonb,integer) to fixture_subscription_worker_a');
  await asSubscriptionWorker(db,OWNER_A,async()=>{await expect(db.query('select public.record_logo_provider_response($1,$2,$3)',[f.j.id,f.j.lease_token,sqlObservation()])).rejects.toMatchObject({code:'42501',message:'logo_worker_unauthorized'});await expect(db.query("select public.report_logo_worker_ready('bad',$1,60)",[[f.descriptor]])).rejects.toMatchObject({code:'42501',message:'logo_worker_unauthorized'});});
  await db.exec('revoke execute on function public.record_logo_provider_response(uuid,uuid,jsonb),public.report_logo_worker_ready(text,jsonb,integer) from fixture_subscription_worker_a');
 });
 it('preserves legacy quote serialization and input shape and still requires a legacy header ID',async()=>{
  const f=await approvedSqlDirectionFixture(db),descriptor={operation:'identity.logo_directions',policyIdentity:'a'.repeat(64),handlerVersion:'logo-directions-v1',provider:'synthetic',model:'legacy-fixture',engine:null,maxCostMicrousd:10};
  await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,$2,$3,$4,$5,$6,10,true)",[OWNER_A,descriptor.operation,descriptor.policyIdentity,descriptor.handlerVersion,descriptor.provider,descriptor.model]);
  await sqlWorker(db,()=>db.query("select public.report_logo_worker_ready('subscription-fixture',$1,90)",[[descriptor]]));
  const q=await rpc('quote_logo_operation',[f.w.projectId,f.request]) as Quote;
  expect(Object.hasOwn(q,'billingMode')).toBe(false);expect(Object.hasOwn(q,'policy')).toBe(false);
  const expected=(await db.query<{v:string}>("select encode(sha256(convert_to(jsonb_build_object('request',q.record->'request','sources',q.source_inputs,'policy',to_jsonb(p)-'subscription_policy','plan',q.record->'conceptPlan','targets',q.record->'targetSlotIds')::text,'UTF8')),'hex') v from public.logo_cost_quotes q join fluid_private.logo_runtime_policies p on p.owner_id=q.owner_id and p.operation=q.operation where q.id=$1",[q.id])).rows[0]!.v;expect(q.inputHash).toBe(expected);
  const intent={requestKey:randomUUID(),quoteId:q.id,acceptedMaxCostMicrousd:10,expected:f.w.heads};await rpc('admit_logo_operation',[f.w.projectId,intent]);
  const j=(await claim())[0]!;expect(j.billing_mode).toBe('openai_api');expect(j.max_attempts).toBe(3);expect(Object.hasOwn(j.input,'billingMode')).toBe(false);expect(Object.hasOwn(j.input,'policy')).toBe(false);expect(j.policy_identity).toBeNull();
  await sqlWorker(db,()=>db.query("select public.begin_logo_job_step($1,$2,'propose-directions','legacy-fixture',10)",[j.id,j.lease_token]));
  await expect(record(j,sqlObservation())).rejects.toMatchObject({code:'22023'});
  const r=await record(j,{provider:'synthetic',model:'legacy-fixture',providerRequestId:null,responseHash:'d'.repeat(64),artifactHash:null,observedAt:new Date().toISOString(),billing:{status:'recorded',confirmedMicrousd:5}});
  const p=(await sqlWorker(db,()=>db.query<{v:{id:string}}>('select public.stage_logo_directions($1,$2,$3,$4,$5) v',[j.id,j.lease_token,f.result,r.id,f.checks]))).rows[0]!.v;
  await expect(sqlWorker(db,()=>db.query("select public.complete_logo_job_step($1,$2,'propose-directions','succeeded',5,$3,null)",[j.id,j.lease_token,{version:2,kind:'logo_directions',publicationId:p.id,providerResponseReceiptId:r.id}]))).rejects.toMatchObject({code:'55000',message:'provider_evidence_required'});
  expect((await db.query('select * from public.logo_direction_records')).rows).toEqual([]);
 });
 it('forbids response-ID replay into another explicitly quoted job on the same project revision',async()=>{
  const f=await started(),obs=sqlObservation();await record(f.j,obs);
  const q=await rpc('quote_logo_operation',[f.w.projectId,f.request]) as Quote;
  await rpc('admit_logo_operation',[f.w.projectId,{...f.intent,requestKey:randomUUID(),quoteId:q.id}]);
  const j=(await claim())[0]!;expect(j.id).not.toBe(f.j.id);
  await sqlWorker(db,()=>db.query("select public.begin_logo_job_step($1,$2,'propose-directions','second-job',0)",[j.id,j.lease_token]));
  await expect(record(j,obs)).rejects.toMatchObject({code:'23505',constraint:'logo_subscription_response_replay'});
  expect((await db.query('select * from public.logo_provider_responses')).rows).toHaveLength(1);
 });
 it('does not publish a response hash without a valid completed subscription response ID',async()=>{
  const f=await started(),r=await record(f.j,{...sqlObservation(),responseId:null});
  await expect(sqlWorker(db,()=>db.query('select public.stage_logo_directions($1,$2,$3,$4,$5)',[f.j.id,f.j.lease_token,f.result,r.id,f.checks]))).rejects.toMatchObject({code:'55000',message:'direction_source_evidence_required'});
  await expect(sqlWorker(db,()=>db.query("select public.complete_logo_job_step($1,$2,'propose-directions','succeeded',0,$3,null)",[f.j.id,f.j.lease_token,{version:2,kind:'logo_directions',publicationId:randomUUID(),providerResponseReceiptId:r.id}]))).rejects.toMatchObject({code:'55000'});
  expect((await db.query('select * from public.logo_direction_records')).rows).toEqual([]);
 });
 it('missing observations cannot turn an interrupted zero-charge request into a confirmed failure',async()=>{
  const f=await started();
  await sqlWorker(db,()=>db.query("select public.complete_logo_job_step($1,$2,'propose-directions','failed',0,null,null)",[f.j.id,f.j.lease_token]));
  expect((await db.query('select state from public.jobs where id=$1',[f.j.id])).rows[0]).toEqual({state:'needs_reconciliation'});
 });
 it('expired or mismatched readiness prevents new dispatch while settled evidence survives withdrawal',async()=>{
  const f=await started();await sqlWorker(db,()=>db.query("select public.report_logo_worker_ready('subscription-fixture','[]',90)"));
  await expect(rpc('quote_logo_operation',[f.w.projectId,f.request])).rejects.toMatchObject({code:'55000'});
  const r=await record(f.j,sqlObservation());
  const p=(await sqlWorker(db,()=>db.query<{v:{id:string}}>('select public.stage_logo_directions($1,$2,$3,$4,$5) v',[f.j.id,f.j.lease_token,f.result,r.id,f.checks]))).rows[0]!.v;
  await sqlWorker(db,async()=>{await db.query("select public.complete_logo_job_step($1,$2,'propose-directions','succeeded',0,$3,null)",[f.j.id,f.j.lease_token,{version:2,kind:'logo_directions',publicationId:p.id,providerResponseReceiptId:r.id}]);await db.query("select public.finish_logo_job($1,$2,'succeeded')",[f.j.id,f.j.lease_token]);});
  expect((await db.query('select state from public.jobs where id=$1',[f.j.id])).rows[0]).toEqual({state:'succeeded'});
 });

});
