-- SOURCE CANDIDATE ONLY. Apply after identity_transactions.sql and shared_worker_pool.sql.
-- No LOGIN, credential, owner binding, platform configuration or enabled default is created.
begin;
do $$
begin
 if session_user<>'postgres' or current_user<>session_user
  or to_regprocedure('fluid_private.shared_account_customer_active(uuid)') is null
  or to_regclass('fluid_private.shared_http_principals') is not null
  or (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='fluid_private.home_attachment_owner()'::regprocedure)<>'5b5f2a913343ce8c2785dc677e1e283aea7a5833f7c83a57b9da03197c4dd40b'
  or (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='fluid_private.identity_web_owner()'::regprocedure)<>'49895b45e6a1cafd7aee6966881f462ab74fba3d024c2385563f0a13efb93721'
 then raise exception 'shared_http_predecessor_unqualified' using errcode='55000'; end if;
end $$;

create table fluid_private.shared_http_principals(
 lane text primary key check(lane in('home','identity')),role_name name not null unique,role_oid oid not null unique,
 enabled boolean not null default false
);
create table fluid_private.shared_http_target(
 singleton boolean primary key default true check(singleton),mode text not null check(mode in('hosted','development')),origin text not null,
 check(mode='hosted' and origin~'^https://[a-z0-9]{20}\.supabase\.co$' or mode='development' and origin='http://127.0.0.1:54321')
);
create table fluid_private.shared_http_requests(
 token_hash bytea primary key,owner_id uuid not null references auth.users(id),session_id uuid not null references auth.sessions(id) on delete cascade,
 lane text not null references fluid_private.shared_http_principals(lane),role_oid oid not null,action text not null,
 arguments_hash bytea not null,eligibility_epoch bigint not null,expires_at timestamptz not null,consumed boolean not null default false
);
create index shared_http_request_expiry on fluid_private.shared_http_requests(owner_id,expires_at);
create table fluid_private.shared_http_contexts(
 backend_pid integer not null,transaction_id xid8 not null,role_name name not null,role_oid oid not null,
 token_hash bytea not null unique references fluid_private.shared_http_requests(token_hash),owner_id uuid not null,
 session_id uuid not null,lane text not null,action text not null,arguments jsonb not null,eligibility_epoch bigint not null,expires_at timestamptz not null,
 primary key(backend_pid,transaction_id)
);

create function fluid_private.shared_http_context_closed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from fluid_private.shared_http_contexts where backend_pid=new.backend_pid and transaction_id=new.transaction_id)
 then raise exception 'shared_http_context_cleanup_required' using errcode='55000'; end if;
 return null;
end $$;
create constraint trigger shared_http_context_cleanup after insert on fluid_private.shared_http_contexts
deferrable initially deferred for each row execute function fluid_private.shared_http_context_closed();

create function fluid_private.shared_http_role(p_lane text) returns oid
language plpgsql stable security definer set search_path='' as $$
declare r pg_catalog.pg_roles; p fluid_private.shared_http_principals; allowed oid[];
begin
 select * into p from fluid_private.shared_http_principals where lane=p_lane and enabled;
 select * into r from pg_catalog.pg_roles where oid=p.role_oid and rolname=p.role_name;
 allowed:=array[to_regprocedure('public.subscription_worker_owner()')::oid,to_regprocedure('public.subscription_worker_can_read_step(uuid,uuid)')::oid,
  to_regprocedure('public.api_text_worker_owner()')::oid,to_regprocedure('public.api_text_worker_can_read_step(uuid,uuid)')::oid,
  to_regprocedure('public.shared_account_http_principal()')::oid];
 if p_lane='home' then allowed:=allowed||to_regprocedure('public.execute_shared_home_request(text,text,jsonb,jsonb)')::oid;
 elsif p_lane='identity' then allowed:=allowed||array[to_regprocedure('public.prepare_shared_identity_request(text,uuid,jsonb,boolean)')::oid,
  to_regprocedure('public.commit_shared_identity_request(uuid,jsonb,jsonb)')::oid,to_regprocedure('public.finish_shared_identity_request()')::oid]; end if;
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
 then raise exception 'shared_http_principal_unqualified' using errcode='42501'; end if;
 return r.oid;
end $$;

