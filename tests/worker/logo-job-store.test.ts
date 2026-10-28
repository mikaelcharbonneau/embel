import { reportLogoFixtureReady, SYNTHETIC_CONCEPT_READINESS } from '../database/logo-readiness-fixture';
import { describe,expect,it,vi } from 'vitest';
import { createLogoJobStore } from '../../worker/logo-job-store';
const job={id:'a0000000-0000-4000-8000-000000000001',ownerId:'a0000000-0000-4000-8000-000000000002',projectId:'a0000000-0000-4000-8000-000000000003',leaseToken:'a0000000-0000-4000-8000-000000000004',operation:'identity.logo_concept',input:{},inputRevision:1,status:'running' as const,reservedCostMicrousd:100,actualCostMicrousd:0};
describe('logo job store',()=>{
 it('forwards a retained ambiguous artifact to the atomic completion boundary',async()=>{const query=vi.fn().mockResolvedValue({rows:[]});await createLogoJobStore({query}).completeStep(job,'preview',{status:'needs_reconciliation',code:'billing_unknown',costMicrousd:0,providerRequestId:'synthetic',result:{publicationId:'retained'}});expect(query).toHaveBeenCalledWith('select public.complete_logo_job_step($1,$2,$3,$4,$5,$6,$7)',[job.id,job.leaseToken,'preview','ambiguous',0,JSON.stringify({error:'billing_unknown',result:{publicationId:'retained'}}),'synthetic']);});
 it('uses only restricted logo claim RPC and refuses another operation at completion',async()=>{const query=vi.fn().mockResolvedValue({rows:[]});const store=createLogoJobStore({query});expect(await store.claim('test',60)).toBeNull();await expect(store.completeStep({...job,operation:'identity.image'},'preview',{status:'failed',code:'not_dispatched',costMicrousd:0,providerRequestId:null})).rejects.toThrow();expect(query).toHaveBeenCalledTimes(1);});
});

import { randomUUID } from 'node:crypto';
import { beforeAll,afterAll } from 'vitest';
import { runOneJob } from '../../worker/runner';
import { createTestDatabase,resetFixture,asRole,OWNER_A,type TestDatabase } from '../database/local-supabase';
import { logoWorkspaceV2Schema } from '../../src/domain/logo-workspace';
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema,logoConceptJobInputSchema } from '../../src/domain/logo-jobs';
describe('existing runner with real restricted logo SQL',()=>{
 let db:TestDatabase;
 beforeAll(async()=>{db=await createTestDatabase();await resetFixture(db);await db.exec(`create role fixture_logo_runner login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;grant usage on schema public to fixture_logo_runner;grant execute on function public.claim_logo_job(text,integer),public.heartbeat_logo_job(uuid,uuid,integer),public.register_logo_job_plan(uuid,uuid,jsonb),public.begin_logo_job_step(uuid,uuid,text,text,bigint),public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),public.read_leased_logo_record(uuid,uuid,text,jsonb) to fixture_logo_runner;`);await db.query("insert into fluid_private.logo_worker_principals select rolname,oid,$1 from pg_roles where rolname='fixture_logo_runner'",[OWNER_A]);await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_concept',$2,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',100,true)",[OWNER_A,'a'.repeat(64)]);},60_000);
 afterAll(async()=>{await db?.close();});
 it('keeps six one-step children independent without modifying the stop-on-failure runner',async()=>{
  await reportLogoFixtureReady(db,'fixture_logo_runner',['fixture'],[SYNTHETIC_CONCEPT_READINESS]);
  await asRole(db,'authenticated',OWNER_A,async()=>{
   const workspace=logoWorkspaceV2Schema.parse((await db.query<{v:unknown}>('select public.start_logo_project($1) v',[{requestKey:randomUUID(),brief:{name:'Runner local',activity:'Test',audience:'Test',personality:'Precise',logoTypes:['wordmark']}}])).rows[0]!.v);
   const brief=(await db.query<{v:{payload:{referenceSnapshotId:string}}}>("select public.read_logo_workspace_record($1,'stage',$2) v",[workspace.projectId,workspace.stages.brief_references!.id])).rows[0]!.v;
   const quote=logoCostQuoteSchema.parse((await db.query<{v:unknown}>('select public.quote_logo_operation($1,$2) v',[workspace.projectId,{operation:'concepts',expected:workspace.heads,briefRevisionId:workspace.stages.brief_references!.id,referenceSnapshotId:brief.payload.referenceSnapshotId}])).rows[0]!.v);
   await db.query('select public.admit_logo_operation($1,$2)',[workspace.projectId,{requestKey:randomUUID(),quoteId:quote.id,acceptedMaxCostMicrousd:quote.maxCostMicrousd,expected:workspace.heads}]);
  });
  const store=createLogoJobStore(db),seen=new Set<string>();
  await db.exec('set session authorization fixture_logo_runner');
  try{
   const handlers=new Map([['identity.logo_concept',{steps(current:import('../../src/domain/jobs').ClaimedJob){const input=logoConceptJobInputSchema.parse(current.input);return[{key:`logo-preview-v1:${input.slotId}:${input.attemptId}`,maximumCostMicrousd:100,async execute(){seen.add(input.slotId);return{status:'failed' as const,code:'not_dispatched',costMicrousd:0,providerRequestId:null};}}];}}]]);
   for(let i=0;i<6;i++)expect(await runOneJob({store,handlers,workerId:'fixture'})).toBe('failed');
   expect(await runOneJob({store,handlers,workerId:'fixture'})).toBe('idle');
  }finally{await db.exec('set session authorization postgres');}
  expect(seen.size).toBe(6);expect((await db.query<{state:string}>('select state from public.jobs')).rows.every(r=>r.state==='failed')).toBe(true);expect((await db.query('select reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:0});
 });
});

describe('known partial export completion',()=>{
 it('retains the exact partial group in a failed zero-cost step',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[]}),result={version:2,kind:'logo_export_partial',publicationId:'a0000000-0000-4000-8000-000000000020'};
  await createLogoJobStore({query}).completeStep({...job,operation:'identity.logo_export',reservedCostMicrousd:0},'prepare-export',{status:'failed',code:'export_file_failed',result,costMicrousd:0,providerRequestId:null});
  expect(query).toHaveBeenCalledExactlyOnceWith('select public.complete_logo_job_step($1,$2,$3,$4,$5,$6,$7)',[job.id,job.leaseToken,'prepare-export','failed',0,JSON.stringify({error:'export_file_failed',result}),null]);
 });
 it('does not widen failed-result publication to another operation or export kind',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[]}),result={version:2,kind:'logo_export_partial',publicationId:'a0000000-0000-4000-8000-000000000020'};
  await expect(createLogoJobStore({query}).completeStep(job,'preview',{status:'failed',code:'export_file_failed',result,costMicrousd:0,providerRequestId:null})).rejects.toThrow();
  await expect(createLogoJobStore({query}).completeStep({...job,operation:'identity.logo_export',reservedCostMicrousd:0},'prepare-export',{status:'failed',code:'export_file_failed',result:{...result,kind:'logo_export'},costMicrousd:0,providerRequestId:null})).rejects.toThrow();expect(query).not.toHaveBeenCalled();
 });
});
