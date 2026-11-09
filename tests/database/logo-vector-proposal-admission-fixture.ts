import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import {asRole,OWNER_A,resetFixture,type TestDatabase} from './local-supabase';
import {logoWorkspaceV2Schema} from '@/domain/logo-workspace';
import {legacyLogoCostQuoteSchema as logoCostQuoteSchema,logoDispatchReceiptSchema} from '@/domain/logo-jobs';
import {proposalFixture} from '../features/logo-vector/proposal-fixtures';
import {buildLogoVectorProposalContext} from '@/features/logo-vector/server/proposal-context';
import {proposalPolicy} from '../server/logo-vector-proposal-fixtures';
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";
export const WEB='fixture_proposal_admission_web',WORKER='fixture_proposal_admission_worker';
export async function proposalLogin<T>(db:TestDatabase,role:string,run:()=>Promise<T>){if(![WEB,WORKER].includes(role))throw Error('Unexpected fixture role');await db.exec(`set session authorization ${role}`);try{return await run();}finally{await db.exec('set session authorization postgres');}}
/** preserve/owner are disposable multi-project verification options only. */
export async function proposalAdmissionFixture(db:TestDatabase,source?:ReturnType<typeof proposalFixture>,options:{preserve?:boolean;owner?:string}={}){
 const owner=options.owner??OWNER_A;
 if(!options.preserve)await resetFixture(db);
 for(const role of [WEB,WORKER])await db.exec(`do $$begin if not exists(select 1 from pg_roles where rolname='${role}') then create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;end if;end$$;grant usage on schema public,fluid_private to ${role};`);
 await db.exec(`grant execute on function fluid_private.quote_logo_vector_proposal(uuid,jsonb) to ${WEB};
 grant execute on function public.report_logo_worker_ready(text,jsonb,integer),public.claim_logo_job(text,integer),public.begin_logo_job_step(uuid,uuid,text,text,bigint),public.heartbeat_logo_job(uuid,uuid,integer),public.read_leased_logo_record(uuid,uuid,text,jsonb),public.record_logo_provider_response(uuid,uuid,jsonb),public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),public.expire_logo_job_leases(),fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid) to ${WORKER};`);
 await db.query('insert into fluid_private.logo_asset_web_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2 on conflict(role_name) do update set role_oid=excluded.role_oid,owner_id=excluded.owner_id',[owner,WEB]);
 await db.query('insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2 on conflict(role_name) do update set role_oid=excluded.role_oid,owner_id=excluded.owner_id',[owner,WORKER]);
 const rpc=(name:string,args:unknown[],rpcOwner=owner)=>asRole(db,'authenticated',rpcOwner,async()=>(await db.query<{v:unknown}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0]!.v);
 const workspace=logoWorkspaceV2Schema.parse(await startLogoFixture(ownerQuery(db, owner), {requestKey:randomUUID(),brief:{name:'Aster',activity:'Synthetic admission metadata',audience:'',personality:'',logoTypes:['combination']}}));
 const f=source??proposalFixture(),brief=(await db.query<{record:typeof f.brief}>('select record from public.logo_stage_revisions where id=$1',[workspace.stages.brief_references!.id])).rows[0]!.record;
 f.brief=brief;f.revision.ownerId=owner;f.revision.projectId=workspace.projectId;f.revision.inputRevisions=[{stage:'brief_references',id:brief.id,revision:brief.revision}];
 for(const ref of [f.revision.sourcePreview,f.revision.documentAsset,f.revision.svgAsset]){ref.ownerId=owner;ref.projectId=workspace.projectId;}
 for(const font of f.fonts){font.asset.ownerId=owner;font.asset.projectId=workspace.projectId;await db.query('insert into public.logo_font_records(record_id,version_id,owner_id,project_id,record) values($1,$2,$3,$4,$5)',[font.id,font.asset.versionId,owner,workspace.projectId,font]);}
 // Synthetic editable fixtures must rebind their embedded font references too.
 const editable=f.document.components.filter(c=>c.editingKind==='editable_text');
 for(const component of editable){component.textSource.font.ownerId=owner;component.textSource.font.projectId=workspace.projectId;}
 if(editable.length)f.seal(f.revision.locks.map(lock=>lock.componentId));
 await db.query('insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)',[f.revision.id,owner,workspace.projectId,f.revision]);
 await db.query("select fluid_private.logo_append_stage($1,$2,'vector',$3,$4)",[owner,workspace.projectId,{vectorRevisionId:f.revision.id,approvalId:null},f.revision.inputRevisions]);
 const current=logoWorkspaceV2Schema.parse(await rpc('get_logo_workspace',[workspace.projectId]));
 const context=buildLogoVectorProposalContext(f),request={operation:'propose_vector_edit',expected:current.heads,baseVectorRevisionId:f.revision.id,instruction:'Rotate the symbol',targetComponentIds:f.targetComponentIds};
 const evidence={version:1,request,context,baseRevision:f.revision,brief,fonts:f.fonts},policy=proposalPolicy();
 const hash=(await db.query<{v:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') v",[policy])).rows[0]!.v;
 await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled,text_policy) values($1,'identity.logo_vector_propose',$2,'logo-vector-propose-v1','openai','gpt-6.1-sol',122880,true,$3) on conflict(owner_id,operation) do nothing",[owner,hash,policy]);
 await db.query('update public.usage_accounts set limit_microusd=5000000 where owner_id=$1',[owner]);
 const descriptor={operation:'identity.logo_vector_propose',policyIdentity:hash,handlerVersion:'logo-vector-propose-v1',provider:'openai',model:'gpt-6.1-sol',engine:null,maxCostMicrousd:122880,textPolicy:policy};
 const worker=<T>(run:()=>Promise<T>)=>proposalLogin(db,WORKER,run);
 const report=async(manifest:unknown[]=[descriptor])=>worker(async()=>(await db.query<{v:boolean}>("select public.report_logo_worker_ready('proposal-fixture',$1,90) v",[manifest])).rows[0]!.v);
 expect(await report()).toBe(true);
 const quote=logoCostQuoteSchema.parse(await proposalLogin(db,WEB,async()=>(await db.query<{v:unknown}>('select fluid_private.quote_logo_vector_proposal($1,$2) v',[workspace.projectId,evidence])).rows[0]!.v));
 const intent={requestKey:randomUUID(),quoteId:quote.id,acceptedMaxCostMicrousd:quote.maxCostMicrousd,expected:current.heads};
 const admit=(input:unknown=intent,rpcOwner=owner)=>rpc('admit_logo_operation',[workspace.projectId,input],rpcOwner);
 const admitted=async()=>logoDispatchReceiptSchema.parse(await admit());
 const claim=()=>worker(async()=>(await db.query<{id:string;owner_id:string;project_id:string;lease_token:string;input:unknown;input_revision:number;reserved_cost_microusd:number;actual_cost_microusd:number;state:string;max_attempts:number;attempts:number;plan_manifest:unknown;policy_identity:null}>('select * from public.claim_logo_job($1,60)',['proposal-fixture'])).rows[0]);
 return{workspace:current,quote,intent,context,evidence,policy,descriptor,rpc,worker,report,admit,admitted,claim};
}
