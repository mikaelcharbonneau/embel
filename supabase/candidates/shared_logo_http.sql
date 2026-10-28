-- UNAPPLIED shared Logo web authority. No roles, credentials, provider calls or live grants.
-- Apply after shared_account_http.sql; this separate purpose never widens its Home/Identity issuers.
begin;
do $$begin
 if session_user<>'postgres' or current_user<>session_user or to_regclass('fluid_private.shared_http_target') is null
  or to_regclass('fluid_private.shared_logo_http_principals') is not null
  or (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='fluid_private.logo_asset_web_owner()'::regprocedure)<>'b566cac09087444c2c095394bfcc90d1955fd290afd41cf549c53139bfe38b8c'
 then raise exception 'shared_logo_http_predecessor_unqualified' using errcode='55000';end if;
end $$;
create table fluid_private.shared_logo_http_principals(
 lane text primary key check(lane='logo'),role_name name not null unique,role_oid oid not null unique,
 enabled boolean not null default false
);
create table fluid_private.shared_logo_http_requests(
 token_hash bytea primary key,owner_id uuid not null references auth.users(id),session_id uuid not null references auth.sessions(id) on delete cascade,
 lane text not null references fluid_private.shared_logo_http_principals(lane),role_oid oid not null,action text not null,
 arguments_hash bytea not null,eligibility_epoch bigint not null,expires_at timestamptz not null,consumed boolean not null default false
);
create index shared_logo_http_request_expiry on fluid_private.shared_logo_http_requests(owner_id,expires_at);
create table fluid_private.shared_logo_http_contexts(
 backend_pid integer not null,transaction_id xid8 not null,role_name name not null,role_oid oid not null,
 token_hash bytea not null unique references fluid_private.shared_logo_http_requests(token_hash),owner_id uuid not null,
 session_id uuid not null,lane text not null,action text not null,arguments jsonb not null,eligibility_epoch bigint not null,expires_at timestamptz not null,
 primary key(backend_pid,transaction_id)
);


create function fluid_private.shared_logo_http_context_closed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from fluid_private.shared_logo_http_contexts where backend_pid=new.backend_pid and transaction_id=new.transaction_id)
 then raise exception 'shared_logo_http_context_cleanup_required' using errcode='55000'; end if;
 return null;
end $$;
create constraint trigger shared_logo_http_context_cleanup after insert on fluid_private.shared_logo_http_contexts deferrable initially deferred for each row execute function fluid_private.shared_logo_http_context_closed();
create function fluid_private.shared_logo_http_role(p_lane text) returns oid
language plpgsql stable security definer set search_path='' as $$
declare r pg_catalog.pg_roles; p fluid_private.shared_logo_http_principals; allowed oid[];
begin
 select * into p from fluid_private.shared_logo_http_principals where lane=p_lane and enabled;
 select * into r from pg_catalog.pg_roles where oid=p.role_oid and rolname=p.role_name;
 allowed:=array[to_regprocedure('public.subscription_worker_owner()')::oid,to_regprocedure('public.subscription_worker_can_read_step(uuid,uuid)')::oid,
  to_regprocedure('public.api_text_worker_owner()')::oid,to_regprocedure('public.api_text_worker_can_read_step(uuid,uuid)')::oid,
  to_regprocedure('public.shared_logo_http_principal()')::oid];
 if p_lane<>'logo' then raise exception 'shared_logo_http_lane_denied' using errcode='42501'; end if;
 allowed:=allowed||to_regprocedure('public.execute_shared_logo_request(text,text,jsonb,jsonb)')::oid;
 allowed:=array_remove(allowed,null);
 if r.oid is null or not r.rolcanlogin or r.rolinherit or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolbypassrls or r.rolreplication
  or exists(select 1 from pg_catalog.pg_auth_members where member=r.oid
   or roleid=r.oid and not(member=to_regrole('postgres')::oid and admin_option and not inherit_option and not set_option))
  or exists(select 1 from pg_catalog.pg_class where relowner=r.oid)
  or exists(select 1 from pg_catalog.pg_namespace where nspowner=r.oid)
  or exists(select 1 from pg_catalog.pg_proc where proowner=r.oid)
  or has_database_privilege(r.oid,current_database(),'CREATE')
  or has_schema_privilege(r.oid,'public','CREATE') or has_schema_privilege(r.oid,'fluid_private','CREATE') or has_schema_privilege(r.oid,'fluid_private','USAGE')
  or exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname in('public','fluid_private','auth','storage') and c.relkind in('r','p','v','m','f')
   and (has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') or has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE,TRIGGER')))
  or exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where case when n.nspname in('public','fluid_private','auth','storage') and c.relkind='S'
    then has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE') else false end)
  or exists(select 1 from pg_catalog.pg_proc fn join pg_catalog.pg_namespace ns on ns.oid=fn.pronamespace
   where ns.nspname='public' and fn.prosecdef and has_function_privilege(r.oid,fn.oid,'EXECUTE') and not(fn.oid=any(allowed)))
 then raise exception 'shared_logo_http_principal_unqualified' using errcode='42501'; end if;
 return r.oid;
