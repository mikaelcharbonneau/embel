import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { cliVersion, DevelopmentError, localDockerEnvironment, migrationSources, privateDirectory, readOptional, repositoryRoot, settingsFor, writeState } from './config.mjs';
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

/** `migrationsBefore` (a version) checks only the migrations before it: the shared packets
 * are installed at that point of a new database's history. */
export async function developmentDatabase(root=repositoryRoot,{migrationsBefore}={}) {
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
 const migrations=(await migrationSources(root)).filter(m=>!migrationsBefore||m.staged.slice(0,14)<migrationsBefore);
 if(JSON.stringify(installed)!==JSON.stringify(migrations.map(m=>m.staged.slice(0,14))))throw new DevelopmentError('Local baseline migration history differs from this checkout.');
 const status=async()=>JSON.parse(await command(process.execPath,[path.join(root,'node_modules/supabase/dist/supabase.js'),'status','--output','json','--workdir',state],{...environment,SUPABASE_HOME:path.join(state,'cli-home'),SUPABASE_TELEMETRY_DISABLED:'1'}));
 return {settings,state,sql,status};
}

export async function installDevelopmentSchema(root=repositoryRoot,options={}) {
 const db=await developmentDatabase(root,options),bundle=await composeDevelopmentSchema(db.settings,root);
 const present=await db.sql("select to_regclass('fluid_private.portable_development_installation') is not null;");
 if(present==='f')await db.sql(bundle.sql);
 const marker=JSON.parse(await db.sql('select row_to_json(t) from fluid_private.portable_development_installation t;'));
 if(marker.project_id!==db.settings.projectId||marker.origin!=='http://127.0.0.1:'+db.settings.apiPort||marker.manifest_sha256!==bundle.manifestHash)throw new DevelopmentError('Shared development schema differs from its recorded source or target. Use a separate checkout to install a changed schema.');
 if(await db.sql(`select count(*)=1 and bool_and(mode='development' and origin=${q(marker.origin)}) from fluid_private.shared_http_target;`)!=='t')throw new DevelopmentError('Shared development service target changed.');
 await verifyDevelopmentAuthority(db,root);
 const directory=path.join(db.state,'shared'); await privateDirectory(directory);
 await writeState(path.join(directory,'schema-manifest.json'),JSON.stringify({version:1,cliVersion,manifestHash:bundle.manifestHash,packets:bundle.manifest,upgrades:[]},null,2)+'\n');
 return {...db,directory};
}

