-- UNAPPLIED fixed-slot Storage authority. No Auth account, password, enabled
-- binding, bucket, provider function, owner role or credential is provisioned.
-- Install after shared_worker_logo.sql and the reviewed legacy Storage packets.
begin;
do $$begin
 if not exists(select 1 from pg_proc where oid=to_regprocedure('fluid_private.logo_generative_storage_member(public.jobs,public.logo_asset_publications,text)')
  and proowner=to_regrole('postgres')::oid and proconfig=array['search_path=""'] and not proleakproof
  and md5(prosrc)='29fc321cdb2cc4a1b814f84e6679fd7f') then raise exception 'shared_storage_lineage_predecessor_mismatch' using errcode='55000'; end if;
 if not exists(select 1 from pg_proc where oid=to_regprocedure('fluid_private.shared_http_customer_storage_live()')
  and proowner=to_regrole('postgres')::oid and prosecdef and provolatile='v' and proconfig=array['search_path=""'] and not proleakproof
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='063abd63edbfb2608e3fea7ffbdb59dda98e1c3df18369fc3d03e6bd6c6d4866')
  or not exists(select 1 from pg_policy where polrelid='storage.objects'::regclass and polname='embel_shared_customer_storage_live'
   and not polpermissive and polcmd='*' and polroles=array[to_regrole('authenticated')::oid]
   and pg_get_expr(polqual,polrelid)=$gate$((bucket_id <> 'fluid-assets'::text) OR ( SELECT fluid_private.shared_http_customer_storage_live() AS shared_http_customer_storage_live))$gate$
   and pg_get_expr(polwithcheck,polrelid)=pg_get_expr(polqual,polrelid))
 then raise exception 'shared_storage_customer_gate_predecessor_mismatch' using errcode='55000'; end if;
end $$;
create table fluid_private.shared_storage_target (
 singleton boolean primary key default true check(singleton), origin text not null check(origin ~ '^https://[^/?#@]+$' or origin ~ '^http://127[.]0[.]0[.]1:[0-9]{4,5}$')
);
create table fluid_private.shared_storage_actors (
 auth_user_id uuid primary key references fluid_private.shared_service_actors(auth_user_id),
 slot_id uuid not null unique references fluid_private.shared_worker_slots(slot_id),
 enabled boolean not null default false,
 verified_session_id uuid,verified_instance_id uuid,verified_generation bigint,verified_at timestamptz
);
-- Issued immutable-output authorization is evidence. Session logout must revoke
-- use, without cascading deletion of that evidence needed for reconciliation.
create table fluid_private.shared_storage_grants (
 session_id uuid not null, auth_user_id uuid not null references fluid_private.shared_storage_actors(auth_user_id),
 execution_id uuid not null references fluid_private.shared_worker_executions(execution_id),
 reservation_id uuid not null references public.logo_asset_publications(id),
 storage_path text not null check(length(storage_path)<=147),
 mode text not null check(mode in('read','write','observe')),member text not null check(member in('reference','base','source','font','logo-document','output')),
 binding jsonb not null,created_at timestamptz not null default clock_timestamp(),
 primary key(session_id,execution_id,reservation_id,mode),
 check((mode='read' and member in('reference','base','source','font','logo-document')) or (mode in('write','observe') and member='output'))
);
create index shared_storage_issued_output on fluid_private.shared_storage_grants(execution_id,reservation_id) where mode='write';
create index shared_storage_exact_object on fluid_private.shared_storage_grants(session_id,auth_user_id,storage_path);
create function fluid_private.shared_storage_identity_bound() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from fluid_private.shared_service_actors where auth_user_id=auth.uid() and purpose='logo_storage')
 or exists(select 1 from fluid_private.shared_storage_actors where auth_user_id=auth.uid());
$$;
-- A permanent legacy actor cannot fall back to ordinary customer Storage if
-- its old registry row is removed. Existing rows still use every unchanged
-- legacy session/reservation/policy check; this grants no access on its own.
create function fluid_private.shared_storage_legacy_registry_present() returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from fluid_private.shared_service_actors where auth_user_id=auth.uid() and purpose='legacy_logo_storage')
  or exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=auth.uid());
