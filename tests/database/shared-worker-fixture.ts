import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, seedProject, OWNER_A, OWNER_B, HASH, type TestDatabase } from './local-supabase';

export { OWNER_A, OWNER_B };
export type SharedFixtureSlot = {slotId:string;roleName:string;lane:'strategy'|'naming'|'logo';deploymentId:string};
export type SharedFixtureLease = Record<string,unknown>;
/** Synthetic Auth rows and memory-only LOGIN roles, never a live deployment. */
export async function createSharedWorkerFixture(options:{probe?:boolean}={}) {
 const withProbe=options.probe!==false;
 const db=await createTestDatabase();
 try {
  await db.exec(`alter table auth.users add column email_confirmed_at timestamptz;
   alter table auth.users add column is_anonymous boolean not null default false;
   alter table auth.users add column banned_until timestamptz;
   alter table auth.users add column deleted_at timestamptz;`);
  await db.exec(await readFile(new URL('../../supabase/candidates/shared_worker_pool.sql',import.meta.url),'utf8'));
  // This probe has a finite fixture-only action list. Production lane adapters
  // use their real engine claim/receipt state machines instead of this fixture.
  if(withProbe)for(const lane of ['strategy','naming','logo'])await db.exec(`create function public.shared_${lane}_worker_action(l jsonb,e jsonb,a text,args jsonb default null) returns jsonb
   language plpgsql security definer set search_path='' as $$
   declare x fluid_private.shared_worker_executions;jid uuid:=(args->>'jobId')::uuid; begin
    if a='claim' then
     perform fluid_private.enter_shared_worker_claim_context(l,jid);
     update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '60 seconds',worker_id=l->>'instanceId',attempts=attempts+1 where id=jid;
     x:=fluid_private.bind_shared_worker_execution(l,jid);
     perform fluid_private.leave_shared_worker_context(); return fluid_private.shared_worker_execution_json(x);
    elsif a in('active','observe','fail','leak') then
     perform fluid_private.enter_shared_worker_context(l,e,case when a='observe' then 'observe' else 'active' end);
     if a='fail' then raise exception 'fixture_rollback'; end if;
     if a='leak' then return '{}'::jsonb; end if;
     e:=jsonb_build_object('ownerId',fluid_private.shared_worker_context_owner(l->>'lane'),'jobId',fluid_private.shared_worker_context_job(l->>'lane'),'mode',fluid_private.shared_worker_context_mode(l->>'lane'));
     perform fluid_private.leave_shared_worker_context(); return e;
    elsif a='close' then perform fluid_private.close_shared_worker_execution(l,e);return '{}'::jsonb;
    elsif a='park' then perform fluid_private.park_shared_worker_execution(l,e);return '{}'::jsonb;
    else raise exception 'fixture_action_denied';end if;
   end $$;
   revoke all on function public.shared_${lane}_worker_action(jsonb,jsonb,text,jsonb) from public;`);
  async function seedUser(ownerId:string,options:{confirmed?:boolean;anonymous?:boolean;banned?:boolean}={}) {
   await db.query(`insert into auth.users(id,email_confirmed_at,is_anonymous,banned_until) values($1,case when $2 then clock_timestamp() else null end,$3,case when $4 then clock_timestamp()+interval '1 day' else null end)`,[ownerId,options.confirmed!==false,options.anonymous??false,options.banned??false]);
  }
  async function seedSlot(options:{lane?:SharedFixtureSlot['lane'];index?:number;policies?:readonly {operation:string;policyIdentity:string;policy:Record<string,unknown>}[];tenantActiveLimit?:number}={}) {
   const lane=options.lane??'strategy',index=options.index??1;
   const slot={slotId:randomUUID(),roleName:`embel_shared_${lane}_fixture_${index}`,lane,deploymentId:'fixture-shared-deployment'};
   await db.exec(`create role ${slot.roleName} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4;
    grant usage on schema public to ${slot.roleName};
    grant execute on function public.shared_worker_pool_configuration(),public.claim_shared_worker_slot(uuid,uuid,text,integer),public.renew_shared_worker_slot(jsonb,integer),public.release_shared_worker_slot(jsonb),public.fence_shared_worker_slot(jsonb),public.read_shared_worker_executions(jsonb),public.read_shared_worker_execution_page(jsonb,uuid,integer) to ${slot.roleName};`);
   if(withProbe)await db.exec(`grant execute on function public.shared_${lane}_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
   await db.query(`insert into fluid_private.shared_worker_slots(slot_id,lane,slot_index,role_name,role_oid,deployment_id,enabled,tenant_active_limit)
    select $1,$2,$3,rolname,oid,$4,true,$5 from pg_roles where rolname=$6`,[slot.slotId,lane,index,slot.deploymentId,options.tenantActiveLimit??1,slot.roleName]);
   for(const policy of options.policies??[{operation:'strategy',policyIdentity:'fixture-uncapped-v1',policy:{providerBudgetVersion:2}}]) {
    await db.query('insert into fluid_private.shared_worker_policies(slot_id,operation,policy_identity,policy) values($1,$2,$3,$4)',[slot.slotId,policy.operation,policy.policyIdentity,policy.policy]);
   }
   return slot;
  }
  async function asSlot<T>(slot:SharedFixtureSlot,run:()=>Promise<T>):Promise<T> {
   await db.exec(`set session authorization ${slot.roleName}`);
   try{return await run();}finally{if(db.isInTransaction())await db.exec('rollback');await db.exec('set session authorization postgres');await db.query("select set_config('request.jwt.claim.sub','',false)");}
  }
  async function lease(slot:SharedFixtureSlot,instanceId=randomUUID()) {
   return asSlot(slot,async()=>(await db.query<{lease:SharedFixtureLease}>('select public.claim_shared_worker_slot($1,$2,$3,60) lease',[slot.slotId,instanceId,slot.deploymentId])).rows[0]!.lease);
  }
  async function seedJob(ownerId=OWNER_A,slot?:SharedFixtureSlot,options:{operation?:string;policyIdentity?:string;policy?:Record<string,unknown>;projectId?:string}={}) {
   const projectId=options.projectId??(await seedProject(db,ownerId)).id;
   const jobId=randomUUID();
   await db.query(`insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,billing_mode) values($1,$2,$3,$4,1,$5,'{}',$6,0,'openai_api')`,[jobId,ownerId,projectId,options.operation??'strategy',HASH,`fixture-${jobId}`]);
   if(slot){await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ownerId]);try{await db.query('select fluid_private.admit_shared_worker_job($1,$2,$3,$4,$5)',[jobId,slot.lane,options.policyIdentity??'fixture-uncapped-v1',slot.deploymentId,options.policy??{providerBudgetVersion:2}]);}finally{await db.query("select set_config('request.jwt.claim.sub','',false)");}}
   return {jobId,projectId,ownerId};
  }
  return {db,seedUser,seedSlot,asSlot,lease,seedJob,async close(){await db.exec('set session authorization postgres');await db.close();}};
 }catch(error){await db.close();throw error;}
}
export type SharedWorkerFixture=Awaited<ReturnType<typeof createSharedWorkerFixture>>;
export type {TestDatabase};