create function fluid_private.shared_http_live(p_owner uuid,p_session uuid,p_expires timestamptz) returns boolean
language sql volatile security definer set search_path='' as $$
 select p_expires>clock_timestamp() and fluid_private.shared_account_customer_active(p_owner)
  and exists(select 1 from auth.sessions where id=p_session and user_id=p_owner and (not_after is null or not_after>clock_timestamp()));
$$;

-- Only verified PostgREST sessions can issue ownership delegation. There is no observation action or byte-evidence argument.
create function public.issue_shared_account_request(p_lane text,p_action text,p_arguments jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare claims jsonb:=auth.jwt(); owner uuid:=auth.uid(); sid uuid; role_id oid; expires timestamptz; token text;
begin
 if session_user<>'authenticator' or current_setting('role')<>'authenticated' or owner is null
  or claims->>'sub' is distinct from owner::text or claims->>'role' is distinct from 'authenticated'
  or claims->>'aud' is distinct from 'authenticated' or claims->>'is_anonymous' is distinct from 'false'
  or not exists(select 1 from fluid_private.shared_http_target where claims->>'iss'=origin||'/auth/v1')
  or jsonb_typeof(claims->'exp') is distinct from 'number' or jsonb_typeof(p_arguments)<>'array'
  or octet_length(p_arguments::text)>(case when p_lane='home' then 131072 else 40000 end)
 then raise exception 'shared_http_verified_session_required' using errcode='42501'; end if;
 sid:=(claims->>'session_id')::uuid;
 expires:=least(to_timestamp((claims->>'exp')::double precision),clock_timestamp()+interval '30 seconds');
 perform 1 from auth.users where id=owner for share;
 perform 1 from auth.sessions where id=sid and user_id=owner for share;
 perform 1 from fluid_private.shared_accounts where owner_id=owner for share;
 if not fluid_private.shared_http_live(owner,sid,expires) then raise exception 'shared_http_account_unavailable' using errcode='42501'; end if;
 role_id:=fluid_private.shared_http_role(p_lane);
 if not ((p_lane='identity' and p_action='identity' and jsonb_array_length(p_arguments)=3
    and jsonb_typeof(p_arguments->0)='string' and jsonb_typeof(p_arguments->1)='object' and jsonb_typeof(p_arguments->2)='boolean')
   or (p_lane='home' and p_action='prepare' and jsonb_array_length(p_arguments)=2
    and jsonb_typeof(p_arguments->0)='object' and jsonb_typeof(p_arguments->1)='number')
   or (p_lane='home' and p_action in('lookup','readback') and jsonb_array_length(p_arguments)=1 and jsonb_typeof(p_arguments->0)='string')
   or (p_lane='home' and p_action='lookup_project' and jsonb_array_length(p_arguments)=1 and jsonb_typeof(p_arguments->0)='string')
   or (p_lane='home' and p_action='save' and jsonb_array_length(p_arguments)=2 and jsonb_typeof(p_arguments->0)='object' and jsonb_typeof(p_arguments->1)='string')
   or (p_lane='home' and p_action='resolve' and jsonb_array_length(p_arguments)=1 and jsonb_typeof(p_arguments->0)='array' and jsonb_array_length(p_arguments->0)<=5))
 then raise exception 'shared_http_scope_invalid' using errcode='22023'; end if;
 if p_lane='identity' and not exists(select 1 from public.projects where id=(p_arguments->>0)::uuid and owner_id=owner)
  or p_lane='home' and p_action='readback' and not exists(select 1 from public.home_attachments where id=(p_arguments->>0)::uuid and owner_id=owner)
 then raise exception 'shared_http_scope_missing' using errcode='P0002'; end if;
 -- Bound abandoned delegations. These rows contain hashes and authority metadata, never passwords or JWTs.
 perform pg_advisory_xact_lock(hashtextextended(owner::text||':shared-http-issuer',0));
 delete from fluid_private.shared_http_requests r where r.owner_id=owner and r.expires_at<clock_timestamp()
  and not exists(select 1 from fluid_private.shared_http_contexts c where c.token_hash=r.token_hash);
 if (select count(*) from fluid_private.shared_http_requests where owner_id=owner and expires_at>clock_timestamp())>=64
 then raise exception 'shared_http_request_busy' using errcode='55000'; end if;
 token:=encode(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid()),'hex');
 insert into fluid_private.shared_http_requests values(sha256(convert_to(token,'UTF8')),owner,sid,p_lane,role_id,p_action,sha256(convert_to(p_arguments::text,'UTF8')),
  (select eligibility_epoch from fluid_private.shared_accounts where owner_id=owner),expires,false);
 return jsonb_build_object('version',1,'token',token,'ownerId',owner,'expiresAt',expires);