$$;
create function fluid_private.shared_storage_auth_context() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare claims jsonb:=auth.jwt(); actor uuid:=auth.uid(); sid uuid; result jsonb;
begin
 if actor is null or claims->>'sub' is distinct from actor::text or claims->>'role' is distinct from 'authenticated'
  or claims->>'aud' is distinct from 'authenticated' or claims->'is_anonymous' is distinct from 'false'::jsonb
  or not coalesce(fluid_private.logo_uuid(claims->'session_id'),false) or jsonb_typeof(claims->'exp') is distinct from 'number'
  or (claims->>'exp')::numeric<=extract(epoch from clock_timestamp()) then return null; end if;
 sid:=(claims->>'session_id')::uuid;
 select jsonb_build_object('version',1,'slotId',s.slot_id,'instanceId',s.instance_id,'generation',s.generation,
  'roleName',s.role_name,'roleOid',s.role_oid::bigint,'authUserId',actor,'sessionId',sid) into result
 from fluid_private.shared_storage_actors a join fluid_private.shared_service_actors marker on marker.auth_user_id=a.auth_user_id and marker.purpose='logo_storage'
 join fluid_private.shared_worker_slots s on s.slot_id=a.slot_id and s.lane='logo'
 join auth.sessions session on session.id=sid and session.user_id=actor
 join auth.users u on u.id=actor cross join fluid_private.shared_storage_target target
 where a.auth_user_id=actor and a.enabled and target.singleton and claims->>'iss'=target.origin||'/auth/v1'
  and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false) and u.deleted_at is null
  and (u.banned_until is null or u.banned_until<=clock_timestamp()) and (session.not_after is null or session.not_after>clock_timestamp())
  and fluid_private.shared_worker_role_safe(s.role_name,s.role_oid)
  and not exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=actor);
 return result;
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end $$;
create function public.shared_logo_storage_session() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare context jsonb:=fluid_private.shared_storage_auth_context();
begin
 if context is null or not exists(select 1 from fluid_private.shared_worker_slots where slot_id=(context->>'slotId')::uuid and enabled
  and expires_at>clock_timestamp() and instance_id is not null) then raise exception 'shared_storage_session_unavailable' using errcode='42501'; end if;
 update fluid_private.shared_storage_actors set verified_session_id=(context->>'sessionId')::uuid,verified_instance_id=(context->>'instanceId')::uuid,
  verified_generation=(context->>'generation')::bigint,verified_at=clock_timestamp() where auth_user_id=auth.uid();
 return context;
end $$;
create function public.shared_logo_storage_session_closed() returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare claims jsonb:=auth.jwt(); actor uuid:=auth.uid(); sid uuid;
begin
 -- A verified JWT may outlive logout. This endpoint checks only that JWT's own
 -- fixed service actor/session; it cannot enumerate users or accept a selector.
 if actor is null or claims->>'sub' is distinct from actor::text or claims->>'role' is distinct from 'authenticated'
  or claims->>'aud' is distinct from 'authenticated' or claims->'is_anonymous' is distinct from 'false'::jsonb
  or not coalesce(fluid_private.logo_uuid(claims->'session_id'),false) or jsonb_typeof(claims->'exp') is distinct from 'number'
  or (claims->>'exp')::numeric<=extract(epoch from clock_timestamp())
  or not exists(select 1 from fluid_private.shared_storage_target where singleton and claims->>'iss'=origin||'/auth/v1')
  or not fluid_private.shared_storage_identity_bound() then raise exception 'shared_storage_cleanup_unverified' using errcode='42501'; end if;
 sid:=(claims->>'session_id')::uuid;
 if to_regclass('auth.refresh_tokens') is null or (select count(*) from pg_attribute where attrelid=to_regclass('auth.refresh_tokens')
  and attname in('session_id','user_id','revoked') and not attisdropped)<>3 then raise exception 'shared_storage_cleanup_schema_unavailable' using errcode='55000'; end if;
 return not exists(select 1 from auth.sessions where id=sid and user_id=actor)
  and not exists(select 1 from auth.refresh_tokens where session_id=sid and user_id::text=actor::text and not coalesce(revoked,false));
end $$;
create function fluid_private.shared_storage_slot_ready(p_slot uuid) returns boolean
language sql volatile security definer set search_path='' as $$
 select exists(select 1 from fluid_private.shared_storage_actors a join fluid_private.shared_worker_slots s using(slot_id)
 join auth.sessions session on session.id=a.verified_session_id and session.user_id=a.auth_user_id
 join auth.users u on u.id=a.auth_user_id
 where a.slot_id=p_slot and a.enabled and s.enabled and s.lane='logo' and s.expires_at>clock_timestamp()
 and a.verified_instance_id=s.instance_id and a.verified_generation=s.generation
 and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false) and u.deleted_at is null
 and (u.banned_until is null or u.banned_until<=clock_timestamp()) and (session.not_after is null or session.not_after>clock_timestamp())
 and exists(select 1 from fluid_private.shared_service_actors where auth_user_id=a.auth_user_id and purpose='logo_storage')
 and not exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=a.auth_user_id)
 and fluid_private.shared_worker_role_safe(s.role_name,s.role_oid));
