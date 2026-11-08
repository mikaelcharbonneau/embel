import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createSharedWorkerFixture,type SharedWorkerFixture,type SharedFixtureLease } from './shared-worker-fixture';

// Own database: every enabled slot here shares the six-job per-person limit.
describe('several Logo slots share one per-person limit (synthetic Auth, no provider)',()=>{
 let f:SharedWorkerFixture;
 beforeAll(async()=>{f=await createSharedWorkerFixture();},60_000);
 afterAll(async()=>{await f?.close();});
 type Slot=Awaited<ReturnType<SharedWorkerFixture['seedSlot']>>;
 const action=(s:Slot,l:SharedFixtureLease,a:string,j:string)=>f.asSlot(s,async()=>(await f.db.query<{value:Record<string,unknown>}>(`select public.shared_${s.lane}_worker_action($1,null,$2,jsonb_build_object('jobId',$3::uuid)) value`,[l,a,j])).rows[0]!.value);
 const policies=[{operation:'identity.logo_concept',policyIdentity:'fixture-uncapped-v1',policy:{providerBudgetVersion:2}}];

 it('lets one person run six Logo jobs at once, one per slot, and holds the seventh',async()=>{
  const user=randomUUID();await f.seedUser(user);
  const slots:Slot[]=[];for(let index=1;index<=7;index++)slots.push(await f.seedSlot({lane:'logo',index,policies,tenantActiveLimit:6}));
  // One fixture connection: lease each slot in turn.
  const leases:SharedFixtureLease[]=[];for(const slot of slots)leases.push(await f.lease(slot));
  const jobs=[];for(const slot of slots)jobs.push(await f.seedJob(user,slot,{operation:'identity.logo_concept'}));
  for(let index=0;index<6;index++)await action(slots[index]!,leases[index]!,'claim',jobs[index]!.jobId);
  const active=await f.db.query<{count:number;slots:number}>("select count(*)::int count,count(distinct slot_id)::int slots from fluid_private.shared_worker_executions where lane='logo' and owner_id=$1 and state='active'",[user]);
  expect(active.rows[0]).toEqual({count:6,slots:6});
  await expect(action(slots[6]!,leases[6]!,'claim',jobs[6]!.jobId)).rejects.toThrow(/shared_job_denied/);
  const configured=await f.asSlot(slots[0]!,async()=>(await f.db.query<{value:{globalConcurrency:number;maxPerTenantPerLane:number}}>('select public.shared_worker_pool_configuration() value')).rows[0]!.value);
  expect(configured).toMatchObject({globalConcurrency:7,maxPerTenantPerLane:6});
 });
});
