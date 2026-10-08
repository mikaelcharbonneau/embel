import { randomUUID } from 'node:crypto';
import { asRole, OWNER_A, type TestDatabase } from './local-supabase';
import { logoWorkspaceV2Schema, type LogoMutationReceipt } from '@/domain/logo-workspace';
import type { LogoResolvedDirectionInput } from '@/domain/logo-jobs';
import { normalizeDirectionResponse } from '@/features/identity-directions/server/direction-response';
import { inspectTypographySamples } from '@/features/identity-directions/server/font-inspection';
import { fontFixture, fontBytes } from '../features/identity-directions/fixtures';
import { separatedLogoDocument } from '../features/logo-vector/fixtures';

export const SQL_SUBSCRIPTION_ROLE = 'fixture_logo_subscription';
export const sqlSubscriptionPolicy = () => ({version:1,billingMode:'chatgpt_subscription',handlerVersion:'logo-directions-v1',adapterVersion:'logo-directions-chatgpt-v1',registrationId:'sql-fixture-registration',model:'fixture-text-model',apiCharge:'verified_zero',limits:{maxInputBytes:131072,maxOutputBytes:262144,maxStreamBytes:2097152,deadlineMs:240000,maxObservedWebSearchCalls:0,maxRequestsPerHour:20,maxQueuedJobs:3}});
export type SqlPolicy = ReturnType<typeof sqlSubscriptionPolicy>;
export async function sqlWorker<T>(db:TestDatabase,run:()=>Promise<T>,role=SQL_SUBSCRIPTION_ROLE){await db.exec(`set session authorization ${role}`);try{return await run();}finally{await db.exec('set session authorization postgres');}}
export async function logoSqlRpc(db:TestDatabase,name:string,args:unknown[],owner=OWNER_A){return asRole(db,'authenticated',owner,async()=>(await db.query<{v:unknown}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) v`,args)).rows[0]!.v);}
export async function installSqlSubscriptionFixture(db:TestDatabase){
 await db.exec(`create role ${SQL_SUBSCRIPTION_ROLE} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 grant usage on schema public,fluid_private to ${SQL_SUBSCRIPTION_ROLE};
 grant execute on function fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb),public.report_logo_worker_ready(text,jsonb,integer),public.claim_logo_job(text,integer),public.begin_logo_job_step(uuid,uuid,text,text,bigint),public.heartbeat_logo_job(uuid,uuid,integer),public.read_leased_logo_record(uuid,uuid,text,jsonb),public.record_logo_provider_response(uuid,uuid,jsonb),public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),public.stage_logo_directions(uuid,uuid,jsonb,uuid,jsonb),public.load_logo_direction_inputs(uuid,uuid) to ${SQL_SUBSCRIPTION_ROLE};`);
}
export async function bindSqlSubscriptionFixture(db:TestDatabase){for(const table of ['logo_asset_web_principals','logo_worker_principals'])await db.query(`insert into fluid_private.${table}(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2 on conflict(role_name) do update set owner_id=excluded.owner_id,role_oid=excluded.role_oid`,[OWNER_A,SQL_SUBSCRIPTION_ROLE]);}
export async function sqlPolicyIdentity(db:TestDatabase,policy:unknown){return (await db.query<{v:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') v",[policy])).rows[0]!.v;}
export async function configureSqlSubscriptionFixture(db:TestDatabase,policy=sqlSubscriptionPolicy()){
 await db.query('insert into fluid_private.subscription_registrations(registration_id,owner_id,connected,plan_usage_enabled) values($1,$2,true,true) on conflict(registration_id) do update set connected=true,plan_usage_enabled=true',[policy.registrationId,OWNER_A]);
 const hash=await sqlPolicyIdentity(db,policy);
 await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled,subscription_policy) values($1,'identity.logo_directions',$2,'logo-directions-v1','openai',$3,0,true,$4) on conflict(owner_id,operation) do update set policy_identity=excluded.policy_identity,model=excluded.model,subscription_policy=excluded.subscription_policy",[OWNER_A,hash,policy.model,policy]);
 const descriptor={operation:'identity.logo_directions',policyIdentity:hash,handlerVersion:'logo-directions-v1',provider:'openai',model:policy.model,engine:null,maxCostMicrousd:0,billingMode:'chatgpt_subscription',policy};
 const ready=(await sqlWorker(db,()=>db.query<{v:boolean}>("select public.report_logo_worker_ready('subscription-fixture',$1,90) v",[[descriptor]]))).rows[0]!.v;
 if(!ready)throw new Error('Synthetic subscription readiness rejected');
 return {policy,hash,descriptor};
}
export async function approvedSqlDirectionFixture(db:TestDatabase){
 const brief={name:'Fluid SQL',activity:'Synthetic SQL test',audience:'Fixture',personality:'Calm',logoTypes:['wordmark']};
 const start=logoWorkspaceV2Schema.parse(await logoSqlRpc(db,'start_logo_project',[{requestKey:randomUUID(),brief}])),vectorId=randomUUID();
 await db.query('insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)',[vectorId,OWNER_A,start.projectId,{id:vectorId,ownerId:OWNER_A,projectId:start.projectId,reviewStatus:'review_required',inputRevisions:[start.stages.brief_references],locks:[]}]);
 const approved=(await sqlWorker(db,()=>db.query<{v:LogoMutationReceipt}>('select fluid_private.apply_logo_trusted_command($1,$2,$3) v',[start.projectId,{method:'acceptLogoVector',body:{requestKey:randomUUID(),expected:start.heads,vectorRevisionId:vectorId,acceptEarlierBasis:false}},{vectorRevisionId:vectorId,currentVectorRevisionId:null,expected:start.heads}]))).rows[0]!.v;
 const w=approved.workspace,original=fontFixture(),font={...original,asset:{...original.asset,ownerId:OWNER_A,projectId:w.projectId}};
 await db.query('insert into public.logo_font_records(record_id,version_id,owner_id,project_id,record) values($1,$2,$3,$4,$5)',[font.id,font.asset.versionId,OWNER_A,w.projectId,font]);
 const source=(await db.query<{v:Record<string,unknown>}>('select fluid_private.logo_prepare_direction_sources($1,$2,$3) v',[OWNER_A,w.projectId,w.approvedLogo!.id])).rows[0]!.v;
 const resolved={...source,logo:separatedLogoDocument()} as unknown as LogoResolvedDirectionInput;delete (resolved as unknown as Record<string,unknown>).logoRevision;
 const candidate={directions:[0,1,2].map(n=>({name:`Synthetic direction ${n+1}`,palette:{swatches:[{key:'ink',name:'Ink',hex:['#191919','#242424','#333333'][n]},{key:'paper',name:'Paper',hex:'#FFFFFF'}],pairings:[{role:'body',foregroundKey:'ink',backgroundKey:'paper'}]},typography:{styles:[{key:'body',role:'body',sampleText:brief.name,fontVersionId:font.id,weight:400,style:'normal',sizePx:16,lineHeight:1.5}]},graphics:{elements:[]}}))};
 const result=normalizeDirectionResponse(candidate,resolved),checks=await inspectTypographySamples({record:font,bytes:fontBytes(),contentHash:font.asset.contentHash,purpose:'render'},result.typography.flatMap(t=>t.styles.map(s=>({typographyVersionId:t.id,styleKey:s.key,role:s.role,text:s.sampleText,weight:s.weight,style:s.style}))));
 return {w,result,checks,source,request:{operation:'directions',expected:w.heads,approvedLogoId:w.approvedLogo!.id}};
}
export function sqlObservation(policy=sqlSubscriptionPolicy()) {return {version:2,billingMode:'chatgpt_subscription',registrationId:policy.registrationId,responseId:'resp_fixture_sql',usage:{inputTokens:2,outputTokens:3,totalTokens:5},provider:'openai',model:policy.model,providerRequestId:null as string|null,responseHash:'c'.repeat(64) as string|null,observedAt:new Date().toISOString(),billing:{status:'recorded',confirmedMicrousd:0},artifactHash:null};}
