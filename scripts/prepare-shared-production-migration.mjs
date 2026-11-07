/** SOURCE-ONLY handoff compiler. Never opens a DB/network connection, runs SQL,
 * reads credentials, grants access or guesses an existing installation. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const PRODUCTION_ORIGIN='https://fricsfwqibyhemknqgyf.supabase.co';
export const PACKET_NAMES=["identity_transactions.sql","shared_worker_pool.sql","shared_account_http.sql","shared_worker_strategy.sql","shared_worker_naming.sql","shared_worker_logo.sql","shared_storage_authority.sql","shared_logo_http.sql","shared_logo_advanced.sql","shared_identity_generation.sql"];
// Frozen source SHA pins are filled only after the separately owned candidates
// complete review. There is deliberately no CLI override for these hashes.
export const PACKET_SHA256=Object.freeze({
 "identity_transactions.sql": "25675c0ab7f4364ff29573caebc4a36e8b15673989ec075a72288a961db5259c",
 "shared_worker_pool.sql": "11adbf25d003088992e348c55ab895312ca465422635609db050696a26903741",
 "shared_account_http.sql": "4015fb24db184b580bd988d23257b05f9fd376e62acd6138170c70bfce68cc41",
 "shared_worker_strategy.sql": "39249deadb877322130d638c3d6c7bcb7f64bb2c7d114f322c88498134112298",
 "shared_worker_naming.sql": "29cd5b890bf3bceafbe2616206c0870f2eb5574a4bf32e88c115114485904d8e",
 "shared_worker_logo.sql": "9553738a876691842facacef389bf0615fbd53d65083cf7ed819440628a49c7e",
 "shared_storage_authority.sql": "035d81318b72c682bc0baef4fda29125a74adae343365afcb7b4022d7536cdae",
 "shared_logo_http.sql": "ac39a8de9c2b4d803f3380a5972c118040448707f317b6dc408569641bcc7d24",
 "shared_logo_advanced.sql": "e3796a279a59b866815008bb20ef3b5200248cae4d66aa2fa3f1f97609a5d4fb",
 "shared_identity_generation.sql": "a3282d7acb4a64867fa01509461fedc6f7f35079c5d8cfd1cac5bd3a9938b9f2"
});
// Additive post-install corrections run after all ten immutable shared packets.
// They never rewrite a predecessor and are not used by non-shared installers.
export const POST_INSTALL_PACKETS=Object.freeze([{name:'shared_storage_download_metadata.sql',sha256:'d7c32eff52cea335be05391ea0fdd33c8588193ad641b09cb00bf5f88d3b8cd6'},{name:'shared_logo_storage_member.sql',sha256:'6761a0c7dc7d605f20fee3233c7a50843be38b1410849efdb26806ed942f53f1'},{name:'shared_naming_brainstorm.sql',sha256:'31d008226e2dc98507ee5442966d56650930cdf4f7d9ad94ac0c4e0242c91253'},{name:'shared_naming_brainstorm_event_capacity.sql',sha256:'9e1edd20a7dffc3aeef68cc2937c8934f08552a9328a45600d1c9f3b7690e10c'},{name:'shared_logo_raster_uncapped.sql',sha256:'91d7ab31e7da04c3f7edd82b924f2330d425f55aea9126453482094c6c280798'},{name:'shared_logo_raster_recovery.sql',sha256:'d70df635c40735a584916af4f63c0a11553017fc05a9b1a3d2599da79b077ac2'},{name:'shared_identity_selected_logo_boards.sql',sha256:'45ec832fda4d5ed44f5c18ee270b73ce8def68553cb610880e7498076173495b'},{name:'shared_identity_http_writer_permissions.sql',sha256:'03b7cf1a757b21b5116f9ebcceac370df78f61c7466dde467f732400c238a618'},{name:'shared_naming_brainstorm_delivery_recovery.sql',sha256:'c1bee52bffdcc2ebd26680dfe6b553b00388e63168139ee8cd428efc36d34ab3'},{name:'shared_guided_journey_stages.sql',sha256:'8a109bad7c30b1299bd40a729e00c5f92288edbbf2dca7ab3d0de0ed8ed3e8d1'}]);
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw new Error(code);};
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";

/** Tokenize only outer SQL. Dollar bodies, quoted strings/identifiers and
 * nested comments retain their exact bytes; psql commands cannot hide outside
 * those bodies. This is intentionally not a general SQL rewriting utility. */
