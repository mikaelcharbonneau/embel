/** Isolated PG17 NOSUPER source-packet verification. No ports, network, host
 * mounts, live database, passwords, Auth service or provider calls. The cached
 * image is required; this script does not pull or install infrastructure. */
import { execFileSync,spawn } from 'node:child_process';
import { readFileSync, readdirSync,writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const image='ghcr.io/supabase/cli/postgres:17.11.0.006-r0@sha256:ee0f2d9747fb9d3c0a29703684ec718f070384ad05bf0d92823ed02cabde8e5a';
const name=`embel-shared-native17-${randomBytes(6).toString('hex')}`;
const compileAuthorityOnly=process.argv.length===3&&process.argv[2]==='--compile-authority-only';
if(process.argv.length!==2&&!compileAuthorityOnly)throw Error('Unsupported native verification argument');
const packetPaths=['identity_transactions.sql','shared_worker_pool.sql','shared_account_http.sql','shared_worker_strategy.sql','shared_worker_naming.sql','shared_worker_logo.sql','shared_storage_authority.sql','shared_logo_http.sql','shared_logo_advanced.sql','shared_identity_generation.sql','shared_naming_brainstorm.sql'];
const packets=Object.fromEntries(packetPaths.map(path=>[path,readFileSync(new URL('../supabase/candidates/'+path,import.meta.url),'utf8')]));
const env={...process.env};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
const docker=(args,input)=>execFileSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,input,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:20*1024*1024});
let created=false,stage='cached-image';const passed=[];
const assert=(value,label)=>{if(!value)throw Error(label);passed.push(label);};
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const sql=(source,role='postgres')=>docker(['exec','-i',name,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','/tmp','-U',role,'-d','postgres'],source).trim();
const scalar=(source,role)=>JSON.parse(sql(`select to_jsonb(${source});`,role));
const rpc=(fn,args=[],role='fixture_enrollment_operator')=>scalar(`public.${fn}(${args.map(v=>v==null?'null':quote(typeof v==='object'?JSON.stringify(v):v)).join(',')})`,role);
function interactiveSql(role){
 const child=spawn('docker',['--host=unix:///var/run/docker.sock','exec','-i',name,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','/tmp','-U',role,'-d','postgres'],{env,stdio:['pipe','pipe','pipe']});
 const state={child,out:'',err:'',done:null};child.stdout.on('data',chunk=>{state.out+=String(chunk);});child.stderr.on('data',chunk=>{state.err+=String(chunk);});child.stdin.on('error',()=>{});
 state.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});return state;
}
async function eventually(predicate){for(let i=0;i<150;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('bounded-native-lock-probe-timeout');}
const catalog=()=>JSON.parse(sql(`begin;set local search_path='';select coalesce(jsonb_agg(jsonb_build_object(
 'schema',n.nspname,'name',p.proname,'argumentTypes',pg_catalog.oidvectortypes(p.proargtypes),
 'sha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex'),
 'language',l.lanname,'volatility',p.provolatile,'securityDefiner',p.prosecdef,'leakproof',p.proleakproof,
 'owner',pg_catalog.pg_get_userbyid(p.proowner),'searchPath',p.proconfig,
 'broadExecute',(exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE')
  or pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') or pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
  or pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE'))) order by n.nspname,p.proname,pg_catalog.oidvectortypes(p.proargtypes)),'[]'::jsonb)
 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace join pg_catalog.pg_language l on l.oid=p.prolang
 where n.nspname in('public','fluid_private');commit;`));
const functionKey=f=>JSON.stringify([f.schema,f.name,f.argumentTypes]);

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
 stage='standalone-identity';sql(packets['identity_transactions.sql']);
 stage='auth-session-interface';sql(`create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz);
 create table auth.refresh_tokens(user_id text,revoked boolean not null default false);
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant execute on function auth.jwt() to authenticated;`);
 for(const path of ['logo_worker_storage.sql','logo_production_storage.sql','../activation/logo_production_storage.sql','logo_generative_storage.sql','../activation/logo_generative_storage.sql','logo_local_concepts.sql','../activation/logo_concepts_50_publication_adjudication.sql','logo_local_refinements.sql']){
  stage=`logo-predecessor:${path}`;sql(readFileSync(new URL(`../supabase/candidates/${path}`,import.meta.url),'utf8'));
 }
 const baselineCatalog=new Map(catalog().map(f=>[functionKey(f),JSON.stringify(f)]));
 let previousCatalog=new Map(baselineCatalog);const workerManifestKeys=new Set();
 for(const path of packetPaths.filter(path=>path!=='identity_transactions.sql')){
  stage=`shared-packet:${path}`;sql(packets[path]);assert(true,`${path}-installed-by-nosuper-postgres`);
  const current=catalog();
  if(!['shared_account_http.sql','shared_logo_http.sql'].includes(path))for(const f of current){const key=functionKey(f);if(previousCatalog.get(key)!==JSON.stringify(f))workerManifestKeys.add(key);}
  previousCatalog=new Map(current.map(f=>[functionKey(f),JSON.stringify(f)]));
 }
 const compiledFunctions=catalog().filter(f=>baselineCatalog.get(functionKey(f))!==JSON.stringify(f)).map(f=>({...f,lanes:workerManifestKeys.has(functionKey(f))||f.schema==='fluid_private'&&f.name==='shared_http_customer_storage_live'?['strategy','naming','logo']:[]}));
 assert(sql("select count(*) from pg_roles where rolname='embel_account_role_manager';")==='0','no-online-role-manager-installed');
 if(!compileAuthorityOnly){
 stage='fixture-only-bounded-probe';
 const strategyGatewayDefinition=sql("select pg_get_functiondef('public.shared_strategy_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure);");
 const strategyGatewayBodyHash=sql("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='public.shared_strategy_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure;");
 sql(`create or replace function public.shared_strategy_worker_action(p_slot jsonb,p_execution jsonb,p_action text,p_args jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$declare l jsonb:=p_slot;e jsonb:=p_execution;a text:=p_action;jid uuid:=(p_args->>'jobId')::uuid;x fluid_private.shared_worker_executions;j public.jobs;result jsonb;begin
 if a='claim' then
  perform fluid_private.enter_shared_worker_claim_context(l,jid);
  update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '60 seconds',worker_id=l->>'instanceId',attempts=attempts+1 where id=jid;
  x:=fluid_private.bind_shared_worker_execution(l,jid);perform fluid_private.leave_shared_worker_context();return fluid_private.shared_worker_execution_json(x);
 elsif a in('active','observe','observe_lock','fail','leak') then
  perform fluid_private.enter_shared_worker_context(l,e,case when a in('observe','observe_lock') then 'observe' else 'active' end);
  if a='fail' then raise exception 'fixture_rollback';end if;if a='leak' then return '{}'::jsonb;end if;
  if a='observe_lock' then j:=fluid_private.lock_leased_job((e->>'jobId')::uuid,(e->>'leaseToken')::uuid);end if;
  result:=jsonb_build_object('ownerId',fluid_private.shared_worker_context_owner(l->>'lane'),'jobId',fluid_private.shared_worker_context_job(l->>'lane'),'mode',fluid_private.shared_worker_context_mode(l->>'lane'));
  perform fluid_private.leave_shared_worker_context();return result;
 elsif a='close' then perform fluid_private.close_shared_worker_execution(l,e);return '{}'::jsonb;
 elsif a='park' then perform fluid_private.park_shared_worker_execution(l,e);return '{}'::jsonb;
 else raise exception 'fixture_action_denied';end if;end $$;
 revoke all on function public.shared_strategy_worker_action(jsonb,jsonb,text,jsonb) from public;`);
 const owners=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
 sql(`insert into auth.users(id,email_confirmed_at,is_anonymous) values ${owners.map(o=>`(${quote(o)},clock_timestamp(),false)`).join(',')};`);
 assert(sql('select count(*) from fluid_private.shared_accounts;')==='2','confirmed-signup-is-data-only-for-two-customers');
 const slots=[1,2].map(index=>({id:`00000000-0000-4000-8000-00000000000${index}`,role:`embel_shared_strategy_native_${index}`}));
 for(const [index,s] of slots.entries())sql(`create role ${s.role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4;
 grant usage on schema public to ${s.role};grant execute on function public.shared_worker_pool_configuration(),public.claim_shared_worker_slot(uuid,uuid,text,integer),public.renew_shared_worker_slot(jsonb,integer),public.release_shared_worker_slot(jsonb),public.fence_shared_worker_slot(jsonb),public.read_shared_worker_executions(jsonb),public.read_shared_worker_execution_page(jsonb,uuid,integer),public.shared_strategy_worker_action(jsonb,jsonb,text,jsonb) to ${s.role};
 insert into fluid_private.shared_worker_slots(slot_id,lane,slot_index,role_name,role_oid,deployment_id,enabled) select ${quote(s.id)},'strategy',${index+1},rolname,oid,'native-shared-fixture',true from pg_roles where rolname=${quote(s.role)};
 insert into fluid_private.shared_worker_policies values(${quote(s.id)},'strategy',${quote('a'.repeat(64))},'{"providerBudgetVersion":2}');`);
 const s=slots[0],foreign=slots[1];
 let lease=rpc('claim_shared_worker_slot',[s.id,'10000000-0000-4000-8000-000000000001','native-shared-fixture',60],s.role);
 assert(typeof lease.roleOid==='number'&&lease.generation===1,'fixed-slot-proof-numeric-oid-generation');
 const capacity=rpc('shared_worker_pool_configuration',[],s.role);
 assert(capacity.tenantScope==='per_lane'&&capacity.maxPerTenantPerLane===1&&capacity.globalConcurrency===2&&JSON.stringify(capacity.slotIds)===JSON.stringify(slots.map(s=>s.id).sort()),'global-slot-roster-and-per-lane-capacity-proved-in-SQL');
 const checkDenied=(source,role,label,pattern=/ERROR:/)=>{let rejected=false;try{sql(source,role);}catch(error){const detail=String(error.stderr);rejected=pattern.test(detail)&&!/does not exist|syntax error|invalid input syntax|no function matches|cannot change name/i.test(detail);}assert(rejected,label);};
 checkDenied(`select public.renew_shared_worker_slot(${quote(JSON.stringify(lease))},60);`,foreign.role,'foreign-slot-login-denied');
 checkDenied('select * from public.jobs;',s.role,'shared-slot-raw-customer-table-denied');
 checkDenied('select * from auth.users;',s.role,'shared-slot-raw-auth-table-denied');
 checkDenied('set role postgres;',s.role,'fixed-slot-cannot-borrow-database-owner');
 sql(`grant execute on function public.create_project(text,text,jsonb,text) to ${s.role};`);
 checkDenied('select public.shared_worker_pool_configuration();',s.role,'extra-generic-public-execute-grant-invalidates-slot');
 sql(`revoke execute on function public.create_project(text,text,jsonb,text) from ${s.role};`);
 checkDenied(`update fluid_private.shared_worker_slots set role_oid=1 where slot_id=${quote(s.id)};`,'postgres','fixed-slot-principal-identity-cannot-be-rebound');
 checkDenied(`select public.claim_shared_worker_slot(${quote(s.id)},${quote(lease.instanceId)},'native-shared-fixture',60);`,s.role,'live-slot-reclaim-needs-renewal-token');
 const jobFor=owner=>JSON.parse(sql(`begin;select set_config('request.jwt.claim.sub',${quote(owner)},true);with p as(select * from public.create_project('complete_brand','Native shared fixture','{}',${quote('a'.repeat(64))}))
 insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,billing_mode)
 select ${quote(owner)},p.id,'strategy',1,${quote('a'.repeat(64))},'{}',gen_random_uuid()::text,0,'openai_api' from p returning json_build_object('jobId',id,'projectId',project_id);
 commit;`).split('\n').find(line=>line.startsWith('{')));
 const admit=job=>sql(`begin;select set_config('request.jwt.claim.sub',(select owner_id::text from public.jobs where id=${quote(job.jobId)}),true);select fluid_private.admit_shared_worker_job(${quote(job.jobId)},'strategy',${quote('a'.repeat(64))},'native-shared-fixture','{"providerBudgetVersion":2}');commit;`);
 const action=(l,e,a,j=null)=>rpc('shared_strategy_worker_action',[l,e,a,j===null?null:{jobId:j}],s.role);
 stage='bounded-concurrent-Auth-delete-lock-order';
 const lockJob=jobFor(owners[0]);admit(lockJob);
 const authDelete=interactiveSql('postgres');
 authDelete.child.stdin.write(`\\set VERBOSITY sqlstate\nbegin;set local statement_timeout='5s';select 'fixture_auth_row_held' from auth.users where id=${quote(owners[0])} for update;\n`);
 await eventually(()=>authDelete.out.includes('fixture_auth_row_held'));
 const workerWait=interactiveSql(s.role);
 workerWait.child.stdin.end(`begin;set local statement_timeout='5s';select public.shared_strategy_worker_action(${quote(JSON.stringify(lease))},null,'claim',${quote(JSON.stringify({jobId:lockJob.jobId}))});commit;\n`);
 await eventually(()=>sql(`select exists(select 1 from pg_stat_activity where usename=${quote(s.role)} and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0);`)==='t');
 authDelete.child.stdin.end(`delete from auth.users where id=${quote(owners[0])};commit;\n`);
 const [deleteCode,workerCode]=await Promise.all([authDelete.done,workerWait.done]);
 assert(deleteCode!==0&&/23503/.test(authDelete.err)&&!/40P01/.test(authDelete.err+workerWait.err),'hard-Auth-delete-rejects-history-FK-without-job-Auth-deadlock');
 assert(workerCode===0,'actual-worker-blocked-on-Auth-resumes-after-rejected-delete');
 const lockExecution=JSON.parse(workerWait.out.split('\n').find(line=>line.startsWith('{')));
 sql(`update public.jobs set state='succeeded',lease_token=null,lease_expires_at=null where id=${quote(lockJob.jobId)};`);action(lease,lockExecution,'close');
 stage='two-owner-core-lifecycle';
 let historical;
 for(const owner of owners){const job=jobFor(owner);admit(job);const e=action(lease,null,'claim',job.jobId);
  assert(action(lease,e,'active').ownerId===owner,'actual-same-slot-owner-derived-'+owner.slice(0,1));
  checkDenied(`select public.shared_strategy_worker_action(${quote(JSON.stringify(lease))},${quote(JSON.stringify({...e,ownerId:owners.find(o=>o!==owner)}))},'active',null);`,s.role,'forged-execution-owner-denied-'+owner.slice(0,1));
  checkDenied(`select public.shared_strategy_worker_action(${quote(JSON.stringify(lease))},${quote(JSON.stringify(e))},'fail',null);`,s.role,'context-rolled-back-on-error-'+owner.slice(0,1));
  checkDenied(`select public.shared_strategy_worker_action(${quote(JSON.stringify(lease))},${quote(JSON.stringify(e))},'leak',null);`,s.role,'context-leak-rejects-commit-'+owner.slice(0,1));
  assert(sql('select count(*) from fluid_private.shared_worker_gateway_context;')==='0','reused-client-has-no-context-'+owner.slice(0,1));
  if(owner===owners[0]){sql(`update public.jobs set state='succeeded',lease_token=null,lease_expires_at=null where id=${quote(job.jobId)};`);action(lease,e,'close');}
  else historical={job,e,lease};
 }
 stage='takeover-and-project-scoped-unknown';sql(`update fluid_private.shared_worker_slots set expires_at=clock_timestamp()-interval '1 second' where slot_id=${quote(s.id)};update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${quote(historical.job.jobId)};`);
 lease=rpc('claim_shared_worker_slot',[s.id,'10000000-0000-4000-8000-000000000002','native-shared-fixture',60],s.role);
 assert(lease.generation===2,'slot-restart-increments-generation');
 checkDenied(`select public.shared_strategy_worker_action(${quote(JSON.stringify(historical.lease))},${quote(JSON.stringify(historical.e))},'active',null);`,s.role,'old-generation-new-dispatch-fenced');
 assert(action(historical.lease,historical.e,'observe_lock').ownerId===owners[1],'issued-observation-survives-lease-expiry-and-takeover');
 const unrelated=jobFor(owners[0]);admit(unrelated);const current=action(lease,null,'claim',unrelated.jobId);
 assert(current.ownerId===owners[0],'unrelated-customer-progress-despite-retained-unknown');
 assert(sql(`select state from public.jobs where id=${quote(historical.job.jobId)};`)==='running','old-unknown-not-fabricated-cancelled-or-reissued');
 stage='ban';sql(`update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=${quote(owners[0])};`);
 checkDenied(`select public.shared_strategy_worker_action(${quote(JSON.stringify(lease))},${quote(JSON.stringify(current))},'active',null);`,s.role,'ban-immediately-closes-new-dispatch');
 assert(action(lease,current,'observe').ownerId===owners[0],'ban-preserves-exact-issued-observation');
 sql(`update auth.users set banned_until=null where id=${quote(owners[0])};`);
 checkDenied(`select public.shared_strategy_worker_action(${quote(JSON.stringify(lease))},${quote(JSON.stringify(current))},'active',null);`,s.role,'unban-does-not-revive-old-admission-epoch');
 action(lease,current,'park');
 assert(sql(`select state from fluid_private.shared_worker_executions where execution_id=${quote(current.executionId)};`)==='observing','inactive-epoch-parks-only-scheduling-authority');
 const progress=jobFor(owners[1]);admit(progress);assert(action(lease,null,'claim',progress.jobId).ownerId===owners[1],'fresh-other-project-progress-without-slot-expiration');
 const page=rpc('read_shared_worker_execution_page',[lease,null,1],s.role);
 assert(page.version===1&&page.items.length===1&&typeof page.nextCursor==='string','retained-recovery-is-bounded-cursor-page');
 const liveExecution=JSON.parse(sql(`select fluid_private.shared_worker_execution_json(e) from fluid_private.shared_worker_executions e where slot_id=${quote(s.id)} and state='active';`));
 checkDenied(`select public.fence_shared_worker_slot(${quote(JSON.stringify(historical.lease))});`,s.role,'old-process-cannot-withdraw-new-slot-generation');
 assert(rpc('fence_shared_worker_slot',[lease],s.role)===true,'fatal-local-engine-withdraws-admission-immediately');
 checkDenied(`select public.shared_strategy_worker_action(${quote(JSON.stringify(lease))},${quote(JSON.stringify(liveExecution))},'active',null);`,s.role,'fenced-current-engine-cannot-dispatch');
 assert(action(lease,liveExecution,'observe').jobId===liveExecution.jobId,'fencing-retains-issued-observation-without-inventing-stop');
 stage='restore-actual-strategy-gateway';sql(strategyGatewayDefinition);
 assert(sql("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='public.shared_strategy_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure;")===strategyGatewayBodyHash,'actual-Strategy-gateway-restored-exactly-after-finite-core-probe');
 stage='actual-http-SQL-capability-boundary';
 const httpRoles={home:'embel_shared_http_home_native',identity:'embel_shared_http_identity_native'};
 const origin='https://abcdefghijklmnopqrst.supabase.co';
 for(const [lane,role] of Object.entries(httpRoles))sql(`create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  grant usage on schema public to ${role};
  grant execute on function public.shared_account_http_principal() to ${role};
  insert into fluid_private.shared_http_principals(lane,role_name,role_oid,enabled) select ${quote(lane)},rolname,oid,true from pg_roles where rolname=${quote(role)};`);
 sql(`grant execute on function public.execute_shared_home_request(text,text,jsonb,jsonb) to ${httpRoles.home};
  insert into fluid_private.shared_http_target(mode,origin) values('hosted',${quote(origin)});`);
 const sessions=owners.map((owner,index)=>({owner,id:`20000000-0000-4000-8000-00000000000${index+1}`}));
 for(const session of sessions)sql(`insert into auth.sessions(id,user_id) values(${quote(session.id)},${quote(session.owner)});`);
 const asVerifiedStatement=(session,statement,overrides={},operation=null)=>{
  const claims={sub:session.owner,role:'authenticated',aud:'authenticated',iss:origin+'/auth/v1',is_anonymous:false,session_id:session.id,exp:Math.floor(Date.now()/1000)+3600,...overrides};
  return JSON.parse(sql(`begin;set local role authenticated;set local request.jwt.claim.sub=${quote(session.owner)};set local request.jwt.claims=${quote(JSON.stringify(claims))};${operation===null?'':`set local storage.operation=${quote(operation)};`}${statement};commit;`,'authenticator'));
 };
 const asVerifiedSession=(session,expression,overrides={},operation=null)=>asVerifiedStatement(session,`select ${expression}`,overrides,operation);
 const issue=(session,action,args,overrides={})=>asVerifiedSession(session,`public.issue_shared_account_request('home',${quote(action)},${quote(JSON.stringify(args))})`,overrides);
 const args=[{requestKey:'30000000-0000-4000-8000-000000000001',name:'brief.txt',mimeType:'text/plain',contentHash:'a'.repeat(64)},5];
 const references=[];
 for(const session of sessions){const cap=issue(session,'prepare',args);
  const ref=rpc('execute_shared_home_request',[cap.token,'prepare',args,null],httpRoles.home);
  assert(ref.ref.ownerId===session.owner,'verified-SQL-session-home-owner-derived-'+session.owner.slice(0,1));references.push(ref.ref.id);
  checkDenied(`select public.execute_shared_home_request(${quote(cap.token)},'prepare',${quote(JSON.stringify(args))},null);`,httpRoles.home,'home-request-token-replay-denied-'+session.owner.slice(0,1));
 }
 assert(references[0]!==references[1],'same-fixed-home-login-keeps-owner-reservations-distinct');
 let foreignSessionDenied=false;try{issue(sessions[0],'prepare',args,{session_id:sessions[1].id});}catch{foreignSessionDenied=true;}assert(foreignSessionDenied,'HTTP-issuer-rejects-foreign-auth-session');
 const wrongArgsCap=issue(sessions[0],'prepare',[{...args[0],requestKey:'30000000-0000-4000-8000-000000000002'},5]);
 checkDenied(`select public.execute_shared_home_request(${quote(wrongArgsCap.token)},'prepare',${quote(JSON.stringify(args))},null);`,httpRoles.home,'HTTP-request-arguments-immutable');
 checkDenied(`select public.execute_shared_home_request(${quote(wrongArgsCap.token)},'prepare',${quote(JSON.stringify(args))},null);`,httpRoles.identity,'HTTP-home-capability-cannot-cross-fixed-principals');
 assert(sql('select count(*) from fluid_private.shared_http_contexts;')==='0','HTTP-private-context-empty-after-owner-reuse-and-denials');
 stage='actual-Logo-web-SQL-capability-boundary';const logoRole='embel_shared_http_logo_native';
 sql(`create role ${logoRole} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  grant usage on schema public to ${logoRole};grant execute on function public.shared_logo_http_principal(),public.execute_shared_logo_request(text,text,jsonb,jsonb) to ${logoRole};
  insert into fluid_private.shared_logo_http_principals(lane,role_name,role_oid,enabled) select 'logo',rolname,oid,true from pg_roles where rolname=${quote(logoRole)};`);
 for(const [index,session] of sessions.entries()){
  const input={requestKey:`40000000-0000-4000-8000-00000000000${index+1}`,brief:{name:'Native shared fixture',activity:'Studio',audience:'Founders',personality:'Calm',logoTypes:['wordmark']}};
  const workspace=asVerifiedSession(session,`public.start_logo_project(${quote(JSON.stringify(input))})`);
  const upload={kind:'upload',intent:{requestKey:`50000000-0000-4000-8000-00000000000${index+1}`,usage:'logo_reference',mimeType:'image/png',contentHash:'b'.repeat(64),rightsDeclaration:'Synthetic native fixture rights'},byteLength:100};
  const logoArgs=[workspace.projectId,upload];const cap=asVerifiedSession(session,`public.issue_shared_logo_request('asset_prepare',${quote(JSON.stringify(logoArgs))})`);
  const prepared=rpc('execute_shared_logo_request',[cap.token,'asset_prepare',logoArgs,null],logoRole);
  assert(prepared.reference.ownerId===session.owner,'fixed-Logo-web-verifier-prepares-owner-bound-unverified-upload-'+session.owner.slice(0,1));
  checkDenied(`select public.execute_shared_logo_request(${quote(cap.token)},'asset_prepare',${quote(JSON.stringify(logoArgs))},null);`,logoRole,'Logo-web-request-replay-denied-'+session.owner.slice(0,1));
 }
 assert(sql('select count(*) from fluid_private.shared_logo_http_contexts;')==='0','Logo-web-context-cleared-after-owner-reuse');
 stage='actual-two-client-identity-close-and-late-admission';
 const identityProject=asVerifiedSession(sessions[1],`to_jsonb(public.create_project('visual_identity_only','Native closure fixture','{"description":"Synthetic native closure race","selectedName":"Fixture"}','${'c'.repeat(64)}'))`);
 const identityIntent={version:2,spendControl:'uncapped',expectedProjectRevision:1,expectedReferenceRevision:0,expectedPreferencesRevision:0,expectedIdentityRevision:0,idempotencyKey:'native-close-intent-race-0001',acceptedPolicyIdentity:'d'.repeat(64)};
 const identityClaims={sub:sessions[1].owner,role:'authenticated',aud:'authenticated',iss:origin+'/auth/v1',is_anonymous:false,session_id:sessions[1].id,exp:Math.floor(Date.now()/1000)+3600};
 const identityPrefix=`begin;set local role authenticated;set local request.jwt.claim.sub=${quote(sessions[1].owner)};set local request.jwt.claims=${quote(JSON.stringify(identityClaims))};`;
 const originalArgs=`${quote(identityProject.id)},${quote(JSON.stringify(identityIntent))}`;
 const closingIntent=interactiveSql('authenticator'),lateAdmission=interactiveSql('authenticator');
 try{
  closingIntent.child.stdin.write(`${identityPrefix}select public.close_shared_identity_generation_intent(${originalArgs});select 'native_identity_closure_held';\n`);
  await eventually(()=>closingIntent.out.includes('native_identity_closure_held'));
  lateAdmission.child.stdin.end(`${identityPrefix}set local application_name='embel_native_late_identity';select public.ensure_shared_identity_batch(${originalArgs});commit;\n`);
  await eventually(()=>sql("select exists(select 1 from pg_stat_activity where application_name='embel_native_late_identity' and wait_event_type='Lock' and wait_event='advisory');")==='t');
  assert(!lateAdmission.out.includes('batchId'),'late-original-admission-waits-on-the-actual-closure-transaction');
  closingIntent.child.stdin.end('commit;\n');
  assert(await closingIntent.done===0,'original-intent-closure-commits-on-first-native-connection');
  assert(await lateAdmission.done!==0&&lateAdmission.err.includes('identity_generation_intent_closed'),'late-original-admission-denied-after-atomic-closure-on-second-native-connection');
 }finally{
  if(!closingIntent.child.stdin.writableEnded)closingIntent.child.stdin.end('rollback;\n');
  if(!lateAdmission.child.stdin.writableEnded)lateAdmission.child.stdin.end('rollback;\n');
 }
 assert(sql(`select (select count(*) from fluid_private.shared_identity_rejected_intents where project_id=${quote(identityProject.id)} and request_key=${quote(identityIntent.idempotencyKey)})=1 and not exists(select 1 from fluid_private.shared_identity_requests where project_id=${quote(identityProject.id)});`)==='t','closure-race-retains-one-immutable-witness-without-a-generation-or-provider-call');
 const closedIntent=asVerifiedSession(sessions[1],`public.close_shared_identity_generation_intent(${originalArgs})`);
 assert(closedIntent.status==='not_admitted'&&closedIntent.ownerId===sessions[1].owner&&isDeepStrictEqual(closedIntent.intent,identityIntent),'exact-closure-replay-remains-scoped-to-original-intent');
 let foreignClosureDenied=false;try{asVerifiedSession(sessions[0],`public.close_shared_identity_generation_intent(${originalArgs})`);}catch{foreignClosureDenied=true;}
 assert(foreignClosureDenied,'foreign-account-cannot-close-another-accounts-original-generation-intent');
 stage='actual-verified-session-proposal-request-discovery';
 const pendingProposals=asVerifiedSession(sessions[1],`public.list_pending_logo_vector_proposal_requests(${quote(identityProject.id)},null,10)`);
 assert(pendingProposals.ownerId===sessions[1].owner&&pendingProposals.projectId===identityProject.id&&Array.isArray(pendingProposals.items)&&pendingProposals.items.length===0&&pendingProposals.nextCursor===null,'verified-owner-can-read-bounded-empty-proposal-discovery-without-creating-work');
 let foreignProposalPageDenied=false;try{asVerifiedSession(sessions[0],`public.list_pending_logo_vector_proposal_requests(${quote(identityProject.id)},null,10)`);}catch{foreignProposalPageDenied=true;}
 assert(foreignProposalPageDenied,'proposal-discovery-denies-another-accounts-project');
 let forgedProposalSessionDenied=false;try{asVerifiedSession(sessions[1],`public.list_pending_logo_vector_proposal_requests(${quote(identityProject.id)},null,10)`,{session_id:sessions[0].id});}catch{forgedProposalSessionDenied=true;}
 assert(forgedProposalSessionDenied,'proposal-discovery-denies-a-foreign-physical-auth-session');
 stage='actual-two-client-export-recovery-project-contention';
 const nativeLogoRole='embel_shared_logo_native_contend',nativeLogoSlot='90000000-0000-4000-8000-000000000001';
 sql(`create role ${nativeLogoRole} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4;
  grant usage on schema public to ${nativeLogoRole};grant execute on function public.claim_shared_worker_slot(uuid,uuid,text,integer),public.shared_logo_worker_action(jsonb,jsonb,text,jsonb) to ${nativeLogoRole};
  insert into fluid_private.shared_worker_slots(slot_id,lane,slot_index,role_name,role_oid,deployment_id,enabled)
   select ${quote(nativeLogoSlot)},'logo',1,rolname,oid,'native-export-lock-fixture',true from pg_roles where rolname=${quote(nativeLogoRole)};`);
 rpc('claim_shared_worker_slot',[nativeLogoSlot,'90000000-0000-4000-8000-000000000002','native-export-lock-fixture',120],nativeLogoRole);
 assert(sql(`select not has_function_privilege(${quote(nativeLogoRole)},'public.list_pending_logo_vector_proposal_requests(uuid,uuid,integer)','EXECUTE');`)==='t','fixed-worker-login-has-no-customer-proposal-discovery-grant');
 const contentionSeed=readFileSync(new URL('../tests/database/shared-logo-native-contention-fixture.sql',import.meta.url),'utf8');
 const contentionCase=JSON.parse(sql(`create temporary table shared_logo_contention_parameters(owner_id uuid,project_id uuid,slot_id uuid);
  insert into shared_logo_contention_parameters values(${quote(sessions[1].owner)},${quote(identityProject.id)},${quote(nativeLogoSlot)});
  ${contentionSeed.replace('select c.job_id,c.project_id,s.role_name,fluid_private.shared_worker_slot_json(s) slot,\n fluid_private.shared_worker_execution_json(e) execution',"select jsonb_build_object('jobId',c.job_id,'projectId',c.project_id,'roleName',s.role_name,'slot',fluid_private.shared_worker_slot_json(s),'execution',fluid_private.shared_worker_execution_json(e))")}`));
 const holdingProject=interactiveSql('postgres'),observingExport=interactiveSql(nativeLogoRole);
 try{
  holdingProject.child.stdin.write(`begin;select 1 from public.projects where id=${quote(identityProject.id)} for update;select 'native_export_project_held';\n`);
  await eventually(()=>holdingProject.out.includes('native_export_project_held'));
  observingExport.child.stdin.end(`set statement_timeout='2s';select public.shared_logo_worker_action(${quote(JSON.stringify(contentionCase.slot))},${quote(JSON.stringify(contentionCase.execution))},'finish_known','[]');\n`);
  assert(await observingExport.done===0,'native-export-recovery-does-not-wait-for-a-conflicting-project-lock');
  const result=JSON.parse(observingExport.out.trim());
  assert(result.result.status==='retained_unknown','native-export-project-contention-retains-uncertainty-without-a-completion-witness');
  assert(sql(`select state='needs_reconciliation' and lease_token is null and error_code='export_publication_unknown' from public.jobs where id=${quote(contentionCase.jobId)};`)==='t','native-export-contention-keeps-original-job-state-and-no-revived-lease');
  assert(sql(`select not exists(select 1 from fluid_private.shared_logo_export_resolutions where job_id=${quote(contentionCase.jobId)}) and not exists(select 1 from fluid_private.shared_worker_gateway_context);`)==='t','native-export-contention-leaves-no-resolution-or-private-context');
 }finally{
  if(!holdingProject.child.stdin.writableEnded)holdingProject.child.stdin.end('rollback;\n');
  if(!observingExport.child.stdin.writableEnded)observingExport.child.stdin.end('rollback;\n');
  await holdingProject.done;
 }
 stage='actual-customer-Storage-RLS-and-session-logout';
 const homePath=sql(`select owner_id::text||'/home/'||id::text||'/'||blob_version_id::text from public.home_attachments where id=${quote(references[0])};`);
 const secondInput=[{...args[0],requestKey:'30000000-0000-4000-8000-000000000003'},5];
 const secondCap=issue(sessions[0],'prepare',secondInput);const secondHome=rpc('execute_shared_home_request',[secondCap.token,'prepare',secondInput,null],httpRoles.home);
 const secondPath=sql(`select owner_id::text||'/home/'||id::text||'/'||blob_version_id::text from public.home_attachments where id=${quote(secondHome.ref.id)};`);
 asVerifiedStatement(sessions[0],`insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',${quote(homePath)},${quote(owners[0])});select jsonb_build_object('inserted',true)`,{},'object.upload');
 const rawRead=()=>asVerifiedSession(sessions[0],`(select count(*) from storage.objects where bucket_id='fluid-assets' and name=${quote(homePath)})`,{},'object.get_authenticated');
 assert(rawRead()===1,'current-customer-JWT-reads-own-real-SQL-Storage-row');
 sql(`update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=${quote(owners[0])};`);
 assert(rawRead()===0,'stale-still-unexpired-customer-JWT-Storage-read-denied-after-ban');
 let bannedInsert=false;try{asVerifiedStatement(sessions[0],`insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',${quote(secondPath)},${quote(owners[0])});select jsonb_build_object('inserted',true)`,{},'object.upload');}catch(error){bannedInsert=/row-level security|42501/.test(String(error.stderr));}
 assert(bannedInsert,'stale-customer-JWT-Storage-insert-denied-after-ban');
 sql(`update auth.users set banned_until=null where id=${quote(owners[0])};`);assert(rawRead()===1,'unban-restores-authorized-own-history-with-current-live-session');
 const orphanInput=[{...args[0],requestKey:'30000000-0000-4000-8000-000000000004'},5];const orphanCap=issue(sessions[0],'prepare',orphanInput);
 assert(Number(sql(`select count(*) from fluid_private.shared_http_requests where session_id=${quote(sessions[0].id)};`))>0
  &&Number(sql(`select count(*) from fluid_private.shared_logo_http_requests where session_id=${quote(sessions[0].id)};`))>0,'logout-fixture-has-both-ephemeral-delegation-lanes');
 sql(`delete from auth.sessions where id=${quote(sessions[0].id)};`);
 assert(sql(`select count(*) from fluid_private.shared_http_requests where session_id=${quote(sessions[0].id)};`)==='0'
  &&sql(`select count(*) from fluid_private.shared_logo_http_requests where session_id=${quote(sessions[0].id)};`)==='0','actual-session-delete-cascades-only-both-ephemeral-delegation-tables');
 assert(rawRead()===0,'old-customer-JWT-Storage-read-denied-after-real-session-delete');
 checkDenied(`select public.execute_shared_home_request(${quote(orphanCap.token)},'prepare',${quote(JSON.stringify(orphanInput))},null);`,httpRoles.home,'deleted-session-old-delegation-cannot-redeem');
 assert(sql(`select count(*) from public.home_attachments where id=${quote(references[0])};`)==='1'
  &&sql(`select count(*) from storage.objects where bucket_id='fluid-assets' and name=${quote(homePath)};`)==='1'
  &&sql(`select count(*) from auth.users where id=${quote(owners[0])};`)==='1','logout-preserves-owner-artifact-and-Storage-history');
 assert(sql(`select count(*) from auth.sessions where id=${quote(sessions[1].id)};`)==='1','logout-does-not-revoke-neighbor-session');
 }
 stage='source-authority-manifest';const finalFunctions=new Map(catalog().map(f=>[functionKey(f),JSON.stringify(f)]));
 assert(compiledFunctions.every(({lanes,...f})=>{void lanes;return finalFunctions.get(functionKey(f))===JSON.stringify(f);}),'compiled-authority-functions-match-restored-native-catalog');
 assert(Object.entries(packets).every(([path,source])=>readFileSync(new URL('../supabase/candidates/'+path,import.meta.url),'utf8')===source),'source-packet-bytes-unchanged-during-native-verification');
 const manifest={version:1,packets:Object.entries(packets).map(([path,source])=>({path:`supabase/candidates/${path}`,sha256:createHash('sha256').update(source).digest('hex')})),functions:compiledFunctions};
 const manifestBytes=JSON.stringify(manifest,null,2)+'\n';writeFileSync(new URL('../worker/shared-pool/authority-manifest.json',import.meta.url),manifestBytes);
 stage='done';console.log(JSON.stringify({verification:'passed',mode:compileAuthorityOnly?'compile-authority-only':'full-native',nativeVersion:17,installer:'postgres NOSUPER CREATEROLE',migrationCount:migrationNames.length,checkCount:passed.length,passed,packetSha256:Object.fromEntries(Object.entries(packets).map(([p,s])=>[p,createHash('sha256').update(s).digest('hex')])),manifest:{path:'worker/shared-pool/authority-manifest.json',sha256:createHash('sha256').update(manifestBytes).digest('hex'),functions:compiledFunctions.length,workerFunctions:compiledFunctions.filter(f=>f.lanes.length).length},proofScope:compileAuthorityOnly?'exact eleven source-packet installation and compiled catalog only; no unrelated runtime suites':'native fixed-slot authority plus lane installation and actual Home/Logo web SQL delegation; Strategy gateway temporarily replaced by finite core probe then restored with exact body hash; no provider engines or real upload observation',liveSupabaseServices:false,providerCalls:false}));
}catch(error){console.error(JSON.stringify({verification:'failed',stage,sqlError:String(error?.stderr??'').match(/ERROR:\s+([^\n]{1,180})/)?.[1],error:error instanceof Error?error.message.split('\n')[0].replace(/Command failed:.*/,'native fixture command failed'):'native fixture failed'}));process.exitCode=1;
}finally{if(created){try{docker(['rm','--force',name]);const absent=docker(['ps','--all','--quiet','--filter',`name=^/${name}$`]).trim()==='';if(!absent)throw Error('fixture-cleanup-incomplete');console.log(JSON.stringify({fixtureContainerRemoved:true,persistentAccessCreated:false}));}catch{console.error('Native fixture cleanup failed');process.exitCode=1;}}}