end $$;

create function fluid_private.shared_http_redeem(p_token text,p_lane text,p_action text,p_arguments jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare r fluid_private.shared_http_requests; snapshot fluid_private.shared_http_requests; role_id oid;
begin
 role_id:=fluid_private.shared_http_role(p_lane);
 if session_user<>(select role_name from fluid_private.shared_http_principals where lane=p_lane)
  or to_regrole(session_user)::oid<>role_id or current_setting('role')<>'none' or p_token!~'^[a-f0-9]{64}$'
  or exists(select 1 from fluid_private.shared_http_contexts where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 then raise exception 'shared_http_redemption_denied' using errcode='42501'; end if;
 -- Read immutable identity first. Auth/session deletion cascades token rows, so
 -- acquiring a token lock before its parent Auth locks would invert that order.
 select * into r from fluid_private.shared_http_requests where token_hash=sha256(convert_to(p_token,'UTF8'));
 if r.token_hash is null or r.consumed or r.lane<>p_lane or r.role_oid<>role_id or r.action<>p_action
  or r.arguments_hash<>sha256(convert_to(p_arguments::text,'UTF8'))
  or r.eligibility_epoch is distinct from (select eligibility_epoch from fluid_private.shared_accounts where owner_id=r.owner_id)
  or not fluid_private.shared_http_live(r.owner_id,r.session_id,r.expires_at)
 then raise exception 'shared_http_request_invalid' using errcode='42501'; end if;
 snapshot:=r;
 -- Hold real Auth/session rows until transaction outcome; no post-ban write race.
 perform 1 from auth.users where id=r.owner_id for share;
 perform 1 from auth.sessions where id=r.session_id and user_id=r.owner_id for share;
 perform 1 from fluid_private.shared_accounts where owner_id=r.owner_id for share;
 select * into r from fluid_private.shared_http_requests where token_hash=sha256(convert_to(p_token,'UTF8')) for update;
 if r.token_hash is null or r is distinct from snapshot or r.consumed or r.lane<>p_lane or r.role_oid<>role_id or r.action<>p_action
  or r.arguments_hash<>sha256(convert_to(p_arguments::text,'UTF8'))
  or not fluid_private.shared_http_live(r.owner_id,r.session_id,r.expires_at)
  or r.eligibility_epoch is distinct from (select eligibility_epoch from fluid_private.shared_accounts where owner_id=r.owner_id)
 then raise exception 'shared_http_account_unavailable' using errcode='42501'; end if;
 update fluid_private.shared_http_requests set consumed=true where token_hash=r.token_hash;
 insert into fluid_private.shared_http_contexts values(pg_backend_pid(),pg_current_xact_id(),session_user,role_id,r.token_hash,r.owner_id,r.session_id,p_lane,p_action,p_arguments,r.eligibility_epoch,r.expires_at);
 return r.owner_id;
end $$;

-- No owner argument. NULL only for an unregistered legacy login; registered shared callers fail closed without their private request context.
create function fluid_private.shared_http_context_owner(p_lane text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare c fluid_private.shared_http_contexts; role_id oid;
begin
 if not exists(select 1 from fluid_private.shared_http_principals where role_name=session_user) then return null; end if;
 role_id:=fluid_private.shared_http_role(p_lane);
 select * into c from fluid_private.shared_http_contexts where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()
  and role_name=session_user and role_oid=role_id and lane=p_lane;
 if c.owner_id is null or c.eligibility_epoch is distinct from (select eligibility_epoch from fluid_private.shared_accounts where owner_id=c.owner_id)
  or not fluid_private.shared_http_live(c.owner_id,c.session_id,c.expires_at)
 then raise exception 'shared_http_context_required' using errcode='42501'; end if;
 return c.owner_id;
end $$;

-- The checked legacy body remains byte-for-byte as suffix; its independent login/owner path remains authoritative for every unregistered login.
do $$
declare body text;
begin
 select prosrc into body from pg_proc where oid='fluid_private.home_attachment_owner()'::regprocedure;
 body:=replace(body,E'begin\n',E'begin\n result:=fluid_private.shared_http_context_owner(''home''); if result is not null then return result; end if;\n');
 execute format('create or replace function fluid_private.home_attachment_owner() returns uuid language plpgsql stable security definer set search_path='''' as %L',body);
 select prosrc into body from pg_proc where oid='fluid_private.identity_web_owner()'::regprocedure;
 body:=replace(body,E'begin\n',E'begin\n owner:=fluid_private.shared_http_context_owner(''identity''); if owner is not null then return owner; end if;\n');
 execute format('create or replace function fluid_private.identity_web_owner() returns uuid language plpgsql stable security invoker set search_path='''' as %L',body);
end $$;

create function public.prepare_shared_identity_request(p_token text,p_project uuid,p_request jsonb,p_refinement boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid;
begin
 owner:=fluid_private.shared_http_redeem(p_token,'identity','identity',jsonb_build_array(p_project,p_request,p_refinement));
 perform set_config('request.jwt.claim.sub',owner::text,true);
 return fluid_private.prepare_identity_transaction(p_project,p_request,p_refinement);
end $$;

create function public.commit_shared_identity_request(p_project uuid,p_request jsonb,p_proposal jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid; c fluid_private.shared_http_contexts; result jsonb;
begin
 owner:=fluid_private.shared_http_context_owner('identity');
 if owner is null then raise exception 'shared_http_context_required' using errcode='42501'; end if;
 select * into strict c from fluid_private.shared_http_contexts where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if c.action<>'identity' or c.arguments->0<>to_jsonb(p_project) or c.arguments->1 is distinct from p_request
 then raise exception 'shared_http_request_mismatch' using errcode='42501'; end if;
 result:=fluid_private.commit_identity_transaction(p_project,p_request,p_proposal);
 return result;
end $$;

create function public.finish_shared_identity_request() returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if fluid_private.shared_http_context_owner('identity') is null then raise exception 'shared_http_context_required' using errcode='42501'; end if;
 delete from fluid_private.shared_http_contexts where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and role_name=session_user;
 return true;
end $$;

-- Only the fixed verifier may supply observations. A customer's 'readback' scope contains attachment identity only, never byte evidence.
create function public.execute_shared_home_request(p_token text,p_action text,p_arguments jsonb,p_observation jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid; result jsonb;
begin
 owner:=fluid_private.shared_http_redeem(p_token,'home',p_action,p_arguments);
 -- Compatibility RPCs derive auth.uid from this transaction-local, independently verified context; caller GUCs never supply the owner.
 perform set_config('request.jwt.claim.sub',owner::text,true);
 case p_action
 when 'prepare' then result:=fluid_private.prepare_home_attachment(p_arguments->0,(p_arguments->>1)::bigint);
 when 'lookup' then result:=fluid_private.lookup_home_attachment((p_arguments->>0)::uuid);
 when 'resolve' then result:=fluid_private.resolve_home_attachments(array(select value::uuid from jsonb_array_elements_text(p_arguments->0)));
 when 'save' then result:=public.save_attached_home_project(p_arguments->0,p_arguments->>1);
 when 'lookup_project' then result:=public.read_attached_home_project_request((p_arguments->>0)::uuid);
 when 'readback' then
  if p_observation is null then raise exception 'shared_http_observation_required' using errcode='22023'; end if;
  result:=fluid_private.observe_home_attachment((p_arguments->>0)::uuid,p_observation);
 else raise exception 'shared_http_action_invalid' using errcode='22023';
 end case;
 if p_action<>'readback' and p_observation is not null then raise exception 'shared_http_scope_invalid' using errcode='22023'; end if;
 delete from fluid_private.shared_http_contexts where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and role_name=session_user;
 return result;
end $$;

create function public.shared_account_http_principal() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p fluid_private.shared_http_principals;
begin
 select * into p from fluid_private.shared_http_principals where role_name=session_user and role_oid=to_regrole(session_user)::oid;
 if p.role_oid is null or current_setting('role')<>'none' or fluid_private.shared_http_role(p.lane)<>p.role_oid
 then raise exception 'shared_http_principal_unqualified' using errcode='42501'; end if;
 return jsonb_build_object('version',1,'lane',p.lane,'roleName',p.role_name,'roleOid',p.role_oid::bigint,'origin',(select origin from fluid_private.shared_http_target));
end $$;

-- Raw customer Storage requests do not traverse the web delegation gateway.
-- Recheck the verified JWT's physical Auth session and current account here;
-- object history is independent of the admission epoch and survives re-login.
-- Fixed service actors retain their separate execution/path Storage policies.
create function fluid_private.shared_http_customer_storage_live() returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare owner uuid:=auth.uid(); claims jsonb:=auth.jwt(); sid uuid;
begin
 if owner is null then return false; end if;
 if not exists(select 1 from fluid_private.shared_accounts where owner_id=owner)
  or exists(select 1 from fluid_private.shared_service_actors where auth_user_id=owner) then return true; end if;
 if claims->>'sub' is distinct from owner::text or claims->>'role' is distinct from 'authenticated'
  or claims->>'aud' is distinct from 'authenticated' or claims->'is_anonymous' is distinct from 'false'::jsonb
  or not coalesce(fluid_private.logo_uuid(claims->'session_id'),false)
  or jsonb_typeof(claims->'exp') is distinct from 'number'
  or (claims->>'exp')::numeric<=extract(epoch from clock_timestamp())
  or claims ? 'nbf' and (jsonb_typeof(claims->'nbf') is distinct from 'number'
   or (claims->>'nbf')::numeric>extract(epoch from clock_timestamp()))
  or not exists(select 1 from fluid_private.shared_http_target where singleton and claims->>'iss'=origin||'/auth/v1') then return false; end if;
 sid:=(claims->>'session_id')::uuid;
 -- Hold actual Auth rows through this Storage transaction. A concurrent ban or
 -- session deletion must serialize with the final request authority check.
 perform 1 from auth.users where id=owner for share;
 perform 1 from auth.sessions where id=sid and user_id=owner for share;
 perform 1 from fluid_private.shared_accounts where owner_id=owner for share;
 return fluid_private.shared_account_customer_active(owner)
  and exists(select 1 from auth.sessions where id=sid and user_id=owner and (not_after is null or not_after>clock_timestamp()));
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

-- Reset arbitrary default ACL grants on our new objects, then grant only fixed intended call surfaces.
do $$
declare target record; grantee record;
begin
 for target in select c.oid,c.relowner from pg_class c where c.oid in('fluid_private.shared_http_principals'::regclass,'fluid_private.shared_http_target'::regclass,'fluid_private.shared_http_requests'::regclass,'fluid_private.shared_http_contexts'::regclass) loop
  execute format('alter table %s enable row level security',target.oid::regclass); execute format('alter table %s force row level security',target.oid::regclass);
  for grantee in select distinct a.grantee from aclexplode(coalesce((select relacl from pg_class where oid=target.oid),acldefault('r',target.relowner))) a where a.grantee<>target.relowner loop
   execute format('revoke all on table %s from %s',target.oid::regclass,case when grantee.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grantee.grantee)) end);
  end loop;
 end loop;
 for target in select p.oid,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in('public','fluid_private') and p.proname in('shared_http_context_closed','shared_http_role','shared_http_live','shared_http_redeem','shared_http_context_owner','shared_http_customer_storage_live','issue_shared_account_request','prepare_shared_identity_request','commit_shared_identity_request','finish_shared_identity_request','execute_shared_home_request','shared_account_http_principal') loop
  for grantee in select distinct a.grantee from aclexplode(coalesce((select proacl from pg_proc where oid=target.oid),acldefault('f',target.proowner))) a where a.grantee<>target.proowner loop
   execute format('revoke all on function %s from %s',target.oid::regprocedure,case when grantee.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grantee.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.issue_shared_account_request(text,text,jsonb) to authenticated;
grant execute on function fluid_private.shared_http_context_owner(text) to fluid_identity_writer_definer_v1;
grant execute on function fluid_private.shared_http_customer_storage_live() to authenticated;
create policy embel_shared_customer_storage_live on storage.objects as restrictive for all to authenticated
 using(bucket_id<>'fluid-assets' or (select fluid_private.shared_http_customer_storage_live()))
 with check(bucket_id<>'fluid-assets' or (select fluid_private.shared_http_customer_storage_live()));
-- Operator installation separately registers exact fixed restricted logins and grants ONLY:
-- Identity: public.shared_account_http_principal(), public.prepare_shared_identity_request(text,uuid,jsonb,boolean),
-- public.commit_shared_identity_request(uuid,jsonb,jsonb), public.finish_shared_identity_request().
-- Home verifier: public.shared_account_http_principal(), public.execute_shared_home_request(text,text,jsonb,jsonb).
commit;
