-- LOCAL DISABLED SOURCE CANDIDATE ONLY. No hosted application or new grant.
-- Apply after the accepted proposal quote/admission/observation/completion candidates.
-- The sixth hint inherits exact descriptor, current principal, TTL and shared
-- paid-uncertainty gates. A hint never authorizes quote/admission/dispatch.
begin;
do $migration$
declare body text; definition text;
begin
 select prosrc into body from pg_catalog.pg_proc where oid='public.read_logo_capabilities(uuid)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '34b78c8dba702eb7842ce356451f6f576fa672044dc57a247b4bc6185af2cf0f' then
  raise exception 'proposal_capabilities_predecessor_mismatch: public.read_logo_capabilities(uuid)' using errcode='55000';
 end if;
 definition:=pg_catalog.pg_get_functiondef('public.read_logo_capabilities(uuid)'::regprocedure);
 execute replace(definition,body,$replacement$
declare owner uuid:=auth.uid(); observed timestamptz:=date_trunc('milliseconds',clock_timestamp());
 target_operation text; ready_until timestamptz; statuses jsonb:='{}';
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 perform 1 from public.projects where id=p_project_id and owner_id=owner;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 foreach target_operation in array array['identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose'] loop
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
end $replacement$);
end $migration$;
commit;
