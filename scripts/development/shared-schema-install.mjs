import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { cliVersion, DevelopmentError, localDockerEnvironment, migrationSources, privateDirectory, readOptional, repositoryRoot, settingsFor, writeState } from './config.mjs';
import { composeSupplementalUpgrade, SUPPLEMENTAL_PACKET } from './shared-schema-upgrade.mjs';
import { composeDevelopmentSchema, sqlLiteral as q } from './shared-schema.mjs';

function command(binary, args, env, input) {
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output='',errors='';
  child.stdout.on('data',chunk=>{output+=chunk;}); child.stderr.on('data',chunk=>{errors+=chunk;});
  child.stdin.on('error',()=>{}); // psql may reject a guard before consuming its input.
  const timer=setTimeout(()=>child.kill('SIGTERM'),180_000);
  child.on('error',()=>{clearTimeout(timer);reject(new DevelopmentError('Local provisioning command could not start.'));});
  child.on('close',code=>{clearTimeout(timer);if(code===0)resolve(output.trim());else {
   // Never expose a SQL statement, credential, CLI status or URL in errors.
   const diagnostic=errors.match(/ERROR:\s+([a-z][a-z_]{5,90})(?:\s|$)/)?.[1];
   reject(new DevelopmentError('Local provisioning failed'+(diagnostic?' ('+diagnostic+')':'')+'. Private command output withheld.'));
  }});
  child.stdin.end(input??'');
 });
}

