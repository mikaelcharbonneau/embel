import { readFile } from "node:fs/promises";
import { createTestDatabase, OWNER_A, OWNER_B } from "./local-supabase";
import { installGenerativeStorageFixture } from "./logo-generative-storage-fixture";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { strategyOperations, type ApprovedWorkerProfile } from "../../worker/account-enrollment/configuration";
import type { StrategyOperation } from "../../src/domain/strategy-jobs";

/** Disposable, inert SQL roles/approvals only; no host qualification, vault,
 * Auth/Storage HTTP operation or provider request. */
export async function createManagedStrategyFixture() {
 const db=await createTestDatabase();
 await installGenerativeStorageFixture(db);
 for(const path of ["candidates/logo_local_concepts.sql","activation/logo_concepts_50_publication_adjudication.sql","candidates/logo_local_refinements.sql"])
  await db.exec(await readFile(new URL(`../../supabase/${path}`,import.meta.url),"utf8"));
 await db.exec("alter table auth.users add column email_confirmed_at timestamptz; alter table auth.users add column banned_until timestamptz");
 for(const name of ["account_service_enrollment.sql","account_worker_enrollment.sql"])
  await db.exec(await readFile(new URL(`../../supabase/candidates/${name}`,import.meta.url),"utf8"));
 const addon=await readFile(new URL("../../supabase/candidates/account_strategy_uncapped.sql",import.meta.url),"utf8");
 await db.exec("begin; savepoint changed_predecessor; create or replace function public.check_api_text_runtime(p_operation text,p_policy jsonb,p_deployment_id text) returns boolean language sql as 'select true'");
 let installationGuard="";
 try{await db.exec(addon);}catch(error){installationGuard=error instanceof Error?error.message:String(error);}
 await db.exec("rollback to savepoint changed_predecessor; rollback");
 if(!installationGuard.includes("unexpected_managed_strategy_predecessor"))throw Error("Managed Strategy predecessor guard did not reject changed metadata/body");
 await db.exec("alter default privileges grant execute on functions to fixture_production_acl_probe; alter default privileges grant all on tables to fixture_production_acl_probe");
 await db.exec(addon);
 await db.exec("alter default privileges revoke execute on functions from fixture_production_acl_probe; alter default privileges revoke all on tables from fixture_production_acl_probe");
 const operator="fixture_strategy_operator",reporter="fixture_strategy_reporter";
 await db.exec(`create role ${operator} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  create role ${reporter} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  grant usage on schema public to ${operator},${reporter};
  grant execute on function public.claim_account_service_enrollment(integer),public.record_account_service_enrollment(uuid,uuid,text,text,text),
   public.provision_account_worker_enrollment(uuid,uuid,text,jsonb,text,text),public.publish_account_worker_enrollment(uuid,uuid,text,text),
   public.verify_account_worker_enrollment(uuid,uuid,text,jsonb),public.disable_account_worker_enrollment(uuid,uuid,text) to ${operator};
  grant execute on function public.report_account_worker_process(jsonb,text,text,timestamptz) to ${reporter};
  insert into fluid_private.account_enrollment_operators select rolname,oid,2 from pg_roles where rolname='${operator}';`);
 type Claim={id:string;ownerId:string;generation:number;revision:number;leaseToken:string};
 type Binding={ownerId:string;generation:number;revision:number;operationKey:string;capability:"strategy";roleName:string;roleOid:number;credentialRef:string;workerId:string;deploymentId:string;profileFingerprint:string;storageAuthUserId:null};
 async function session<T>(role:string,run:()=>Promise<T>) {
  if(!/^[a-z][a-z0-9_]{0,62}$/u.test(role))throw Error("Invalid fixture role");
  await db.exec("savepoint strategy_fixture_call");await db.exec(`set session authorization ${role}`);
  try{return await run();}catch(e){await db.exec("rollback to savepoint strategy_fixture_call");throw e;}
  finally{await db.exec("set session authorization postgres; release savepoint strategy_fixture_call");}
 }
 async function rpc<T>(name:string,args:unknown[]=[],role=operator):Promise<T> {
  if(!/^[a-z_]+$/u.test(name))throw Error("Invalid fixture RPC");
  return session(role,async()=>(await db.query<{value:T}>(`select to_jsonb(public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")})) value`,args.map(x=>x&&typeof x==="object"?JSON.stringify(x):x))).rows[0]!.value);
 }
 async function owner<T>(ownerId:string,run:()=>Promise<T>) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ownerId]);
  try{return await session("authenticated",run);}finally{await db.query("select set_config('request.jwt.claim.sub','',false)");}
 }
 async function enroll(ownerId=OWNER_A,options:{existingLedger?:boolean}={}) {
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,clock_timestamp())",[ownerId]);
  // Existing ordinary bookkeeping account, with zero allowance. No packet
  // creates or funds it. Tests assert that limit remains exactly zero.
  if(options.existingLedger!==false)await db.query("insert into public.usage_accounts(owner_id,limit_microusd) values($1,0)",[ownerId]);
  const claim=await rpc<Claim>("claim_account_service_enrollment",[120]);
  if(claim.ownerId!==ownerId)throw Error("Unexpected fixture enrollment");
  await rpc("record_account_service_enrollment",[claim.id,claim.leaseToken,"strategy","provisioning",null]);
  const policies=Object.fromEntries(strategyOperations.map(op=>[op,guidedStrategyPolicy(op)]));
  const identities:Record<string,string>={};
  for(const op of strategyOperations){
   identities[op]=(await db.query<{value:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') value",[JSON.stringify(policies[op])])).rows[0]!.value;
   await db.query("insert into fluid_private.strategy_runtime_policy(operation,policy,enabled) values($1,$2,true) on conflict(operation) do nothing",[op,JSON.stringify(policies[op])]);
  }
  const proofHash=(await db.query<{value:string}>("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') value from pg_proc where oid='public.account_enrollment_managed_principal()'::regprocedure")).rows[0]!.value;
  const profile:ApprovedWorkerProfile={capability:"strategy",profileId:`synthetic-strategy-${ownerId}`,providerBindingRef:`synthetic-provider-${ownerId}`,modelVerificationReceipt:"synthetic-model-receipt",
   applicationOrigin:"https://www.embel.xyz",supabaseOrigin:"https://fricsfwqibyhemknqgyf.supabase.co",projectId:"prj_syntheticfixture",deploymentId:"dpl_syntheticfixture",
   sourceRevision:"a".repeat(40),artifactSha256:"b".repeat(64),managedProofSha256:proofHash,dispatchApproved:true,
   runtime:{node:process.versions.node,icu:process.versions.icu!,unicode:process.versions.unicode!,platform:"linux",arch:"x64"},
   model:"gpt-6.1-sol",admissionContract:"hosted_strategy_owner_uncapped_v1",spendControl:"uncapped",policyIdentities:identities as Record<typeof strategyOperations[number],string>};
  await db.query("insert into fluid_private.account_worker_provider_approvals values($1,'openai','api.openai.com',$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour')",[profile.providerBindingRef,profile.model,profile.modelVerificationReceipt]);
  await db.query(`insert into fluid_private.account_worker_profile_approvals(profile_id,capability,profile,policies,provider_binding_ref,reporter_role_name,reporter_role_oid,approved_at,expires_at)
   select $1,'strategy',$2,$3,$4,rolname,oid,clock_timestamp(),clock_timestamp()+interval '1 hour' from pg_roles where rolname=$5`,
   [profile.profileId,JSON.stringify(profile),JSON.stringify(policies),profile.providerBindingRef,reporter]);
  const verifier=`SCRAM-SHA-256$4096:${"A".repeat(22)}==$${"A".repeat(43)}=:${"A".repeat(43)}=`;
  const binding=await rpc<Binding>("provision_account_worker_enrollment",[claim.id,claim.leaseToken,"strategy",profile,`synthetic-credential-${ownerId}`,verifier]);
  await rpc("report_account_worker_heartbeat",[binding,null],binding.roleName);
  const observedAt=(await db.query<{value:string}>("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') value")).rows[0]!.value;
  const receipt=`synthetic-running-${ownerId}`;
  await rpc("report_account_worker_process",[binding,"running",receipt,observedAt],reporter);
  await rpc("publish_account_worker_enrollment",[claim.id,claim.leaseToken,"strategy",receipt]);
  await rpc("verify_account_worker_enrollment",[claim.id,claim.leaseToken,"strategy",{...binding,receipt,observedAt,sourceRevision:profile.sourceRevision,artifactSha256:profile.artifactSha256,storageSessionId:null}]);
  const database={query:(sql:string,args:unknown[]=[])=>session(binding.roleName,()=>{
   const fixed=sql.replace(/\s+/gu," ").trim();
   if(fixed==="select state, request_key, reserved_cost_microusd from public.job_steps where job_id = $1 and owner_id = $2 and project_id = $3 and step_key = $4")
    return db.query<Record<string,unknown>>("SELECT * FROM public.read_account_worker_strategy_step($1,$2,$3,$4)",args);
   if(fixed==="select exists(select 1 from public.job_steps where job_id=$1 and owner_id=$2 and project_id=$3 and state='succeeded') as has_results")
    return db.query<Record<string,unknown>>("SELECT public.account_worker_strategy_has_results($1,$2,$3) AS has_results",args);
   return db.query<Record<string,unknown>>(sql,args);
  })};
  return {claim,binding,profile,policies,identities,database};
 }
 async function project(operation:StrategyOperation="strategy.reformulate",ownerId=OWNER_A) {
  const stage=operation==="strategy.reformulate"?"competitors":operation.slice("strategy.".length);
  const context=contextSnapshotSchema.parse({description:"Inert managed Strategy brief",intake:{conversation:[{kind:"user_message",id:"synthetic-prompt",text:"Coffee workshops",createdAt:"2026-10-17T12:00:00Z"}],
   guidedInterview:{version:1,stage,turns:[{id:"synthetic-turn",userMessageId:"synthetic-prompt",inputRevision:1,stage,purpose:operation==="strategy.reformulate"?"message":operation==="strategy.competitors"?"research":"propose"}],answers:[]}}});
  return owner(ownerId,()=>rpc<{id:string}>("create_project",["complete_brand","Inert managed Strategy",context,"a".repeat(64)],"authenticated"));
 }
 async function submit(projectId:string,identity:string,key="synthetic-managed-request-0001",operation:StrategyOperation="strategy.reformulate",ownerId=OWNER_A,revision=1) {
  return owner(ownerId,()=>rpc<{id:string;spendControl:"uncapped";policyIdentity:string;dispatch:{version:1;jobId:string;policyIdentity:string;deploymentId:string;dispatchIdentity:string}}>("enqueue_managed_strategy_job",[projectId,revision,operation,key,identity],"authenticated"));
 }
 return {db,rpc,session,owner,enroll,project,submit,installationGuard,async close(){await db.exec("set session authorization postgres");await db.close();}};
}
export {OWNER_A,OWNER_B};
