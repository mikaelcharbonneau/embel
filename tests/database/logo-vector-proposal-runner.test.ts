import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createTestDatabase,type TestDatabase} from './local-supabase';
import {proposalSqlRunnerFixture,deferred} from './logo-vector-proposal-runner-fixture';
import {completionLedger,resultFor} from './logo-vector-proposal-completion-fixture';
import {proposalObservation} from '../server/logo-vector-proposal-fixtures';
import {logoVectorProposalProviderObservationSchema,logoVectorProposalRecordSchema} from '@/domain/logo-vector-proposal-jobs';
import type {LogoVectorProposalProvider} from '@/features/logo-vector/server/proposal-provider';
import {createLogoVectorProposalHandler} from '../../worker/handlers/logo-vector-proposals';
import {runOneJob,type JobHandler} from '../../worker/runner';
const candidates=await Promise.all(['logo-vector-proposals.sql','logo-vector-proposal-quotes.sql','logo-vector-proposal-admission.sql','logo-vector-proposal-observations.sql','logo-vector-proposal-completion.sql'].map(name=>readFile(new URL('../../supabase/candidates/'+name,import.meta.url),'utf8')));
let db:TestDatabase;
beforeAll(async()=>{db=await createTestDatabase({additionalMigrations:candidates});},60_000);afterAll(async()=>{await db?.close();});
async function setup(options:{hold?:boolean;lostAck?:'record'|'stage';shortDeadline?:boolean}={}){
 const f=await proposalSqlRunnerFixture(db),started=deferred<void>(),release=deferred<void>(),staged=deferred<string>();let calls=0;
 const provider:LogoVectorProposalProvider={async propose(context,_instruction,policy,_signal,dispatch){await dispatch.beforeDispatch(structuredClone(dispatch.job));calls++;started.resolve();if(options.hold)await release.promise;return{kind:'observed',observation:logoVectorProposalProviderObservationSchema.parse({...proposalObservation(),textPolicy:policy}),result:resultFor(context.components[0]!.id)};}};
 const real=f.ports;
 const ports={...real,async recordResponse(...args:Parameters<typeof real.recordResponse>){const value=await real.recordResponse(...args);if(options.lostAck==='record')throw Error('Synthetic lost committed observation acknowledgment');return value;},async stageProposal(...args:Parameters<typeof real.stageProposal>){const value=await real.stageProposal(...args);staged.resolve(value.id);if(options.lostAck==='stage')throw Error('Synthetic lost committed stage acknowledgment');return value;}};
 const original=createLogoVectorProposalHandler({...ports,provider});
 // Earlier test-only runner deadline, never a policy or production handler edit.
 const handler:JobHandler=options.shortDeadline?{steps:job=>original.steps(job).map(step=>({...step,timeoutMs:30}))}:original;
 const run=(heartbeatMs=1000)=>runOneJob({store:f.store,handlers:new Map([['identity.logo_vector_propose',handler]]),workerId:'proposal-fixture',heartbeatMs,abortGraceMs:5,leaseSeconds:60});
 const read=async(id:string)=>logoVectorProposalRecordSchema.parse(await f.serial(()=>f.rpc('read_logo_vector_proposal',[f.workspace.projectId,id])));
 return{...f,started,release,staged,run,read,calls:()=>calls};
}
it('runs the reviewed handler through actual restricted SQL and real evidence ports with one bill and no artwork',async()=>{
 const f=await setup();expect(await f.run()).toBe('succeeded');const id=await f.staged.promise;
 expect(await f.read(id)).toMatchObject({state:'succeeded',actualCostMicrousd:34,materialization:'unavailable'});expect(f.calls()).toBe(1);
 expect(await completionLedger(db,f.admission.jobIds[0]!)).toMatchObject({job:{state:'succeeded',actual_cost_microusd:34},reservation:{state:'settled'},account:{provider_actual_microusd:34,reserved_microusd:0}});
 expect((await db.query('select * from public.logo_asset_publications')).rows).toEqual([]);expect((await db.query('select * from public.job_steps')).rows).toHaveLength(1);
});
it('retains actual late SQL bill and bounded output after runner lease_lost without completeStep or reinference',async()=>{
 const f=await setup({hold:true}),running=f.run(5);await f.started.promise;
 await f.serial(()=>db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.admission.jobIds[0]]));
 expect(await running).toBe('lease_lost');await f.connection.query('select public.expire_logo_job_leases()');f.release.resolve();const id=await f.staged.promise;
 const record=await f.read(id);expect(record).toMatchObject({state:'needs_reconciliation',actualCostMicrousd:34,payload:resultFor(f.context.components[0]!.id).payload});
 expect((await db.query<{result:unknown}>('select result from fluid_private.logo_vector_proposal_prepared_results where id=$1',[id])).rows[0]!.result).toEqual(resultFor(f.context.components[0]!.id));
 expect(await completionLedger(db,f.admission.jobIds[0]!)).toMatchObject({job:{state:'needs_reconciliation',actual_cost_microusd:34},reservation:{state:'active'},account:{provider_actual_microusd:34,reserved_microusd:122846}});
 expect((await db.query('select state,completed_at from public.job_steps')).rows).toEqual([{state:'in_flight',completed_at:null}]);expect(f.calls()).toBe(1);expect(await f.store.claim('proposal-fixture',60)).toBe(null);
});
it('retains a later SQL response after the runner commits zero-cost uncertainty and replays that original request exactly',async()=>{
 const f=await setup({hold:true,shortDeadline:true}),running=f.run();await f.started.promise;expect(await running).toBe('needs_reconciliation');
 expect((await completionLedger(db,f.admission.jobIds[0]!)).account).toMatchObject({provider_actual_microusd:0,reserved_microusd:122880});
 const original=f.claimed()!;f.release.resolve();const id=await f.staged.promise;expect(await f.read(id)).toMatchObject({state:'needs_reconciliation',actualCostMicrousd:34});
 await f.store.completeStep(original,'propose-vector-edit',{status:'needs_reconciliation',code:'provider_outcome_unknown',costMicrousd:0,providerRequestId:null});
 expect((await completionLedger(db,original.id)).account).toEqual({spent_microusd:34,provider_actual_microusd:34,reserved_microusd:122846});expect(f.calls()).toBe(1);
});
it.each(['record','stage'] as const)('recovers a lost committed %s acknowledgment through actual SQL completion and keeps one bill/output',async lostAck=>{
 const f=await setup({lostAck});expect(await f.run()).toBe('needs_reconciliation');const job=f.admission.jobIds[0]!,p=(await db.query<{id:string;result:unknown}>('select id,result from fluid_private.logo_vector_proposal_prepared_results where job_id=$1',[job])).rows[0]!;
 expect(p.result).toEqual(resultFor(f.context.components[0]!.id));expect(await f.read(p.id)).toMatchObject({state:'needs_reconciliation',actualCostMicrousd:34,payload:resultFor(f.context.components[0]!.id).payload});
 expect((await db.query('select * from public.logo_provider_responses')).rows).toHaveLength(1);expect((await db.query('select * from fluid_private.logo_vector_proposals')).rows).toHaveLength(1);
 expect((await completionLedger(db,job)).account).toEqual({spent_microusd:34,provider_actual_microusd:34,reserved_microusd:122846});expect(f.calls()).toBe(1);
});
