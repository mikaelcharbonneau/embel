/** Isolated PG17 NOSUPER source-packet verification. No ports, network, host
 * mounts, live database, passwords, Auth service or provider calls. The cached
 * image is required; this script does not pull or install infrastructure. */
import { execFileSync,spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
const image='ghcr.io/supabase/cli/postgres:17.11.0.006-r0@sha256:ee0f2d9747fb9d3c0a29703684ec718f070384ad05bf0d92823ed02cabde8e5a';
const name=`embel-enrollment-native17-${randomBytes(6).toString('hex')}`;
const packets={identity:readFileSync(new URL('../supabase/candidates/identity_transactions.sql',import.meta.url),'utf8'),strategy:readFileSync(new URL('../supabase/candidates/account_strategy_uncapped.sql',import.meta.url),'utf8'),core:readFileSync(new URL('../supabase/candidates/account_service_enrollment.sql',import.meta.url),'utf8'),worker:readFileSync(new URL('../supabase/candidates/account_worker_enrollment.sql',import.meta.url),'utf8')};
const env={...process.env};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
const docker=(args,input)=>execFileSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,input,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:20*1024*1024});
let created=false,stage='cached-image';const passed=[];
const assert=(value,label)=>{if(!value)throw Error(label);passed.push(label);};
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const sql=(source,role='postgres')=>docker(['exec','-i',name,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','/tmp','-U',role,'-d','postgres'],source).trim();
const scalar=(source,role)=>JSON.parse(sql(`select to_jsonb(${source});`,role));
const rpc=(fn,args=[],role='fixture_enrollment_operator')=>scalar(`public.${fn}(${args.map(v=>quote(v&&typeof v==='object'?JSON.stringify(v):v)).join(',')})`,role);
const denies=(source,role,label)=>{let denied=false;try{sql(source,role);}catch(error){denied=/42501|permission denied|not permitted|unavailable|unconfirmed|invalid_identity_login|home_principal_invalid/.test(String(error.stderr));}assert(denied,label);};
const verifier=(()=>{const salt=Buffer.alloc(16,7),salted=pbkdf2Sync('isolated-disposable-fixture',salt,4096,32,'sha256');return`SCRAM-SHA-256$4096:${salt.toString('base64')}$${createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64')}:${createHmac('sha256',salted).update('Server Key').digest('base64')}`;})();
try{
 docker(['image','inspect',image,'--format','{{.Id}}']);
 stage='start-network-none';docker(['run','--detach','--rm','--pull=never','--network=none','--user=postgres',`--name=${name}`,'--entrypoint=sh',image,'-c',"initdb -D /tmp/enrollment-fixture -U fixture_platform --auth=trust >/tmp/init.log && exec postgres -D /tmp/enrollment-fixture -k /tmp -c listen_addresses= -c shared_preload_libraries= -c log_statement=none -c log_min_error_statement=panic"]);created=true;
 for(let i=0;i<100;i++){try{docker(['exec',name,'pg_isready','-h','/tmp','-U','fixture_platform','-d','postgres']);break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 stage='native-platform-bootstrap';sql(`create role postgres login nosuperuser noinherit createdb createrole noreplication bypassrls;
 grant pg_monitor to postgres with inherit true,set false; alter database postgres owner to postgres;
 create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 grant anon,authenticated,service_role to postgres with inherit false,set true;`,'fixture_platform');
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
 stage='production-identity-helper-install';sql(packets.identity);assert(sql("select count(*) from pg_roles where rolname like 'fixture_identity_replacement_%';")==='0','identity-installer-creates-no-fixture-login');
 stage='logo-prerequisites';sql(`create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz);create table auth.refresh_tokens(user_id text,revoked boolean not null default false);
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant execute on function auth.jwt() to authenticated;`);
 for(const path of ['candidates/logo_worker_storage.sql','candidates/logo_production_storage.sql','activation/logo_production_storage.sql','candidates/logo_generative_storage.sql','activation/logo_generative_storage.sql','candidates/logo_local_concepts.sql','activation/logo_concepts_50_publication_adjudication.sql','candidates/logo_local_refinements.sql']){stage=`prerequisite:${path}`;sql(readFileSync(new URL(`../supabase/${path}`,import.meta.url),'utf8'));}
 stage='candidate-nosuper-install';sql(packets.core);
 stage='worker-candidate-nosuper-install';sql(packets.worker);assert(true,'worker-packet-installs-with-nosuper-manager-grant-transfer');
 stage='strategy-uncapped-nosuper-install';sql(packets.strategy);assert(true,'strategy-uncapped-packet-installs-with-nosuper-operator');
 stage='operator-registration';sql(`create role fixture_enrollment_operator login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 grant usage on schema public to fixture_enrollment_operator;
 grant execute on function public.claim_account_service_enrollment(integer),public.read_account_service_enrollment_claim(uuid,uuid),public.record_account_service_enrollment(uuid,uuid,text,text,text),public.provision_account_enrollment_http(uuid,uuid,text,text,text),public.revoke_account_enrollment_http(uuid,uuid,text),public.verify_account_http_revocation(uuid,uuid,text,text),public.acknowledge_account_enrollment_revocation(uuid,uuid,text,text),public.finish_account_service_enrollment(uuid,uuid,text[]) to fixture_enrollment_operator;
 insert into fluid_private.account_enrollment_operators(role_name,role_oid,management_version)select rolname,oid,2 from pg_roles where rolname='fixture_enrollment_operator';`);
 stage='worker-reporter-and-synthetic-approval';sql(`create role fixture_worker_reporter login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 grant usage on schema public to fixture_worker_reporter;grant execute on function public.report_account_worker_process(jsonb,text,text,timestamptz) to fixture_worker_reporter;
 grant execute on function public.provision_account_worker_enrollment(uuid,uuid,text,jsonb,text,text),public.publish_account_worker_enrollment(uuid,uuid,text,text),public.verify_account_worker_enrollment(uuid,uuid,text,jsonb),public.disable_account_worker_enrollment(uuid,uuid,text),public.verify_account_worker_revocation(uuid,uuid,text),public.read_account_worker_enrollment(uuid,uuid,text),public.suspend_account_worker_enrollment(uuid,uuid,text,text),public.resume_account_worker_enrollment(uuid,uuid,text) to fixture_enrollment_operator;`);
 const namingPolicy=JSON.parse(execFileSync(process.execPath,['--conditions=react-server','--import','tsx','--input-type=module','-e','import { brainPolicy } from "./tests/database/naming-brain-fixture.ts";process.stdout.write(JSON.stringify({...brainPolicy,model:"gpt-6-luna"}))'],{cwd:new URL('..',import.meta.url),encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 const policyHash=sql(`select encode(sha256(convert_to(${quote(JSON.stringify(namingPolicy))}::jsonb::text,'UTF8')),'hex');`);
 const profile={capability:'naming',profileId:'native-synthetic-naming',providerBindingRef:'native-synthetic-provider',modelVerificationReceipt:'native-synthetic-model-receipt',applicationOrigin:'https://www.embel.xyz',supabaseOrigin:'https://fricsfwqibyhemknqgyf.supabase.co',projectId:'prj_nativefixture',deploymentId:'dpl_nativefixture',sourceRevision:'a'.repeat(40),artifactSha256:'b'.repeat(64),managedProofSha256:'292a03340b72444ecc248921cc159c0a02a7338a2ab6cb093666d6e78f0e9017',runtime:{node:process.versions.node,icu:process.versions.icu,unicode:process.versions.unicode,platform:'linux',arch:'x64'},dispatchApproved:true,model:'gpt-6-luna',admissionContract:'hosted_owner_v1',providerBudgetVersion:2,spendControl:'uncapped',policyIdentity:policyHash};
 sql(`insert into fluid_private.account_worker_provider_approvals values(${quote(profile.providerBindingRef)},'openai','api.openai.com',${quote(profile.model)},${quote(profile.modelVerificationReceipt)},clock_timestamp(),clock_timestamp()+interval '1 hour');
 insert into fluid_private.account_worker_profile_approvals(profile_id,capability,profile,policies,provider_binding_ref,reporter_role_name,reporter_role_oid,approved_at,expires_at)
 select ${quote(profile.profileId)},'naming',${quote(JSON.stringify(profile))}::jsonb,${quote(JSON.stringify({'naming.generate':namingPolicy}))}::jsonb,${quote(profile.providerBindingRef)},rolname,oid,clock_timestamp(),clock_timestamp()+interval '1 hour' from pg_roles where rolname='fixture_worker_reporter';`);
 const owners=['a1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002'];
 sql(`insert into auth.users(id,email_confirmed_at)values${owners.map(o=>`(${quote(o)},clock_timestamp())`).join(',')};`);
 const bindings=[];let first;
 for(const owner of owners){
  stage=`provision-owner-${owners.indexOf(owner)+1}`;const claim=rpc('claim_account_service_enrollment');assert(claim.ownerId===owner,'claim-exact-owner-'+owners.indexOf(owner));if(!first)first=claim;
  for(const cap of ['home_attachments','identity_transactions']){const step=claim.steps.find(s=>s.capability===cap),ref=`fixture:${step.operationKey}`;
   rpc('record_account_service_enrollment',[claim.id,claim.leaseToken,cap,'provisioning']);rpc('record_account_service_enrollment',[claim.id,claim.leaseToken,cap,'credential_reserved',ref]);
   const binding=rpc('provision_account_enrollment_http',[claim.id,claim.leaseToken,cap,ref,verifier]);bindings.push(binding);
   const retry=rpc('provision_account_enrollment_http',[claim.id,claim.leaseToken,cap,ref,verifier]);assert(retry.roleOid===binding.roleOid,'lost-ack-idempotent-oid-'+cap+'-'+owners.indexOf(owner));
   rpc('record_account_service_enrollment',[claim.id,claim.leaseToken,cap,'published',`fixture-published:${step.operationKey}`]);rpc('record_account_service_enrollment',[claim.id,claim.leaseToken,cap,'ready',`fixture-qualified:${step.operationKey}`]);
   const proof=scalar('public.account_enrollment_managed_principal()',binding.roleName);assert(proof.ownerId===owner&&proof.roleOid===binding.roleOid&&proof.identityHelperOwnerQualified===true,'actual-restricted-session-proof-'+cap+'-'+owners.indexOf(owner));
   if(cap==='identity_transactions'){
    let invalidRequest=false;try{sql(`begin;select set_config('request.jwt.claim.sub',${quote(owner)},true);select fluid_private.prepare_identity_transaction('00000000-0000-4000-8000-000000000000','{}',false);rollback;`,binding.roleName);}catch(error){invalidRequest=String(error.stderr).includes('invalid_identity_request');}
    assert(invalidRequest,'production-identity-helper-validates-real-owner-before-input-'+owners.indexOf(owner));
    let foreignClaim=false;try{sql(`begin;select set_config('request.jwt.claim.sub',${quote(owners.find(other=>other!==owner))},true);select fluid_private.prepare_identity_transaction('00000000-0000-4000-8000-000000000000','{}',false);rollback;`,binding.roleName);}catch(error){foreignClaim=String(error.stderr).includes('identity_claim_mismatch');}
    assert(foreignClaim,'production-identity-helper-rejects-foreign-claim-'+owners.indexOf(owner));
   }

   denies('set role embel_account_role_manager;',binding.roleName,'customer-cannot-set-manager-'+cap+'-'+owners.indexOf(owner));
   denies(`select * from fluid_private.account_service_enrollments;`,binding.roleName,'customer-cannot-read-controlplane-'+cap+'-'+owners.indexOf(owner));
   denies('select public.claim_account_service_enrollment();',binding.roleName,'customer-cannot-call-operator-'+cap+'-'+owners.indexOf(owner));
  }
  stage='native-naming-provision';const namingStep=claim.steps.find(s=>s.capability==='naming');rpc('record_account_service_enrollment',[claim.id,claim.leaseToken,'naming','provisioning']);
  const naming=rpc('provision_account_worker_enrollment',[claim.id,claim.leaseToken,'naming',profile,`fixture:${namingStep.operationKey}`,verifier]);bindings.push(naming);
  const retry=rpc('provision_account_worker_enrollment',[claim.id,claim.leaseToken,'naming',profile,`fixture:${namingStep.operationKey}`,verifier]);assert(retry.roleOid===naming.roleOid,'native-naming-create-retry-same-oid-'+owners.indexOf(owner));
  assert(scalar('public.account_enrollment_managed_principal()',naming.roleName).ownerId===owner,'native-naming-actual-owner-proof-'+owners.indexOf(owner));
  stage='native-naming-status';scalar(`public.report_naming_brain_worker_status(${quote(JSON.stringify(namingPolicy))}::jsonb,${quote(naming.deploymentId)},${quote(naming.workerId)},null,120)`,naming.roleName);
  scalar(`public.report_account_worker_heartbeat(${quote(JSON.stringify(naming))}::jsonb,null)`,naming.roleName);
  stage='native-naming-process-report';const observedAt=sql(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');`),receipt=`fixture-process-running:${naming.operationKey}`;
  rpc('report_account_worker_process',[naming,'running',receipt,observedAt],'fixture_worker_reporter');rpc('publish_account_worker_enrollment',[claim.id,claim.leaseToken,'naming',receipt]);
  stage='native-naming-verify';const proof={...naming,receipt,observedAt,sourceRevision:profile.sourceRevision,artifactSha256:profile.artifactSha256,storageSessionId:null};assert(rpc('verify_account_worker_enrollment',[claim.id,claim.leaseToken,'naming',proof])===true,'native-naming-sql-heartbeat-reporter-ready-'+owners.indexOf(owner));
  denies('select public.claim_account_service_enrollment();',naming.roleName,'naming-cannot-use-operator-'+owners.indexOf(owner));
  if(owner===owners[0]){
   stage='native-same-operation-maintenance';const state=rpc('read_account_worker_enrollment',[claim.id,claim.leaseToken,'naming']);
   assert(state.descriptor.binding.roleOid===naming.roleOid&&state.heartbeat.roleOid===naming.roleOid&&!state.restartAllowed,'maintenance-reads-exact-existing-binding-and-fresh-heartbeat');
   rpc('suspend_account_worker_enrollment',[claim.id,claim.leaseToken,'naming','verification_unavailable']);
   assert(scalar('public.account_worker_observation_principal()',naming.roleName).ownerId===owner,'maintenance-suspension-retains-issued-observation-identity');
   assert(sql(`select fluid_private.account_worker_owner_ready(${quote(owner)},'naming');`)==='f','maintenance-suspension-closes-new-admission');
   denies(`select public.resume_account_worker_enrollment(${quote(claim.id)},${quote(claim.leaseToken)},'naming');`,'fixture_enrollment_operator','maintenance-cannot-restart-without-trusted-stopped-report');
   const stoppedAt=sql(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');`);
   rpc('report_account_worker_process',[naming,'stopped',`fixture-maintenance-stopped:${naming.operationKey}`,stoppedAt],'fixture_worker_reporter');
   assert(!rpc('read_account_worker_enrollment',[claim.id,claim.leaseToken,'naming']).restartAllowed,'maintenance-active-leadership-still-fences-restart');
   // Synthetic time passage in the isolated catalog; no real worker/lease is
   // terminated or expired by this source-only fixture.
   sql(`update fluid_private.naming_worker_leadership set expires_at=clock_timestamp()-interval '1 second' where owner_id=${quote(owner)};`);
   assert(rpc('read_account_worker_enrollment',[claim.id,claim.leaseToken,'naming']).restartAllowed,'maintenance-stopped-and-quiescent-same-binding-can-resume');
   const resumed=rpc('resume_account_worker_enrollment',[claim.id,claim.leaseToken,'naming']);
   assert(resumed.binding.roleOid===naming.roleOid&&resumed.binding.operationKey===naming.operationKey,'maintenance-resume-keeps-role-and-operation');
   scalar(`public.report_naming_brain_worker_status(${quote(JSON.stringify(namingPolicy))}::jsonb,${quote(naming.deploymentId)},${quote(naming.workerId)},null,120)`,naming.roleName);
   scalar(`public.report_account_worker_heartbeat(${quote(JSON.stringify(naming))}::jsonb,null)`,naming.roleName);
   const freshAt=sql(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');`),freshReceipt=`fixture-maintenance-running:${naming.operationKey}`;
   rpc('report_account_worker_process',[naming,'running',freshReceipt,freshAt],'fixture_worker_reporter');
   assert(rpc('verify_account_worker_enrollment',[claim.id,claim.leaseToken,'naming',{...proof,receipt:freshReceipt,observedAt:freshAt}])===true,'maintenance-fresh-real-SQL-heartbeat-requalifies-existing-ready-step');
  }

  const result=rpc('finish_account_service_enrollment',[claim.id,claim.leaseToken]);assert(result.status==='pending'&&result.capabilities.home_attachments&&result.capabilities.identity_transactions&&result.capabilities.naming&&!result.capabilities.strategy&&!result.capabilities.logo,'three-capabilities-ready-full-account-pending-'+owners.indexOf(owner));
 }
 stage='tenant-boundaries';denies(`set role ${bindings.find(b=>b.ownerId===owners[1]&&b.capability==='home_attachments').roleName};`,bindings[0].roleName,'customer-cannot-set-neighbor');
 denies(`select fluid_private.home_attachment_owner();`,'fixture_enrollment_operator','operator-cannot-use-customer-helper');
 // Manager has only ADMIN/noSET/noINHERIT children; test SET directly through
 // a fixture-platform session setting its *session* principal to manager.
 let managerSetDenied=false;try{sql(`set session authorization embel_account_role_manager;set role ${bindings[0].roleName};`,'fixture_platform');}catch(error){managerSetDenied=/permission denied|not permitted/.test(String(error.stderr));}assert(managerSetDenied,'manager-admin-edge-cannot-set-customer');
 stage='stale-jwt-storage';const home=bindings[0],request='c1000000-0000-4000-8000-000000000003';
 const reservation=scalar(`fluid_private.prepare_home_attachment(${quote(JSON.stringify({requestKey:request,name:'proof.txt',mimeType:'text/plain',contentHash:'a'.repeat(64)}))}::jsonb,1)`,home.roleName);
 const path=reservation.storagePath;
 const storage=(text)=>sql(`select set_config('request.jwt.claim.sub',${quote(owners[0])},false);select set_config('storage.operation','object.get_authenticated',false);set role authenticated;${text}`);
 sql(`insert into storage.objects(bucket_id,name,owner_id)values('fluid-assets',${quote(path)},${quote(owners[0])});`);
 assert(storage(`select count(*) from storage.objects where name=${quote(path)};`).split('\n').at(-1)==='1','home-storage-before-ban-visible');
 sql(`update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=${quote(owners[0])};`);
 assert(storage(`select count(*) from storage.objects where name=${quote(path)};`).split('\n').at(-1)==='0','stale-jwt-home-storage-denied-after-ban');
 denies(`select public.account_enrollment_managed_principal();`,home.roleName,'ban-closes-new-managed-admission');
 stage='revoke';const revoke=rpc('claim_account_service_enrollment');assert(revoke.ownerId===owners[0]&&revoke.mode==='revoke','ban-invalidates-lease-and-requests-revocation');
 denies(`select public.record_account_service_enrollment(${quote(first.id)},${quote(first.leaseToken)},'home_attachments','ready','stale');`,'fixture_enrollment_operator','stale-activation-cannot-win-ban');
 for(const cap of ['home_attachments','identity_transactions']){
  const role=bindings.find(b=>b.ownerId===owners[0]&&b.capability===cap).roleName;
  // Existing transactions may carry an uncertain commit or receipt. They are
  // observed and allowed to finish, never terminated or reported drained early.
  const active=spawn('docker',['--host=unix:///var/run/docker.sock','exec','-i',name,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','/tmp','-U',role,'-d','postgres'],{env,stdio:['pipe','ignore','ignore']});
  const completed=new Promise(resolve=>{active.on('exit',code=>resolve(code===0));active.on('error',()=>resolve(false));});
  active.stdin.write('begin;select 1;\n');
  let observed=false;for(let i=0;i<20;i++){if(sql(`select count(*) from pg_stat_activity where usename=${quote(role)} and state='idle in transaction' and xact_start is not null;`)==='1'){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}
  assert(observed,'native-owned-active-transaction-observed-'+cap);
  rpc('revoke_account_enrollment_http',[revoke.id,revoke.leaseToken,cap]);
  denies(`select public.verify_account_http_revocation(${quote(revoke.id)},${quote(revoke.leaseToken)},${quote(cap)},${quote('http-binding:'+'a'.repeat(64))});`,'fixture_enrollment_operator','revocation-blocked-until-existing-transaction-drains-'+cap);
  active.stdin.end('rollback;\n');assert(await completed,'owned-transaction-finished-without-termination-'+cap);
  const proof=rpc('verify_account_http_revocation',[revoke.id,revoke.leaseToken,cap,'http-binding:'+'a'.repeat(64)]);assert(proof.authorityDisabled&&proof.runtimeStopped&&proof.storageDenied,'sql-authorization-and-drain-proof-'+cap);rpc('acknowledge_account_enrollment_revocation',[revoke.id,revoke.leaseToken,cap,proof.receipt]);
 }
 for(const cap of ['strategy','logo']){
  const absence=rpc('verify_account_worker_revocation',[revoke.id,revoke.leaseToken,cap]);
  assert(absence.scope==='never_provisioned'&&absence.authorityAbsent===true&&!Object.hasOwn(absence,'runtimeStopped'),'never-provisioned-SQL-absence-without-fake-process-stop-'+cap);
 }
 const naming=bindings.find(b=>b.ownerId===owners[0]&&b.capability==='naming');
 rpc('disable_account_worker_enrollment',[revoke.id,revoke.leaseToken,'naming']);
 assert(sql(`select rolcanlogin from pg_roles where rolname=${quote(naming.roleName)};`)==='t','worker-keeps-observation-login-until-stop-proof');
 assert(scalar('public.account_worker_observation_principal()',naming.roleName).ownerId===owners[0],'worker-exact-observation-identity-survives-ban-during-drain');
 denies(`select public.verify_account_worker_revocation(${quote(revoke.id)},${quote(revoke.leaseToken)},'naming');`,'fixture_enrollment_operator','worker-revocation-blocked-without-stopped-report');
 const stoppedAt=sql(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');`);rpc('report_account_worker_process',[naming,'stopped',`fixture-process-stopped:${naming.operationKey}`,stoppedAt],'fixture_worker_reporter');
 const stopped=rpc('verify_account_worker_revocation',[revoke.id,revoke.leaseToken,'naming']);assert(stopped.authorityDisabled&&stopped.runtimeStopped&&stopped.revision===revoke.revision,'worker-stopped-proof-allows-final-nologin');
 rpc('acknowledge_account_enrollment_revocation',[revoke.id,revoke.leaseToken,'naming',stopped.receipt]);
 const revoked=rpc('finish_account_service_enrollment',[revoke.id,revoke.leaseToken,'{home_attachments,identity_transactions,strategy,naming,logo}']);assert(revoked.status==='unavailable','revocation-has-no-false-ready');
 stage='reactivate-generation';sql(`update auth.users set banned_until=null where id=${quote(owners[0])};`);const next=rpc('claim_account_service_enrollment');assert(next.generation===2&&next.revision>first.revision,'unban-reconciles-new-generation');
 for(const cap of ['home_attachments','identity_transactions']){const step=next.steps.find(s=>s.capability===cap),ref=`fixture:${step.operationKey}`;rpc('record_account_service_enrollment',[next.id,next.leaseToken,cap,'provisioning']);rpc('record_account_service_enrollment',[next.id,next.leaseToken,cap,'credential_reserved',ref]);const b=rpc('provision_account_enrollment_http',[next.id,next.leaseToken,cap,ref,verifier]);assert(b.roleOid===bindings.find(x=>x.ownerId===owners[0]&&x.capability===cap).roleOid,'reenable-preserves-owner-oid-'+cap);}
 stage='complete';console.log(JSON.stringify({nativeVersion:17,installer:'postgres NOSUPER CREATEROLE',migrationCount:migrationNames.length,checkCount:passed.length,identityPacketSha256:createHash('sha256').update(packets.identity).digest('hex'),strategyPacketSha256:createHash('sha256').update(packets.strategy).digest('hex'),sourcePacketSha256:createHash('sha256').update(packets.core).digest('hex'),passed,workerProof:'SQL heartbeat plus synthetic trusted launcher report only; no actual worker process/provider',workerPacketSha256:createHash('sha256').update(packets.worker).digest('hex'),liveSupabaseServices:false,providerCalls:false}));
}catch(error){console.error(JSON.stringify({verification:'failed',stage,sqlError:String(error?.stderr??'').match(/ERROR:\s+([a-z_ ]{1,150})/)?.[1],error: error instanceof Error ? error.message.split('\n')[0].replace(/Command failed:.*/, 'native fixture command failed') : 'native fixture failed'}));process.exitCode=1;
}finally{if(created){try{docker(['rm','--force',name]);const absent=docker(['ps','--all','--quiet','--filter',`name=^/${name}$`]).trim()==='';if(!absent)throw Error('fixture-cleanup-incomplete');console.log(JSON.stringify({fixtureContainerRemoved:true,persistentAccessCreated:false}));}catch{console.error('Native fixture cleanup failed');process.exitCode=1;}}}
