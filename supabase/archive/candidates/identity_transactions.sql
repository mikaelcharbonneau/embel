-- UNAPPLIED production Identity transaction helper packet. PostgreSQL 17/18 catalog contract.
-- Installs reviewed exact helper bodies and a restricted NOLOGIN owner only.
-- No login, password, account, owner binding, provider call or runtime factory
-- activation. Fresh signatures/table are required; unknown predecessors stop.
begin;
set local search_path='';
do $guard$
declare item record; actual_hash text; helper pg_catalog.pg_roles;
begin
 if current_user<>'postgres' or session_user<>current_user or current_setting('server_version_num')::integer not between 170000 and 189999
  or not exists(select 1 from pg_roles where rolname=current_user and (rolcreaterole or rolsuper))
  or not exists(select 1 from pg_namespace where nspname='fluid_private' and nspowner=to_regrole('postgres')::oid)
  then raise exception 'identity_transaction_reviewed_installer_required' using errcode='42501'; end if;
 if to_regclass('fluid_private.identity_web_principals') is not null or to_regprocedure('fluid_private.identity_web_owner()') is not null
  or to_regprocedure('fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)') is not null
  or to_regprocedure('fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)') is not null
  then raise exception 'identity_transaction_unknown_existing_boundary' using errcode='55000'; end if;
 for item in select * from(values
  ('asset_usages','d690a4871929d64c1a09bd03e56b7038611cefd9f2ac0f03976594778ad12eab'),
  ('asset_versions','b620dcd68b7122e205368067e9ebf25d79af9043bedcb2d34d95d3884e0973cf'),
  ('assets','7b582e41e1227ea776a52c7cad66cf2fae36c6da87f20db5ffbab412969b7ed8'),
  ('identity_batches','f7e5305a3887be2bbf56815f366f76739d0760699e53b7daf480ead71bc6496b'),
  ('identity_component_changes','ff0de88505958141b00f472664b873a0e7e739bc7f17890369e29bcde11a326c'),
  ('identity_generated_roots','1ce324312fe05d2ba48856fdcb08e9e72b3c631c8afbc722e1b753ccab7b1806'),
  ('identity_input_snapshots','bbab103d11c649ef7a6416de237a75e84032bc5a9576de81b9d8f4f7049f697d'),
  ('identity_preferences','0afdb80bb8210094468a0b76cdf918bf5a07a3f4b34ec1ea8e599efa4fb5fca6'),
  ('identity_reference_heads','8d78ce90254f111317ad51e9bea1f13c3ca2ffcae559d9ecee9c7b4c46608ddc'),
  ('identity_reference_reactions','f249b1e54f84560a5898c57d0321dfe5f07793efc0b22c409840ed81db8c11be'),
  ('identity_reference_snapshots','b36f68aca07675f1d6f4470502eaf91c4335ad82263aae49a3ee6444556b785a'),
  ('identity_references','968967dd25ead337fa4d02794c64ad91618f54c9366d128c3b01c66768d2e795'),
  ('identity_selections','0522fbd68595aff5b9e7eb4598a831c193243edc53d0e605fcdab50ce708a577'),
  ('identity_sessions','7049dbdf2fd89e923247814b871f04001084bcb9d237b2bbd83f7122b329e047'),
  ('identity_system_files','2c6f121299ba5a41a4d34d963fda0724b5a633dc3f0534c5738b2fda808692d6'),
  ('identity_system_versions','129b8d88dfc7304564cf9e77afc22f601729fc40308f0436d92636e8e0e4bdae'),
  ('job_steps','6f9e1971d5b4fa1ec2f49aaf25754ee2e5036fa937d89c4b9dd315e5073335f3'),
  ('jobs','b9366458eb6fc249a183d474c1e5fe0b41b9e8e521546cbe2465a5353c09e87f'),
  ('project_revisions','37293aabd790ff264d768e2836ce15a87fdd23eb3a13c32e054df0022c708775'),
  ('projects','ed15c201cb9b85b517d30edbd99e9d6de40ddffd62fe57d0790ceb2ae0db49da')
 ) expected(relation_name,shape_hash) loop
  select encode(sha256(convert_to((select jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated) order by a.attnum)::text
   from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),'UTF8')),'hex') into actual_hash
   from pg_class c where c.oid=to_regclass('public.'||item.relation_name) and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity
    and c.relowner=to_regrole('postgres')::oid and exists(select 1 from pg_constraint where conrelid=c.oid and contype='p')
    and not exists(select 1 from pg_policy policy where policy.polrelid=c.oid and 0::oid=any(policy.polroles) and not(
     c.relname='job_steps' and policy.polcmd='r' and policy.polpermissive and policy.polwithcheck is null
     and (policy.polname='subscription_worker_step_read' and pg_get_expr(policy.polqual,policy.polrelid)='public.subscription_worker_can_read_step(job_id, owner_id)'
      or policy.polname='api_text_worker_step_read' and pg_get_expr(policy.polqual,policy.polrelid)='public.api_text_worker_can_read_step(job_id, owner_id)')));
  if actual_hash is distinct from item.shape_hash then raise exception 'identity_transaction_relation_predecessor_unqualified' using errcode='55000'; end if;
 end loop;
 for item in select * from(values
  ('fluid_private.asset_library_project(public.projects)','2686dfdd01bbb151ee8b3ebfb828ad7cb5f899a1b0a51f9a7faba71a2b6559e1',false,'s','sql'),
  ('fluid_private.identity_change_json(public.identity_component_changes)','3d3aecb2c88d8f21233eb674a9c40eb2f11855084bec26e5be1b6da1abed69e9',false,'s','sql'),
  ('fluid_private.identity_preferences_json(public.identity_preferences)','cff93f97bd22fbd02d34d44fc0a50facd446d269c375374b08e6045a3182dda7',false,'s','sql'),
  ('fluid_private.identity_reference_entry(uuid,uuid,uuid)','71b1fbf91c17d19a138ba83e053dd538b7d474fe8f36906734152469f2d42081',false,'s','sql'),
  ('fluid_private.identity_selection_json(public.identity_selections)','d9cd3344a97e04d32663ac032e49e62c2afbbc6df57c7499088531e908a7763d',false,'s','sql'),
  ('fluid_private.identity_session_json(public.identity_sessions)','bf2f9935679a9b1311e917cd17448ba3321f3dbb7f87fdaf9c379e02f627cc90',false,'s','sql'),
  ('fluid_private.identity_system_json(public.identity_system_versions)','0931335426cccb9196386443a07ed2ec8221617972b75f941d32226b1220e66c',false,'s','sql'),
  ('fluid_private.identity_time_key(text)','cb76330a4cecd8149ad929e5684134fee37adf4c250fd3d57390ff4ac531b31a',false,'i','plpgsql'),
  ('public.api_text_worker_can_read_step(uuid,uuid)','866bcae2b61ca9b16395ce81b7f7e74f1a0a6ad683564e2ac6315bc29e02d575',true,'s','sql'),
  ('public.api_text_worker_owner()','93b39417918c0dedbe60331922e3b2184ff55fe91fb3f16ce692ea92334a8f73',true,'s','sql'),
  ('public.subscription_worker_can_read_step(uuid,uuid)','ac0412038414c8cb9599e5649a9a59e733e2c7ca4f87670aa406b9fdb3f276d0',true,'s','plpgsql'),
  ('public.subscription_worker_owner()','8865deffd4aeecabec93b93a8622f3381de46967f3c0bb04d0ef97db895185e4',true,'s','sql')
 ) expected(signature,body_hash,definer,volatility,language_name) loop
  if not exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure(item.signature)
   and p.proowner=to_regrole('postgres')::oid and p.prosecdef=item.definer and p.provolatile::text=item.volatility
   and l.lanname=item.language_name and p.proconfig=array['search_path=""'] and not p.proleakproof
   and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=item.body_hash)
   then raise exception 'identity_transaction_function_predecessor_unqualified' using errcode='55000'; end if;
 end loop;
 select * into helper from pg_roles where rolname='fluid_identity_writer_definer_v1';
 if helper.oid is not null and (helper.rolcanlogin or helper.rolinherit or helper.rolsuper or helper.rolcreatedb or helper.rolcreaterole or helper.rolreplication or helper.rolbypassrls
  or exists(select 1 from pg_auth_members where member=helper.oid)
  or exists(select 1 from pg_auth_members where roleid=helper.oid and not(member=to_regrole('postgres')::oid and admin_option and not inherit_option and not set_option))
  or (select count(*) from pg_auth_members where roleid=helper.oid)>1
  or exists(select 1 from pg_class where relowner=helper.oid) or exists(select 1 from pg_namespace where nspowner=helper.oid)
  or exists(select 1 from pg_proc where proowner=helper.oid)
  or has_schema_privilege(helper.oid,'public','CREATE') or has_schema_privilege(helper.oid,'fluid_private','CREATE')
  or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','fluid_private','auth','storage') and c.relkind in('r','p','v','m','f')
   and (has_any_column_privilege(helper.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') or has_table_privilege(helper.oid,c.oid,'DELETE,TRUNCATE,TRIGGER'))))
  then raise exception 'identity_transaction_helper_principal_unqualified' using errcode='55000'; end if;
 if helper.oid is null then execute 'create role fluid_identity_writer_definer_v1 nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls'; end if;
end $guard$;

create table fluid_private.identity_web_principals (
 login_role_oid oid primary key, login_role_name name unique not null, owner_id uuid unique not null
);
revoke all on fluid_private.identity_web_principals from public;
create function fluid_private.identity_web_owner() returns uuid
language plpgsql stable security invoker set search_path='' as $$
declare principal pg_catalog.pg_roles; owner uuid;
begin
 select * into principal from pg_catalog.pg_roles where rolname=session_user;
 if principal.oid is null or not principal.rolcanlogin or principal.rolsuper or principal.rolinherit
  or principal.rolcreatedb or principal.rolcreaterole or principal.rolreplication or principal.rolbypassrls
  or exists(select 1 from pg_catalog.pg_auth_members where member=principal.oid)
 then raise exception 'invalid_identity_login' using errcode='42501'; end if;
 select p.owner_id into owner from fluid_private.identity_web_principals p
 where p.login_role_oid=principal.oid and p.login_role_name=session_user;
 if owner is null then raise exception 'unbound_identity_login' using errcode='42501'; end if;
 return owner;
end $$;
create function fluid_private.prepare_identity_transaction(p_project uuid,p_request jsonb,p_refinement boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_owner uuid:=fluid_private.identity_web_owner(); v_role oid:=pg_catalog.to_regrole(session_user)::oid;
 v_relation oid; v_target uuid; v_ids uuid[]; v_jobs uuid[]; v_assets uuid[]; v_output_assets uuid[]:='{}';
 v_project public.projects; v_head public.identity_reference_heads; v_session public.identity_sessions;
 v_preferences public.identity_preferences; v_replay public.identity_component_changes;
 v_row public.identity_system_versions; v_base public.identity_system_versions; v_root public.identity_generated_roots;
 v_batch public.identity_batches; v_job public.jobs; v_step public.job_steps; v_input public.identity_input_snapshots;
 v_change public.identity_component_changes; v_selection public.identity_selections;
 v_now timestamptz:=pg_catalog.clock_timestamp(); v_id uuid; v_walk uuid; v_seen uuid[]; v_key text; v_counter numeric;
 v_system jsonb; v_files jsonb; v_file jsonb; v_asset jsonb; v_output jsonb; v_manifest jsonb; v_stale jsonb;
 v_context jsonb; v_reference jsonb; v_selected jsonb; v_old_snapshot jsonb; v_preference_value jsonb; v_component text;
 v_records jsonb:='[]'; v_roots jsonb:='[]'; v_sources jsonb:='[]'; v_proof_files jsonb:='[]'; v_batches jsonb;
 v_dto jsonb; v_frozen jsonb; v_reason text; v_changed jsonb; v_previous jsonb;
begin
 if pg_catalog.current_setting('request.jwt.claim.sub',true) is distinct from v_owner::text then
  raise exception 'identity_claim_mismatch' using errcode='42501'; end if;
 if p_refinement is null or pg_catalog.jsonb_typeof(p_request) is distinct from 'object' or pg_catalog.octet_length(p_request::text)>32768
  or not(p_request ?& (case when p_refinement then array['baseSystemVersionId','component','input','idempotencyKey','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','acceptEarlierBasis']
   else array['systemVersionId','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','acceptEarlierBasis'] end))
  or p_request-(case when p_refinement then array['baseSystemVersionId','component','input','idempotencyKey','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','acceptEarlierBasis']
   else array['systemVersionId','expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision','acceptEarlierBasis'] end)<>'{}'
  or pg_catalog.jsonb_typeof(p_request->'acceptEarlierBasis') is distinct from 'boolean'
 then raise exception 'invalid_identity_request' using errcode='22023'; end if;
 foreach v_key in array array['expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision'] loop
  if pg_catalog.jsonb_typeof(p_request->v_key) is distinct from 'number' then raise exception 'invalid_identity_fence' using errcode='22023'; end if;
  v_counter:=(p_request->>v_key)::numeric;
  if v_counter<>pg_catalog.trunc(v_counter) or v_counter<(case when v_key='expectedProjectRevision' then 1 else 0 end) or v_counter>9007199254740991 then raise exception 'invalid_identity_fence' using errcode='22023'; end if;
 end loop;
 v_target:=(p_request->>(case when p_refinement then 'baseSystemVersionId' else 'systemVersionId' end))::uuid;
 if v_target is null or (p_refinement and (p_request->>'component' not in ('colors','typography') or pg_catalog.jsonb_typeof(p_request->'input') is distinct from 'object'
  or coalesce(p_request->>'idempotencyKey','')!~'^[A-Za-z0-9._:-]{16,128}$')) then raise exception 'invalid_identity_request' using errcode='22023'; end if;

 select c.oid into v_relation from pg_catalog.pg_class c where c.relnamespace=pg_catalog.pg_my_temp_schema() and c.relname='identity_transaction_preparation';
 if v_relation is not null then
  -- Never inspect caller contents or execute a caller view before validating its owner and shape.
  if not exists(select 1 from pg_catalog.pg_class c where c.oid=v_relation and c.relowner=pg_catalog.to_regrole(current_user)::oid
  and c.relnamespace=pg_catalog.pg_my_temp_schema() and c.relkind='r' and c.relpersistence='t'
  and not exists(select 1 from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl where acl.grantee<>c.relowner))
  or (select pg_catalog.array_agg(attname::text order by attnum) from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and not attisdropped)
   is distinct from array['singleton','backend_pid','transaction_id','session_user_name','session_user_oid','owner_id','project_id','refinement','request','payload','consumed']
  or (select pg_catalog.array_agg(pg_catalog.format_type(atttypid,atttypmod) order by attnum) from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and not attisdropped)
   is distinct from array['boolean','integer','xid8','name','oid','uuid','uuid','boolean','jsonb','jsonb','boolean']
  or exists(select 1 from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and (attisdropped or not attnotnull or attacl is not null))
  or (select count(*) from pg_catalog.pg_constraint where conrelid=v_relation and contype in ('p','c'))<>2
 then raise exception 'untrusted_identity_preparation_relation' using errcode='42501'; end if;
 end if;
 if exists(select 1 from pg_catalog.pg_locks l where l.locktype='advisory' and l.database=(select oid from pg_catalog.pg_database where datname=pg_catalog.current_database())
  and l.pid=pg_catalog.pg_backend_pid() and l.classid=1229214808::oid and l.objid=pg_catalog.pg_backend_pid()::oid and l.objsubid=2 and l.granted)
 then raise exception 'identity_preparation_repeated' using errcode='PT409'; end if;
 perform pg_catalog.pg_advisory_xact_lock(1229214808,pg_catalog.pg_backend_pid());
 if v_relation is not null then raise exception 'unexpected_identity_preparation' using errcode='55000'; end if;
 create temporary table identity_transaction_preparation (
  singleton boolean primary key check(singleton),backend_pid integer not null,transaction_id xid8 not null,
  session_user_name name not null,session_user_oid oid not null,owner_id uuid not null,project_id uuid not null,
  refinement boolean not null,request jsonb not null,payload jsonb not null,consumed boolean not null
 ) on commit drop;

 select * into v_project from public.projects where id=p_project and owner_id=v_owner for update;
 if not found then raise exception 'identity_project_not_found' using errcode='P0002'; end if;
 select * into v_head from public.identity_reference_heads where project_id=p_project and owner_id=v_owner for update;
 select * into v_session from public.identity_sessions where project_id=p_project and owner_id=v_owner for update;
 if p_refinement then
  select * into v_replay from public.identity_component_changes where project_id=p_project and owner_id=v_owner and idempotency_key=p_request->>'idempotencyKey';
  if found then
   if v_replay.intent is distinct from p_request then raise exception 'identity_intent_conflict' using errcode='PT409'; end if;
   v_target:=v_replay.result_system_id;
  end if;
 end if;
 if not exists(select 1 from public.identity_system_versions where id=v_target and owner_id=v_owner and project_id=p_project) then raise exception 'identity_system_not_found' using errcode='P0002'; end if;
 -- Immutable target/base/root and accepted same-batch siblings determine the graph before source locks.
 with recursive graph(id) as (
  select v_target union
  select edge.id from graph g join public.identity_system_versions s on s.id=g.id and s.owner_id=v_owner and s.project_id=p_project
  cross join lateral (
   select s.base_system_id id union select s.root_system_id
   union select sibling.system_id from public.identity_generated_roots root join public.identity_generated_roots sibling on sibling.batch_id=root.batch_id and sibling.owner_id=root.owner_id and sibling.project_id=root.project_id
    where root.system_id=s.root_system_id and root.owner_id=v_owner and root.project_id=p_project
  ) edge where edge.id is not null
 ) select pg_catalog.array_agg(id order by id) into v_ids from graph;
 if pg_catalog.cardinality(v_ids)>1024 or (select count(*) from public.identity_system_versions where id=any(v_ids) and owner_id=v_owner and project_id=p_project)<>pg_catalog.cardinality(v_ids)
 then raise exception 'invalid_identity_graph' using errcode='55000'; end if;
 foreach v_id in array v_ids loop
  v_walk:=v_id; v_seen:='{}';
  loop
   if v_walk=any(v_seen) then raise exception 'cyclic_identity_graph' using errcode='55000'; end if;
   v_seen:=pg_catalog.array_append(v_seen,v_walk);
   select * into strict v_row from public.identity_system_versions where id=v_walk and owner_id=v_owner and project_id=p_project;
   exit when v_row.source->>'kind'='generated';
   if v_row.base_system_id is null or not(v_row.base_system_id=any(v_ids)) then raise exception 'missing_identity_base' using errcode='55000'; end if;
   v_walk:=v_row.base_system_id;
  end loop;
 end loop;
 select coalesce(pg_catalog.array_agg(distinct job_id order by job_id),'{}') into v_jobs from public.identity_generated_roots where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project;
 for v_id in select id from public.jobs where id=any(v_jobs) and owner_id=v_owner and project_id=p_project order by id for share loop null; end loop;
 perform 1 from public.job_steps where job_id=any(v_jobs) and owner_id=v_owner and project_id=p_project order by job_id,step_key for share;

 for v_row in select * from public.identity_system_versions where id=any(v_ids) and owner_id=v_owner and project_id=p_project order by id loop
  v_system:=fluid_private.identity_system_json(v_row);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('component',f.component,'role',f.role,'asset',pg_catalog.jsonb_build_object(
   'ownerId',a.owner_id,'projectId',a.project_id,'assetId',a.id,'versionId',av.id,'contentHash',av.content_hash,'purpose',a.purpose,'mimeType',av.mime_type)) order by f.slot),'[]') into v_files
   from public.identity_system_files f join public.assets a on a.id=f.asset_id and a.owner_id=f.owner_id and a.project_id=f.project_id
   join public.asset_versions av on av.id=f.version_id and av.asset_id=f.asset_id and av.owner_id=f.owner_id and av.project_id=f.project_id
   where f.system_id=v_row.id and f.owner_id=v_owner and f.project_id=p_project;
  if v_files is distinct from pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('component',null,'role','board','asset',v_row.board->'asset'))||v_row.production_files
   or exists(select 1 from (select slot,pg_catalog.row_number() over(order by slot)-1 expected from public.identity_system_files where system_id=v_row.id and owner_id=v_owner and project_id=p_project) slots where slot<>expected)
  then raise exception 'invalid_identity_file_projection' using errcode='55000'; end if;
  select v_proof_files||coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('systemVersionId',v_row.id,'slot',n-1)||value order by n),'[]') into v_proof_files from pg_catalog.jsonb_array_elements(v_files) with ordinality x(value,n);
  v_change:=null; v_selection:=null;
  if v_row.source->>'kind'='generated' then
   select * into strict v_root from public.identity_generated_roots where system_id=v_row.id and owner_id=v_owner and project_id=p_project;
   select * into strict v_batch from public.identity_batches where id=v_root.batch_id and job_id=v_root.job_id and owner_id=v_owner and project_id=p_project;
   select * into strict v_job from public.jobs where id=v_root.job_id and owner_id=v_owner and project_id=p_project;
   select * into strict v_step from public.job_steps where job_id=v_root.job_id and step_key=v_root.step_key and owner_id=v_owner and project_id=p_project;
   select * into strict v_input from public.identity_input_snapshots where id=v_batch.input_id and owner_id=v_owner and project_id=p_project;
   select context into strict v_context from public.project_revisions where project_id=p_project and owner_id=v_owner and revision=v_input.project_revision;
   select snapshot into strict v_reference from public.identity_reference_snapshots where project_id=p_project and owner_id=v_owner and reference_revision=v_input.reference_revision;
   select preferences into v_preference_value from public.identity_preferences where project_id=p_project and owner_id=v_owner and revision=v_input.preferences_revision;
   if v_input.preferences_revision is null then v_preference_value:=pg_catalog.jsonb_build_object('version',1,'creativeLocale',coalesce(v_context->>'creativeLocale','en'),'notes',coalesce(v_context#>>'{intake,identityNotes}',''),'avoidanceNotes',''); end if;
   v_output:=v_step.output->'identity';
   if v_job.operation<>'identity.image' or v_job.input_revision<>v_input.project_revision or v_step.state<>'succeeded' or v_step.completed_at is null
    or v_row.input_id<>v_input.id or v_row.root_system_id<>v_row.id or v_row.base_system_id is not null or v_row.change_id is not null
    or v_row.source is distinct from pg_catalog.jsonb_build_object('kind','generated','batchId',v_batch.id,'jobId',v_job.id,'stepKey',v_step.step_key)
    or v_step.output-'identity' is distinct from '{}'::jsonb or pg_catalog.octet_length(v_step.output::text)>1048576
    or v_output-'systems' is distinct from pg_catalog.jsonb_build_object('version',1,'operation','identity.image','ownerId',v_owner,'projectId',p_project,'batchId',v_batch.id,'jobId',v_job.id,'stepKey',v_step.step_key,'targetCount',3,'input',v_input.input)
    or pg_catalog.jsonb_typeof(v_output->'systems') is distinct from 'array' or pg_catalog.jsonb_array_length(v_output->'systems') not between 1 and 3
    or v_output#>array['systems',v_root.output_index::text] is distinct from v_system or v_root.board is distinct from v_row.board->'asset'
    or v_input.input->'referenceSnapshot' is distinct from v_reference or v_input.input->'preferences' is distinct from v_preference_value
   then raise exception 'invalid_identity_completed_graph' using errcode='55000'; end if;
   -- Full output is checked, including not-yet-accepted siblings. Normalized
   -- context/WHATWG/Naming semantics remain the explicit shared-TS boundary.
   for v_manifest in select value from pg_catalog.jsonb_array_elements(v_output->'systems') loop
    if not(v_manifest ?& array['id','ownerId','projectId','createdAt','input','source','components','board','productionFiles'])
     or v_manifest-array['id','ownerId','projectId','createdAt','input','source','components','board','productionFiles'] is distinct from '{}'::jsonb
     or v_manifest->'input' is distinct from v_input.input or v_manifest->'source' is distinct from v_row.source
     or v_manifest->>'ownerId' is distinct from v_owner::text or v_manifest->>'projectId' is distinct from p_project::text
     or v_manifest#>'{board,depictsSystemVersionId}' is distinct from v_manifest->'id' or v_manifest#>'{board,staleComponents}' is distinct from '[]'::jsonb
    then raise exception 'invalid_identity_output_scope' using errcode='55000'; end if;
    for v_file in select value from pg_catalog.jsonb_array_elements(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('asset',v_manifest#>'{board,asset}'))||(v_manifest->'productionFiles')) loop
     select pg_catalog.jsonb_build_object('ownerId',a.owner_id,'projectId',a.project_id,'assetId',a.id,'versionId',av.id,'contentHash',av.content_hash,'purpose',a.purpose,'mimeType',av.mime_type) into v_asset
      from public.asset_versions av join public.assets a on a.id=av.asset_id and a.owner_id=av.owner_id and a.project_id=av.project_id
      where av.id=(v_file#>>'{asset,versionId}')::uuid and av.asset_id=(v_file#>>'{asset,assetId}')::uuid and av.owner_id=v_owner and av.project_id=p_project;
     if v_asset is null or v_asset is distinct from v_file->'asset' or v_asset->>'purpose' not in ('brand_asset','legacy_unknown') then raise exception 'invalid_identity_output_asset' using errcode='55000'; end if;
     v_output_assets:=pg_catalog.array_append(v_output_assets,(v_asset->>'assetId')::uuid);
    end loop;
   end loop;
   if exists(select 1 from pg_catalog.jsonb_array_elements(v_output->'systems') x group by x->>'id' having count(*)>1)
    or exists(select 1 from pg_catalog.jsonb_array_elements(v_output->'systems') x group by x#>'{board,asset,versionId}' having count(*)>1)
    or exists(select 1 from pg_catalog.jsonb_array_elements(v_output->'systems') x group by x#>'{board,asset,contentHash}' having count(*)>1)
   then raise exception 'duplicate_identity_output' using errcode='55000'; end if;
   v_roots:=v_roots||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('batch',pg_catalog.jsonb_build_object('id',v_batch.id,'ownerId',v_owner,'projectId',p_project,'jobId',v_job.id,'targetCount',3,'input',v_input.input),
    'step',pg_catalog.jsonb_build_object('ownerId',v_owner,'projectId',p_project,'jobId',v_job.id,'stepKey',v_step.step_key,'state',v_step.state,'completedAt',v_step.completed_at,'output',v_step.output),
    'receipt',pg_catalog.jsonb_build_object('version',1,'ownerId',v_owner,'projectId',p_project,'batchId',v_batch.id,'jobId',v_job.id,'stepKey',v_step.step_key,'outputIndex',v_root.output_index,'systemVersionId',v_row.id,'board',v_root.board),'system',v_system));
   v_sources:=v_sources||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('systemVersionId',v_row.id,'job',pg_catalog.jsonb_build_object('id',v_job.id,'ownerId',v_owner,'projectId',p_project,'operation',v_job.operation,'inputRevision',v_job.input_revision),
    'context',v_context,'referenceSnapshot',v_reference,'preferencesRevision',coalesce(v_input.preferences_revision,0),'preferences',v_preference_value));
  else
   select * into strict v_base from public.identity_system_versions where id=v_row.base_system_id and owner_id=v_owner and project_id=p_project;
   select * into strict v_change from public.identity_component_changes where id=v_row.change_id and owner_id=v_owner and project_id=p_project;
   select * into strict v_selection from public.identity_selections where id=v_change.selection_id and owner_id=v_owner and project_id=p_project;
   v_component:=v_change.component;
   select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(component) order by n),'[]') into v_stale from pg_catalog.unnest(array['logo','colors','typography','graphics','imagery','composition']) with ordinality t(component,n)
    where component=v_component or v_base.board->'staleComponents' ? component;
   select coalesce(pg_catalog.jsonb_agg(value order by n),'[]') into v_files from pg_catalog.jsonb_array_elements(v_base.production_files) with ordinality t(value,n) where value->>'component'<>v_component;
   if v_row.input_id<>v_base.input_id or v_row.root_system_id<>v_base.root_system_id or v_change.base_system_id<>v_base.id or v_change.result_system_id<>v_row.id
    or v_row.source is distinct from pg_catalog.jsonb_build_object('kind','manual_edit','baseSystemVersionId',v_base.id,'changeId',v_change.id,'component',v_component,'editedAtProjectRevision',v_change.project_revision,'editedAtReferenceRevision',v_change.reference_revision,'editedAtPreferencesRevision',coalesce(v_change.preferences_revision,0))
    or v_change.before_value is distinct from v_base.components->v_component or v_row.components is distinct from pg_catalog.jsonb_set(v_base.components,array[v_component],v_change.after_value)
    or v_row.board is distinct from pg_catalog.jsonb_set(v_base.board,'{staleComponents}',v_stale) or v_row.production_files is distinct from v_files
    or v_selection.system_id<>v_row.id or v_selection.reason<>'refined' or v_selection.current_basis<>v_change.current_basis
    or v_selection.project_revision<>v_change.project_revision or v_selection.reference_revision<>v_change.reference_revision or v_selection.preferences_revision is distinct from v_change.preferences_revision
    or v_selection.accepted_earlier_basis<>v_change.accepted_earlier_basis or v_change.accepted_earlier_basis is distinct from (v_change.current_basis<>(fluid_private.identity_system_json(v_base)#>'{input,basis}'))
    or v_change.created_at<>v_row.created_at or v_selection.created_at<>v_change.created_at
   then raise exception 'invalid_identity_manual_graph' using errcode='55000'; end if;
  end if;
  v_records:=v_records||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('system',v_system,'rootSystemId',v_row.root_system_id,'base',v_row.base_system_id,
   'change',case when v_change.id is null then null else fluid_private.identity_change_json(v_change) end,'selection',fluid_private.identity_selection_json(v_selection)));
 end loop;
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('batchId',batch_id,'acceptedRootCount',amount) order by batch_id),'[]') into v_batches from
  (select batch_id,count(*) amount from public.identity_generated_roots where owner_id=v_owner and project_id=p_project and system_id=any(v_ids) group by batch_id) b;
 if pg_catalog.jsonb_array_length(v_roots)>48 or pg_catalog.jsonb_array_length(v_batches)>48 or pg_catalog.jsonb_array_length(v_proof_files)>50176
  or exists(select 1 from pg_catalog.jsonb_array_elements(v_batches) x where (x->>'acceptedRootCount')::integer not between 1 and 3)
  or exists(select 1 from public.identity_generated_roots r join public.identity_generated_roots sibling on sibling.batch_id=r.batch_id and sibling.owner_id=r.owner_id and sibling.project_id=r.project_id
    where r.system_id=any(v_ids) and r.owner_id=v_owner and r.project_id=p_project and (not(sibling.system_id=any(v_ids)) or (r.system_id<>sibling.system_id and (r.board->'versionId'=sibling.board->'versionId' or r.board->'contentHash'=sibling.board->'contentHash'))))
 then raise exception 'invalid_identity_batch_graph' using errcode='55000'; end if;
 -- Freeze the final asset set before the last lock class. No earlier lock is acquired in commit.
 select coalesce(pg_catalog.array_agg(distinct asset_id order by asset_id),'{}') into v_assets from (
  select asset_id from public.identity_system_files where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project
  union select asset_id from public.identity_references where owner_id=v_owner and project_id=p_project
  union select asset_id from public.asset_usages where selection_id=v_session.current_selection_id and owner_id=v_owner and project_id=p_project
  union select pg_catalog.unnest(v_output_assets)
 ) final_assets;
 perform 1 from public.assets where id=any(v_assets) and owner_id=v_owner and project_id=p_project order by id for update;
 if (select count(*) from public.assets where id=any(v_assets) and owner_id=v_owner and project_id=p_project)<>pg_catalog.cardinality(v_assets) then raise exception 'missing_identity_asset' using errcode='55000'; end if;

 v_dto:=pg_catalog.jsonb_build_object('version',1,'principal',pg_catalog.jsonb_build_object('sessionUserName',session_user,'sessionUserOid',v_role::bigint,'boundOwnerId',v_owner),'ownerId',v_owner,'projectId',p_project,
  'proofs',pg_catalog.jsonb_build_object('records',v_records,'roots',v_roots,'rootSources',v_sources,'files',v_proof_files,'batches',v_batches));
 if v_replay.id is not null then
  select * into strict v_row from public.identity_system_versions where id=v_replay.result_system_id and owner_id=v_owner and project_id=p_project;
  select * into strict v_selection from public.identity_selections where id=v_replay.selection_id and owner_id=v_owner and project_id=p_project;
  v_dto:=v_dto||pg_catalog.jsonb_build_object('kind','replay','intent',v_replay.intent,'response',pg_catalog.jsonb_build_object('system',fluid_private.identity_system_json(v_row),'change',fluid_private.identity_change_json(v_replay),'selection',fluid_private.identity_selection_json(v_selection)));
 else
  if (p_request->>'expectedProjectRevision')::bigint<>v_project.current_revision or (p_request->>'expectedReferenceRevision')::bigint<>coalesce(v_head.reference_revision,0)
   or (p_request->>'expectedPreferencesRevision')::bigint<>coalesce(v_session.current_preferences_revision,0) or (p_request->>'expectedIdentityRevision')::bigint<>coalesce(v_session.identity_revision,0)
  then raise exception 'identity_revision_conflict' using errcode='PT409'; end if;
  select context into strict v_context from public.project_revisions where project_id=p_project and owner_id=v_owner and revision=v_project.current_revision;
  select * into v_preferences from public.identity_preferences where project_id=p_project and owner_id=v_owner and revision=v_session.current_preferences_revision;
  select coalesce(pg_catalog.jsonb_agg(fluid_private.identity_reference_entry(reference_id,p_project,v_owner) order by reference_id),'[]') into v_selected
   from public.identity_reference_reactions where project_id=p_project and owner_id=v_owner and (ensemble or pg_catalog.cardinality(elements)>0);
  if pg_catalog.jsonb_array_length(v_selected)<>coalesce(v_head.selected_reference_count,0) or exists(select 1 from public.identity_reference_reactions where project_id=p_project and owner_id=v_owner and revision>coalesce(v_head.reference_revision,0)) then raise exception 'invalid_identity_reference_head' using errcode='55000'; end if;
  select snapshot into v_old_snapshot from public.identity_reference_snapshots where project_id=p_project and owner_id=v_owner and reference_revision=coalesce(v_head.reference_revision,0);
  v_reference:=coalesce(v_old_snapshot,pg_catalog.jsonb_build_object('version',1,'ownerId',v_owner,'projectId',p_project,'referenceRevision',coalesce(v_head.reference_revision,0),'selectedReferenceCount',coalesce(v_head.selected_reference_count,0),'capturedAt',v_now,'selected',v_selected));
  if v_reference->'selected' is distinct from v_selected or v_reference->'selectedReferenceCount' is distinct from pg_catalog.to_jsonb(coalesce(v_head.selected_reference_count,0)) then raise exception 'invalid_identity_reference_snapshot' using errcode='55000'; end if;
  select fluid_private.identity_selection_json(s) into v_previous from public.identity_selections s where s.id=v_session.current_selection_id and s.owner_id=v_owner and s.project_id=p_project;
  v_reason:=case when exists(select 1 from public.identity_selections where system_id=v_target and owner_id=v_owner and project_id=p_project) then 'restored' else 'selected' end;
  v_dto:=v_dto||pg_catalog.jsonb_build_object('kind','new','project',fluid_private.asset_library_project(v_project)||pg_catalog.jsonb_build_object('context',v_context),
   'session',fluid_private.identity_session_json(v_session),'preferences',fluid_private.identity_preferences_json(v_preferences),'referenceSnapshot',v_reference,'previousSelection',v_previous,
   'targetSystemId',v_target,'selectionId',pg_catalog.gen_random_uuid(),'systemVersionId',pg_catalog.gen_random_uuid(),'changeId',pg_catalog.gen_random_uuid(),'now',v_now,'reason',v_reason);
 end if;
 select pg_catalog.jsonb_build_object(
  'projects',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.projects frozen_row where owner_id=v_owner and id=p_project),
  'project_revisions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.project_revisions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_heads',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_heads frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_sessions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_sessions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_preferences',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_preferences frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_references',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_references frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_reactions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_reactions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_snapshots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_snapshots frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_system_versions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_system_versions frozen_row where owner_id=v_owner and id=any(v_ids) and project_id=p_project),
  'identity_input_snapshots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_input_snapshots frozen_row where owner_id=v_owner and id in(select input_id from public.identity_system_versions where id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'identity_system_files',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_system_files frozen_row where owner_id=v_owner and system_id=any(v_ids) and project_id=p_project),
  'identity_generated_roots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_generated_roots frozen_row where owner_id=v_owner and batch_id in(select batch_id from public.identity_generated_roots where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'identity_batches',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_batches frozen_row where owner_id=v_owner and id in(select batch_id from public.identity_generated_roots where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'jobs',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.jobs frozen_row where owner_id=v_owner and id=any(v_jobs) and project_id=p_project),
  'job_steps',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.job_steps frozen_row where owner_id=v_owner and job_id=any(v_jobs) and project_id=p_project),
  'identity_component_changes',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_component_changes frozen_row where owner_id=v_owner and result_system_id=any(v_ids) and project_id=p_project),
  'identity_selections',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_selections frozen_row where owner_id=v_owner and project_id=p_project),
  'asset_usages',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.asset_usages frozen_row where owner_id=v_owner and project_id=p_project),
  'assets',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.assets frozen_row where owner_id=v_owner and id=any(v_assets) and project_id=p_project),
  'asset_versions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.asset_versions frozen_row where owner_id=v_owner and asset_id=any(v_assets) and project_id=p_project)
 ) into v_frozen;
 if pg_catalog.octet_length(v_dto::text)>16777216 or pg_catalog.octet_length(v_frozen::text)>16777216 then raise exception 'identity_graph_limit' using errcode='55000'; end if;
 insert into pg_temp.identity_transaction_preparation values(true,pg_catalog.pg_backend_pid(),pg_catalog.pg_current_xact_id(),session_user,v_role,v_owner,p_project,p_refinement,p_request,
  pg_catalog.jsonb_build_object('dto',v_dto,'frozen',v_frozen,'ids',v_ids,'jobs',v_jobs,'assets',v_assets),false);
 return v_dto;