export function stripReviewedTransactionEnvelope(source,expectedSha){
 if(!/^[a-f0-9]{64}$/.test(expectedSha??'')||sha(source)!==expectedSha)fail('reviewed_source_hash_mismatch');
 const statements=[];let tokens=[],i=0;
 const token=(text,start,end)=>tokens.push({text,start,end});
 while(i<source.length){
  const start=i,c=source[i];
  if(/\s/.test(c)){i++;continue;}
  if(source.startsWith('--',i)){i=source.indexOf('\n',i+2);if(i<0)i=source.length;continue;}
  if(source.startsWith('/*',i)){let depth=1;i+=2;while(i<source.length&&depth){if(source.startsWith('/*',i)){depth++;i+=2;}else if(source.startsWith('*/',i)){depth--;i+=2;}else i++;}if(depth)fail('unterminated_sql_comment');continue;}
  if(c==='\\')fail('psql_meta_not_allowed');
  if(c==='\''||c==='"'){
   const escaped=c==='\''&&/[eE]/.test(source[start-1]??'')&&!/[A-Za-z0-9_$]/.test(source[start-2]??'');i++;let closed=false;
   while(i<source.length){if(escaped&&source[i]==='\\'){i+=2;continue;}if(source[i]===c){if(source[i+1]===c){i+=2;continue;}i++;closed=true;break;}i++;}
   if(!closed)fail('unterminated_sql_quote');token('quoted',start,i);continue;
  }
  const dollar=source.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
  if(dollar){const end=source.indexOf(dollar,i+dollar.length);if(end<0)fail('unterminated_sql_body');i=end+dollar.length;token('body',start,i);continue;}
  const word=source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
  if(word){i+=word.length;token(word.toLowerCase(),start,i);continue;}
  i++;if(c===';'){if(tokens.length)statements.push({tokens,end:i});tokens=[];}else token(c,start,i);
 }
 if(tokens.length||statements.length<2)fail('candidate_outer_transaction_required');
 const first=statements[0],last=statements.at(-1);
 if(first.tokens.length!==1||first.tokens[0].text!=='begin'||last.tokens.length!==1||last.tokens[0].text!=='commit')fail('candidate_outer_transaction_required');
 for(const statement of statements.slice(1,-1)){
  const words=statement.tokens.map(t=>t.text);
  if(['begin','commit','rollback','abort','end','savepoint','release','start'].includes(words[0])
   ||words[0]==='prepare'&&words[1]==='transaction'||words[0]==='set'&&['transaction','session','local'].includes(words[1])&&words.includes('transaction'))fail('nested_transaction_control_not_allowed');
 }
 return source.slice(0,first.tokens[0].start)+source.slice(first.end,last.tokens[0].start)+source.slice(last.end);
}

const identitySignatures=['fluid_private.identity_web_owner()','fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)','fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)'];
// Read only bounded catalog definitions/hashes and the known legacy service
// registry. No function execution, user content, settings, email, Auth token,
// password or secret column is read. The parent must separately correlate this
// catalog inventory to the verified production project/connection.
const legacyProof=`jsonb_build_array(b.auth_user_id,b.owner_id,b.role_name,b.role_oid::bigint,b.worker_id,b.enabled,
 p.role_name,p.role_oid::bigint,p.owner_id,r.rolname,r.oid::bigint,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,u.is_anonymous,
 (select coalesce(jsonb_agg(jsonb_build_array(member::bigint,roleid::bigint,admin_option,inherit_option,set_option) order by member,roleid),'[]'::jsonb) from pg_catalog.pg_auth_members where member=r.oid))`;