export async function verifyDevelopmentAuthority(db,root=repositoryRoot) {
 const manifest=JSON.parse(await readOptional(path.join(root,'scripts/development/shared-authority-manifest.json')));
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

const httpFunctions=lane=>lane==='logo'?['shared_logo_http_principal()','execute_shared_logo_request(text,text,jsonb,jsonb)']:['shared_account_http_principal()',...(lane==='home'?['execute_shared_home_request(text,text,jsonb,jsonb)']:['prepare_shared_identity_request(text,uuid,jsonb,boolean)','commit_shared_identity_request(uuid,jsonb,jsonb)','finish_shared_identity_request()'])];
const password=()=>randomBytes(36).toString('base64url');

/** The web lanes' three restricted logins (Home attachments, Creative direction
 * writes, Logo uploads), like production. Version 1 files also listed the old
 * worker slots and their Storage account; those were retired with the workers. */
export async function provisionDevelopmentSchema(root=repositoryRoot) {
 const db=await installDevelopmentSchema(root),file=path.join(db.directory,'provisioning.json');
 const existing=await readOptional(file),suffix=db.settings.projectId.slice(-12);
 const databaseUrl=(role,secret)=>`postgresql://${role}:${secret}@127.0.0.1:${db.settings.dbPort}/postgres?sslmode=disable`;
 const target={deploymentId:db.settings.projectId,applicationOrigin:'http://127.0.0.1:'+db.settings.webPort,supabaseOrigin:'http://127.0.0.1:'+db.settings.apiPort,databaseHost:'127.0.0.1',databasePort:db.settings.dbPort};
 const stored=existing?JSON.parse(existing):null;
 const data=stored?{version:2,target:stored.target,httpPrincipals:stored.httpPrincipals}:{version:2,target,
  httpPrincipals:['identity','home','logo'].map(lane=>{const roleName=`embel_shared_http_${lane}_${suffix}`;return {lane,roleName,roleOid:null,databaseUrl:databaseUrl(roleName,password())};})};
 if(stored&&![1,2].includes(stored.version)||JSON.stringify(data.target)!==JSON.stringify(target)||data.httpPrincipals?.length!==3)throw new DevelopmentError('Stored local principal configuration belongs to a different target.');
 // Persist before creation, so an interruption can resume the same identities.
 await writeState(file,JSON.stringify(data,null,2)+'\n');
 const statements=['begin; select pg_advisory_xact_lock(743182914);'];
 for(const principal of data.httpPrincipals){
  const lane=principal.lane,expected=`embel_shared_http_${lane}_${suffix}`;
  if(!['identity','home','logo'].includes(lane)||principal.roleName!==expected)throw new DevelopmentError('Stored local principal identity is invalid.');
  const url=new URL(principal.databaseUrl);
  if(url.hostname!=='127.0.0.1'||url.port!==String(target.databasePort)||decodeURIComponent(url.username)!==expected||url.pathname!=='/postgres'||!/^[A-Za-z0-9_-]{48}$/.test(url.password))throw new DevelopmentError('Stored local principal credential is invalid.');
  const registry=lane==='logo'?'shared_logo_http_principals':'shared_http_principals';
  const binding=`select 1 from fluid_private.${registry} where lane=${q(lane)} and role_name=${q(expected)} and role_oid=(select oid from pg_roles where rolname=${q(expected)})`;
  statements.push(`do $$ begin
   if not exists(select 1 from pg_roles where rolname=${q(expected)}) then
    create role ${expected} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4 password ${q(url.password)};
   elsif not exists(${binding}) or ${principal.roleOid===null?'false':`(select oid from pg_roles where rolname=${q(expected)})<>${Number(principal.roleOid)}`} then raise exception 'portable_principal_changed'; end if;
  end $$; grant usage on schema public to ${expected};
  grant execute on function ${httpFunctions(lane).map(f=>'public.'+f).join(',')} to ${expected};`);
  statements.push(`insert into fluid_private.${registry}(lane,role_name,role_oid,enabled)
   select ${q(lane)},rolname,oid,true from pg_roles where rolname=${q(expected)} on conflict(lane) do nothing;`);
 }
 statements.push('commit;');
 await db.sql(statements.join('\n'));
 const roles=JSON.parse(await db.sql(`select json_object_agg(rolname,oid) from pg_roles where rolname in(${data.httpPrincipals.map(p=>q(p.roleName)).join(',')});`));
 for(const principal of data.httpPrincipals)principal.roleOid=Number(roles[principal.roleName]);
 await writeState(file,JSON.stringify(data,null,2)+'\n');
 await verifyDevelopmentPrincipals(data);
 return data;
}

export async function verifyDevelopmentPrincipals(data) {
 for(const principal of data.httpPrincipals){
  const client=new pg.Client({connectionString:principal.databaseUrl,connectionTimeoutMillis:10_000});
  try{
   await client.connect();
   const response=await client.query('select public.'+(principal.lane==='logo'?'shared_logo_http_principal()':'shared_account_http_principal()')+' as value');
   const value=response.rows[0]?.value;
   if(value?.lane!==principal.lane||value.roleName!==principal.roleName||value.roleOid!==principal.roleOid||value.origin!==data.target.supabaseOrigin)throw new Error('principal differs');
  }catch{throw new DevelopmentError('A local restricted principal failed real database login or authority verification.');}
  finally{await client.end().catch(()=>{});}
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const data=await provisionDevelopmentSchema();console.log(JSON.stringify({schema:'installed and verified',web:data.httpPrincipals.map(s=>s.lane)}));}
 catch(error){console.error(error instanceof DevelopmentError?error.message:'Local schema provisioning failed; private diagnostics withheld.');process.exitCode=1;}
}