$$;
-- Operation membership is independent of the physical slot and is resolved
-- only through a fixed source-owned helper, never a caller-selected function.
-- Optional extension packets fail closed until their exact authority exists.
create function fluid_private.shared_storage_operation_policy(j public.jobs) returns jsonb
language plpgsql stable set search_path='' as $$declare result jsonb;begin
 if j.operation='identity.image' then
  if to_regprocedure('fluid_private.shared_identity_job(public.jobs)') is null then return null;end if;
  execute 'select case when fluid_private.shared_identity_job($1) then policy else null end from fluid_private.shared_job_admissions where job_id=($1).id' into result using j;
 elsif to_regprocedure('fluid_private.shared_logo_storage_policy(public.jobs)') is not null then
  execute 'select fluid_private.shared_logo_storage_policy($1)' into result using j;
 else select fluid_private.logo_policy_descriptor(p) into result from fluid_private.logo_runtime_policies p where p.owner_id=j.owner_id and p.operation=j.operation and fluid_private.logo_job_policy_matches(j,p);end if;
 return result;
end $$;
create function fluid_private.shared_storage_operation_policy_matches(j public.jobs,p_approved jsonb) returns boolean
language sql stable set search_path='' as $$select coalesce(fluid_private.shared_storage_operation_policy(j)=p_approved,false);$$;
create function fluid_private.shared_storage_operation_member(j public.jobs,r public.logo_asset_publications,p_mode text) returns text
language plpgsql stable set search_path='' as $$declare result jsonb;legacy text;begin
 if j.operation='identity.image' then
  if to_regprocedure('fluid_private.shared_identity_storage_member(public.jobs,public.logo_asset_publications,text)') is null then return null;end if;
  execute 'select fluid_private.shared_identity_storage_member($1,$2,$3)' into result using j,r,p_mode;
 elsif to_regprocedure('fluid_private.shared_logo_storage_member(public.jobs,public.logo_asset_publications,text)') is not null then
  execute 'select fluid_private.shared_logo_storage_member($1,$2,$3)' into result using j,r,p_mode;
 elsif j.operation in('identity.logo_concept','identity.logo_refine') then
  legacy:=fluid_private.logo_generative_storage_member(j,r,p_mode);result:=case when legacy is null then null else jsonb_build_object('member',legacy) end;
 end if;
 if result->>'member' not in('reference','base','source','font','logo-document','output') or result->>'member' is null then return null;end if;
 return result->>'member';
end $$;
create function fluid_private.shared_storage_execution(context jsonb,p_execution uuid,p_token uuid,p_job uuid,p_lease uuid,p_observe boolean default false)
returns fluid_private.shared_worker_executions language plpgsql volatile set search_path='' as $$
declare e fluid_private.shared_worker_executions; s fluid_private.shared_worker_slots; a fluid_private.shared_job_admissions; j public.jobs;
begin
 if context is null or p_execution is null or p_token is null or p_job is null or p_lease is null then return null; end if;
 select * into e from fluid_private.shared_worker_executions where execution_id=p_execution and execution_token=p_token and job_id=p_job and lease_token=p_lease;
 select * into s from fluid_private.shared_worker_slots where slot_id=(context->>'slotId')::uuid;
 select * into a from fluid_private.shared_job_admissions where job_id=p_job;
 select * into j from public.jobs where id=p_job;
 if e.execution_id is null or s.slot_id is null or a.job_id is null or e.state='closed'
  or (e.slot_id,e.lane) is distinct from(s.slot_id,'logo'::text)
  or not p_observe and e.deployment_id is distinct from s.deployment_id
  or (a.owner_id,a.project_id,a.operation,a.input_hash,a.lane,a.policy_identity,a.deployment_id)
    is distinct from(j.owner_id,j.project_id,j.operation,j.input_hash,'logo'::text,e.policy_identity,e.deployment_id)
  or (e.owner_id,e.project_id,e.operation) is distinct from(j.owner_id,j.project_id,j.operation)
  or j.input->>'policyIdentity' is distinct from e.policy_identity
  or (j.lease_token is not null and j.lease_token<>e.lease_token) then return null; end if;
 if not p_observe and (not s.enabled or s.expires_at<=clock_timestamp() or e.state<>'active'
  or (e.instance_id,e.generation) is distinct from(s.instance_id,s.generation)
  or not fluid_private.shared_worker_admission_active(e.job_id) or j.state<>'running' or j.cancel_requested_at is not null
  or j.lease_token is distinct from e.lease_token or j.lease_expires_at<=clock_timestamp()
  or not exists(select 1 from fluid_private.shared_worker_policies p where p.slot_id=s.slot_id and p.operation=e.operation and p.policy_identity=e.policy_identity and p.policy=a.policy)
  or not fluid_private.shared_storage_operation_policy_matches(j,a.policy)) then return null; end if;
 return e;
