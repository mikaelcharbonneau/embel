import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createSharedWorkerFixture,OWNER_A,OWNER_B,type SharedWorkerFixture,type SharedFixtureLease } from './shared-worker-fixture';

describe('fixed shared slot SQL authority (synthetic Auth, no provider)',()=>{
 let f:SharedWorkerFixture;
 beforeAll(async()=>{f=await createSharedWorkerFixture();await f.seedUser(OWNER_A);await f.seedUser(OWNER_B);},60_000);
 afterAll(async()=>{await f?.close();});
 const action=(s:Awaited<ReturnType<SharedWorkerFixture['seedSlot']>>,l:SharedFixtureLease,e:unknown,a:string,j:string|null=null)=>f.asSlot(s,async()=>(await f.db.query<{value:Record<string,unknown>}>(`select public.shared_${s.lane}_worker_action($1,$2,$3,jsonb_build_object('jobId',$4::uuid)) value`,[l,e,a,j])).rows[0]!.value);
 it('confirmation creates only metadata and repeated ensure is idempotent',async()=>{
  const before=(await f.db.query('select rolname from pg_roles order by oid')).rows;
  const user=randomUUID();await f.seedUser(user,{confirmed:false});
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
  let value=(await f.db.query<{value:{eligible:boolean;epoch:number}}> ('select public.ensure_shared_account_enrollment() value')).rows[0]!.value;
  expect(value.eligible).toBe(false);const epoch=value.epoch;
  expect((await f.db.query<{value:{epoch:number}}>('select public.ensure_shared_account_enrollment() value')).rows[0]!.value.epoch).toBe(epoch);
  await f.db.query('update auth.users set email_confirmed_at=clock_timestamp() where id=$1',[user]);
  value=(await f.db.query<{value:{eligible:boolean;epoch:number}}>('select public.get_shared_account_enrollment() value')).rows[0]!.value;
  expect(value.eligible).toBe(true);expect(value.epoch).toBeGreaterThan(epoch);
  expect((await f.db.query('select rolname from pg_roles order by oid')).rows).toEqual(before);
  await f.db.query("select set_config('request.jwt.claim.sub','',false)");
 });
 it('actual login/OID owns the slot, not a claimed owner, role GUC or reused process identifier',async()=>{
  const s=await f.seedSlot({index:1}),other=await f.seedSlot({index:2});const instance=randomUUID();const l=await f.lease(s,instance);
  expect(typeof l.roleOid).toBe('number');
  const configuration=await f.asSlot(s,async()=>(await f.db.query<{profile:{globalConcurrency:number;maxPerTenantPerLane:number;slotIds:string[]}}>('select public.shared_worker_pool_configuration() profile')).rows[0]!.profile);
  expect(configuration).toEqual({version:1,tenantScope:'per_lane',globalConcurrency:2,maxPerTenantPerLane:1,slotIds:[s.slotId,other.slotId].sort()});
  await expect(f.lease(s,instance)).rejects.toThrow(/shared_slot_held/);
  await expect(f.asSlot(other,()=>f.db.query('select public.renew_shared_worker_slot($1,60)',[l]))).rejects.toThrow(/shared_slot_fenced/);
  await expect(f.asSlot(s,()=>f.db.query('select * from public.jobs'))).rejects.toThrow(/permission denied/);
  await expect(f.asSlot(s,()=>f.db.query("select fluid_private.enter_shared_worker_context('{}','{}','active')"))).rejects.toThrow(/permission denied/);
  await expect(f.asSlot(s,()=>f.db.query("select public.renew_shared_worker_slot($1,60)",[{...l,roleOid:1}]))).rejects.toThrow(/shared_slot_fenced/);
  await f.db.exec(`create sequence auth.shared_slot_sequence_probe;grant usage on sequence auth.shared_slot_sequence_probe to ${s.roleName}`);
  await expect(f.asSlot(s,()=>f.db.query('select public.shared_worker_pool_configuration()'))).rejects.toThrow(/shared_slot_denied/);
  await f.db.exec(`revoke usage on sequence auth.shared_slot_sequence_probe from ${s.roleName}`);
  await f.db.exec(`grant execute on function public.create_project(text,text,jsonb,text) to ${s.roleName}`);
  await expect(f.asSlot(s,()=>f.db.query('select public.shared_worker_pool_configuration()'))).rejects.toThrow(/shared_slot_denied/);
  await f.db.exec(`revoke execute on function public.create_project(text,text,jsonb,text) from ${s.roleName}`);
  await expect(f.db.query('update fluid_private.shared_worker_slots set role_oid=1 where slot_id=$1',[s.slotId])).rejects.toThrow(/shared_slot_identity_immutable/);
 });
 it('two owners reuse one connection/slot with no residual tenant context, and forged scope is denied',async()=>{
  const s=await f.seedSlot({index:3}),l=await f.lease(s);
  for(const owner of [OWNER_A,OWNER_B]){
   const j=await f.seedJob(owner,s);const e=await action(s,l,null,'claim',j.jobId);
   expect((await action(s,l,e,'active')).ownerId).toBe(owner);
   await expect(action(s,l,{...e,ownerId:owner===OWNER_A?OWNER_B:OWNER_A},'active')).rejects.toThrow(/shared_execution_denied/);
   await expect(action(s,l,{...e,leaseToken:randomUUID()},'observe')).rejects.toThrow(/shared_execution_denied/);
   await expect(action(s,l,e,'fail')).rejects.toThrow(/fixture_rollback/);
   await expect(action(s,l,e,'leak')).rejects.toThrow(/shared_context_cleanup_required/);
   expect((await f.db.query('select * from fluid_private.shared_worker_gateway_context')).rows).toHaveLength(0);
   await f.db.query("update public.jobs set state='succeeded',lease_token=null,lease_expires_at=null where id=$1",[j.jobId]);
   await action(s,l,e,'close');
  }
  expect((await f.db.query('select * from fluid_private.shared_worker_gateway_context')).rows).toHaveLength(0);
 });
 it('expired generation preserves observations and unknown outcome while unrelated work progresses',async()=>{
  const s=await f.seedSlot({index:4}),old=await f.lease(s),a=await f.seedJob(OWNER_A,s);const e=await action(s,old,null,'claim',a.jobId);
  await f.db.query("update fluid_private.shared_worker_slots set expires_at=clock_timestamp()-interval '1 second' where slot_id=$1",[s.slotId]);
  const fresh=await f.lease(s);
  expect(fresh.generation).toBe(Number(old.generation)+1);
  await expect(action(s,old,e,'active')).rejects.toThrow(/shared_slot_fenced|shared_execution_fenced/);
  expect((await action(s,old,e,'observe')).jobId).toBe(a.jobId);
  expect((await action(s,fresh,e,'observe')).jobId).toBe(a.jobId);
  await expect(action(s,{...old,leaseToken:randomUUID()},e,'observe')).rejects.toThrow(/shared_observation_fenced/);
  const b=await f.seedJob(OWNER_B,s);const second=await action(s,fresh,null,'claim',b.jobId);expect(second.ownerId).toBe(OWNER_B);
  await expect(action(s,fresh,e,'close')).rejects.toThrow(/shared_execution_not_drained/);
  expect((await f.db.query<{state:string}>('select state from public.jobs where id=$1',[a.jobId])).rows[0]!.state).toBe('running');
  const rows=await f.asSlot(s,()=>f.db.query<{pending:{mode:string;execution:{jobId:string}}}>('select public.read_shared_worker_executions($1) pending',[fresh]));
  expect(rows.rows.some(r=>r.pending.mode==='observe'&&r.pending.execution.jobId===a.jobId)).toBe(true);
 });
 it('ban closes active dispatch immediately while exact issued observations survive',async()=>{
  const user=randomUUID();await f.seedUser(user);const s=await f.seedSlot({index:5}),l=await f.lease(s),j=await f.seedJob(user,s),e=await action(s,l,null,'claim',j.jobId);
  await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1",[user]);
  await expect(action(s,l,e,'active')).rejects.toThrow(/shared_dispatch_closed/);
  expect((await action(s,l,e,'observe')).ownerId).toBe(user);
  await f.db.query('update auth.users set banned_until=null where id=$1',[user]);
  await expect(action(s,l,e,'active')).rejects.toThrow(/shared_dispatch_closed/);
  expect((await action(s,l,e,'observe')).ownerId).toBe(user);
  await action(s,l,e,'park');
  expect((await f.db.query<{state:string}>('select state from fluid_private.shared_worker_executions where execution_id=$1',[e.executionId])).rows[0]!.state).toBe('observing');
  const another=await f.seedJob(OWNER_A,s);await action(s,l,null,'claim',another.jobId);
  await expect(f.asSlot(s,()=>f.db.query('select public.release_shared_worker_slot($1)',[l]))).rejects.toThrow(/shared_slot_not_drained/);
 });
 it('parking requires a real observation state and never declares the provider stopped',async()=>{
  const user=randomUUID();await f.seedUser(user);const s=await f.seedSlot({index:9}),l=await f.lease(s),j=await f.seedJob(user,s),e=await action(s,l,null,'claim',j.jobId);
  await expect(action(s,l,e,'park')).rejects.toThrow(/shared_execution_not_observable/);
  await f.db.query("update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null where id=$1",[j.jobId]);
  await action(s,l,e,'park');expect((await action(s,l,e,'observe')).ownerId).toBe(user);
  const next=await f.seedJob(user,s);expect((await action(s,l,null,'claim',next.jobId)).jobId).toBe(next.jobId);
  expect((await f.db.query<{state:string}>('select state from public.jobs where id=$1',[j.jobId])).rows[0]!.state).toBe('needs_reconciliation');
  await expect(action(s,l,e,'close')).rejects.toThrow(/shared_execution_not_drained/);
 });
 it('mismatched immutable admission/policy and tenant active bound cannot be bypassed',async()=>{
  const user=randomUUID();await f.seedUser(user);const s=await f.seedSlot({index:6}),other=await f.seedSlot({index:7}),l=await f.lease(s),otherLease=await f.lease(other);
  const a=await f.seedJob(user,s),b=await f.seedJob(user,other);await action(s,l,null,'claim',a.jobId);
  await expect(action(other,otherLease,null,'claim',b.jobId)).rejects.toThrow(/shared_job_denied/);
  await expect(f.db.query("update fluid_private.shared_job_admissions set owner_id=$2 where job_id=$1",[b.jobId,OWNER_B])).rejects.toThrow(/shared_admission_immutable/);
  const orphan=await f.seedJob(OWNER_B);await expect(action(other,otherLease,null,'claim',orphan.jobId)).rejects.toThrow(/shared_job_denied/);
  await f.db.query("update fluid_private.shared_worker_policies set policy='{}' where slot_id=$1",[other.slotId]);
  await expect(action(other,otherLease,null,'claim',b.jobId)).rejects.toThrow(/shared_job_denied/);
 });
 it('a fixed Storage actor never becomes an enrolled customer',async()=>{
  const user=randomUUID();await f.seedUser(user,{confirmed:false});await f.db.query("insert into fluid_private.shared_service_actors values($1,'logo_storage')",[user]);
  await f.db.query('update auth.users set email_confirmed_at=clock_timestamp() where id=$1',[user]);
  expect((await f.db.query<{active:boolean}>('select fluid_private.shared_account_customer_active($1) active',[user])).rows[0]!.active).toBe(false);
 });
 it('pages retained observations with an indexed stable cursor and a hard result bound',async()=>{
  const user=randomUUID();await f.seedUser(user);const s=await f.seedSlot({index:8});let l=await f.lease(s);const ids:string[]=[];
  for(let i=0;i<30;i++){
   const j=await f.seedJob(user,s),e=await action(s,l,null,'claim',j.jobId);ids.push(e.executionId as string);
   if(i<29){await f.db.query("update fluid_private.shared_worker_slots set expires_at=clock_timestamp()-interval '1 second' where slot_id=$1",[s.slotId]);l=await f.lease(s);}
  }
  let cursor:string|null=null;const seen:string[]=[];
  do{
   const page: {items:{execution:{executionId:string}}[];nextCursor:string|null}=await f.asSlot(s,async()=>(await f.db.query<{page:{items:{execution:{executionId:string}}[];nextCursor:string|null}}>('select public.read_shared_worker_execution_page($1,$2,7) page',[l,cursor])).rows[0]!.page);
   expect(page.items.length).toBeLessThanOrEqual(7);seen.push(...page.items.map(item=>item.execution.executionId));cursor=page.nextCursor;
  }while(cursor);
  expect(seen).toEqual(ids.sort());
  await expect(f.asSlot(s,()=>f.db.query('select public.read_shared_worker_execution_page($1,null,26)',[l]))).rejects.toThrow(/invalid_shared_recovery_limit/);
  expect((await f.asSlot(s,()=>f.db.query('select public.read_shared_worker_executions($1)',[l]))).rows).toHaveLength(25);
 });
 it('fatal local failure immediately fences admission without inventing a remote stop',async()=>{
  const owner=randomUUID();await f.seedUser(owner);const s=await f.seedSlot({index:10}),other=await f.seedSlot({index:11}),l=await f.lease(s),j=await f.seedJob(owner,s),e=await action(s,l,null,'claim',j.jobId);
  await expect(f.asSlot(other,()=>f.db.query('select public.fence_shared_worker_slot($1)',[l]))).rejects.toThrow(/shared_slot_fenced/);
  await f.asSlot(s,()=>f.db.query('select public.fence_shared_worker_slot($1)',[l]));
  await expect(action(s,l,e,'active')).rejects.toThrow(/shared_slot_fenced/);
  expect((await action(s,l,e,'observe')).jobId).toBe(j.jobId);
  expect((await f.db.query<{state:string}>('select state from public.jobs where id=$1',[j.jobId])).rows[0]!.state).toBe('running');
  const fresh=await f.lease(s);expect(fresh.generation).toBe(Number(l.generation)+1);
  await expect(f.asSlot(s,()=>f.db.query('select public.fence_shared_worker_slot($1)',[l]))).rejects.toThrow(/shared_slot_fenced/);
 });
});
