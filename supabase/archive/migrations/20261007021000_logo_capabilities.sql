-- LOCAL REVIEWED PROPOSAL ONLY. Do not apply hosted SQL without authorization.
-- This sole new authenticated grant is an owned, read-only UI hint. It grants
-- no worker access and never enables policy, jobs, storage or provider calls.
-- Quote/admission/dispatch retain their authoritative current checks.
begin;

create function public.read_logo_capabilities(p_project_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); observed timestamptz:=date_trunc('milliseconds',clock_timestamp());
 target_operation text; ready_until timestamptz; statuses jsonb:='{}';
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 perform 1 from public.projects where id=p_project_id and owner_id=owner;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 foreach target_operation in array array['identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export'] loop
  -- A broad max over unqualified rows could borrow a revoked worker's lifetime.
  -- Every row contributing expiry independently passes the same full descriptor,
  -- owner/principal and registration gates as the current readiness predicate.
  select date_trunc('milliseconds',least(max(r.ready_until),observed+interval '30 seconds')) into ready_until
   from fluid_private.logo_worker_readiness r
   join fluid_private.logo_runtime_policies p on p.owner_id=r.owner_id and p.operation=r.operation
   join fluid_private.logo_worker_principals binding on binding.role_oid=r.role_oid and binding.owner_id=r.owner_id
   join pg_catalog.pg_roles principal on principal.oid=binding.role_oid and principal.rolname=binding.role_name
   where r.owner_id=owner and r.operation=target_operation and r.ready_until>clock_timestamp() and p.enabled
    and r.descriptor=fluid_private.logo_policy_descriptor(p)
    and (p.subscription_policy is null or fluid_private.logo_subscription_registration_ready(p.owner_id,p.subscription_policy))
    and principal.rolcanlogin and not principal.rolinherit and not principal.rolsuper and not principal.rolbypassrls
    and not principal.rolcreatedb and not principal.rolcreaterole and not principal.rolreplication
    and not exists(select 1 from pg_catalog.pg_auth_members membership where membership.member=principal.oid)
   having count(*)>0;
  -- Also require the current authoritative operation predicate. Any future
  -- row-level predicate change must update this expiry projection in lockstep.
  if ready_until>clock_timestamp() and fluid_private.logo_operation_ready(owner,target_operation) then
   statuses:=statuses||jsonb_build_object(target_operation,jsonb_build_object('status','available','expiresAt',to_char(ready_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  else
   statuses:=statuses||jsonb_build_object(target_operation,jsonb_build_object('status','unavailable'));
  end if;
 end loop;
 return jsonb_build_object('ownerId',owner,'projectId',p_project_id,'observedAt',to_char(observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'operations',statuses);
end $$;

-- Exact OID cleanup removes hostile default grants and grant options, without
-- changing any existing overload, function, relation ACL or default privilege.
do $$ declare object_id oid:='public.read_logo_capabilities(uuid)'::regprocedure; recipient record;
begin
 for recipient in select distinct a.grantee from pg_catalog.pg_proc p
  cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  where p.oid=object_id and a.grantee<>p.proowner loop
  execute format('revoke all on function %s from %s cascade',object_id::regprocedure,
   case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_catalog.pg_get_userbyid(recipient.grantee)) end);
 end loop;
end $$;
grant execute on function public.read_logo_capabilities(uuid) to authenticated;
commit;