end $$;
create function public.authorize_shared_logo_storage(p_execution uuid,p_execution_token uuid,p_job uuid,p_lease uuid,p_reservation uuid,p_mode text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare context jsonb:=fluid_private.shared_storage_auth_context(); e fluid_private.shared_worker_executions; j public.jobs;
 r public.logo_asset_publications; member text; result jsonb; previous fluid_private.shared_storage_grants; capability jsonb;
begin
 if p_mode is null or p_mode not in('probe','read','write','observe') or (p_mode='probe')<>(p_reservation is null) then raise exception 'shared_storage_mode_invalid' using errcode='22023'; end if;
 e:=fluid_private.shared_storage_execution(context,p_execution,p_execution_token,p_job,p_lease,p_mode='observe');
 if e.execution_id is null then raise exception 'shared_storage_execution_denied' using errcode='42501'; end if;
 select * into j from public.jobs where id=e.job_id;
 select policy into capability from fluid_private.shared_job_admissions where job_id=j.id;
 context:=context||jsonb_build_object('instanceId',e.instance_id,'generation',e.generation);
 result:=context||jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'ownerId',j.owner_id,'projectId',j.project_id,
  'jobId',j.id,'leaseToken',e.lease_token,'inputRevision',j.input_revision,'jobInput',j.input,'capability',capability,
  'mode',p_mode,'member',null,'reservation',null,'publication',null);
 if p_mode='probe' then return result; end if;
 select * into r from public.logo_asset_publications where id=p_reservation and owner_id=j.owner_id and project_id=j.project_id;
 if p_mode='observe' then
  if not exists(select 1 from fluid_private.shared_storage_grants issued where issued.execution_id=e.execution_id and issued.reservation_id=r.id and issued.mode='write'
   and issued.auth_user_id=auth.uid() and issued.binding->'execution'=fluid_private.shared_worker_execution_json(e)
   and issued.binding->>'roleName'=context->>'roleName' and issued.binding->'roleOid'=context->'roleOid')
   or r.job_id is distinct from e.job_id or r.lease_token is distinct from e.lease_token then raise exception 'shared_storage_observation_denied' using errcode='42501'; end if;
  -- The original frozen lease remains evidence after expiration/Stop. This
  -- composite snapshot permits only member verification, never a database write.
  j.lease_token:=e.lease_token;
  member:=fluid_private.shared_storage_operation_member(j,r,'write');
 else member:=fluid_private.shared_storage_operation_member(j,r,p_mode); end if;
 if member is null then raise exception 'shared_storage_member_denied' using errcode='42501'; end if;
 result:=result||jsonb_build_object('member',member,'reservation',fluid_private.logo_asset_reservation(r),
  'publication',case when p_mode in('write','observe') then r.request->'publication' else null end);
 insert into fluid_private.shared_storage_grants(session_id,auth_user_id,execution_id,reservation_id,storage_path,mode,member,binding)
 values((context->>'sessionId')::uuid,auth.uid(),e.execution_id,r.id,r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text,p_mode,member,result) on conflict do nothing;
 select * into previous from fluid_private.shared_storage_grants where session_id=(context->>'sessionId')::uuid and execution_id=e.execution_id and reservation_id=r.id and mode=p_mode;
 if previous.auth_user_id is distinct from auth.uid() or previous.member is distinct from member or previous.binding is distinct from result then raise exception 'shared_storage_grant_conflict' using errcode='42501'; end if;
 return result;