export async function developmentDatabase(root=repositoryRoot) {
 if(Object.keys(process.env).some(key=>key==='VERCEL'||key.startsWith('VERCEL_')))throw new DevelopmentError('Use a development shell without hosted Vercel markers.');
 const settings=await settingsFor(root),state=path.join(root,'.embel-dev');
 if(!await readOptional(path.join(state,'settings.json')))throw new DevelopmentError('Run npm run dev:up first.');
 let endpoint=process.env.DOCKER_CONTEXT?null:process.env.DOCKER_HOST;
 if(!endpoint){const context=process.env.DOCKER_CONTEXT||await command('docker',['context','show'],process.env);endpoint=JSON.parse(await command('docker',['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}'],process.env));}
 const environment=localDockerEnvironment(endpoint),container='supabase_db_'+settings.projectId;
 const inspect=JSON.parse(await command('docker',['inspect','--format','{{json .NetworkSettings.Ports}}',container],environment));
 if(!inspect['5432/tcp']?.length||inspect['5432/tcp'].some(p=>!['127.0.0.1','::1'].includes(p.HostIp)||p.HostPort!==String(settings.dbPort)))throw new DevelopmentError('Provisioning requires this checkout’s loopback-only database.');
 const sql=source=>command('docker',['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],environment,"set search_path='';\n"+source);
 const installed=(await sql('select version from supabase_migrations.schema_migrations order by version;')).split(/\r?\n/);
 const migrations=await migrationSources(root);
 if(JSON.stringify(installed)!==JSON.stringify(migrations.map(m=>m.staged.slice(0,14))))throw new DevelopmentError('Local baseline migration history differs from this checkout.');
 const status=async()=>JSON.parse(await command(process.execPath,[path.join(root,'node_modules/supabase/dist/supabase.js'),'status','--output','json','--workdir',state],{...environment,SUPABASE_HOME:path.join(state,'cli-home'),SUPABASE_TELEMETRY_DISABLED:'1'}));
 return {settings,state,sql,status};
}

export async function installDevelopmentSchema(root=repositoryRoot) {
 const db=await developmentDatabase(root),bundle=await composeDevelopmentSchema(db.settings,root);
 const present=await db.sql("select to_regclass('fluid_private.portable_development_installation') is not null;");
 if(present==='f')await db.sql(bundle.sql);
 const marker=JSON.parse(await db.sql('select row_to_json(t) from fluid_private.portable_development_installation t;'));
 if(marker.project_id!==db.settings.projectId||marker.origin!=='http://127.0.0.1:'+db.settings.apiPort||marker.manifest_sha256!==bundle.manifestHash)throw new DevelopmentError('Shared development schema differs from its recorded source or target. Use a separate checkout to install a changed schema.');
 if(await db.sql(`select (select count(*)=1 and bool_and(mode='development' and origin=${q(marker.origin)}) from fluid_private.shared_http_target) and (select count(*)=1 and bool_and(origin=${q(marker.origin)}) from fluid_private.shared_storage_target);`)!=='t')throw new DevelopmentError('Shared development service targets changed.');
 await verifyDevelopmentAuthority(db,root);
 await db.sql(await composeSupplementalUpgrade(db.settings,bundle.manifestHash,root));
 const directory=path.join(db.state,'shared'); await privateDirectory(directory);
 await writeState(path.join(directory,'schema-manifest.json'),JSON.stringify({version:1,cliVersion,manifestHash:bundle.manifestHash,packets:bundle.manifest,upgrades:[SUPPLEMENTAL_PACKET]},null,2)+'\n');
 return {...db,directory};
}

export async function verifyDevelopmentAuthority(db,root=repositoryRoot) {
 const manifest=JSON.parse(await readOptional(path.join(root,'worker/shared-pool/authority-manifest.json')));
 if(manifest.version!==1||!Array.isArray(manifest.functions)||manifest.functions.length<1)throw new DevelopmentError('Shared engine authority manifest is missing.');
 const mismatch=await db.sql(`select count(*) from jsonb_array_elements(${q(JSON.stringify(manifest.functions))}::jsonb) e
 left join pg_namespace n on n.nspname=e->>'schema'
 left join pg_proc p on p.pronamespace=n.oid and p.proname=e->>'name' and oidvectortypes(p.proargtypes)=e->>'argumentTypes'
 left join pg_language l on l.oid=p.prolang
 where p.oid is null or encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') is distinct from e->>'sha256'
 or pg_get_userbyid(p.proowner) is distinct from e->>'owner'
 or p.prosecdef is distinct from (e->>'securityDefiner')::boolean or p.proleakproof is distinct from (e->>'leakproof')::boolean
 or p.provolatile::text is distinct from e->>'volatility' or l.lanname is distinct from e->>'language'
 or coalesce(to_jsonb(p.proconfig),'null'::jsonb) is distinct from e->'searchPath'
 or (exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
 or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') or has_function_privilege('service_role',p.oid,'EXECUTE')) is distinct from (e->>'broadExecute')::boolean;`);
 if(mismatch!=='0')throw new DevelopmentError('Local database does not match the shared engine’s reviewed authority manifest.');
 return manifest.functions.length;
}

const workerFunctions=lane=>['shared_worker_pool_configuration()','claim_shared_worker_slot(uuid,uuid,text,integer)','renew_shared_worker_slot(jsonb,integer)','release_shared_worker_slot(jsonb)','fence_shared_worker_slot(jsonb)','read_shared_worker_executions(jsonb)','read_shared_worker_execution_page(jsonb,uuid,integer)',`shared_${lane}_worker_action(jsonb,jsonb,text,jsonb)`,...(lane==='strategy'?['list_shared_strategy_dispatches(jsonb,integer)']:[])];
const httpFunctions=lane=>lane==='logo'?['shared_logo_http_principal()','execute_shared_logo_request(text,text,jsonb,jsonb)']:['shared_account_http_principal()',...(lane==='home'?['execute_shared_home_request(text,text,jsonb,jsonb)']:['prepare_shared_identity_request(text,uuid,jsonb,boolean)','commit_shared_identity_request(uuid,jsonb,jsonb)','finish_shared_identity_request()'])];
const password=()=>randomBytes(36).toString('base64url');

export async function provisionDevelopmentSchema(root=repositoryRoot) {
 const db=await installDevelopmentSchema(root),file=path.join(db.directory,'provisioning.json');
 const existing=await readOptional(file),suffix=db.settings.projectId.slice(-12);
 const databaseUrl=(role,secret)=>`postgresql://${role}:${secret}@127.0.0.1:${db.settings.dbPort}/postgres?sslmode=disable`;
 const target={deploymentId:db.settings.projectId,applicationOrigin:'http://127.0.0.1:'+db.settings.webPort,supabaseOrigin:'http://127.0.0.1:'+db.settings.apiPort,databaseHost:'127.0.0.1',databasePort:db.settings.dbPort};
 const data=existing?JSON.parse(existing):{version:1,target,
  slots:['strategy','naming','logo'].map(lane=>{const roleName=`embel_shared_${lane}_${suffix}`;return {slotId:randomUUID(),lane,slotIndex:1,roleName,roleOid:null,databaseUrl:databaseUrl(roleName,password())};}),
  httpPrincipals:['identity','home','logo'].map(lane=>{const roleName=`embel_shared_http_${lane}_${suffix}`;return {lane,roleName,roleOid:null,databaseUrl:databaseUrl(roleName,password())};}),
  storage:{authUserId:randomUUID(),email:`embel-logo-${suffix}@development.invalid`,password:password(),publishableKey:''}};
 if(data.version!==1||JSON.stringify(data.target)!==JSON.stringify(target)||data.slots?.length!==3||data.httpPrincipals?.length!==3)throw new DevelopmentError('Stored local principal configuration belongs to a different target.');
 // Persist before creation, so an interruption can resume the same identities.
 await writeState(file,JSON.stringify(data,null,2)+'\n');
 const statements=['begin; select pg_advisory_xact_lock(743182914);'];
 for(const principal of [...data.slots,...data.httpPrincipals]){
  const worker='slotId' in principal,lane=principal.lane,expected=worker?`embel_shared_${lane}_${suffix}`:`embel_shared_http_${lane}_${suffix}`;
  if(!['strategy','naming','logo','identity','home'].includes(lane)||principal.roleName!==expected)throw new DevelopmentError('Stored local principal identity is invalid.');
  const url=new URL(principal.databaseUrl);
  if(url.hostname!=='127.0.0.1'||url.port!==String(target.databasePort)||decodeURIComponent(url.username)!==expected||url.pathname!=='/postgres'||!/^[A-Za-z0-9_-]{48}$/.test(url.password))throw new DevelopmentError('Stored local principal credential is invalid.');
  const binding=worker?`select 1 from fluid_private.shared_worker_slots where slot_id=${q(principal.slotId)}::uuid and role_name=${q(expected)} and role_oid=(select oid from pg_roles where rolname=${q(expected)}) and lane=${q(lane)} and deployment_id=${q(target.deploymentId)}`
   :`select 1 from fluid_private.${lane==='logo'?'shared_logo_http_principals':'shared_http_principals'} where lane=${q(lane)} and role_name=${q(expected)} and role_oid=(select oid from pg_roles where rolname=${q(expected)})`;
  statements.push(`do $$ begin
   if not exists(select 1 from pg_roles where rolname=${q(expected)}) then
    create role ${expected} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4 password ${q(url.password)};
   elsif not exists(${binding}) or ${principal.roleOid===null?'false':`(select oid from pg_roles where rolname=${q(expected)})<>${Number(principal.roleOid)}`} then raise exception 'portable_principal_changed'; end if;
  end $$; grant usage on schema public to ${expected};
  grant execute on function ${(worker?workerFunctions(lane):httpFunctions(lane)).map(f=>'public.'+f).join(',')} to ${expected};`);
  if(worker)statements.push(`insert into fluid_private.shared_worker_slots(slot_id,lane,slot_index,role_name,role_oid,deployment_id,enabled,tenant_active_limit)
   select ${q(principal.slotId)}::uuid,${q(lane)},1,rolname,oid,${q(target.deploymentId)},true,1 from pg_roles where rolname=${q(expected)} on conflict(slot_id) do nothing;`);
  else statements.push(`insert into fluid_private.${lane==='logo'?'shared_logo_http_principals':'shared_http_principals'}(lane,role_name,role_oid,enabled)
   select ${q(lane)},rolname,oid,true from pg_roles where rolname=${q(expected)} on conflict(lane) do nothing;`);
 }
 statements.push(`insert into fluid_private.shared_service_actors(auth_user_id,purpose) values(${q(data.storage.authUserId)}::uuid,'logo_storage') on conflict do nothing;
 insert into fluid_private.shared_storage_actors(auth_user_id,slot_id,enabled) values(${q(data.storage.authUserId)}::uuid,${q(data.slots.find(s=>s.lane==='logo').slotId)}::uuid,true) on conflict do nothing;
 do $$ begin if not exists(select 1 from fluid_private.shared_service_actors a join fluid_private.shared_storage_actors s using(auth_user_id)
 where a.auth_user_id=${q(data.storage.authUserId)}::uuid and a.purpose='logo_storage' and s.enabled and s.slot_id=${q(data.slots.find(s=>s.lane==='logo').slotId)}::uuid)
 then raise exception 'portable_storage_actor_changed'; end if; end $$;
 commit;`);
 await db.sql(statements.join('\n'));
 const roles=JSON.parse(await db.sql(`select json_object_agg(rolname,oid) from pg_roles where rolname in(${[...data.slots,...data.httpPrincipals].map(p=>q(p.roleName)).join(',')});`));
 for(const principal of [...data.slots,...data.httpPrincipals])principal.roleOid=Number(roles[principal.roleName]);
 await writeState(file,JSON.stringify(data,null,2)+'\n');
 const status=await db.status();
 if(status.API_URL!==target.supabaseOrigin||!status.SERVICE_ROLE_KEY||!status.PUBLISHABLE_KEY)throw new DevelopmentError('Local Auth administration status is unavailable.');
 const headers={apikey:status.SERVICE_ROLE_KEY,Authorization:'Bearer '+status.SERVICE_ROLE_KEY,'Content-Type':'application/json'};
 let response=await fetch(target.supabaseOrigin+'/auth/v1/admin/users/'+data.storage.authUserId,{headers,signal:AbortSignal.timeout(10_000),redirect:'error'});
 if(response.status===404||response.status===422){
  response=await fetch(target.supabaseOrigin+'/auth/v1/admin/users',{method:'POST',headers,body:JSON.stringify({id:data.storage.authUserId,email:data.storage.email,password:data.storage.password,email_confirm:true,app_metadata:{purpose:'embel_development_logo_storage'}}),signal:AbortSignal.timeout(10_000),redirect:'error'});
 }
 if(!response.ok)throw new DevelopmentError('Local Logo service account could not be provisioned.');
 const actor=await response.json();if(actor.id!==data.storage.authUserId||actor.email!==data.storage.email||!actor.email_confirmed_at)throw new DevelopmentError('Local Logo service account differs from its expected identity.');
 data.storage.publishableKey=status.PUBLISHABLE_KEY;
 await writeState(file,JSON.stringify(data,null,2)+'\n');
 await verifyDevelopmentPrincipals(data);
 return data;
}

export async function verifyDevelopmentPrincipals(data) {
 for(const principal of [...data.slots,...data.httpPrincipals]){
  const client=new pg.Client({connectionString:principal.databaseUrl,connectionTimeoutMillis:10_000});
  try{
   await client.connect();
   const worker='slotId' in principal;
   const response=await client.query('select public.'+(worker?'shared_worker_pool_configuration()':principal.lane==='logo'?'shared_logo_http_principal()':'shared_account_http_principal()')+' as value');
   const value=response.rows[0]?.value;
   if(worker){if(value?.globalConcurrency!==data.slots.length||JSON.stringify([...value.slotIds].sort())!==JSON.stringify(data.slots.map(s=>s.slotId).sort()))throw new Error('pool differs');}
   else if(value?.lane!==principal.lane||value.roleName!==principal.roleName||value.roleOid!==principal.roleOid||value.origin!==data.target.supabaseOrigin)throw new Error('principal differs');
  }catch{throw new DevelopmentError('A local restricted principal failed real database login or authority verification.');}
  finally{await client.end().catch(()=>{});}
 }
}

// Root's model-policy composer calls this only after generating a validated
// SharedPoolConfiguration. This never creates model receipts or paid requests.
export async function installDevelopmentPolicies(configuration,root,namingFingerprint) {
 const db=await installDevelopmentSchema(root),data=JSON.parse(await readOptional(path.join(db.directory,'provisioning.json')));
 if(configuration.target.kind!=='development'||Object.entries(data.target).some(([key,value])=>configuration.target[key]!==value))throw new DevelopmentError('Development policy target differs from local provisioning.');
 if(configuration.slots.length!==data.slots.length||new Set(configuration.slots.map(s=>s.slotId)).size!==data.slots.length)throw new DevelopmentError('Development policy requires every provisioned slot exactly once.');
 const statements=['begin; select pg_advisory_xact_lock(743182914);'];
 for(const slot of configuration.slots){
  const own=data.slots.find(s=>s.slotId===slot.slotId&&s.lane===slot.lane&&s.roleOid===slot.roleOid&&s.roleName===slot.roleName);
  if(!own)throw new DevelopmentError('Development policy slot is not provisioned locally.');
  if(slot.lane==='naming'){
   const expected=q(JSON.stringify(namingFingerprint))+'::jsonb';
   statements.push(`insert into fluid_private.shared_naming_slot_configuration as cfg(slot_id,readiness_fingerprint) values(${q(slot.slotId)}::uuid,${expected})
    on conflict(slot_id) do update set readiness_fingerprint=excluded.readiness_fingerprint,ready_until=null
    where cfg.readiness_fingerprint is distinct from excluded.readiness_fingerprint;`);
  }
  for(const [operation,policy] of Object.entries(slot.policies)){
   const body=q(JSON.stringify(policy))+'::jsonb';
   const identity=slot.lane==='logo'?q(policy.policyIdentity):`encode(sha256(convert_to((${body})::text,'UTF8')),'hex')`;
   const valid=slot.lane==='strategy'?`fluid_private.api_text_guided_policy(${q(operation)},${body})`:slot.lane==='naming'?`fluid_private.naming_brain_valid_policy(${body})`
    :operation==='identity.image'?`fluid_private.shared_identity_policy_valid(${body})`:`fluid_private.shared_logo_policy_valid(${q(operation)},${body})`;
   statements.push(`do $$ begin if not coalesce(${valid},false) then raise exception 'portable_policy_unqualified'; end if; end $$;`);
   statements.push(`insert into fluid_private.shared_worker_policies(slot_id,operation,policy_identity,policy) values(${q(slot.slotId)}::uuid,${q(operation)},${identity},${body}) on conflict(slot_id,operation) do update set policy_identity=excluded.policy_identity,policy=excluded.policy;`);
  }
 }
 statements.push('commit;');await db.sql(statements.join('\n'));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const data=await provisionDevelopmentSchema();console.log(JSON.stringify({schema:'installed and verified',workers:data.slots.map(s=>s.lane),web:data.httpPrincipals.map(s=>s.lane),storage:'real local service account provisioned'}));}
 catch(error){console.error(error instanceof DevelopmentError?error.message:'Local schema provisioning failed; private diagnostics withheld.');process.exitCode=1;}
}