end $$;
create function fluid_private.shared_logo_http_live(p_owner uuid,p_session uuid,p_expires timestamptz) returns boolean
language sql volatile security definer set search_path='' as $$
 select p_expires>clock_timestamp() and fluid_private.shared_account_customer_active(p_owner)
  and exists(select 1 from auth.sessions where id=p_session and user_id=p_owner and (not_after is null or not_after>clock_timestamp()));
$$;
create function public.issue_shared_logo_request(p_action text,p_arguments jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p_lane text:='logo'; claims jsonb:=auth.jwt(); owner uuid:=auth.uid(); sid uuid; role_id oid; expires timestamptz; token text;
begin
 if session_user<>'authenticator' or current_setting('role')<>'authenticated' or owner is null
  or claims->>'sub' is distinct from owner::text or claims->>'role' is distinct from 'authenticated'
  or claims->>'aud' is distinct from 'authenticated' or claims->>'is_anonymous' is distinct from 'false'
  or not exists(select 1 from fluid_private.shared_http_target where claims->>'iss'=origin||'/auth/v1')
  or jsonb_typeof(claims->'exp') is distinct from 'number' or jsonb_typeof(p_arguments)<>'array'
  or octet_length(p_arguments::text)>1048576
 then raise exception 'shared_logo_http_verified_session_required' using errcode='42501'; end if;
 sid:=(claims->>'session_id')::uuid;
 expires:=least(to_timestamp((claims->>'exp')::double precision),clock_timestamp()+interval '30 seconds');
 perform 1 from auth.users where id=owner for share;
 perform 1 from auth.sessions where id=sid and user_id=owner for share;
 perform 1 from fluid_private.shared_accounts where owner_id=owner for share;
 if not fluid_private.shared_logo_http_live(owner,sid,expires) then raise exception 'shared_logo_http_account_unavailable' using errcode='42501'; end if;
 role_id:=fluid_private.shared_logo_http_role(p_lane);
 if p_action not in('asset_prepare','asset_readback','command_read','command_apply','input_prepare','input_commit','proposal_quote')
  or jsonb_array_length(p_arguments)<>2 or jsonb_typeof(p_arguments->0)<>'string'
  or (p_action='asset_readback' and jsonb_typeof(p_arguments->1)<>'string')
  or (p_action<>'asset_readback' and jsonb_typeof(p_arguments->1)<>'object')
 then raise exception 'shared_logo_http_scope_invalid' using errcode='22023';end if;
 if not exists(select 1 from public.projects where id=(p_arguments->>0)::uuid and owner_id=owner)
  or p_action='asset_readback' and not exists(select 1 from public.logo_asset_publications
   where id=(p_arguments->>1)::uuid and project_id=(p_arguments->>0)::uuid and owner_id=owner)
 then raise exception 'shared_logo_http_scope_missing' using errcode='P0002';end if;
 -- Bound abandoned delegations. These rows contain hashes and authority metadata, never passwords or JWTs.
 perform pg_advisory_xact_lock(hashtextextended(owner::text||':shared-http-issuer',0));
 delete from fluid_private.shared_logo_http_requests r where r.owner_id=owner and r.expires_at<clock_timestamp()
  and not exists(select 1 from fluid_private.shared_logo_http_contexts c where c.token_hash=r.token_hash);
 if (select count(*) from fluid_private.shared_logo_http_requests where owner_id=owner and expires_at>clock_timestamp())>=64
 then raise exception 'shared_logo_http_request_busy' using errcode='55000'; end if;
 token:=encode(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid()),'hex');
 insert into fluid_private.shared_logo_http_requests values(sha256(convert_to(token,'UTF8')),owner,sid,p_lane,role_id,p_action,sha256(convert_to(p_arguments::text,'UTF8')),
  (select eligibility_epoch from fluid_private.shared_accounts where owner_id=owner),expires,false);
 return jsonb_build_object('version',1,'token',token,'ownerId',owner,'expiresAt',expires);
