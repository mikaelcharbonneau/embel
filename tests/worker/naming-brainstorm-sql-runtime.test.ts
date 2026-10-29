import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { createSharedWorkerFixture, type SharedWorkerFixture } from '../database/shared-worker-fixture';
import { brainPolicy, brainPreferences, brainReadinessFingerprint, brainRpc, initialIntent } from '../database/naming-brain-fixture';
import { asRole, OWNER_A } from '../database/local-supabase';
import { sharedSlotLeaseSchema } from '../../worker/shared-pool/contracts';
import { createSharedLaneGateway } from '../../worker/shared-lanes/gateway';
import { createSharedNamingLaneEngine } from '../../worker/shared-lanes/naming';
import type { JobDatabase } from '../../worker/postgres-store';
import { createNamingBrainstormProvider } from '../../src/server/ai/naming-brainstorm-provider';
import { getNamingFeed } from '../../src/server/data/naming-brain';
import type { AuthenticatedContext } from '../../src/server/auth/context';

/** Composition only: real installed SDK, worker/store/gateway, SQL and server
 * provenance against disposable PGlite. Every HTTP byte is an inert fixture. */
describe('Naming brainstorm SQL/SDK/server composition',()=>{
 let f:SharedWorkerFixture;
 beforeAll(async()=>{
  f=await createSharedWorkerFixture({probe:false});await f.seedUser(OWNER_A);
  for(const file of ['shared_worker_naming.sql','shared_naming_brainstorm.sql']){
   await f.db.exec(await readFile(new URL(`../../supabase/candidates/${file}`,import.meta.url),'utf8'));
  }
 },60_000);
 afterAll(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();await f?.close();});
 it('runs the actual worker through one durable 120-candidate SDK stream and verifies its 100 saved names through getNamingFeed',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Unexpected real network access in SQL composition fixture');}));
  vi.stubEnv('EMBEL_SHARED_WORKERS_ENABLED','true');
  const policy={...brainPolicy,model:'gpt-6-luna'};
  const identity=(await f.db.query<{h:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h",[JSON.stringify(policy)])).rows[0]!.h;
  const slot=await f.seedSlot({lane:'naming',policies:[{operation:'naming.generate',policyIdentity:identity,policy}]});
  await f.db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  await f.db.query('insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)',[slot.slotId,JSON.stringify(brainReadinessFingerprint)]);
  const lease=sharedSlotLeaseSchema.parse(await f.lease(slot));
  const actions:string[]=[];
  const database:JobDatabase={async query(sql,values=[]){
   expect(sql).toBe('select public.shared_naming_worker_action($1::jsonb,$2::jsonb,$3,$4::jsonb) as envelope');
   actions.push(String(values[2]));
   return f.asSlot(slot,()=>f.db.query<Record<string,unknown>>(sql,values));
  }};
  const gateway=createSharedLaneGateway({database,slot:()=>lease,lane:'naming',deploymentId:slot.deploymentId});
  expect(await gateway.invoke('qualify',[policy,brainReadinessFingerprint])).toBe(true);
  const project=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','Synthetic SDK SQL composition',{description:'Synthetic fixture brief'},'a'.repeat(64)])).id;
  await brainRpc(f.db,'save_naming_preferences',[project,0,brainPreferences]);
  const intent=initialIntent('sql-sdk-composition-initial');
  expect(await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,intent])).toMatchObject({code:'preferences_validation_pending'});
  const work=await gateway.invoke('preference_work',[20]) as {projectId:string;preferencesVersion:number;preferencesHash:string}[];
  const row=work.find(value=>value.projectId===project)!;
  await gateway.invoke('attest_preferences',[project,row.preferencesVersion,row.preferencesHash,brainReadinessFingerprint,{ready:true,missing:[]}]);
  const admitted=await brainRpc<{run:{jobId:string;runId:string}}>(f.db,'ensure_shared_naming_brainstorm_run',[project,intent]);
  const jobId=admitted.run.jobId,runId=admitted.run.runId;
  const methods:string[]=[];
  const provider=createNamingBrainstormProvider({apiKey:'synthetic-inert-sdk-key',fetch:async(incoming,init)=>{
   const request=new Request(incoming,init);methods.push(request.method);
   expect(new URL(request.url).pathname).toBe('/v1/responses');expect(request.method).toBe('POST');
   expect(request.headers.get('x-stainless-retry-count')).toBe('0');
   const body=await request.json();
   const calls=(await f.db.query<{request:unknown;candidate_target:number}>('select request,candidate_target from fluid_private.naming_brainstorm_calls where run_id=$1',[runId])).rows;
   expect(calls).toHaveLength(1);expect(calls[0]!.request).toEqual(body);expect(calls[0]!.candidate_target).toBe(120);
   expect(body).toMatchObject({model:policy.model,store:true,stream:true,reasoning:{effort:'low'},metadata:{embel_job_id:jobId,embel_run_id:runId}});
   const candidates=Array.from({length:120},(_,index)=>({value:`RuntimeCedar${index}`,rationale:'Synthetic creative sound and imagery.',primaryApproach:'real_words'}));
   const response={id:'resp_sql_runtime_fixture',status:'completed',model:policy.model,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({candidates})}]}],usage:{input_tokens:80,output_tokens:60,total_tokens:140}};
   const events=[{type:'response.created',sequence_number:0,response:{id:response.id}},{type:'response.completed',sequence_number:1,response}];
   return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream','x-request-id':'req_sql_runtime_fixture'}});
  }});
  const engine=createSharedNamingLaneEngine({database,slot:()=>lease,deploymentId:slot.deploymentId,workerId:'fixture-sql-sdk-worker',provider:{apiKey:'synthetic-inert-sdk-key',model:policy.model,modelVerificationReceipt:'synthetic-fixture-only'},policy},{brainstormProvider:provider});
  try{expect(await engine.run(undefined,AbortSignal.timeout(15_000))).toEqual({disposition:'ack',state:'succeeded'});}finally{await engine.close();}
  expect(methods).toEqual(['POST']);
  expect(actions).toEqual(expect.arrayContaining(['claim','brainstorm_state','brainstorm_begin','brainstorm_event','brainstorm_publish','brainstorm_finish']));
  expect(actions.indexOf('brainstorm_begin')).toBeLessThan(actions.indexOf('brainstorm_event'));
  expect(actions.indexOf('brainstorm_event')).toBeLessThan(actions.indexOf('brainstorm_publish'));
  expect((await f.db.query('select kind from fluid_private.naming_brainstorm_events where call_id in(select call_id from fluid_private.naming_brainstorm_calls where run_id=$1) order by kind',[runId])).rows).toEqual([{kind:'completed'},{kind:'created'}]);
  const rpcNames:string[]=[];
  const auth={userId:OWNER_A,client:{rpc:async(name:string,args:Record<string,unknown>)=>{
   rpcNames.push(name);
   return asRole(f.db,'authenticated',OWNER_A,async()=>{
    let data:unknown;
    if(name==='get_naming_feed')data=(await f.db.query<{v:unknown}>('select public.get_naming_feed($1,$2) v',[args.p_project_id,JSON.stringify(args.p_query)])).rows[0]!.v;
    else if(name==='get_naming_brainstorm_sources')data=(await f.db.query<{v:unknown}>('select public.get_naming_brainstorm_sources($1,$2) v',[args.p_project_id,args.p_candidate_ids])).rows[0]!.v;
    else if(name==='get_shared_naming_availability')data=(await f.db.query<{v:unknown}>('select public.get_shared_naming_availability($1) v',[args.p_project_id])).rows[0]!.v;
    else throw Error('Unexpected authenticated RPC in SQL composition fixture');
    return {data,error:null};
   });
  }}} as unknown as AuthenticatedContext;
  const feed=await getNamingFeed(auth,project);
  expect(feed.entries).toHaveLength(100);expect(feed.activeRun).toMatchObject({jobId,runId,state:'succeeded',generationProfile:'brainstorm_v1',fulfillment:{status:'complete',acceptedCount:100,coverageSatisfied:true}});
  expect(feed.activeRun!.brainstormCompletionId).toBeTypeOf('string');
  expect(feed.entries.every(entry=>entry.entry.candidate.origin.kind==='brainstorm'&&entry.publishedClaims.length===0)).toBe(true);
  expect(rpcNames).toEqual(['get_naming_feed','get_naming_brainstorm_sources','get_shared_naming_availability']);
  expect((await f.db.query('select actual_cost_microusd from fluid_private.naming_brain_runs where id=$1',[runId])).rows).toEqual([{actual_cost_microusd:null}]);
 },30_000);
});
