import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LogoWorkerConnection } from '../src/server/data/logo-jobs';
import { parseClaimedJob } from './postgres-store';
import { PlanConflictError,type JobStore } from './runner';
import { logoOperationSchema,logoExportPartialStepOutputSchema } from '../src/domain/logo-jobs';
import { stepOutcomeSchema,type ClaimedJob } from '../src/domain/jobs';

/** One restricted connection, existing runner. No privileged base-store fallback. */
export function createLogoJobStore(connection:LogoWorkerConnection):JobStore & {expireLeases():Promise<number>}{
 function valid(job:ClaimedJob){logoOperationSchema.parse(job.operation);}
 return{
  async claim(workerId,leaseSeconds){const r=await connection.query('select * from public.claim_logo_job($1,$2)',[workerId,leaseSeconds]);return r.rows.length?parseClaimedJob(r.rows[0]):null;},
  async heartbeat(job,leaseSeconds){valid(job);const r=await connection.query('select * from public.heartbeat_logo_job($1,$2,$3)',[job.id,job.leaseToken,leaseSeconds]);const j=parseClaimedJob(r.rows[0]);if(j.ownerId!==job.ownerId||j.projectId!==job.projectId)throw new Error('Lease owner mismatch');return{cancelled:j.status==='cancel_requested'};},
  async registerPlan(job,manifest){valid(job);try{await connection.query('select public.register_logo_job_plan($1,$2,$3)',[job.id,job.leaseToken,JSON.stringify(manifest)]);}catch(e){if(e instanceof Error&&e.message==='plan_conflict'){const r=await connection.query<{value:boolean}>('select public.read_leased_logo_record($1,$2,\'has_results\',null) value',[job.id,job.leaseToken]);throw new PlanConflictError(z.boolean().parse(r.rows[0]?.value));}throw e;}},
  async beginStep(job,stepKey,maximumCostMicrousd){valid(job);const key=createHash('sha256').update(`${job.id}:${stepKey}`).digest('hex');const r=await connection.query<{value:unknown}>('select public.begin_logo_job_step($1,$2,$3,$4,$5) value',[job.id,job.leaseToken,stepKey,key,maximumCostMicrousd]);return z.enum(['started','already_succeeded']).parse(r.rows[0]?.value);},
  async completeStep(job,stepKey,raw){valid(job);const outcome=stepOutcomeSchema.parse(raw);if(outcome.status==='failed'&&outcome.result!==undefined){if(job.operation!=='identity.logo_export'||stepKey!=='prepare-export'||outcome.costMicrousd!==0||outcome.providerRequestId!==null||!['export_file_failed','export_package_too_large'].includes(outcome.code))throw new Error('Failed publication is only permitted for known partial exports');logoExportPartialStepOutputSchema.parse(outcome.result);}const state=outcome.status==='needs_reconciliation'?'ambiguous':outcome.status;const output=outcome.status==='succeeded'?outcome.result:{error:outcome.code,...('result'in outcome?{result:outcome.result}:{})};await connection.query('select public.complete_logo_job_step($1,$2,$3,$4,$5,$6,$7)',[job.id,job.leaseToken,stepKey,state,outcome.costMicrousd,JSON.stringify(output),outcome.providerRequestId]);},
  async finish(job,state){valid(job);await connection.query('select public.finish_logo_job($1,$2,$3)',[job.id,job.leaseToken,state]);},
  async expireLeases(){const r=await connection.query<{value:unknown}>('select public.expire_logo_job_leases() value');return z.number().int().nonnegative().parse(r.rows[0]?.value);},
 };
}