const helperAuthority=`(select encode(sha256(convert_to(coalesce(jsonb_agg(value order by value::text),'[]'::jsonb)::text,'UTF8')),'hex') from (
 select jsonb_build_array('relation',n.nspname,c.relname,a.privilege_type,a.is_grantable) value from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a where a.grantee=to_regrole('fluid_identity_writer_definer_v1')::oid
 union all select jsonb_build_array('column',n.nspname,c.relname,col.attname,a.privilege_type,a.is_grantable) from pg_catalog.pg_attribute col join pg_catalog.pg_class c on c.oid=col.attrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace cross join lateral pg_catalog.aclexplode(col.attacl) a where a.grantee=to_regrole('fluid_identity_writer_definer_v1')::oid
 union all select jsonb_build_array('schema',n.nspname,a.privilege_type,a.is_grantable) from pg_catalog.pg_namespace n cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a where a.grantee=to_regrole('fluid_identity_writer_definer_v1')::oid
 union all select jsonb_build_array('function',n.nspname,p.proname,(select jsonb_agg(jsonb_build_array(tn.nspname,t.typname) order by args.ordinality) from unnest(p.proargtypes) with ordinality args(typeid,ordinality) join pg_catalog.pg_type t on t.oid=args.typeid join pg_catalog.pg_namespace tn on tn.oid=t.typnamespace),a.privilege_type,a.is_grantable) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where a.grantee=to_regrole('fluid_identity_writer_definer_v1')::oid
 union all select jsonb_build_array('database',d.datname,a.privilege_type,a.is_grantable) from pg_catalog.pg_database d cross join lateral pg_catalog.aclexplode(coalesce(d.datacl,pg_catalog.acldefault('d',d.datdba))) a where d.datname=current_database() and a.grantee=to_regrole('fluid_identity_writer_definer_v1')::oid
 union all select jsonb_build_array('policy',n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,pg_catalog.pg_get_expr(p.polqual,p.polrelid),pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where to_regrole('fluid_identity_writer_definer_v1')::oid=any(p.polroles)
) authority)`;
export const INVENTORY_EXPRESSION=`jsonb_build_object(
 'version',1,
 'database',jsonb_build_object('name',current_database(),'oid',(select oid::bigint from pg_catalog.pg_database where datname=current_database()),'serverVersion',current_setting('server_version_num')::integer,'currentUser',current_user,'sessionUser',session_user),
 'sharedObjects',(select coalesce(jsonb_agg(value order by value::text),'[]'::jsonb) from (select value from (
  select jsonb_build_array('relation',n.nspname,c.relname) value from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','fluid_private') and left(c.relname,7)='shared_'
  union all select jsonb_build_array('function',n.nspname,p.proname,pg_catalog.oidvectortypes(p.proargtypes)) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','fluid_private') and (left(p.proname,7)='shared_' or p.proname in('refresh_shared_account','get_shared_account_enrollment','ensure_shared_account_enrollment','issue_shared_account_request','prepare_shared_identity_request','commit_shared_identity_request','finish_shared_identity_request','execute_shared_home_request','issue_shared_logo_request','execute_shared_logo_request','authorize_shared_logo_storage'))
  union all select jsonb_build_array('policy',n.nspname,c.relname,p.polname) from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where left(p.polname,12)='embel_shared'
 ) all_objects order by value::text limit 257) objects),
 'identity',jsonb_build_object(
  'relationPresent',to_regclass('fluid_private.identity_web_principals') is not null,
  'functions',(select coalesce(jsonb_agg(jsonb_build_object('signature',signature,'sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_catalog.pg_get_userbyid(p.proowner),'definer',p.prosecdef,'language',l.lanname,'volatility',p.provolatile::text,'safePath',p.proconfig=array['search_path=""'] and not p.proleakproof,'noPublicExecute',not exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')) order by signature),'[]'::jsonb)
   from unnest(array[${identitySignatures.map(quote).join(',')}]) signature join pg_catalog.pg_proc p on p.oid=to_regprocedure(signature) join pg_catalog.pg_language l on l.oid=p.prolang),
  'columns',(select coalesce(jsonb_agg(jsonb_build_array(a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull) order by a.attnum),'[]'::jsonb) from pg_catalog.pg_attribute a where a.attrelid=to_regclass('fluid_private.identity_web_principals') and a.attnum>0 and not a.attisdropped),
  'relationQualified',exists(select 1 from pg_catalog.pg_class c where c.oid=to_regclass('fluid_private.identity_web_principals') and c.relowner=to_regrole('postgres')::oid and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity),
  'constraints',(select coalesce(jsonb_agg(pg_catalog.pg_get_constraintdef(oid) order by pg_catalog.pg_get_constraintdef(oid)),'[]'::jsonb) from pg_catalog.pg_constraint where conrelid=to_regclass('fluid_private.identity_web_principals') and contype in('p','u','f','c','x')),
  'tableAclSafe',not exists(select 1 from pg_catalog.pg_class c cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a where c.oid=to_regclass('fluid_private.identity_web_principals') and a.grantee<>c.relowner and not(a.grantee=to_regrole('fluid_identity_writer_definer_v1')::oid and a.privilege_type='SELECT' and not a.is_grantable)),
  'helperAuthoritySha256',${helperAuthority},
  'helperQualified',exists(select 1 from pg_catalog.pg_roles r where r.rolname='fluid_identity_writer_definer_v1' and not r.rolcanlogin and not r.rolinherit and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not r.rolbypassrls
    and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid or m.roleid=r.oid and not(m.member=to_regrole('postgres')::oid and m.admin_option and not m.inherit_option and not m.set_option)))
 ),
 'legacyActors',(select coalesce(jsonb_agg(jsonb_build_object('authUserId',b.auth_user_id,'proofSha256',encode(sha256(convert_to(${legacyProof}::text,'UTF8')),'hex'),
  'qualified',p.role_name is not null and r.oid is not null and u.id is not null and b.auth_user_id<>b.owner_id and u.is_anonymous=false and not r.rolinherit and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not r.rolbypassrls and not exists(select 1 from pg_catalog.pg_auth_members where member=r.oid)) order by b.auth_user_id),'[]'::jsonb)
  from (select * from fluid_private.logo_storage_principals order by auth_user_id limit 129) b left join fluid_private.logo_worker_principals p on p.role_name=b.role_name and p.role_oid=b.role_oid and p.owner_id=b.owner_id
  left join pg_catalog.pg_roles r on r.oid=b.role_oid and r.rolname=b.role_name left join auth.users u on u.id=b.auth_user_id)
)`;
export const READ_ONLY_INVENTORY_SQL=`-- Run only through the already verified frics project read connector.\n-- Metadata only; no user content, passwords, settings or token values.\nSELECT ${INVENTORY_EXPRESSION} AS inventory;\n`;
const prerequisiteSignatures=[...new Set(PACKET_NAMES.flatMap(name=>[...readFileSync(new URL('../supabase/candidates/'+name,import.meta.url),'utf8').matchAll(/'((?:fluid_private|public)\.[a-z0-9_]+\([a-z0-9_., \[\]]*\))'/g)].map(match=>match[1]).filter(signature=>!signature.includes('shared'))))].sort();
if(prerequisiteSignatures.length>256)fail('prerequisite_inventory_bound_exceeded');
const prerequisiteNames=[...new Set(prerequisiteSignatures.map(signature=>signature.slice(0,signature.indexOf('('))))];
const identityPredecessorRelations=['asset_usages','asset_versions','assets','identity_batches','identity_component_changes','identity_generated_roots','identity_input_snapshots','identity_preferences','identity_reference_heads','identity_reference_reactions','identity_reference_snapshots','identity_references','identity_selections','identity_sessions','identity_system_files','identity_system_versions','job_steps','jobs','project_revisions','projects'];
export const READ_ONLY_PREREQUISITE_SQL=`-- Bounded predecessor definitions/hashes only; never executes a candidate helper.\nSELECT jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',name,'argumentTypes',pg_catalog.oidvectortypes(p.proargtypes),'present',p.oid IS NOT NULL,'sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_catalog.pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile,'language',l.lanname,'emptySearchPath',p.proconfig=ARRAY['search_path=""'],'configurationEntries',coalesce(cardinality(p.proconfig),0),'leakproof',p.proleakproof) ORDER BY name,p.oid) FROM unnest(ARRAY[${prerequisiteNames.map(quote).join(',')}]) name LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=split_part(name,'.',1) LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace=n.oid AND p.proname=split_part(name,'.',2) LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang),
 'relations',(SELECT jsonb_agg(jsonb_build_object('relation',name,'present',c.oid IS NOT NULL,'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forcedRls',c.relforcerowsecurity,'primaryKey',EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype='p'),
  'shapeSha256',encode(sha256(convert_to((SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated) ORDER BY a.attnum)::text FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'UTF8')),'hex')) ORDER BY name) FROM unnest(ARRAY[${identityPredecessorRelations.map(quote).join(',')}]) name LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public' LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=name)
) AS prerequisites;\n`;