end $$;
create function fluid_private.shared_storage_object_allowed(p_bucket text,p_name text,p_owner text,p_access text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare context jsonb:=fluid_private.shared_storage_auth_context(); g fluid_private.shared_storage_grants; e fluid_private.shared_worker_executions; j public.jobs; r public.logo_asset_publications;
begin
 if context is null or p_bucket is distinct from 'fluid-assets' or p_access is null or p_access not in('read','write') then return false; end if;
 for g in select grants.* from fluid_private.shared_storage_grants grants join public.logo_asset_publications p on p.id=grants.reservation_id
  where grants.session_id=(context->>'sessionId')::uuid and grants.auth_user_id=auth.uid()
   and grants.storage_path=p_name and p_name=p.owner_id::text||'/'||p.project_id::text||'/'||p.asset_id::text||'/'||p.version_id::text
   and (p_access='read' or grants.mode='write') loop
  if p_access='write' and p_owner is distinct from auth.uid()::text then continue; end if;
  e:=fluid_private.shared_storage_execution(context,g.execution_id,(g.binding#>>'{execution,executionToken}')::uuid,
   (g.binding->>'jobId')::uuid,(g.binding->>'leaseToken')::uuid,g.mode='observe');
  if e.execution_id is null or g.binding->'execution' is distinct from fluid_private.shared_worker_execution_json(e)
   or g.binding->>'roleName' is distinct from context->>'roleName' or g.binding->'roleOid' is distinct from context->'roleOid' then continue; end if;
  select * into j from public.jobs where id=e.job_id;
  select * into r from public.logo_asset_publications where id=g.reservation_id;
  if g.mode in('write','observe') and p_owner is distinct from auth.uid()::text then continue; end if;
  if g.mode='observe' then
   if p_access<>'read' or not exists(select 1 from fluid_private.shared_storage_grants issued where issued.execution_id=e.execution_id and issued.reservation_id=r.id and issued.mode='write'
    and issued.auth_user_id=g.auth_user_id and issued.binding->'execution'=fluid_private.shared_worker_execution_json(e)) then continue; end if;
   j.lease_token:=e.lease_token;
  end if;
  if fluid_private.shared_storage_operation_member(j,r,case when g.mode='observe' then 'write' else g.mode end)=g.member then return true; end if;
 end loop;
 return false;
end $$;

do $$declare obj record; gr record; begin
 for obj in select c.oid,c.oid::regclass signature from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='fluid_private' and c.relname in('shared_storage_target','shared_storage_actors','shared_storage_grants') loop
  execute format('alter table %s enable row level security',obj.signature); execute format('alter table %s force row level security',obj.signature);
  for gr in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=obj.oid and a.grantee<>c.relowner loop
   execute format('revoke all on table %s from %s cascade',obj.signature,case when gr.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(gr.grantee)) end);
  end loop;
 end loop;
 for obj in select p.oid,p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in('fluid_private','public') and (p.proname like 'shared_storage_%' or p.proname in('shared_logo_storage_session','shared_logo_storage_session_closed','authorize_shared_logo_storage')) loop
  for gr in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=obj.oid and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',obj.signature,case when gr.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(gr.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.shared_logo_storage_session(),public.shared_logo_storage_session_closed(),public.authorize_shared_logo_storage(uuid,uuid,uuid,uuid,uuid,text),
 fluid_private.shared_storage_identity_bound(),fluid_private.shared_storage_legacy_registry_present(),fluid_private.shared_storage_object_allowed(text,text,text,text) to authenticated;
create policy embel_shared_legacy_storage_registry_fence on storage.objects as restrictive for all to authenticated
 using(bucket_id<>'fluid-assets' or (select fluid_private.shared_storage_legacy_registry_present()))
 with check(bucket_id<>'fluid-assets' or (select fluid_private.shared_storage_legacy_registry_present()));
create policy embel_shared_storage_read on storage.objects for select to authenticated using(
 storage.allow_only_operation('object.get_authenticated') and fluid_private.shared_storage_object_allowed(bucket_id,name,owner_id,'read'));
create policy embel_shared_storage_insert on storage.objects for insert to authenticated with check(
 storage.allow_only_operation('object.upload') and owner_id=(select auth.uid())::text and fluid_private.shared_storage_object_allowed(bucket_id,name,owner_id,'write'));
create policy embel_shared_storage_read_fence on storage.objects as restrictive for select to authenticated using(
 not (select fluid_private.shared_storage_identity_bound()) or storage.allow_only_operation('object.get_authenticated') and fluid_private.shared_storage_object_allowed(bucket_id,name,owner_id,'read'));
create policy embel_shared_storage_insert_fence on storage.objects as restrictive for insert to authenticated with check(
 not (select fluid_private.shared_storage_identity_bound()) or storage.allow_only_operation('object.upload') and owner_id=(select auth.uid())::text and fluid_private.shared_storage_object_allowed(bucket_id,name,owner_id,'write'));
create policy embel_shared_storage_update_fence on storage.objects as restrictive for update to authenticated using(not (select fluid_private.shared_storage_identity_bound())) with check(not (select fluid_private.shared_storage_identity_bound()));
create policy embel_shared_storage_delete_fence on storage.objects as restrictive for delete to authenticated using(not (select fluid_private.shared_storage_identity_bound()));
commit;