end $$;
create function fluid_private.commit_identity_transaction(p_project uuid,p_request jsonb,p_proposal jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_owner uuid:=fluid_private.identity_web_owner(); v_role oid:=pg_catalog.to_regrole(session_user)::oid;
 v_relation oid; v_prepared record; v_dto jsonb; v_frozen jsonb; v_ids uuid[]; v_jobs uuid[]; v_assets uuid[];
 v_input jsonb; v_basis jsonb; v_reference_basis jsonb; v_response jsonb; v_expected jsonb; v_system jsonb; v_selection jsonb; v_change jsonb;
 v_components jsonb; v_board jsonb; v_files jsonb; v_stale_components jsonb; v_freshness jsonb; v_changed jsonb;
 v_project public.projects; v_head public.identity_reference_heads; v_session public.identity_sessions; v_target public.identity_system_versions;
 v_selected public.identity_selections; v_saved_change public.identity_component_changes; v_saved_system public.identity_system_versions;
 v_previous public.identity_selections; v_now timestamptz; v_system_id uuid; v_selection_id uuid; v_change_id uuid; v_component text;
 v_project_revision bigint; v_reference_revision bigint; v_preferences_revision bigint; v_identity_revision bigint;
 v_stale boolean; v_refinement boolean; v_reason text; v_count bigint; v_expected_count bigint; v_saved_snapshot jsonb;
begin
 if pg_catalog.current_setting('request.jwt.claim.sub',true) is distinct from v_owner::text then raise exception 'identity_claim_mismatch' using errcode='42501'; end if;
 select c.oid into v_relation from pg_catalog.pg_class c where c.relnamespace=pg_catalog.pg_my_temp_schema() and c.relname='identity_transaction_preparation';
 if v_relation is null then raise exception 'identity_preparation_required' using errcode='55000'; end if;
 if not exists(select 1 from pg_catalog.pg_class c where c.oid=v_relation and c.relowner=pg_catalog.to_regrole(current_user)::oid
  and c.relnamespace=pg_catalog.pg_my_temp_schema() and c.relkind='r' and c.relpersistence='t'
  and not exists(select 1 from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl where acl.grantee<>c.relowner))
  or (select pg_catalog.array_agg(attname::text order by attnum) from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and not attisdropped)
   is distinct from array['singleton','backend_pid','transaction_id','session_user_name','session_user_oid','owner_id','project_id','refinement','request','payload','consumed']
  or (select pg_catalog.array_agg(pg_catalog.format_type(atttypid,atttypmod) order by attnum) from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and not attisdropped)
   is distinct from array['boolean','integer','xid8','name','oid','uuid','uuid','boolean','jsonb','jsonb','boolean']
  or exists(select 1 from pg_catalog.pg_attribute where attrelid=v_relation and attnum>0 and (attisdropped or not attnotnull or attacl is not null))
  or (select count(*) from pg_catalog.pg_constraint where conrelid=v_relation and contype in ('p','c'))<>2
 then raise exception 'untrusted_identity_preparation_relation' using errcode='42501'; end if;
 if not exists(select 1 from pg_catalog.pg_locks l where l.locktype='advisory' and l.database=(select oid from pg_catalog.pg_database where datname=pg_catalog.current_database())
  and l.pid=pg_catalog.pg_backend_pid() and l.classid=1229214808::oid and l.objid=pg_catalog.pg_backend_pid()::oid and l.objsubid=2 and l.granted)
 then raise exception 'identity_guard_required' using errcode='55000'; end if;
 if (select count(*) from pg_temp.identity_transaction_preparation)<>1 then raise exception 'invalid_identity_preparation' using errcode='55000'; end if;
 select * into strict v_prepared from pg_temp.identity_transaction_preparation where singleton;
 if v_prepared.consumed or v_prepared.backend_pid<>pg_catalog.pg_backend_pid() or v_prepared.transaction_id<>pg_catalog.pg_current_xact_id()
  or v_prepared.session_user_name<>session_user or v_prepared.session_user_oid<>v_role or v_prepared.owner_id<>v_owner or v_prepared.project_id<>p_project
  or v_prepared.request is distinct from p_request or v_prepared.payload#>>'{dto,kind}'<>'new'
 then raise exception 'stale_identity_preparation' using errcode='55000'; end if;
 v_dto:=v_prepared.payload->'dto'; v_refinement:=v_prepared.refinement;
 select pg_catalog.array_agg(value::uuid order by value) into v_ids from pg_catalog.jsonb_array_elements_text(v_prepared.payload->'ids');
 select coalesce(pg_catalog.array_agg(value::uuid order by value),'{}') into v_jobs from pg_catalog.jsonb_array_elements_text(v_prepared.payload->'jobs');
 select coalesce(pg_catalog.array_agg(value::uuid order by value),'{}') into v_assets from pg_catalog.jsonb_array_elements_text(v_prepared.payload->'assets');
 -- No lock acquisition here: exact graph reread is bound to preparation and the already-held classes.
 select pg_catalog.jsonb_build_object(
  'projects',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.projects frozen_row where owner_id=v_owner and id=p_project),
  'project_revisions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.project_revisions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_heads',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_heads frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_sessions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_sessions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_preferences',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_preferences frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_references',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_references frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_reactions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_reactions frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_reference_snapshots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_reference_snapshots frozen_row where owner_id=v_owner and project_id=p_project),
  'identity_system_versions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_system_versions frozen_row where owner_id=v_owner and id=any(v_ids) and project_id=p_project),
  'identity_input_snapshots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_input_snapshots frozen_row where owner_id=v_owner and id in(select input_id from public.identity_system_versions where id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'identity_system_files',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_system_files frozen_row where owner_id=v_owner and system_id=any(v_ids) and project_id=p_project),
  'identity_generated_roots',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_generated_roots frozen_row where owner_id=v_owner and batch_id in(select batch_id from public.identity_generated_roots where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'identity_batches',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_batches frozen_row where owner_id=v_owner and id in(select batch_id from public.identity_generated_roots where system_id=any(v_ids) and owner_id=v_owner and project_id=p_project) and project_id=p_project),
  'jobs',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.jobs frozen_row where owner_id=v_owner and id=any(v_jobs) and project_id=p_project),
  'job_steps',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.job_steps frozen_row where owner_id=v_owner and job_id=any(v_jobs) and project_id=p_project),
  'identity_component_changes',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_component_changes frozen_row where owner_id=v_owner and result_system_id=any(v_ids) and project_id=p_project),
  'identity_selections',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.identity_selections frozen_row where owner_id=v_owner and project_id=p_project),
  'asset_usages',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.asset_usages frozen_row where owner_id=v_owner and project_id=p_project),
  'assets',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.assets frozen_row where owner_id=v_owner and id=any(v_assets) and project_id=p_project),
  'asset_versions',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(frozen_row) order by pg_catalog.to_jsonb(frozen_row)::text),'[]') from public.asset_versions frozen_row where owner_id=v_owner and asset_id=any(v_assets) and project_id=p_project)
 ) into v_frozen;
 if v_frozen is distinct from v_prepared.payload->'frozen' then raise exception 'identity_graph_changed' using errcode='55000'; end if;
 select * into strict v_project from public.projects where id=p_project and owner_id=v_owner;
 select * into v_head from public.identity_reference_heads where project_id=p_project and owner_id=v_owner;
 select * into v_session from public.identity_sessions where project_id=p_project and owner_id=v_owner;
 select * into strict v_target from public.identity_system_versions where id=(v_dto->>'targetSystemId')::uuid and owner_id=v_owner and project_id=p_project;
 v_project_revision:=(p_request->>'expectedProjectRevision')::bigint; v_reference_revision:=(p_request->>'expectedReferenceRevision')::bigint;
 v_preferences_revision:=(p_request->>'expectedPreferencesRevision')::bigint; v_identity_revision:=(p_request->>'expectedIdentityRevision')::bigint;
 if v_project_revision<>v_project.current_revision or v_reference_revision<>coalesce(v_head.reference_revision,0)
  or v_preferences_revision<>coalesce(v_session.current_preferences_revision,0) or v_identity_revision<>coalesce(v_session.identity_revision,0) or v_identity_revision>=9007199254740991
 then raise exception 'identity_revision_conflict' using errcode='PT409'; end if;
 v_input:=p_proposal->'currentInput'; v_basis:=v_input->'basis'; v_response:=p_proposal->'response';
 if p_proposal-array['version','kind','currentInput','response'] is distinct from '{}'::jsonb or p_proposal->'version' is distinct from '1'::jsonb
  or p_proposal->>'kind' is distinct from (case when v_refinement then 'refinement' else 'selection' end)
  or pg_catalog.octet_length(p_proposal::text)>16777216
  or v_input-array['version','ownerId','projectId','scope','projectRevision','context','referenceSnapshot','preferencesRevision','preferences','capturedAt','basis'] is distinct from '{}'::jsonb
  or v_input->'version' is distinct from '1'::jsonb or v_input->>'ownerId' is distinct from v_owner::text or v_input->>'projectId' is distinct from p_project::text
  or v_input->>'scope' is distinct from v_project.scope::text or v_input->'projectRevision' is distinct from pg_catalog.to_jsonb(v_project_revision)
  or v_input->'referenceSnapshot' is distinct from v_dto->'referenceSnapshot' or v_input->'preferencesRevision' is distinct from pg_catalog.to_jsonb(v_preferences_revision)
  or v_input->'capturedAt' is distinct from v_dto->'now' or pg_catalog.jsonb_typeof(v_input->'context') is distinct from 'object'
  or pg_catalog.jsonb_typeof(v_input->'preferences') is distinct from 'object' or pg_catalog.jsonb_typeof(v_basis) is distinct from 'object'
  or v_basis->'version' is distinct from '1'::jsonb or v_basis->>'ownerId' is distinct from v_owner::text or v_basis->>'projectId' is distinct from p_project::text
  or v_basis->'preferences' is distinct from v_input->'preferences' or (v_preferences_revision>0 and v_input->'preferences' is distinct from v_dto#>'{preferences,preferences}')
 then raise exception 'invalid_identity_proposal_input' using errcode='55000'; end if;
 -- Shared TypeScript owns normalized context/material-basis and complete Naming/WHATWG semantics.
 -- SQL binds that projection to the exact owner, four heads, stored references and preferences.
 select pg_catalog.jsonb_build_object('version',1,'ownerId',v_owner,'projectId',p_project,'references',coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'referenceId',value#>'{reference,id}','media',value#>'{reference,media}','ensemble',value#>'{reaction,ensemble}','elements',value#>'{reaction,elements}') order by value#>>'{reference,id}'),'[]')) into v_reference_basis
  from pg_catalog.jsonb_array_elements(v_dto#>'{referenceSnapshot,selected}');
 if v_basis->'referenceBasis' is distinct from v_reference_basis then raise exception 'invalid_identity_reference_basis' using errcode='55000'; end if;
 v_system:=fluid_private.identity_system_json(v_target);
 select * into v_previous from public.identity_selections where id=v_session.current_selection_id and owner_id=v_owner and project_id=p_project;
 if v_project_revision<coalesce((v_target.source->>'editedAtProjectRevision')::bigint,(v_system#>>'{input,projectRevision}')::bigint)
  or v_reference_revision<coalesce((v_target.source->>'editedAtReferenceRevision')::bigint,(v_system#>>'{input,referenceSnapshot,referenceRevision}')::bigint)
  or v_preferences_revision<coalesce((v_target.source->>'editedAtPreferencesRevision')::bigint,(v_system#>>'{input,preferencesRevision}')::bigint)
  or (v_previous.id is not null and (v_previous.identity_revision<>v_identity_revision or v_previous.project_revision>v_project_revision or v_previous.reference_revision>v_reference_revision or coalesce(v_previous.preferences_revision,0)>v_preferences_revision))
  or (v_previous.id is null and v_identity_revision<>0)
 then raise exception 'identity_creation_revision_conflict' using errcode='PT409'; end if;
 v_stale:=v_system#>'{input,basis}'<>v_basis;
 if v_stale and p_request->'acceptEarlierBasis'<>'true'::jsonb then raise exception 'identity_earlier_basis_required' using errcode='PT409'; end if;
 v_now:=(v_dto->>'now')::timestamptz; v_selection_id:=(v_dto->>'selectionId')::uuid; v_change_id:=(v_dto->>'changeId')::uuid;
 v_system_id:=case when v_refinement then (v_dto->>'systemVersionId')::uuid else v_target.id end;
 v_reason:=case when v_refinement then 'refined' else v_dto->>'reason' end;
 v_selection:=pg_catalog.jsonb_build_object('id',v_selection_id,'ownerId',v_owner,'projectId',p_project,'systemVersionId',v_system_id,
  'identityRevision',v_identity_revision+1,'projectRevision',v_project_revision,'referenceRevision',v_reference_revision,'preferencesRevision',v_preferences_revision,
  'currentBasis',v_basis,'acceptedEarlierBasis',v_stale,'previousSelectionId',v_previous.id,'reason',v_reason,'createdAt',v_now);
 if v_refinement then
  v_component:=p_request->>'component';
  if v_target.components->v_component is not distinct from p_request->'input' then raise exception 'identity_edit_must_change' using errcode='22023'; end if;
  v_components:=pg_catalog.jsonb_set(v_target.components,array[v_component],p_request->'input');
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(component) order by n),'[]') into v_stale_components
   from pg_catalog.unnest(array['logo','colors','typography','graphics','imagery','composition']) with ordinality x(component,n) where component=v_component or v_target.board->'staleComponents' ? component;
  v_board:=pg_catalog.jsonb_set(v_target.board,'{staleComponents}',v_stale_components);
  select coalesce(pg_catalog.jsonb_agg(value order by n),'[]') into v_files from pg_catalog.jsonb_array_elements(v_target.production_files) with ordinality x(value,n) where value->>'component'<>v_component;
  v_change:=pg_catalog.jsonb_build_object('id',v_change_id,'ownerId',v_owner,'projectId',p_project,'baseSystemVersionId',v_target.id,'resultSystemVersionId',v_system_id,
   'projectRevision',v_project_revision,'referenceRevision',v_reference_revision,'preferencesRevision',v_preferences_revision,'currentBasis',v_basis,'acceptedEarlierBasis',v_stale,
   'component',v_component,'before',v_target.components->v_component,'after',p_request->'input','provenance',pg_catalog.jsonb_build_object('kind','user_edit','actorId',v_owner),'createdAt',v_now);
  v_system:=v_system||pg_catalog.jsonb_build_object('id',v_system_id,'createdAt',v_dto->'now','source',pg_catalog.jsonb_build_object('kind','manual_edit','baseSystemVersionId',v_target.id,'changeId',v_change_id,'component',v_component,
   'editedAtProjectRevision',v_project_revision,'editedAtReferenceRevision',v_reference_revision,'editedAtPreferencesRevision',v_preferences_revision),'components',v_components,'board',v_board,'productionFiles',v_files);
  v_expected:=pg_catalog.jsonb_build_object('system',v_system,'change',v_change,'selection',v_selection);
 else
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(label) order by n),'[]') into v_changed from
   (values ('strategy','strategy',1),('name','name',2),('references','referenceBasis',3),('preferences','preferences',4)) x(label,key,n)
   where v_system#>array['input','basis',key] is distinct from v_basis->key;
  v_freshness:=pg_catalog.jsonb_build_object('status',case when pg_catalog.jsonb_array_length(v_changed)=0 then 'current' else 'stale' end,'changed',v_changed);
  v_expected:=pg_catalog.jsonb_build_object('session',pg_catalog.jsonb_build_object('ownerId',v_owner,'projectId',p_project,'identityRevision',v_identity_revision+1,
   'currentSelectionId',v_selection_id,'currentPreferencesRevision',v_preferences_revision,'createdAt',coalesce(v_session.created_at,v_now),'updatedAt',v_now),
   'currentSelection',pg_catalog.jsonb_build_object('selection',v_selection,'system',v_system,'freshness',v_freshness));
 end if;
 if v_response is distinct from v_expected then raise exception 'invalid_identity_transition_projection' using errcode='55000'; end if;

 if v_session.project_id is null then
  insert into public.identity_sessions(project_id,owner_id,created_at,updated_at) values(p_project,v_owner,v_now,v_now);
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'identity_session_write_count' using errcode='55000'; end if;
 end if;
 select snapshot into v_saved_snapshot from public.identity_reference_snapshots where project_id=p_project and owner_id=v_owner and reference_revision=v_reference_revision;
 if found then
  if v_saved_snapshot is distinct from v_dto->'referenceSnapshot' then raise exception 'identity_snapshot_changed' using errcode='55000'; end if;
 else
  insert into public.identity_reference_snapshots(project_id,owner_id,reference_revision,snapshot) values(p_project,v_owner,v_reference_revision,v_dto->'referenceSnapshot');
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'identity_snapshot_write_count' using errcode='55000'; end if;
 end if;
 if v_refinement then
  insert into public.identity_system_versions(id,project_id,owner_id,input_id,root_system_id,base_system_id,change_id,source,components,board,production_files,created_at,created_at_text)
   values(v_system_id,p_project,v_owner,v_target.input_id,v_target.root_system_id,v_target.id,v_change_id,v_system->'source',v_components,v_board,v_files,v_now,v_dto->>'now');
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'identity_system_write_count' using errcode='55000'; end if;
  insert into public.identity_system_files(system_id,slot,project_id,owner_id,component,role,asset_id,version_id)
   select v_system_id,(n-1)::integer,p_project,v_owner,value->>'component',value->>'role',(value#>>'{asset,assetId}')::uuid,(value#>>'{asset,versionId}')::uuid
   from pg_catalog.jsonb_array_elements(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('component',null,'role','board','asset',v_board->'asset'))||v_files) with ordinality x(value,n);
  get diagnostics v_count=row_count;
  if v_count<>pg_catalog.jsonb_array_length(v_files)+1 then raise exception 'identity_file_write_count' using errcode='55000'; end if;
 end if;
 insert into public.identity_selections(id,project_id,owner_id,system_id,identity_revision,project_revision,reference_revision,preferences_revision,current_basis,accepted_earlier_basis,previous_selection_id,reason,created_at)
  values(v_selection_id,p_project,v_owner,v_system_id,v_identity_revision+1,v_project_revision,v_reference_revision,nullif(v_preferences_revision,0),v_basis,v_stale,v_previous.id,v_reason,v_now) returning * into v_selected;
 get diagnostics v_count=row_count;
 if v_count<>1 or fluid_private.identity_selection_json(v_selected) is distinct from v_selection then raise exception 'identity_selection_receipt' using errcode='55000'; end if;
 select count(*) into v_expected_count from public.identity_system_files where system_id=v_system_id and owner_id=v_owner and project_id=p_project;
 insert into public.asset_usages(selection_id,system_id,slot,project_id,owner_id,asset_id,version_id)
  select v_selection_id,system_id,slot,project_id,owner_id,asset_id,version_id from public.identity_system_files where system_id=v_system_id and owner_id=v_owner and project_id=p_project;
 get diagnostics v_count=row_count;
 if v_count<>v_expected_count then raise exception 'identity_usage_write_count' using errcode='55000'; end if;
 if v_refinement then
  insert into public.identity_component_changes(id,project_id,owner_id,base_system_id,result_system_id,selection_id,component,before_value,after_value,project_revision,reference_revision,preferences_revision,current_basis,accepted_earlier_basis,idempotency_key,intent,created_at)
   values(v_change_id,p_project,v_owner,v_target.id,v_system_id,v_selection_id,v_component,v_target.components->v_component,p_request->'input',v_project_revision,v_reference_revision,nullif(v_preferences_revision,0),v_basis,v_stale,p_request->>'idempotencyKey',p_request,v_now) returning * into v_saved_change;
  get diagnostics v_count=row_count;
  if v_count<>1 or fluid_private.identity_change_json(v_saved_change) is distinct from v_change then raise exception 'identity_change_receipt' using errcode='55000'; end if;
 end if;
 update public.identity_sessions set identity_revision=v_identity_revision+1,current_selection_id=v_selection_id,updated_at=v_now
  where project_id=p_project and owner_id=v_owner and identity_revision=v_identity_revision and coalesce(current_preferences_revision,0)=v_preferences_revision and current_selection_id is not distinct from v_previous.id returning * into v_session;
 get diagnostics v_count=row_count;
 if v_count<>1 then raise exception 'identity_head_cas' using errcode='PT409'; end if;
 if exists(select 1 from public.asset_usages where selection_id in(v_previous.id,v_selection_id) and owner_id=v_owner and project_id=p_project and not(asset_id=any(v_assets))) then raise exception 'unprepared_identity_asset' using errcode='55000'; end if;
 select count(distinct asset_id) into v_expected_count from public.asset_usages where selection_id in(v_previous.id,v_selection_id) and owner_id=v_owner and project_id=p_project;
 update public.assets a set used=(a.legacy_used or exists(select 1 from public.asset_usages u join public.identity_sessions h on h.current_selection_id=u.selection_id and h.project_id=u.project_id and h.owner_id=u.owner_id
   where u.asset_id=a.id and u.owner_id=a.owner_id and u.project_id=a.project_id))
  where a.id=any(v_assets) and a.owner_id=v_owner and a.project_id=p_project and a.id in(select asset_id from public.asset_usages where selection_id in(v_previous.id,v_selection_id) and owner_id=v_owner and project_id=p_project);
 get diagnostics v_count=row_count;
 if v_count<>v_expected_count then raise exception 'identity_asset_write_count' using errcode='55000'; end if;
 select * into strict v_saved_system from public.identity_system_versions where id=v_system_id and owner_id=v_owner and project_id=p_project;
 v_response:=case when v_refinement then pg_catalog.jsonb_build_object('system',fluid_private.identity_system_json(v_saved_system),'change',fluid_private.identity_change_json(v_saved_change),'selection',fluid_private.identity_selection_json(v_selected))
  else pg_catalog.jsonb_build_object('session',fluid_private.identity_session_json(v_session),'currentSelection',pg_catalog.jsonb_build_object('selection',fluid_private.identity_selection_json(v_selected),'system',fluid_private.identity_system_json(v_saved_system),'freshness',v_freshness)) end;
 if v_response is distinct from v_expected then raise exception 'identity_persisted_receipt_mismatch' using errcode='55000'; end if;
 update pg_temp.identity_transaction_preparation set consumed=true where singleton and not consumed;
 get diagnostics v_count=row_count;
 if v_count<>1 then raise exception 'identity_preparation_consumed' using errcode='55000'; end if;
 return v_response;
end $$;

-- New objects only: remove hostile/default ACLs without changing global defaults
-- or any inherited helper ACL. No runtime login receives EXECUTE here.
do $$declare entry record; grant_row record;begin
 for entry in select p.oid,p.proowner,p.oid::regprocedure signature from pg_proc p where p.oid=any(array[
  'fluid_private.identity_web_owner()'::regprocedure::oid,'fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)'::regprocedure::oid,
  'fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)'::regprocedure::oid]) loop
  for grant_row in select distinct a.grantee from aclexplode(coalesce((select proacl from pg_proc where oid=entry.oid),acldefault('f',entry.proowner))) a where a.grantee<>entry.proowner loop
   execute format('revoke all on function %s from %s cascade',entry.signature,case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_row.grantee)) end);
  end loop;
 end loop;
 for grant_row in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid='fluid_private.identity_web_principals'::regclass and a.grantee<>c.relowner loop
  execute format('revoke all on table fluid_private.identity_web_principals from %s cascade',case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_row.grantee)) end);
 end loop;
end $$;
alter table fluid_private.identity_web_principals enable row level security;
alter table fluid_private.identity_web_principals force row level security;
create policy identity_transaction_binding_read on fluid_private.identity_web_principals for select to fluid_identity_writer_definer_v1
 using(login_role_name=session_user and login_role_oid=to_regrole(session_user)::oid);
do $$begin execute format('grant temporary on database %I to fluid_identity_writer_definer_v1',current_database()); end $$;
grant usage on schema public,fluid_private to fluid_identity_writer_definer_v1;
grant select on fluid_private.identity_web_principals to fluid_identity_writer_definer_v1;
grant execute on function fluid_private.identity_web_owner(),fluid_private.asset_library_project(public.projects),
 fluid_private.identity_session_json(public.identity_sessions),fluid_private.identity_preferences_json(public.identity_preferences),
 fluid_private.identity_system_json(public.identity_system_versions),fluid_private.identity_selection_json(public.identity_selections),
 fluid_private.identity_change_json(public.identity_component_changes),fluid_private.identity_reference_entry(uuid,uuid,uuid),fluid_private.identity_time_key(text)
 to fluid_identity_writer_definer_v1;
grant select on public.projects,public.project_revisions,public.identity_reference_heads,public.identity_references,
 public.identity_reference_reactions,public.identity_reference_snapshots,public.identity_sessions,public.identity_preferences,
 public.identity_input_snapshots,public.identity_batches,public.identity_generated_roots,public.identity_system_versions,
 public.identity_system_files,public.identity_selections,public.identity_component_changes,public.asset_usages,
 public.jobs,public.job_steps,public.assets,public.asset_versions to fluid_identity_writer_definer_v1;
grant insert on public.identity_reference_snapshots,public.identity_sessions,public.identity_system_versions,
 public.identity_system_files,public.identity_selections,public.identity_component_changes,public.asset_usages to fluid_identity_writer_definer_v1;
grant update(id) on public.projects,public.jobs to fluid_identity_writer_definer_v1;
grant update(project_id) on public.identity_reference_heads to fluid_identity_writer_definer_v1;
grant update(step_key) on public.job_steps to fluid_identity_writer_definer_v1;
grant update(identity_revision,current_selection_id,updated_at) on public.identity_sessions to fluid_identity_writer_definer_v1;
grant update(used) on public.assets to fluid_identity_writer_definer_v1;
do $$declare object_name text;begin
 foreach object_name in array array['projects','project_revisions','identity_reference_heads','identity_references',
  'identity_reference_reactions','identity_reference_snapshots','identity_sessions','identity_preferences',
  'identity_input_snapshots','identity_batches','identity_generated_roots','identity_system_versions',
  'identity_system_files','identity_selections','identity_component_changes','asset_usages','jobs','job_steps','assets','asset_versions'] loop
  execute pg_catalog.format('create policy identity_transaction_read on public.%I for select to fluid_identity_writer_definer_v1 using(owner_id=fluid_private.identity_web_owner())',object_name);
 end loop;
 foreach object_name in array array['identity_reference_snapshots','identity_sessions','identity_system_versions',
  'identity_system_files','identity_selections','identity_component_changes','asset_usages'] loop
  execute pg_catalog.format('create policy identity_transaction_insert on public.%I for insert to fluid_identity_writer_definer_v1 with check(owner_id=fluid_private.identity_web_owner())',object_name);
 end loop;
 foreach object_name in array array['projects','identity_reference_heads','identity_sessions','jobs','job_steps','assets'] loop
  execute pg_catalog.format('create policy identity_transaction_update on public.%I for update to fluid_identity_writer_definer_v1 using(owner_id=fluid_private.identity_web_owner()) with check(owner_id=fluid_private.identity_web_owner())',object_name);
 end loop;
end $$;

-- Temporary installer capabilities only. The original PG17 creator ADMIN edge
-- remains; this self-granted SET edge is removed explicitly by grantor.
grant create on schema fluid_private to fluid_identity_writer_definer_v1;
grant fluid_identity_writer_definer_v1 to postgres with inherit false,set true;
alter function fluid_private.prepare_identity_transaction(uuid,jsonb,boolean) owner to fluid_identity_writer_definer_v1;
alter function fluid_private.commit_identity_transaction(uuid,jsonb,jsonb) owner to fluid_identity_writer_definer_v1;
revoke create on schema fluid_private from fluid_identity_writer_definer_v1;
revoke fluid_identity_writer_definer_v1 from postgres granted by postgres;
do $$begin
 if exists(select 1 from pg_auth_members where member=to_regrole('fluid_identity_writer_definer_v1')::oid)
  or exists(select 1 from pg_auth_members where roleid=to_regrole('fluid_identity_writer_definer_v1')::oid and not(
   member=to_regrole('postgres')::oid and admin_option and not inherit_option and not set_option))
  or (select count(*) from pg_auth_members where roleid=to_regrole('fluid_identity_writer_definer_v1')::oid)>1
  or has_schema_privilege('fluid_identity_writer_definer_v1','public','CREATE') or has_schema_privilege('fluid_identity_writer_definer_v1','fluid_private','CREATE')
  then raise exception 'identity_transaction_installer_cleanup_unqualified' using errcode='55000'; end if;
end $$;
commit;