function strictKeys(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('inventory_schema_unqualified');}
export function composeSharedProductionMigration(input){
 strictKeys(input,['target','catalog']);strictKeys(input.target,['projectRef','origin','issuer']);
 if(input.target.projectRef!=='fricsfwqibyhemknqgyf'||input.target.origin!==PRODUCTION_ORIGIN||input.target.issuer!==PRODUCTION_ORIGIN+'/auth/v1')fail('production_target_unqualified');
 const catalog=input.catalog;strictKeys(catalog,['version','database','sharedObjects','identity','legacyActors']);
 if(catalog.version!==1||!Array.isArray(catalog.sharedObjects)||catalog.sharedObjects.length||!Array.isArray(catalog.legacyActors)||catalog.legacyActors.length>128)fail('existing_shared_install_unknown');
 strictKeys(catalog.database,['name','oid','serverVersion','currentUser','sessionUser']);
 if(catalog.database.name!=='postgres'||!Number.isSafeInteger(catalog.database.oid)||catalog.database.oid<1||catalog.database.currentUser!=='postgres'||catalog.database.sessionUser!=='postgres'||!Number.isInteger(catalog.database.serverVersion)||catalog.database.serverVersion<170000||catalog.database.serverVersion>=190000)fail('catalog_installer_unqualified');
 for(const actor of catalog.legacyActors){strictKeys(actor,['authUserId','proofSha256','qualified']);if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(actor.authUserId)||!/^[a-f0-9]{64}$/.test(actor.proofSha256)||actor.qualified!==true)fail('legacy_actor_proof_unqualified');}
 if(new Set(catalog.legacyActors.map(a=>a.authUserId)).size!==catalog.legacyActors.length)fail('duplicate_legacy_actor');
 const sources=Object.fromEntries(PACKET_NAMES.map(name=>[name,readFileSync(new URL('../supabase/candidates/'+name,import.meta.url),'utf8')]));
 const bodies=Object.fromEntries(PACKET_NAMES.map(name=>[name,stripReviewedTransactionEnvelope(sources[name],PACKET_SHA256[name])]));
 const identity=catalog.identity;strictKeys(identity,['relationPresent','functions','columns','relationQualified','helperQualified','helperAuthoritySha256','constraints','tableAclSafe']);
 if(!Array.isArray(identity.functions)||!Array.isArray(identity.columns))fail('identity_boundary_unknown');
 for(const row of identity.functions){strictKeys(row,['signature','sha256','owner','definer','language','volatility','safePath','noPublicExecute']);if(!identitySignatures.includes(row.signature)||!/^[a-f0-9]{64}$/.test(row.sha256))fail('identity_boundary_unknown');}
 if(!/^[a-f0-9]{64}$/.test(identity.helperAuthoritySha256)||!Array.isArray(identity.constraints)||![identity.relationPresent,identity.relationQualified,identity.helperQualified,identity.tableAclSafe].every(v=>typeof v==='boolean'))fail('identity_boundary_unknown');
 const absent=identity.relationPresent===false&&identity.relationQualified===false&&identity.functions.length===0&&identity.columns.length===0&&identity.constraints.length===0&&identity.tableAclSafe===true;
 // Source-only v1 deliberately supports only the fully absent reviewed packet
 // set. An installed Identity prefix needs equivalence of ALL its predecessor
 // policy/ACL guards; partial hashes cannot establish that, so do not skip it.
 if(!absent)fail('existing_identity_requires_reviewed_complete_catalog_proof');
 const selected=PACKET_NAMES;
 const actorIds=catalog.legacyActors.map(actor=>actor.authUserId);
 const classification=actorIds.length?`INSERT INTO fluid_private.shared_service_actors(auth_user_id,purpose) SELECT b.auth_user_id,'legacy_logo_storage' FROM fluid_private.logo_storage_principals b WHERE b.auth_user_id=ANY(ARRAY[${actorIds.map(quote).join(',')}]::uuid[]);\n`:'';
 const parts=[`-- Reviewed shared production handoff; source compilation only.\nBEGIN;\nSET LOCAL search_path='';\nDO $shared_inventory_guard$ BEGIN\n IF (${INVENTORY_EXPRESSION}) IS DISTINCT FROM ${quote(JSON.stringify(catalog))}::jsonb THEN RAISE EXCEPTION 'shared_production_inventory_changed' USING ERRCODE='55000'; END IF;\nEND $shared_inventory_guard$;\n`];
 for(const name of selected){parts.push(`\n-- SOURCE ${name} SHA256 ${PACKET_SHA256[name]}\n${bodies[name]}\n`);
  if(name==='shared_worker_pool.sql')parts.push(classification);
  if(name==='shared_account_http.sql')parts.push(`INSERT INTO fluid_private.shared_http_target(singleton,mode,origin) VALUES(true,'hosted',${quote(PRODUCTION_ORIGIN)});\n`);
  if(name==='shared_storage_authority.sql')parts.push(`INSERT INTO fluid_private.shared_storage_target(singleton,origin) VALUES(true,${quote(PRODUCTION_ORIGIN)});\n`);
 }
 for(const packet of POST_INSTALL_PACKETS){
  const source=readFileSync(new URL('../supabase/candidates/'+packet.name,import.meta.url),'utf8');
  parts.push(`\n-- POST-INSTALL ${packet.name} SHA256 ${packet.sha256}\n${stripReviewedTransactionEnvelope(source,packet.sha256)}\n`);
 }
 parts.push(`DO $shared_final_guard$ BEGIN\n IF NOT EXISTS(SELECT 1 FROM fluid_private.shared_http_target WHERE singleton AND mode='hosted' AND origin=${quote(PRODUCTION_ORIGIN)}) OR NOT EXISTS(SELECT 1 FROM fluid_private.shared_storage_target WHERE singleton AND origin=${quote(PRODUCTION_ORIGIN)}) THEN RAISE EXCEPTION 'shared_production_issuer_missing' USING ERRCODE='55000'; END IF;\n IF EXISTS(SELECT 1 FROM fluid_private.logo_storage_principals b LEFT JOIN fluid_private.shared_service_actors s ON s.auth_user_id=b.auth_user_id WHERE s.purpose IS DISTINCT FROM 'legacy_logo_storage') THEN RAISE EXCEPTION 'shared_production_legacy_actor_missing' USING ERRCODE='55000'; END IF;\nEND $shared_final_guard$;\nCOMMIT;\n`);
 const sql=parts.join('');return Object.freeze({sql,sha256:sha(sql),packets:selected,sourceHashes:PACKET_SHA256,postInstallPackets:POST_INSTALL_PACKETS,target:PRODUCTION_ORIGIN,requiresReviewedConnection:true});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2);if(args.length===1&&args[0]==='--inventory-sql')process.stdout.write(READ_ONLY_INVENTORY_SQL);
  else if(args.length===1&&args[0]==='--prerequisite-sql')process.stdout.write(READ_ONLY_PREREQUISITE_SQL);
  else if(args.length===4&&args[0]==='--inventory'&&args[2]==='--output'){
   const result=composeSharedProductionMigration(JSON.parse(readFileSync(args[1],'utf8')));writeFileSync(args[3],result.sql,{flag:'wx',mode:0o600});
   console.log(JSON.stringify({prepared:true,sha256:result.sha256,packets:result.packets,postInstallPackets:result.postInstallPackets,target:result.target,executed:false}));
  }else fail('usage_inventory_sql_or_inventory_output');
 }catch(error){console.error(JSON.stringify({prepared:false,code:/^[a-z0-9_]+$/.test(error?.message??'')?error.message:'production_composer_unavailable',executed:false}));process.exitCode=1;}
}
