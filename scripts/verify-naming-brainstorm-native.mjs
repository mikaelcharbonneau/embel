/** Isolated PG17 NOSUPER source-packet verification. No ports, network, host
 * mounts, live database, passwords, Auth service or provider calls. The cached
 * image is required; this script does not pull or install infrastructure. */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
const image='ghcr.io/supabase/cli/postgres:17.11.0.006-r0@sha256:ee0f2d9747fb9d3c0a29703684ec718f070384ad05bf0d92823ed02cabde8e5a';
const name=`embel-brainstorm-native17-${randomBytes(6).toString('hex')}`;
const packetPaths=['shared_worker_pool.sql','shared_worker_naming.sql','shared_naming_brainstorm.sql','shared_naming_brainstorm_event_capacity.sql','shared_naming_brainstorm_delivery_recovery.sql','shared_naming_lease_expiry.sql'];
const packets=Object.fromEntries(packetPaths.map(path=>[path,readFileSync(new URL('../supabase/candidates/'+path,import.meta.url),'utf8')]));
const rollback=readFileSync(new URL('../supabase/operator/rollback_naming_brainstorm_delivery_recovery.sql',import.meta.url),'utf8');
const expiryRollback=readFileSync(new URL('../supabase/operator/rollback_naming_lease_expiry.sql',import.meta.url),'utf8');
const env={...process.env};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
const docker=(args,input)=>execFileSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,input,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:20*1024*1024});
let created=false,stage='cached-image';const passed=[];
const assert=(value,label)=>{if(!value)throw Error(label);passed.push(label);};
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const sql=(source,role='postgres')=>docker(['exec','-i',name,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','/tmp','-U',role,'-d','postgres'],source).trim();
const scalar=(source,role)=>JSON.parse(sql(`select to_jsonb(${source});`,role));
const rpc=(fn,args=[],role='fixture_enrollment_operator')=>scalar(`public.${fn}(${args.map(v=>v==null?'null':quote(typeof v==='object'?JSON.stringify(v):v)).join(',')})`,role);

try{
 docker(['image','inspect',image,'--format','{{.Id}}']);
 stage='start-network-none';docker(['run','--detach','--rm','--pull=never','--network=none','--user=postgres',`--name=${name}`,'--entrypoint=sh',image,'-c',"initdb -D /tmp/enrollment-fixture -U fixture_platform --auth=trust >/tmp/init.log && exec postgres -D /tmp/enrollment-fixture -k /tmp -c listen_addresses= -c shared_preload_libraries= -c log_statement=none -c log_min_error_statement=panic"]);created=true;
 for(let i=0;i<100;i++){try{docker(['exec',name,'pg_isready','-h','/tmp','-U','fixture_platform','-d','postgres']);break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 stage='native-platform-bootstrap';sql(`create role postgres login nosuperuser noinherit createdb createrole noreplication bypassrls;
 grant pg_monitor to postgres with inherit true,set false; alter database postgres owner to postgres;
 create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 grant anon,authenticated,service_role to postgres with inherit false,set true;
 create role authenticator login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 grant authenticated to authenticator with inherit false,set true;`,'fixture_platform');
 assert(sql("select current_user||':'||rolsuper::text||':'||rolcreaterole::text from pg_roles where rolname=current_user;")==='postgres:false:true','installer-is-native17-nosuper-createrole');
 stage='baseline';sql(`
 create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean not null default false,banned_until timestamptz,deleted_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
 create schema storage;create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text,unique(bucket_id,name));
 alter table storage.objects enable row level security;grant usage on schema storage to authenticated,service_role;grant select,insert,update,delete on storage.objects to authenticated,service_role;
 create function storage.operation() returns text language sql stable as $$select current_setting('storage.operation',true)$$;
 create function storage.allow_only_operation(expected_operation text) returns boolean language sql stable as $$select coalesce(regexp_replace(storage.operation(),'^storage\\.','')=regexp_replace(expected_operation,'^storage\\.',''),false)$$;`);
 const migrationNames=readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort((a,b)=>a.replace(/^local/,'').localeCompare(b.replace(/^local/,'')));
 for(const file of migrationNames){stage=`migration:${file}`;sql(readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));}

 for(const path of packetPaths){
  if(path==='shared_naming_brainstorm.sql')sql(`create role fixture_brainstorm_acl_probe nologin;
   grant usage on schema fluid_private to fixture_brainstorm_acl_probe;
   alter default privileges for role postgres in schema fluid_private grant all on tables to fixture_brainstorm_acl_probe;
   alter default privileges for role postgres in schema fluid_private grant all on functions to fixture_brainstorm_acl_probe;`);
  if(path==='shared_naming_brainstorm.sql'){
   const predecessor=sql("select pg_get_functiondef('public.create_brand_from_project_name(uuid,uuid,integer,text,boolean,text)'::regprocedure);");
   sql("alter function public.create_brand_from_project_name(uuid,uuid,integer,text,boolean,text) set search_path=public;");
   let guarded=false;try{sql(packets[path]);}catch(error){guarded=/brainstorm_predecessor_mismatch/.test(String(error.stderr));}
   assert(guarded&&sql("select to_regclass('fluid_private.naming_brainstorm_calls') is null;")==='t','incremental-install-rejects-changed-copy-predecessor-before-mutation');
   sql(predecessor);
  }
  if(path==='shared_naming_brainstorm_delivery_recovery.sql'){
   const predecessor=sql("select pg_get_functiondef('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure);");
   sql("alter function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) set search_path=public;");
   let guarded=false;try{sql(packets[path]);}catch(error){guarded=/brainstorm_delivery_predecessor_mismatch/.test(String(error.stderr));}
   assert(guarded&&sql("select to_regclass('fluid_private.naming_brainstorm_delivery_recoveries') is null;")==='t','delivery-install-rejects-changed-predecessor-before-mutation');
   sql(predecessor);
  }
  // The capacity packet checks the hosted target singleton; this isolated
  // Naming fixture needs only that exact source-owned table, not HTTP actors.
  if(path==='shared_naming_brainstorm_event_capacity.sql'){
   const httpSource=readFileSync(new URL('../supabase/candidates/shared_account_http.sql',import.meta.url),'utf8');
   const targetDefinition=/create table fluid_private\.shared_http_target\([\s\S]*?\n\);/.exec(httpSource)?.[0];
   if(!targetDefinition)throw Error('Missing source-owned HTTP target table');
   sql(targetDefinition+"\ninsert into fluid_private.shared_http_target(singleton,mode,origin)values(true,'hosted','https://fricsfwqibyhemknqgyf.supabase.co');");
  }
  stage=`packet:${path}`;sql(packets[path]);
 }
 assert(sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='fluid_private'and c.relname like 'naming_brainstorm_%'and c.relkind='r'and(not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege('fixture_brainstorm_acl_probe',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));")==='0','new-private-tables-force-RLS-and-strip-hostile-default-grantees');
 assert(sql("select count(*)from pg_proc p join pg_namespace n on n.oid=p.pronamespace,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))acl where n.nspname='fluid_private'and(p.proname like 'naming_brainstorm_%'or p.proname in('shared_naming_brainstorm_ensure_core','recover_naming_brainstorm_delivery'))and acl.grantee<>p.proowner;")==='0','new-private-helper-execute-owner-only');
 stage='native-brainstorm-capability';
 const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',foreign='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',role='embel_shared_naming_brainstorm',slot='00000000-0000-4000-8000-000000000001';
 const fingerprint={version:1,normalizer:'naming-preferences-v1:nfc-lower-nfc',implementationHash:'7108319323898692a388fcf17cb542509583288b0d4b05d7384f8c5b707aeb01',nodeVersion:process.versions.node,icuVersion:process.versions.icu,unicodeVersion:process.versions.unicode};
 const policy=JSON.parse(sql("select jsonb_build_object('version',1,'handlerVersion','naming-brain-v1','billingMode','openai_api','protocol','openai_agents','model','gpt-6-luna','reasoningEffort','xhigh','runAllowanceMicrousd',5000000,'aggregateAllowanceMicrousd',25000000,'maxUnsettledRuns',5,'maxConcurrentCreators',3,'maxInitialCandidates',150,'maxGapCandidates',50,'maxGapRounds',1,'maxInputBytes',131072,'maxOutputBytes',524288,'stageDeadlineMs',240000,'stageLimits',jsonb_build_object('research',jsonb_build_object('maximumCostMicrousd',750000,'maxWebSearchCalls',4),'direction',jsonb_build_object('maximumCostMicrousd',250000,'maxWebSearchCalls',0),'creation',jsonb_build_object('maximumCostMicrousd',1500000,'maxWebSearchCalls',0),'curation',jsonb_build_object('maximumCostMicrousd',500000,'maxWebSearchCalls',0),'verification',jsonb_build_object('maximumCostMicrousd',1250000,'maxWebSearchCalls',20),'gap',jsonb_build_object('maximumCostMicrousd',750000,'maxWebSearchCalls',8),'prepare',jsonb_build_object('maximumCostMicrousd',0,'maxWebSearchCalls',0)));"));
 const policyIdentity=sql(`select encode(sha256(convert_to(${quote(JSON.stringify(policy))}::jsonb::text,'UTF8')),'hex');`);
 sql(`insert into auth.users(id,email_confirmed_at) values(${quote(owner)},clock_timestamp()),(${quote(foreign)},clock_timestamp());
 create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4;
 grant usage on schema public to ${role};
 grant execute on function public.shared_worker_pool_configuration(),public.claim_shared_worker_slot(uuid,uuid,text,integer),public.renew_shared_worker_slot(jsonb,integer),public.release_shared_worker_slot(jsonb),public.fence_shared_worker_slot(jsonb),public.read_shared_worker_executions(jsonb),public.read_shared_worker_execution_page(jsonb,uuid,integer),public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${role};
 insert into fluid_private.shared_worker_slots(slot_id,lane,slot_index,role_name,role_oid,deployment_id,enabled) select ${quote(slot)},'naming',1,rolname,oid,'native-brainstorm-fixture',true from pg_roles where rolname=${quote(role)};
 insert into fluid_private.shared_worker_policies values(${quote(slot)},'naming.generate',${quote(policyIdentity)},${quote(JSON.stringify(policy))});
 insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values(${quote(slot)},${quote(JSON.stringify(fingerprint))});`);
 let lease=rpc('claim_shared_worker_slot',[slot,'10000000-0000-4000-8000-000000000001','native-brainstorm-fixture',120],role),execution=null;
 const action=(name,args={})=>{
  if(name==='brainstorm_begin'){
   const history=JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_object('candidateId',id,'value',value)),'[]') from public.name_candidates where project_id=${quote(execution.projectId)};`));
   args={...args,expectedHistoryEpoch:Number(sql(`select writer_epoch from fluid_private.naming_brain_heads where project_id=${quote(execution.projectId)};`)),historyIdentities:history.map(x=>({...x,identityKey:x.value.toLowerCase().replace(/[\p{P}\s]/gu,'').normalize('NFC')}))};
  }
  return rpc('shared_naming_worker_action',[lease,execution,name,args],role).result;
 };
 const customer=(fn,args,who=owner)=>JSON.parse(sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(who)},true);select to_jsonb(public.${fn}(${args.map(v=>v===null?'null':quote(typeof v==='object'?JSON.stringify(v):v)).join(',')}));commit;`).split('\n').find(x=>x.startsWith('{')||x.startsWith('[')));
 const denied=(fn,label)=>{let no=false;try{fn();}catch(error){no=/ERROR:/.test(String(error.stderr))&&!/syntax error|does not exist|no function matches/.test(String(error.stderr));}assert(no,label);};
 action('qualify',[policy,fingerprint]);
 const project=customer('create_project',['naming_only','Native synthetic brainstorm',{description:'Synthetic brief'},'a'.repeat(64)]).id;
 const prefs={version:2,creativeLocale:'en',notes:'',minimumGraphemes:null,maximumGraphemes:null,approaches:['real_words','invented'],directness:'open_ended',sourceLanguages:[],heritageNotes:'',culturalNotes:'',requiredText:[],excludedText:[]};
 customer('save_naming_preferences',[project,0,prefs]);
 const intent={version:1,expectedProjectRevision:1,expectedPreferencesVersion:1,expectedSteeringRevision:0,expectedDemandSequence:0,consumedThrough:null,idempotencyKey:'native-brainstorm-initial',reason:'initial'};
 assert(customer('ensure_shared_naming_brainstorm_run',[project,intent]).code==='preferences_validation_pending','preference-attestation-not-skipped');
 const work=action('preference_work',[20]).find(x=>x.projectId===project);action('attest_preferences',[project,work.preferencesVersion,work.preferencesHash,fingerprint,{ready:true,missing:[]}]);
 assert(customer('ensure_shared_naming_brainstorm_run',[project,intent]).status==='pending','real-native-admission');
 const claimed=rpc('shared_naming_worker_action',[lease,null,'claim',['native-brainstorm-worker','native-brainstorm-fixture',300]],role);execution=claimed.execution;
 const input=claimed.result.job.input,runId=input.runId;
 assert(input.generationProfile==='brainstorm_v1'&&input.localPipelineVersion===2&&input.providerBudgetVersion===2&&input.localTimingVersion===2&&input.executionAuthority==='hosted_owner_v1','immutable-future-marker-and-oldwire');
 const request={model:'gpt-6-luna',store:true,stream:true,reasoning:{effort:'low'},max_output_tokens:16000,input:'Synthetic request fixture',text:{verbosity:'low',format:{type:'json_schema',name:'naming_brainstorm_v1',strict:true,schema:{type:'object'}}},metadata:{embel_generation_profile:'brainstorm_v1',embel_job_id:execution.jobId,embel_run_id:runId,embel_call_index:'1'}};
 const call=action('brainstorm_begin',{callIndex:1,candidateTarget:120,request});assert(call.dispatch==='create','commit-exact-request-before-only-create');
 assert(action('brainstorm_begin',{callIndex:1,candidateTarget:120,request}).dispatch==='quarantined','never-replay-unknown-create');
 denied(()=>action('authorize',[execution.jobId,execution.leaseToken,'{}']),'old-engine-cannot-dispatch-new-profile');
 denied(()=>sql('select * from fluid_private.naming_brainstorm_calls;',role),'native-direct-LOGIN-raw-table-denied');
 denied(()=>customer('ensure_shared_naming_brainstorm_run',[project,intent],foreign),'native-foreign-customer-denied');
 denied(()=>action('brainstorm_begin',{callIndex:2,candidateTarget:60,request:{...request,metadata:{...request.metadata,embel_call_index:'2'}}}),'unknown-no-topup');
 action('brainstorm_event',{callId:call.callId,kind:'created',responseId:'resp_native_fixture',requestId:'req_native_fixture',observedAt:'2026-10-29T12:00:00Z'});
 assert(action('brainstorm_begin',{callIndex:1,candidateTarget:120,request}).dispatch==='retrieve','known-ID-only-retrieval');
 const raw=Array.from({length:100},(_,i)=>({value:`NativeCedar${i}`,rationale:'Synthetic creative construction.',primaryApproach:'real_words'}));
 const candidates=raw.map(x=>({...x,identityKey:x.value.toLowerCase(),graphemeCount:x.value.length,caution:'Unchecked brainstorm. Research and screening are needed before use.'}));
 const response={id:'resp_native_fixture',status:'completed',model:'gpt-6-luna',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({candidates:raw})}]}]};
 action('brainstorm_event',{callId:call.callId,kind:'completed',responseId:response.id,requestId:'req_native_fixture',observedAt:'2026-10-29T12:01:00Z',response,candidates,usage:{input_tokens:100,output_tokens:200,total_tokens:300}});
 assert(action('brainstorm_publish',{callId:call.callId}).publishedCount===100,'source-bound-native100');
 assert(action('brainstorm_publish',{callId:call.callId}).insertedCount===0,'publication-replay-idempotent');
 assert(action('brainstorm_finish').state==='succeeded','exact100-terminal-witness');
 const feed=customer('get_naming_feed',[project,{}]);
 assert(feed.activeRun.generationProfile==='brainstorm_v1'&&typeof feed.activeRun.brainstormCompletionId==='string'&&!feed.activeRun.progressiveCompletionId&&feed.entries.length===100,'genuine-completion-feed-and-existing-wire');
 assert(feed.activeRun.state==='succeeded'&&feed.activeRun.fulfillment.acceptedCount===100&&feed.activeRun.fulfillment.missingCount===0&&feed.activeRun.fulfillment.coverageSatisfied===false&&feed.activeRun.fulfillment.status==='partial','actual-primary-coverage-shortfall-retained-with-full100-count');
 assert(sql(`select count(*)from fluid_private.naming_brainstorm_calls where run_id=${quote(runId)};`)==='1','no-coverage-only-topup-after-full100');
 assert(sql(`select actual_cost_microusd is null from fluid_private.naming_brain_runs where id=${quote(runId)};`)==='t','actual-dollars-remain-unknown');
 assert(sql(`select count(*) from fluid_private.naming_brain_artifacts where run_id=${quote(runId)};`)==='0'&&sql(`select count(*) from fluid_private.naming_brain_progressive_results where run_id=${quote(runId)};`)==='0','no-fake-research-curation-verification-progressive-artifacts');
 assert(customer('ensure_shared_naming_brainstorm_run',[project,intent]).appendedEntryIds.length===100,'completed-idempotent-intent-has-real-feed-membership');
 const source=feed.entries[0].entry.candidate;
 const copied=customer('create_brand_from_project_name',[project,source.id,1,'Native brainstorm brand',false,'native-brainstorm-copy-direct']);
 assert(copied.currentSelection.candidate.origin.kind==='account_copy'&&copied.currentSelection.candidate.origin.authorship==='generated'
  &&copied.currentSelection.candidate.origin.root.kind==='brainstorm'&&copied.currentSelection.candidate.origin.root.candidateId===source.id
  &&copied.currentSelection.candidate.origin.history.length===0,'actual-brand-copy-preserves-direct-brainstorm-generated-authorship');
 const transformInput={kind:'affixes',seed:source.value,prefixes:['New'],suffixes:[],separator:' '};
 const transformValue='New '+source.value;
 const transformed=customer('persist_name_transform',[project,source.id,null,transformInput,{candidates:[{value:transformValue,identityKey:transformValue.toLowerCase().replaceAll(' ',''),explanation:'Added prefix “New”.'}],truncated:false,notes:[]},'native-brainstorm-transform']);
 const transformedCopy=customer('create_brand_from_project_name',[project,transformed.entries[0].candidate.id,1,'Native transformed brainstorm brand',false,'native-brainstorm-copy-derived']);
 assert(transformedCopy.currentSelection.candidate.origin.authorship==='user_supplied'&&transformedCopy.currentSelection.candidate.origin.root.kind==='brainstorm'
  &&transformedCopy.currentSelection.candidate.origin.history.length===1,'actual-transformed-brainstorm-copy-retains-user-authorship');
 const newPublicGrants=JSON.parse(sql("select jsonb_agg(jsonb_build_object('name',p.proname,'role',r.rolname))from pg_proc p join pg_namespace n on n.oid=p.pronamespace,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))acl left join pg_roles r on r.oid=acl.grantee where n.nspname='public'and p.proname in('ensure_shared_naming_brainstorm_run','get_naming_brainstorm_sources')and acl.grantee<>p.proowner;"));
 assert(newPublicGrants.length===2&&newPublicGrants.every(x=>x.role==='authenticated'),'exact-two-owner-RPCs-authenticated-only-no-worker-grants');

 stage='native-delivery-recovery';
 lease=rpc('renew_shared_worker_slot',[lease,120],role);execution=null;
 action('qualify',[policy,fingerprint]);
 const recoveryProject=customer('create_project',['naming_only','Native saved delivery',{description:'Synthetic recovery brief'},'b'.repeat(64)]).id;
 customer('save_naming_preferences',[recoveryProject,0,prefs]);
 const recoveryIntent={...intent,idempotencyKey:'native-brainstorm-recovery'};
 customer('ensure_shared_naming_brainstorm_run',[recoveryProject,recoveryIntent]);
 const recoveryWork=action('preference_work',[20]).find(x=>x.projectId===recoveryProject);
 action('attest_preferences',[recoveryProject,recoveryWork.preferencesVersion,recoveryWork.preferencesHash,fingerprint,{ready:true,missing:[]}]);
 assert(customer('ensure_shared_naming_brainstorm_run',[recoveryProject,recoveryIntent]).status==='pending','recovery-fixture-real-admission');
 const recoveryClaim=rpc('shared_naming_worker_action',[lease,null,'claim',['native-brainstorm-worker','native-brainstorm-fixture',300]],role);execution=recoveryClaim.execution;
 const recoveryRun=recoveryClaim.result.job.input.runId;
 const recoveryRequest={...request,metadata:{...request.metadata,embel_job_id:execution.jobId,embel_run_id:recoveryRun}};
 const recoveryCall=action('brainstorm_begin',{callIndex:1,candidateTarget:120,request:recoveryRequest});
 const recoveryResponseId='resp_native_retained';
 action('brainstorm_event',{callId:recoveryCall.callId,kind:'created',responseId:recoveryResponseId,requestId:'req_native_retained',observedAt:'2026-10-29T12:02:00Z'});
 action('brainstorm_event',{callId:recoveryCall.callId,kind:'unknown',responseId:recoveryResponseId,requestId:'req_native_retained',observedAt:'2026-10-29T12:03:00Z'});
 assert(action('brainstorm_finish').state==='needs_reconciliation','unknown-outcome-preserved-before-recovery');
 action('recover',[]);
 assert(action('brainstorm_recover_delivery').status==='retained_unknown','no-terminal-response-never-invents-delivery');
 const recoveryRaw={value:'SavedCedar',rationale:'Synthetic recovered construction.',primaryApproach:'real_words'};
 const recoveryCandidate={...recoveryRaw,identityKey:'savedcedar',graphemeCount:10,caution:'Unchecked brainstorm. Research and screening are needed before use.'};
 const recoveryResponse={id:recoveryResponseId,status:'completed',model:'gpt-6-luna',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({candidates:[recoveryRaw]})}]}]};
 action('brainstorm_event',{callId:recoveryCall.callId,kind:'completed',responseId:recoveryResponseId,requestId:'req_native_retained_get',observedAt:'2026-10-29T12:04:00Z',response:recoveryResponse,candidates:[recoveryCandidate],usage:{input_tokens:100,output_tokens:200,total_tokens:300}});
 const originalEvidence=()=>sql(`select jsonb_build_object('call',(select to_jsonb(c)from fluid_private.naming_brainstorm_calls c where call_id=${quote(recoveryCall.callId)}),'events',(select jsonb_agg(to_jsonb(e)order by created_at,event_id)from fluid_private.naming_brainstorm_events e where call_id=${quote(recoveryCall.callId)}),'job',(select to_jsonb(j)-array['progress']from public.jobs j where id=${quote(execution.jobId)}),'reservation',(select to_jsonb(r)from public.usage_reservations r where job_id=${quote(execution.jobId)}),'actualCost',(select actual_cost_microusd from fluid_private.naming_brain_runs where id=${quote(recoveryRun)}));`);
 const retainedEvidence=originalEvidence();
 denied(()=>rpc('shared_naming_worker_action',[lease,{...execution,ownerId:foreign},'brainstorm_recover_delivery',{}],role),'delivery-rejects-forged-owner');
 denied(()=>sql(`select fluid_private.recover_naming_brainstorm_delivery(${quote(JSON.stringify(lease))},${quote(JSON.stringify(execution))},'{}');`,role),'delivery-private-helper-not-callable-by-lane-login');
 sql(`update fluid_private.naming_brain_heads set paused=true where project_id=${quote(recoveryProject)};`);
 assert(action('brainstorm_recover_delivery').insertedCount===0,'delivery-respects-paused-project');
 sql(`update fluid_private.naming_brain_heads set paused=false where project_id=${quote(recoveryProject)};`);
 stage='native-delivery-concurrent-editor';
 const holder=spawn('docker',['--host=unix:///var/run/docker.sock','exec','-i',name,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'],{env,stdio:['pipe','pipe','pipe']});
 const holderClosed=new Promise(resolve=>holder.once('close',resolve));
 try{
  await new Promise((resolve,reject)=>{
   let output='';const timeout=setTimeout(()=>reject(Error('Native row-lock fixture timed out')),5000);
   holder.once('error',error=>{clearTimeout(timeout);reject(error);});
   holder.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('delivery-row-locked')){clearTimeout(timeout);resolve();}});
   holder.stdin.write(`begin;select id from public.projects where id=${quote(recoveryProject)} for update;\n\\echo delivery-row-locked\n`);
  });
  const started=Date.now();
  assert(action('brainstorm_recover_delivery').status==='retained_unknown'&&Date.now()-started<3000,'delivery-contention-is-bounded-and-retryable');
  assert(sql(`select count(*)from fluid_private.naming_brainstorm_delivery_recoveries where run_id=${quote(recoveryRun)};`)==='0'&&originalEvidence()===retainedEvidence,'contended-delivery-preserves-evidence-and-has-no-partial-publication');
 }finally{holder.stdin.end('rollback;\n');await holderClosed;}
 stage='native-delivery-public-result';
 assert(action('brainstorm_recover_delivery').insertedCount===1,'completed-saved-response-delivered-once');
 assert(action('brainstorm_recover_delivery').insertedCount===0,'lost-delivery-ack-replay-does-not-duplicate');
 assert(originalEvidence()===retainedEvidence,'delivery-preserves-original-call-events-job-cost-and-reservation');
 assert(sql(`select recovery.evidence->>'requestHash'=encode(sha256(convert_to(call.request::text,'UTF8')),'hex')
  and recovery.evidence->>'responseHash'=encode(sha256(convert_to((event.payload->'response')::text,'UTF8')),'hex')
  and recovery.evidence->>'eventHash'=encode(sha256(convert_to(event.payload::text,'UTF8')),'hex')
  and recovery.evidence->>'originalJobState'='needs_reconciliation'
  from fluid_private.naming_brainstorm_delivery_recoveries recovery join fluid_private.naming_brainstorm_calls call using(call_id)
  join fluid_private.naming_brainstorm_events event using(event_id) where recovery.call_id=${quote(recoveryCall.callId)};`)==='t','delivery-receipt-hashes-bind-original-immutable-evidence');
 denied(()=>sql(`update fluid_private.naming_brainstorm_delivery_recoveries set candidate_ids='[]' where call_id=${quote(recoveryCall.callId)};`),'delivery-receipt-is-immutable-even-to-owner');
 assert(sql(`select count(*)from fluid_private.naming_brainstorm_completions where run_id=${quote(recoveryRun)};`)==='0','delivery-never-manufactures-completion-or-settlement');
 const recoveredFeed=customer('get_naming_feed',[recoveryProject,{}]);
 assert(recoveredFeed.entries.length===1&&recoveredFeed.activeRun.state==='needs_reconciliation'&&recoveredFeed.activeRun.recoveredNameCount===1&&recoveredFeed.activeRun.accounting.status==='held_unsettled'&&recoveredFeed.activeRun.accounting.confirmedActualCostMicrousd===null,'delivered-result-visible-with-unknown-outcome-and-billing');
 assert(customer('select_project_name',[recoveryProject,recoveredFeed.entries[0].entry.candidate.id,1,false]).currentSelection.candidate.value==='SavedCedar','delivered-result-selectable-while-accounting-unresolved');
 stage='native-lease-expiry';
 // A live lease is left alone; the slot-level action only moves expired ones.
 assert(rpc('shared_naming_worker_action',[lease,null,'expire',['native-brainstorm-worker','native-brainstorm-fixture']],role).result===0,'expiry-leaves-live-leases');
 denied(()=>rpc('shared_naming_worker_action',[lease,execution,'expire',['native-brainstorm-worker','native-brainstorm-fixture']],role),'expiry-is-slot-level-only');
 stage='native-lease-expiry-rollback';
 const expireDefinition=sql("select pg_get_functiondef('fluid_private.expire_shared_naming_leases(jsonb,jsonb)'::regprocedure);");
 sql("alter function fluid_private.expire_shared_naming_leases(jsonb,jsonb) set search_path=public;");
 let expiryRollbackGuarded=false;try{sql(expiryRollback);}catch(error){expiryRollbackGuarded=/naming_lease_expiry_rollback_source_mismatch/.test(String(error.stderr));}
 assert(expiryRollbackGuarded&&sql("select to_regprocedure('fluid_private.expire_shared_naming_leases(jsonb,jsonb)') is not null;")==='t','expiry-rollback-rejects-changed-function-before-mutation');
 sql(expireDefinition);sql(expiryRollback);
 assert(sql("select to_regprocedure('fluid_private.expire_shared_naming_leases(jsonb,jsonb)') is null;")==='t','expiry-rollback-removes-function');
 denied(()=>rpc('shared_naming_worker_action',[lease,null,'expire',['native-brainstorm-worker','native-brainstorm-fixture']],role),'expiry-rollback-disables-expire');
 stage='native-delivery-rollback';
 const deliveryDefinition=sql("select pg_get_functiondef('fluid_private.recover_naming_brainstorm_delivery(jsonb,jsonb,jsonb)'::regprocedure);");
 sql("alter function fluid_private.recover_naming_brainstorm_delivery(jsonb,jsonb,jsonb) set search_path=public;");
 let rollbackGuarded=false;try{sql(rollback);}catch(error){rollbackGuarded=/brainstorm_delivery_rollback_source_mismatch/.test(String(error.stderr));}
 assert(rollbackGuarded&&customer('get_naming_feed',[recoveryProject,{}]).activeRun.recoveredNameCount===1,'rollback-rejects-changed-function-before-mutation');
 sql(deliveryDefinition);sql(rollback);
 const rolledBackFeed=customer('get_naming_feed',[recoveryProject,{}]);
 assert(rolledBackFeed.entries.length===1&&rolledBackFeed.activeRun.recoveredNameCount===undefined&&rolledBackFeed.activeRun.state==='needs_reconciliation','rollback-restores-old-projection-and-keeps-usable-results');
 assert(sql(`select count(*)from fluid_private.naming_brainstorm_delivery_recoveries where run_id=${quote(recoveryRun)};`)==='1','rollback-keeps-immutable-delivery-receipt');
 denied(()=>action('brainstorm_recover_delivery'),'rollback-disables-recovery-entry-point');

 console.log(JSON.stringify({verification:'passed',nativeVersion:sql('show server_version;'),installer:'postgres NOSUPER CREATEROLE',migrationCount:migrationNames.length,checkCount:passed.length,passed,packetSha256:Object.fromEntries(Object.entries(packets).map(([p,s])=>[p,createHash('sha256').update(s).digest('hex')])),rollbackSha256:createHash('sha256').update(rollback).digest('hex'),proofScope:'Disposable native PostgreSQL SQL capability tests with synthetic Auth/provider fixture records. Runtime ICU metadata describes local derived candidate normalization; no real provider inference or factual evidence.',providerCalls:false,liveSupabaseServices:false,authorityManifestWritten:false}));
}catch(error){console.error(JSON.stringify({verification:'failed',stage,sqlError:String(error?.stderr??'').match(/ERROR:\s+([^\n]{1,180})/)?.[1],error:error instanceof Error?error.message.split('\n')[0].replace(/Command failed:.*/,'native fixture command failed'):'native fixture failed'}));process.exitCode=1;
}finally{if(created){try{docker(['rm','--force',name]);console.log(JSON.stringify({fixtureContainerRemoved:true,persistentAccessCreated:false}));}catch{console.error('Native fixture cleanup failed');process.exitCode=1;}}}