end $$;
create function fluid_private.shared_logo_http_redeem(p_token text,p_lane text,p_action text,p_arguments jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare r fluid_private.shared_logo_http_requests; snapshot fluid_private.shared_logo_http_requests; role_id oid;
begin
 role_id:=fluid_private.shared_logo_http_role(p_lane);
 if session_user<>(select role_name from fluid_private.shared_logo_http_principals where lane=p_lane)
  or to_regrole(session_user)::oid<>role_id or current_setting('role')<>'none' or p_token!~'^[a-f0-9]{64}$'
  or exists(select 1 from fluid_private.shared_logo_http_contexts where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 then raise exception 'shared_logo_http_redemption_denied' using errcode='42501'; end if;
 -- Read immutable identity first. Auth/session deletion cascades token rows, so
 -- acquiring a token lock before its parent Auth locks would invert that order.
 select * into r from fluid_private.shared_logo_http_requests where token_hash=sha256(convert_to(p_token,'UTF8'));
 if r.token_hash is null or r.consumed or r.lane<>p_lane or r.role_oid<>role_id or r.action<>p_action
  or r.arguments_hash<>sha256(convert_to(p_arguments::text,'UTF8'))
  or r.eligibility_epoch is distinct from (select eligibility_epoch from fluid_private.shared_accounts where owner_id=r.owner_id)
  or not fluid_private.shared_logo_http_live(r.owner_id,r.session_id,r.expires_at)
 then raise exception 'shared_logo_http_request_invalid' using errcode='42501'; end if;
 snapshot:=r;
 -- Hold real Auth/session rows until transaction outcome; no post-ban write race.
 perform 1 from auth.users where id=r.owner_id for share;
 perform 1 from auth.sessions where id=r.session_id and user_id=r.owner_id for share;
 perform 1 from fluid_private.shared_accounts where owner_id=r.owner_id for share;
 select * into r from fluid_private.shared_logo_http_requests where token_hash=sha256(convert_to(p_token,'UTF8')) for update;
 if r.token_hash is null or r is distinct from snapshot or r.consumed or r.lane<>p_lane or r.role_oid<>role_id or r.action<>p_action
  or r.arguments_hash<>sha256(convert_to(p_arguments::text,'UTF8'))
  or not fluid_private.shared_logo_http_live(r.owner_id,r.session_id,r.expires_at)
  or r.eligibility_epoch is distinct from (select eligibility_epoch from fluid_private.shared_accounts where owner_id=r.owner_id)
 then raise exception 'shared_logo_http_account_unavailable' using errcode='42501'; end if;
 update fluid_private.shared_logo_http_requests set consumed=true where token_hash=r.token_hash;
 insert into fluid_private.shared_logo_http_contexts values(pg_backend_pid(),pg_current_xact_id(),session_user,role_id,r.token_hash,r.owner_id,r.session_id,p_lane,p_action,p_arguments,r.eligibility_epoch,r.expires_at);
 return r.owner_id;
end $$;
create function fluid_private.shared_logo_http_context_owner(p_lane text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare c fluid_private.shared_logo_http_contexts; role_id oid;
begin
 if not exists(select 1 from fluid_private.shared_logo_http_principals where role_name=session_user) then return null; end if;
 role_id:=fluid_private.shared_logo_http_role(p_lane);
 select * into c from fluid_private.shared_logo_http_contexts where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()
  and role_name=session_user and role_oid=role_id and lane=p_lane;
 if c.owner_id is null or c.eligibility_epoch is distinct from (select eligibility_epoch from fluid_private.shared_accounts where owner_id=c.owner_id)
  or not fluid_private.shared_logo_http_live(c.owner_id,c.session_id,c.expires_at)
 then raise exception 'shared_logo_http_context_required' using errcode='42501'; end if;
 return c.owner_id;
end $$;
-- Preserve every original legacy statement; only the exact shared login can use the private context branch.
do $$declare body text;begin
 select prosrc into body from pg_proc where oid='fluid_private.logo_asset_web_owner()'::regprocedure;
 body:=replace(body,E'begin\n',E'begin\n result:=fluid_private.shared_logo_http_context_owner(''logo''); if result is not null then return result; end if;\n');
 execute format('create or replace function fluid_private.logo_asset_web_owner() returns uuid language plpgsql stable security definer set search_path='''' as %L',body);
end $$;

-- Public scope is user intent, NEVER byte observations, materialization or font-validation evidence.
create function public.execute_shared_logo_request(p_token text,p_action text,p_arguments jsonb,p_evidence jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid; result jsonb; project uuid;
begin
 owner:=fluid_private.shared_logo_http_redeem(p_token,'logo',p_action,p_arguments);
 project:=(p_arguments->>0)::uuid;
 if p_evidence is not null and octet_length(p_evidence::text)>4194304 then raise exception 'shared_logo_http_evidence_unbounded' using errcode='22023';end if;
 if p_action in('asset_prepare','command_read','input_prepare') and p_evidence is not null
  or p_action in('asset_readback','command_apply','input_commit','proposal_quote') and p_evidence is null
 then raise exception 'shared_logo_http_evidence_scope_invalid' using errcode='22023';end if;
 case p_action
 when 'asset_prepare' then result:=fluid_private.prepare_logo_asset(project,p_arguments->1,null,null);
 when 'asset_readback' then result:=fluid_private.observe_logo_asset((p_arguments->>1)::uuid,p_evidence,null,null);
 when 'command_read' then
  if p_arguments#>>'{1,method}'='applyLogoVectorProposal' then
   if to_regprocedure('fluid_private.shared_logo_read_proposal_command(uuid,jsonb)') is null then raise exception 'shared_logo_proposal_unavailable' using errcode='55000';end if;
   execute 'select fluid_private.shared_logo_read_proposal_command($1,$2)' into result using project,p_arguments->1;
  else result:=fluid_private.read_logo_trusted_request(project,p_arguments->1);end if;
 when 'command_apply' then
  if p_arguments#>>'{1,method}'='applyLogoVectorProposal' then
   if to_regprocedure('fluid_private.shared_logo_apply_proposal_command(uuid,jsonb,jsonb)') is null then raise exception 'shared_logo_proposal_unavailable' using errcode='55000';end if;
   execute 'select fluid_private.shared_logo_apply_proposal_command($1,$2,$3)' into result using project,p_arguments->1,p_evidence;
  else result:=fluid_private.apply_logo_trusted_command(project,p_arguments->1,p_evidence);end if;
 when 'input_prepare' then result:=fluid_private.prepare_logo_input(project,p_arguments->1);
 when 'input_commit' then
  if jsonb_typeof(p_evidence)<>'object' or not(p_evidence ?& array['receipt','evidence']) or p_evidence-array['receipt','evidence']<>'{}'
  then raise exception 'shared_logo_http_evidence_scope_invalid' using errcode='22023';end if;
  result:=fluid_private.commit_logo_input(project,p_arguments->1,p_evidence->'receipt',p_evidence->'evidence');
 when 'proposal_quote' then
  if p_evidence->'request' is distinct from p_arguments->1 then raise exception 'shared_logo_http_quote_intent_mismatch' using errcode='42501';end if;
  if to_regprocedure('fluid_private.shared_logo_quote_vector_proposal(uuid,jsonb)') is null then raise exception 'shared_logo_proposal_unavailable' using errcode='55000';end if;
  execute 'select fluid_private.shared_logo_quote_vector_proposal($1,$2)' into result using project,p_evidence;
 else raise exception 'shared_logo_http_action_invalid' using errcode='22023';
 end case;
 delete from fluid_private.shared_logo_http_contexts where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and role_name=session_user;
 return result;
end $$;
create function public.shared_logo_http_principal() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p fluid_private.shared_logo_http_principals;
begin
 select * into p from fluid_private.shared_logo_http_principals where role_name=session_user and role_oid=to_regrole(session_user)::oid;
 if p.role_oid is null or p.lane<>'logo' or current_setting('role')<>'none' or fluid_private.shared_logo_http_role('logo')<>p.role_oid
 then raise exception 'shared_logo_http_principal_unqualified' using errcode='42501';end if;
 return jsonb_build_object('version',1,'lane','logo','roleName',p.role_name,'roleOid',p.role_oid::bigint,'origin',(select origin from fluid_private.shared_http_target));
end $$;
-- Reset arbitrary default ACL grants on our new objects, then grant only fixed intended call surfaces.
do $$
declare target record; grantee record;
begin
 for target in select c.oid,c.relowner from pg_class c where c.oid in('fluid_private.shared_logo_http_principals'::regclass,'fluid_private.shared_logo_http_requests'::regclass,'fluid_private.shared_logo_http_contexts'::regclass) loop
  execute format('alter table %s enable row level security',target.oid::regclass); execute format('alter table %s force row level security',target.oid::regclass);
  for grantee in select distinct a.grantee from aclexplode(coalesce((select relacl from pg_class where oid=target.oid),acldefault('r',target.relowner))) a where a.grantee<>target.relowner loop
   execute format('revoke all on table %s from %s',target.oid::regclass,case when grantee.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grantee.grantee)) end);
  end loop;
 end loop;
 for target in select p.oid,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in('public','fluid_private') and p.proname in('shared_logo_http_context_closed','shared_logo_http_role','shared_logo_http_live','shared_logo_http_redeem','shared_logo_http_context_owner','issue_shared_logo_request','execute_shared_logo_request','shared_logo_http_principal') loop
  for grantee in select distinct a.grantee from aclexplode(coalesce((select proacl from pg_proc where oid=target.oid),acldefault('f',target.proowner))) a where a.grantee<>target.proowner loop
   execute format('revoke all on function %s from %s',target.oid::regprocedure,case when grantee.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grantee.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.issue_shared_logo_request(text,jsonb) to authenticated;
-- Separately approved operator registers/enables exact fixed role, grants public schema USAGE and ONLY:
-- public.shared_logo_http_principal(), public.execute_shared_logo_request(text,text,jsonb,jsonb).
commit;
