import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSharedWorkerFixture, type SharedWorkerFixture } from './shared-worker-fixture';
import { brainPolicy, brainPreferences, brainReadinessFingerprint, brainRpc, initialIntent } from './naming-brain-fixture';
import { OWNER_A } from './local-supabase';
const rows=[
 {kind:'created',at:'2030-01-01T00:00:00Z',payload:{responseId:'resp_synthetic_backwards'}},
 {kind:'unknown',at:'2030-01-02T00:00:00Z',payload:{responseId:'resp_synthetic_backwards'}},
];
describe('actual SQL Naming terminal observation precedence under backward clock',()=>{
 let f:SharedWorkerFixture,callId:string;
 let guardedConstraintCases=0;
 const state=async()=>(await f.db.query<{v:{state:string;responseId:string;request:unknown}}> ('select fluid_private.naming_brainstorm_call_state(c) v from fluid_private.naming_brainstorm_calls c where call_id=$1',[callId])).rows[0]!.v;
 const seed=async(kind:string,at:string,payload:Record<string,unknown>={})=>f.db.query('insert into fluid_private.naming_brainstorm_events(call_id,kind,payload,created_at) values($1,$2,$3,$4)',[callId,kind,JSON.stringify({...payload,kind,fixture:true}),at]);
 const backwards=async(kind:string)=>{
  for(const row of rows)await seed(row.kind,row.at,row.payload);
  await seed(kind,'2029-12-31T00:00:00Z',kind==='completed'?{responseId:'resp_synthetic_backwards',candidates:[],usage:{input_tokens:1}}:{errorCode:'synthetic_provider_rejection'});
 };
 beforeAll(async()=>{
  f=await createSharedWorkerFixture({probe:false});await f.seedUser(OWNER_A);
  await f.db.exec(await readFile(new URL('../../supabase/candidates/shared_worker_naming.sql',import.meta.url),'utf8'));
  const candidate=await readFile(new URL('../../supabase/candidates/shared_naming_brainstorm.sql',import.meta.url),'utf8');
  const original=(await f.db.query<{expression:string;definition:string}>("select pg_get_expr(conbin,conrelid) expression,pg_get_constraintdef(oid,true) definition from pg_constraint where conrelid='public.name_candidates'::regclass and conname='name_candidates_check1'")).rows[0]!;
  const snapshot=async()=>(await f.db.query("select pg_get_constraintdef(oid,true) root,(select prosrc from pg_proc where oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure) gateway,to_regclass('fluid_private.naming_brainstorm_calls') calls from pg_constraint where conrelid='public.name_candidates'::regclass and conname='name_candidates_check1'")).rows;
  const before=await snapshot();
  for(const expression of ['length(value)>20',`(${original.expression}) AND value<>'synthetic_forbidden'`]){
   await f.db.exec('begin');
   try{
    await f.db.exec(`alter table public.name_candidates drop constraint name_candidates_check1;alter table public.name_candidates add constraint name_candidates_check1 check (${expression});`);
    await expect(f.db.exec(candidate)).rejects.toThrow('brainstorm_root_constraint_predecessor_mismatch');
    guardedConstraintCases++;
   }finally{await f.db.exec('rollback');}
   expect(await snapshot()).toEqual(before);
  }
  await f.db.exec(candidate);
  const policy={...brainPolicy,model:'gpt-6-luna'};
  const hash=(await f.db.query<{h:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex')h",[JSON.stringify(policy)])).rows[0]!.h;
  const slot=await f.seedSlot({lane:'naming',policies:[{operation:'naming.generate',policyIdentity:hash,policy}]});
  await f.db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  await f.db.query('insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint)values($1,$2)',[slot.slotId,JSON.stringify(brainReadinessFingerprint)]);
  const lease=await f.lease(slot);
  const action=(name:string,args:unknown)=>f.asSlot(slot,async()=>(await f.db.query<{v:{result:unknown;execution:Record<string,unknown>}}> ('select public.shared_naming_worker_action($1,null,$2,$3)v',[lease,name,JSON.stringify(args)])).rows[0]!.v);
  await action('qualify',[policy,brainReadinessFingerprint]);
  const project=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','Synthetic clock regression',{description:'Disposable event ordering'},'a'.repeat(64)])).id;
  await brainRpc(f.db,'save_naming_preferences',[project,0,brainPreferences]);
  const intent=initialIntent('synthetic-backward-clock');
  await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,intent]);
  const work=(await action('preference_work',[20])).result as {projectId:string;preferencesVersion:number;preferencesHash:string}[];
  const row=work.find(x=>x.projectId===project)!;
  await action('attest_preferences',[project,row.preferencesVersion,row.preferencesHash,brainReadinessFingerprint,{ready:true,missing:[]}]);
  await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,intent]);
  const runId=(await f.db.query<{id:string}>('select id from fluid_private.naming_brain_runs where project_id=$1',[project])).rows[0]!.id;
  callId=(await f.db.query<{call_id:string}>('insert into fluid_private.naming_brainstorm_calls(run_id,owner_id,project_id,call_index,candidate_target,request)values($1,$2,$3,1,120,$4)returning call_id',[runId,OWNER_A,project,JSON.stringify({fixture:'ordering-only-no-provider-dispatch'})])).rows[0]!.call_id;

 },60_000);
 afterAll(async()=>{await f?.close();});
 it('atomically refuses wrong or strengthened original root constraints before installing',()=>{expect(guardedConstraintCases).toBe(2);});
 for(const kind of ['completed','rejected'])it(`retains earlier-clock ${kind} over later created/unknown observations`,async()=>{
  await f.db.exec('begin');try{
   await backwards(kind);const result=await state();expect(result.state).toBe(kind);expect(result.responseId).toBe('resp_synthetic_backwards');
   expect((await f.db.query('select kind from fluid_private.naming_brainstorm_events where call_id=$1 order by created_at',[callId])).rows).toHaveLength(3);
   expect(result.request).toEqual({fixture:'ordering-only-no-provider-dispatch'});
  }finally{await f.db.exec('rollback');}
 });
 it('retains timestamp ordering for nonterminal observations and prepared for no event',async()=>{
  expect((await state()).state).toBe('prepared');
  await f.db.exec('begin');try{for(const row of rows)await seed(row.kind,row.at,row.payload);expect((await state()).state).toBe('unknown');}finally{await f.db.exec('rollback');}
 });
});
