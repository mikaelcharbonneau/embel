import {createHash} from 'node:crypto';
import {proposalAdmissionFixture,WORKER} from './logo-vector-proposal-admission-fixture';
import type {TestDatabase} from './local-supabase';
import {parseClaimedJob} from '../../worker/postgres-store';
import type {JobStore} from '../../worker/runner';
import {stepOutcomeSchema,type ClaimedJob} from '@/domain/jobs';
import type {LogoWorkerConnection} from '@/server/data/logo-jobs';
import {createLogoVectorProposalWorkerPorts} from '@/server/data/logo-vector-proposal-worker';

/** Test-only SQL bridge for the disconnected handler. The real five-operation
 * production JobStore/host is intentionally NOT modified or registered here.
 * Every query executes as the actual restricted session_user. Serialization is
 * needed only because this disposable PGlite connection has one session. */
export async function proposalSqlRunnerFixture(db:TestDatabase){
 const f=await proposalAdmissionFixture(db),receipt=await f.admitted();
 await db.exec(`grant execute on function public.register_logo_job_plan(uuid,uuid,jsonb),fluid_private.stage_logo_vector_proposal(uuid,uuid,jsonb,uuid) to ${WORKER};`);
 let pending:Promise<unknown>=Promise.resolve();
 const serial=<T>(run:()=>Promise<T>):Promise<T>=>{const result=pending.then(run,run);pending=result.then(()=>undefined,()=>undefined);return result;};
 const connection:LogoWorkerConnection={query:<Row=Record<string,unknown>>(sql:string,parameters?:unknown[])=>serial(()=>f.worker(()=>db.query<Row>(sql,parameters)))};
 let claimed:ClaimedJob|null=null;
 const store:JobStore={
  async claim(worker,seconds){const result=await connection.query('select * from public.claim_logo_job($1,$2)',[worker,seconds]);claimed=result.rows.length?parseClaimedJob(result.rows[0]):null;return claimed;},
  async registerPlan(job,manifest){await connection.query('select public.register_logo_job_plan($1,$2,$3)',[job.id,job.leaseToken,JSON.stringify(manifest)]);},
  async heartbeat(job,seconds){const result=await connection.query('select * from public.heartbeat_logo_job($1,$2,$3)',[job.id,job.leaseToken,seconds]);const current=parseClaimedJob(result.rows[0]);return{cancelled:current.status==='cancel_requested'};},
  async beginStep(job,key,maximum){const requestKey=createHash('sha256').update(`${job.id}:${key}`).digest('hex');const result=await connection.query<{v:'started'|'already_succeeded'}>('select public.begin_logo_job_step($1,$2,$3,$4,$5) v',[job.id,job.leaseToken,key,requestKey,maximum]);return result.rows[0]!.v;},
  async completeStep(job,key,raw){const o=stepOutcomeSchema.parse(raw),state=o.status==='needs_reconciliation'?'ambiguous':o.status,output=o.status==='succeeded'?o.result:{error:o.code,...('result'in o?{result:o.result}:{})};await connection.query('select public.complete_logo_job_step($1,$2,$3,$4,$5,$6,$7)',[job.id,job.leaseToken,key,state,o.costMicrousd,JSON.stringify(output),o.providerRequestId]);},
  async finish(job,state){await connection.query('select public.finish_logo_job($1,$2,$3)',[job.id,job.leaseToken,state]);},
 };
 return{...f,admission:receipt,connection,ports:createLogoVectorProposalWorkerPorts(connection),store,serial,claimed:()=>claimed};
}
export function deferred<T>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
