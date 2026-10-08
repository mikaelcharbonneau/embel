import {createHash} from 'node:crypto';
import {proposalAdmissionFixture,WORKER} from './logo-vector-proposal-admission-fixture';
import type {TestDatabase} from './local-supabase';
import {createLogoVectorProposalService} from '@/server/data/logo-vector-proposals';
import type {AuthenticatedContext} from '@/server/auth/context';
import {proposalObservation} from '../server/logo-vector-proposal-fixtures';
import {proposed,proposalFixture} from '../features/logo-vector/proposal-fixtures';
import {logoVectorProposalObservedResultSchema,logoVectorProposalPreparedReceiptSchema} from '@/domain/logo-vector-proposal-evidence';
import {logoVectorProposalProviderReceiptSchema} from '@/domain/logo-vector-proposal-jobs';
export function retained(bytes:Uint8Array|string){const b=Buffer.from(bytes);return{encoding:'base64' as const,data:b.toString('base64'),sha256:createHash('sha256').update(b).digest('hex'),byteLength:b.length,truncated:false};}
export function resultFor(componentId='synthetic-symbol') {const payload=proposed({kind:'rotation',componentId,degrees:10});return logoVectorProposalObservedResultSchema.parse({status:'valid',payload,reason:null,retainedOutput:retained(JSON.stringify(payload))});}
export async function proposalCompletionFixture(db:TestDatabase,options:{begin?:boolean;observe?:boolean;observation?:unknown;source?:ReturnType<typeof proposalFixture>}={}){
 const f=await proposalAdmissionFixture(db,options.source);await f.admitted();const j=(await f.claim())!;
 if((await db.query<{v:unknown}>("select to_regprocedure('fluid_private.stage_logo_vector_proposal(uuid,uuid,jsonb,uuid)') v")).rows[0]!.v)await db.exec(`grant execute on function fluid_private.stage_logo_vector_proposal(uuid,uuid,jsonb,uuid) to ${WORKER};`);
 if(options.begin!==false)await f.worker(()=>db.query("select public.begin_logo_job_step($1,$2,'propose-vector-edit','once',122880)",[j.id,j.lease_token]));
 const observation=options.observation??proposalObservation();
 const record=async(o:unknown=observation)=>logoVectorProposalProviderReceiptSchema.parse((await f.worker(()=>db.query<{v:unknown}>('select public.record_logo_provider_response($1,$2,$3) v',[j.id,j.lease_token,o]))).rows[0]!.v);
 const receipt=options.observe===false?null:await record(),result=resultFor(f.context.components[0]!.id);
 const stage=async(value:unknown=result,id=receipt?.id)=>logoVectorProposalPreparedReceiptSchema.parse((await f.worker(()=>db.query<{v:unknown}>('select fluid_private.stage_logo_vector_proposal($1,$2,$3,$4) v',[j.id,j.lease_token,value,id]))).rows[0]!.v);
 const complete=(state:string,cost:number,output:unknown,requestId:string|null=proposalObservation().providerRequestId)=>f.worker(async()=>(await db.query<{v:unknown}>("select public.complete_logo_job_step($1,$2,'propose-vector-edit',$3,$4,$5,$6) v",[j.id,j.lease_token,state,cost,output,requestId])).rows[0]!.v);
 // Normal owned DAL, backed by the actual authenticated-role SQL fixture.
 const read=async(id:string)=>createLogoVectorProposalService().readLogoVectorProposal({userId:j.owner_id,client:{rpc:async(name:string,args:{p_project_id:string;p_proposal_id:string})=>({data:await f.rpc(name,[args.p_project_id,args.p_proposal_id]),error:null})}} as unknown as AuthenticatedContext,f.workspace.projectId,id);
 const finish=(state:string)=>f.worker(()=>db.query('select public.finish_logo_job($1,$2,$3)',[j.id,j.lease_token,state]));
 const expire=async()=>{await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[j.id]);await f.worker(()=>db.query('select public.expire_logo_job_leases()'));};
 return{...f,j,observation,receipt,result,record,stage,complete,read,finish,expire};
}
export async function completionLedger(db:TestDatabase,id:string){return{
 job:(await db.query('select state,actual_cost_microusd,lease_token from public.jobs where id=$1',[id])).rows[0],
 reservation:(await db.query('select state,reserved_microusd,actual_microusd,captured_microusd from public.usage_reservations where job_id=$1',[id])).rows[0],
 account:(await db.query('select spent_microusd,provider_actual_microusd,reserved_microusd from public.usage_accounts where owner_id=(select owner_id from public.jobs where id=$1)',[id])).rows[0],
};}
